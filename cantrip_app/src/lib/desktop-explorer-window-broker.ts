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

const sharedSessionRenewalMaxDelayMs = 5 * 60_000;
const sharedSessionRenewalMinDelayMs = 30_000;

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
  let transportRecoveryPromise: Promise<void> | null = null;
  let transportUnavailableReason: unknown | null = null;
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
          const reason = new Error("The shared Cantrip Code transport closed.");
          transportUnavailableReason = reason;
          void recoverSharedTransport(reason)
            .then(() =>
              scheduleConfiguration(
                hasFileTarget ? context.path : null,
                context.requestedAtMs,
              ),
            )
            .catch(() => undefined);
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
        reportEditorError(
          codeWorkbenchStageError("endpoint", error),
          "endpoint",
        );
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
  let editorPromise: Promise<PreparedEditorAttachment>;
  const prepareEditor = (): Promise<PreparedEditorAttachment> => {
    const raw = (async (): Promise<PreparedEditorAttachment> => {
      preparationController.signal.throwIfAborted();
      const owned = await createProtectedExplorerCodeSessionAttachment(
        context.explorer.id,
        hasFileTarget ? context.path : null,
        context.explorer.activeWorkerId,
        context.explorer.worktreeId,
        context.appearance,
      );
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
      presentationNonce = nonce;
      void setDirectCodeAttachmentPresentation(result.attachment, "editor", {
        signal: preparationController.signal,
      }).catch(() => undefined);
    }
    if (path === null) return;
    let opened: Awaited<ReturnType<typeof openDirectCodeAttachmentFile>>;
    try {
      opened = await openDirectCodeAttachmentFile(result.attachment, path, {
        signal,
      });
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
    if (transportUnavailableReason !== null) {
      return recoverSharedTransport(transportUnavailableReason).then(() =>
        scheduleConfiguration(path, requestedAtMs),
      );
    }
    return scheduleConfiguration(path, requestedAtMs);
  };
  recoverSharedTransport = (reason: unknown): Promise<void> => {
    if (disposed || preparationController.signal.aborted) {
      return Promise.resolve();
    }
    if (transportRecoveryPromise) return transportRecoveryPromise;
    const owned = ownedAttachment;
    const stale = prepared;
    if (!owned || !stale) {
      const error = codeWorkbenchStageError("endpoint", reason);
      reportEditorError(error, "endpoint");
      return Promise.reject(error);
    }
    transportUnavailableReason = reason;
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
      editorPromise = Promise.resolve(replacement);
      transportUnavailableReason = null;
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
    })();
    transportRecoveryPromise = recovery
      .catch((error: unknown) => {
        if (!disposed && !preparationController.signal.aborted) {
          transportUnavailableReason = error;
          reportEditorError(
            codeWorkbenchStageError("endpoint", error),
            "endpoint",
          );
        }
        throw error;
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
    if (
      error instanceof CodeWorkbenchStageError &&
      (error.stage === "frame" || error.stage === "workbench")
    ) {
      await releaseOwnedEditor();
    }
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
