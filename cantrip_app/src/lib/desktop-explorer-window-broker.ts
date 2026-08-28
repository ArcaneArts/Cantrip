import {
  CantripApiError,
  createProtectedExplorerCodeSessionAttachment,
  getExplorerFile,
  loadExplorerMedia,
  releaseProtectedExplorerCodeSessionAttachment,
  renewProtectedExplorerCodeSessionAttachment,
  saveExplorerFile,
  type BoundExplorerCodeSessionAttachment,
} from "@/lib/api";
import {
  openDirectCodeAttachmentFile,
  preferSharedProtectedCodeAttachment,
  recoverPreferredCodeAttachmentRoute,
  retainSharedProtectedCodeAttachmentLease,
  setDirectCodeAttachmentPresentation,
  stopSharedProtectedCodeAttachment,
  subscribePreferredCodeAttachmentUnavailable,
  type PreferredCodeAttachment,
} from "@/lib/desktop-code";
import {
  desktopExplorerWindowChannelName,
  desktopExplorerWindowModes,
  isDesktopExplorerWindowRequest,
  type DesktopExplorerWindowContext,
  type DesktopExplorerWindowResponse,
} from "@/lib/desktop-explorer-window-protocol";
import {
  CODE_WORKBENCH_READY_TIMEOUT_MS,
  CodeWorkbenchStageError,
  codeWorkbenchStageError,
  type CodeWorkbenchStage,
} from "@/lib/code-workbench-frame";
import { errorMessage } from "@/lib/error-message";
import { retireAttachmentBestEffort } from "@/lib/serialized-attachment-lifecycle";

type PreparedEditorAttachment = PreferredCodeAttachment;

export interface DesktopExplorerWindowBroker {
  dispose(): Promise<void>;
  readonly failed: boolean;
  launchId: string;
  openFile(path: string, requestedAtMs?: number): Promise<void>;
  ready: Promise<void>;
}

export interface DesktopExplorerWindowBrokerOptions {
  configureInitialFile?: boolean;
  signal?: AbortSignal;
}

const editorControlRetryDelaysMs = [250, 750] as const;
const editorRouteRecoveryRetryLimit = 2;
const sharedSessionRenewalMaxDelayMs = 5 * 60_000;
const sharedSessionRenewalMinDelayMs = 30_000;

function isTransientEditorControlError(error: unknown): boolean {
  return /(?:failed to fetch|load failed|network|not connected|unavailable)/iu.test(
    errorMessage(error, ""),
  );
}

function waitForAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  await waitForAbortable(
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    signal,
  );
}

async function waitForAbortableTimeout<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await waitForAbortable(
      Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(timeoutError()), timeoutMs);
        }),
      ]),
      signal,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function retryEditorControl<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      const retryDelayMs = editorControlRetryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isTransientEditorControlError(error)) {
        throw error;
      }
      await abortableDelay(retryDelayMs, signal);
    }
  }
}

async function releasePreparedEditor(
  owned: BoundExplorerCodeSessionAttachment,
): Promise<void> {
  await retireAttachmentBestEffort(
    () => stopSharedProtectedCodeAttachment(owned),
    () => releaseProtectedExplorerCodeSessionAttachment(owned),
  );
}

export function createDesktopExplorerWindowBroker(
  input: Omit<DesktopExplorerWindowContext, "requestedAtMs">,
  options: DesktopExplorerWindowBrokerOptions = {},
): DesktopExplorerWindowBroker {
  const launchId = crypto.randomUUID();
  let context: DesktopExplorerWindowContext = {
    ...input,
    requestedAtMs: Date.now(),
  };
  const configureInitialFile = options.configureInitialFile ?? true;
  const channel = new BroadcastChannel(
    desktopExplorerWindowChannelName(launchId),
  );
  const preparationController = new AbortController();
  if (options.signal?.aborted) {
    preparationController.abort(options.signal.reason);
  }
  let disposed = false;
  let prepared: PreparedEditorAttachment | null = null;
  let ownedAttachment: BoundExplorerCodeSessionAttachment | null = null;
  let releasePromise: Promise<void> | null = null;
  let renewalCursor: BoundExplorerCodeSessionAttachment | null = null;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let renewalGeneration = 0;
  let recoverEditorAttachment: (reason: unknown) => Promise<void> = () =>
    Promise.resolve();
  let recoverSharedTransport: (reason: unknown) => Promise<void> = () =>
    Promise.resolve();
  let preparedAtMs: number | null = null;
  let configuredAtMs: number | null = null;
  let configuredWorkbenchNonce: string | null = null;
  let editorError: string | null = null;
  let editorErrorStage: CodeWorkbenchStage = "endpoint";
  let expectedWorkbenchNonce: string | null = null;
  let activeWorkbenchNonce: string | null = null;
  let presentationNonce: string | null = null;
  const initialFileSupportsEditor = desktopExplorerWindowModes(
    context.path,
  ).includes("edit");
  let hasFileTarget = configureInitialFile && initialFileSupportsEditor;
  let navigationRevision = 0;
  let navigationController: AbortController | null = null;
  let recoveryPromise: Promise<void> | null = null;
  let transportRecoveryPromise: Promise<void> | null = null;
  let unsubscribePreparedTerminal: (() => void) | null = null;
  const workbenchWaiters = new Set<{
    reject(error: Error): void;
    resolve(nonce: string): void;
  }>();

  const send = (response: DesktopExplorerWindowResponse) => {
    if (!disposed) channel.postMessage(response);
  };
  const unbindPreparedTerminal = (): void => {
    unsubscribePreparedTerminal?.();
    unsubscribePreparedTerminal = null;
  };
  const bindPreparedTerminal = (candidate: PreparedEditorAttachment): void => {
    unbindPreparedTerminal();
    unsubscribePreparedTerminal = subscribePreferredCodeAttachmentUnavailable(
      candidate,
      () => {
        if (!disposed && prepared === candidate) {
          void recoverSharedTransport(
            new Error("The shared Cantrip Code transport closed."),
          );
        }
      },
    );
  };
  const reportEditorError = (
    error: unknown,
    fallbackStage: CodeWorkbenchStage,
  ) => {
    if (disposed || preparationController.signal.aborted) return;
    const stage =
      error instanceof CodeWorkbenchStageError ? error.stage : fallbackStage;
    const message = errorMessage(
      error,
      "Cantrip Code could not open this file.",
    );
    if (message === editorError && stage === editorErrorStage) return;
    editorError = message;
    editorErrorStage = stage;
    send({ error: message, launchId, stage, type: "editor.failed" });
  };
  const releaseOwnedEditor = async (): Promise<void> => {
    renewalGeneration += 1;
    renewalCursor = null;
    if (renewalTimer) clearTimeout(renewalTimer);
    renewalTimer = null;
    const owned = ownedAttachment;
    if (!owned) return;
    // Stopping the local lease must be retried even after the logical session
    // release has completed. A leader can finish native acquisition after its
    // caller was aborted; the second stop observes and releases that late
    // exact-generation lease without issuing a second session DELETE.
    await stopSharedProtectedCodeAttachment(owned).catch(() => undefined);
    if (!releasePromise) {
      releasePromise = releaseProtectedExplorerCodeSessionAttachment(owned);
    }
    await releasePromise;
  };
  const scheduleSessionRenewal = (
    generation: number,
    delayMs?: number,
  ): void => {
    const current = renewalCursor;
    if (disposed || !current || generation !== renewalGeneration) return;
    if (renewalTimer) clearTimeout(renewalTimer);
    const expiresInMs =
      Date.parse(current.attachment.session.expiresAt) - Date.now();
    const delay =
      delayMs ??
      Math.min(
        sharedSessionRenewalMaxDelayMs,
        Math.max(sharedSessionRenewalMinDelayMs, Math.floor(expiresInMs / 2)),
      );
    renewalTimer = setTimeout(() => {
      renewalTimer = null;
      void renewSessionLease(generation);
    }, delay);
  };
  const renewSessionLease = async (generation: number): Promise<void> => {
    const current = renewalCursor;
    if (disposed || !current || generation !== renewalGeneration) return;
    try {
      const renewed = await renewProtectedExplorerCodeSessionAttachment(
        current,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (disposed || generation !== renewalGeneration) return;
      renewalCursor = renewed;
      scheduleSessionRenewal(generation);
    } catch (error) {
      if (disposed || generation !== renewalGeneration) return;
      const authoritative =
        error instanceof CantripApiError &&
        [401, 403, 404, 409, 410].includes(error.status);
      const expiresInMs =
        Date.parse(current.attachment.session.expiresAt) - Date.now();
      if (authoritative || expiresInMs <= sharedSessionRenewalMinDelayMs) {
        await recoverEditorAttachment(error).catch(() => undefined);
        return;
      }
      scheduleSessionRenewal(
        generation,
        Math.min(sharedSessionRenewalMinDelayMs, expiresInMs / 2),
      );
    }
  };
  const beginSessionRenewal = (
    owned: BoundExplorerCodeSessionAttachment,
  ): void => {
    renewalGeneration += 1;
    renewalCursor = owned;
    scheduleSessionRenewal(renewalGeneration);
  };
  let endpointGeneration = 0;
  let editorPromise: Promise<PreparedEditorAttachment>;
  const prepareEditor = (): Promise<PreparedEditorAttachment> => {
    const generation = ++endpointGeneration;
    const raw = (async (): Promise<PreparedEditorAttachment> => {
      preparationController.signal.throwIfAborted();
      const owned = await createProtectedExplorerCodeSessionAttachment(
        context.explorer.id,
        hasFileTarget ? context.path : null,
        context.explorer.activeWorkerId,
        context.explorer.worktreeId,
        context.appearance,
      );
      if (generation !== endpointGeneration) {
        await releasePreparedEditor(owned);
        throw new DOMException(
          "Explorer Code endpoint was superseded.",
          "AbortError",
        );
      }
      ownedAttachment = owned;
      preparationController.signal.throwIfAborted();
      const preferred = await preferSharedProtectedCodeAttachment(owned, {
        signal: preparationController.signal,
      });
      preparationController.signal.throwIfAborted();
      beginSessionRenewal(owned);
      return preferred;
    })().catch(async (error: unknown) => {
      await releaseOwnedEditor();
      throw error;
    });
    return waitForAbortable(raw, preparationController.signal)
      .then((result) => {
        preparationController.signal.throwIfAborted();
        if (generation !== endpointGeneration) {
          throw new DOMException(
            "Explorer Code endpoint was superseded.",
            "AbortError",
          );
        }
        prepared = result;
        bindPreparedTerminal(result);
        preparedAtMs = Date.now();
        send({
          attachment: result.attachment,
          launchId,
          preparedAtMs,
          type: "editor.endpoint-ready",
        });
        return result;
      })
      .catch((error: unknown) => {
        if (preparationController.signal.aborted) throw error;
        const staged = codeWorkbenchStageError("endpoint", error);
        reportEditorError(staged, "endpoint");
        throw staged;
      });
  };
  editorPromise = prepareEditor();

  const waitForWorkbench = async (signal: AbortSignal): Promise<string> => {
    if (activeWorkbenchNonce) return activeWorkbenchNonce;
    let waiter:
      { reject(error: Error): void; resolve(nonce: string): void } | undefined;
    const operation = new Promise<string>((resolve, reject) => {
      waiter = { reject, resolve };
      workbenchWaiters.add(waiter);
    });
    try {
      return await waitForAbortableTimeout(
        operation,
        signal,
        CODE_WORKBENCH_READY_TIMEOUT_MS,
        () => codeWorkbenchStageError("workbench"),
      );
    } finally {
      if (waiter) workbenchWaiters.delete(waiter);
    }
  };

  const configureEditor = async (
    path: string | null,
    requestedAtMs: number,
    revision: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const result = await editorPromise;
    const nonce = await waitForWorkbench(signal);
    signal.throwIfAborted();
    if (revision !== navigationRevision) return;
    if (presentationNonce !== nonce) {
      try {
        await retryEditorControl(
          () =>
            setDirectCodeAttachmentPresentation(result.attachment, "editor", {
              signal,
            }),
          signal,
        );
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        throw codeWorkbenchStageError("presentation", error);
      }
      signal.throwIfAborted();
      if (revision !== navigationRevision || nonce !== activeWorkbenchNonce)
        return;
      presentationNonce = nonce;
    }
    if (path === null) return;
    let opened: Awaited<ReturnType<typeof openDirectCodeAttachmentFile>>;
    try {
      opened = await retryEditorControl(
        () =>
          openDirectCodeAttachmentFile(result.attachment, path, {
            signal,
          }),
        signal,
      );
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw codeWorkbenchStageError("file", error);
    }
    signal.throwIfAborted();
    if (revision !== navigationRevision || nonce !== activeWorkbenchNonce)
      return;
    if (opened.relativePath !== path) {
      throw codeWorkbenchStageError(
        "file",
        `Worker acknowledged ${opened.relativePath} instead of ${path}.`,
      );
    }
    configuredAtMs = Date.now();
    configuredWorkbenchNonce = nonce;
    editorError = null;
    send({
      configuredAtMs,
      launchId,
      nonce,
      path,
      requestedAtMs,
      type: "editor.ready",
    });
  };

  let navigationQueue = Promise.resolve();
  const scheduleConfiguration = (
    path: string | null,
    requestedAtMs: number,
    routeRecoveryAttempt = 0,
  ): Promise<void> => {
    navigationRevision += 1;
    const revision = navigationRevision;
    navigationController?.abort(
      new DOMException("Explorer Code navigation superseded.", "AbortError"),
    );
    const controller = new AbortController();
    navigationController = controller;
    const signal = AbortSignal.any([
      preparationController.signal,
      controller.signal,
    ]);
    const navigate = navigationQueue.then(() =>
      configureEditor(path, requestedAtMs, revision, signal),
    );
    navigationQueue = navigate.catch(() => undefined);
    return navigate.catch(async (error: unknown) => {
      if (controller.signal.aborted && !preparationController.signal.aborted) {
        return;
      }
      if (prepared && isTransientEditorControlError(error)) {
        const recovery = await recoverPreferredCodeAttachmentRoute(prepared, {
          signal,
        }).catch(() => "recovering" as const);
        if (recovery === "replace-required") {
          await recoverEditorAttachment(error);
          return;
        }
        if (routeRecoveryAttempt < editorRouteRecoveryRetryLimit) {
          await abortableDelay(recovery === "available" ? 250 : 1_000, signal);
          if (revision !== navigationRevision) return;
          await scheduleConfiguration(
            path,
            requestedAtMs,
            routeRecoveryAttempt + 1,
          );
          return;
        }
      }
      reportEditorError(error, path === null ? "presentation" : "file");
      throw error;
    });
  };

  const openFile = (path: string, requestedAtMs = Date.now()) => {
    preparationController.signal.throwIfAborted();
    hasFileTarget = desktopExplorerWindowModes(path).includes("edit");
    context = { ...context, path, requestedAtMs };
    configuredAtMs = null;
    configuredWorkbenchNonce = null;
    editorError = null;
    send({ context, launchId, type: "launch.ready" });
    if (!hasFileTarget) {
      navigationRevision += 1;
      navigationController?.abort(
        new DOMException("Explorer Code navigation superseded.", "AbortError"),
      );
      navigationController = null;
      return Promise.resolve();
    }
    return scheduleConfiguration(path, requestedAtMs);
  };
  recoverEditorAttachment = (reason: unknown): Promise<void> => {
    if (disposed || preparationController.signal.aborted) {
      return Promise.resolve();
    }
    if (recoveryPromise) return recoveryPromise;
    reportEditorError(codeWorkbenchStageError("endpoint", reason), "endpoint");
    navigationController?.abort(
      new DOMException("Explorer Code attachment is recovering.", "AbortError"),
    );
    activeWorkbenchNonce = null;
    expectedWorkbenchNonce = null;
    presentationNonce = null;
    configuredAtMs = null;
    configuredWorkbenchNonce = null;
    unbindPreparedTerminal();
    prepared = null;
    const staleAttachment = ownedAttachment;
    const replacement = (async () => {
      await releaseOwnedEditor();
      preparationController.signal.throwIfAborted();
      if (ownedAttachment === staleAttachment) ownedAttachment = null;
      releasePromise = null;
      return prepareEditor();
    })();
    editorPromise = replacement;
    recoveryPromise = replacement
      .then(() =>
        scheduleConfiguration(
          hasFileTarget ? context.path : null,
          context.requestedAtMs,
        ),
      )
      .finally(() => {
        recoveryPromise = null;
      });
    return recoveryPromise;
  };
  recoverSharedTransport = (reason: unknown): Promise<void> => {
    if (disposed || preparationController.signal.aborted) {
      return Promise.resolve();
    }
    if (transportRecoveryPromise) return transportRecoveryPromise;
    const owned = ownedAttachment;
    const stale = prepared;
    if (!owned || !stale) return recoverEditorAttachment(reason);
    reportEditorError(codeWorkbenchStageError("endpoint", reason), "endpoint");
    navigationController?.abort(
      new DOMException("Explorer Code transport is recovering.", "AbortError"),
    );
    unbindPreparedTerminal();
    const recovery = (async () => {
      const replacement = await preferSharedProtectedCodeAttachment(owned, {
        signal: preparationController.signal,
      });
      if (
        disposed ||
        preparationController.signal.aborted ||
        ownedAttachment !== owned ||
        prepared !== stale
      ) {
        await stopSharedProtectedCodeAttachment(
          owned,
          replacement.sharedTransportLeaseId,
        ).catch(() => undefined);
        return;
      }
      if (replacement.sharedTransportLeaseId) {
        await retainSharedProtectedCodeAttachmentLease(
          owned,
          replacement.sharedTransportLeaseId,
        );
      }
      prepared = replacement;
      preparedAtMs = Date.now();
      activeWorkbenchNonce = null;
      expectedWorkbenchNonce = null;
      presentationNonce = null;
      configuredAtMs = null;
      configuredWorkbenchNonce = null;
      bindPreparedTerminal(replacement);
      send({
        attachment: replacement.attachment,
        launchId,
        preparedAtMs,
        type: "editor.endpoint-ready",
      });
      await scheduleConfiguration(
        hasFileTarget ? context.path : null,
        context.requestedAtMs,
      );
    })();
    transportRecoveryPromise = recovery
      .catch(async (error) => {
        if (!disposed && !preparationController.signal.aborted) {
          await recoverEditorAttachment(error);
        }
      })
      .finally(() => {
        transportRecoveryPromise = null;
      });
    return transportRecoveryPromise;
  };
  const ready =
    configureInitialFile && initialFileSupportsEditor
      ? openFile(context.path, context.requestedAtMs)
      : scheduleConfiguration(null, context.requestedAtMs);
  void ready.catch(async (error: unknown) => {
    reportEditorError(
      error,
      configureInitialFile && initialFileSupportsEditor
        ? "file"
        : "presentation",
    );
    await releaseOwnedEditor();
  });

  const dispose = (): Promise<void> => {
    if (!disposed) {
      disposed = true;
      navigationController?.abort(
        new DOMException("Explorer editor closed.", "AbortError"),
      );
      preparationController.abort(options.signal?.reason);
      options.signal?.removeEventListener("abort", abortFromOwner);
      unbindPreparedTerminal();
      channel.close();
    }
    return releaseOwnedEditor();
  };
  const abortFromOwner = () => void dispose();
  options.signal?.addEventListener("abort", abortFromOwner, { once: true });
  if (options.signal?.aborted) abortFromOwner();

  channel.addEventListener("message", (event) => {
    const request = event.data;
    if (
      !isDesktopExplorerWindowRequest(request) ||
      request.launchId !== launchId
    ) {
      return;
    }
    if (request.type === "launch.request") {
      send({ context, launchId, type: "launch.ready" });
      if (prepared) {
        send({
          attachment: prepared.attachment,
          launchId,
          preparedAtMs: preparedAtMs ?? Date.now(),
          type: "editor.endpoint-ready",
        });
      }
      if (configuredAtMs !== null && configuredWorkbenchNonce !== null) {
        send({
          configuredAtMs,
          launchId,
          nonce: configuredWorkbenchNonce,
          path: context.path,
          requestedAtMs: context.requestedAtMs,
          type: "editor.ready",
        });
      }
      if (editorError) {
        send({
          error: editorError,
          launchId,
          stage: editorErrorStage,
          type: "editor.failed",
        });
      }
      return;
    }
    if (request.type === "editor.workbench-mounted") {
      if (request.nonce === expectedWorkbenchNonce) return;
      expectedWorkbenchNonce = request.nonce;
      if (activeWorkbenchNonce !== request.nonce) {
        activeWorkbenchNonce = null;
        presentationNonce = null;
        configuredAtMs = null;
        configuredWorkbenchNonce = null;
      }
      return;
    }
    if (request.type === "editor.workbench-ready") {
      if (
        (expectedWorkbenchNonce !== null &&
          request.nonce !== expectedWorkbenchNonce) ||
        request.nonce === activeWorkbenchNonce
      ) {
        return;
      }
      const hadWaiters = workbenchWaiters.size > 0;
      expectedWorkbenchNonce = request.nonce;
      activeWorkbenchNonce = request.nonce;
      presentationNonce = null;
      configuredAtMs = null;
      configuredWorkbenchNonce = null;
      editorError = null;
      for (const waiter of [...workbenchWaiters]) {
        waiter.resolve(request.nonce);
      }
      if (!hadWaiters) {
        void scheduleConfiguration(
          hasFileTarget ? context.path : null,
          context.requestedAtMs,
        ).catch(() => undefined);
      }
      return;
    }
    if (request.type === "editor.workbench-failed") {
      if (
        expectedWorkbenchNonce !== null &&
        request.nonce !== expectedWorkbenchNonce
      ) {
        return;
      }
      const failed = new CodeWorkbenchStageError(request.stage, request.error);
      for (const waiter of [...workbenchWaiters]) {
        waiter.reject(failed);
      }
      reportEditorError(failed, request.stage);
      return;
    }
    void (async () => {
      try {
        if (request.type === "file.read") {
          send({
            file: await getExplorerFile(context.explorer.id, context.path),
            launchId,
            requestId: request.requestId,
            type: "file.result",
          });
          return;
        }
        if (request.type === "media.read") {
          send({
            blob: await loadExplorerMedia(context.explorer.id, context.path),
            launchId,
            requestId: request.requestId,
            type: "media.result",
          });
          return;
        }
        send({
          file: await saveExplorerFile(context.explorer.id, {
            content: request.content,
            path: context.path,
            version: request.version,
          }),
          launchId,
          requestId: request.requestId,
          type: "file.result",
        });
      } catch (error) {
        send({
          error: errorMessage(error),
          launchId,
          requestId: request.requestId,
          type: "request.failed",
        });
      }
    })();
  });

  return {
    get failed() {
      return editorError !== null;
    },
    launchId,
    openFile,
    ready,
    dispose,
  };
}
