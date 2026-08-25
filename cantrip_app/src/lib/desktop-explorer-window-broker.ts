import {
  createProtectedExplorerCodeAttachment,
  getExplorerFile,
  loadExplorerMedia,
  releaseCodeAttachment,
  saveExplorerFile,
} from "@/lib/api";
import {
  openDirectCodeAttachmentFile,
  preferProtectedCodeAttachment,
  recoverPreferredCodeAttachmentRoute,
  setDirectCodeAttachmentPresentation,
  stopDirectCodeAttachment,
  type PreferredCodeAttachment,
} from "@/lib/desktop-code";
import {
  desktopExplorerWindowChannelName,
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
  attachmentId: string,
  directTunnelId: string,
  desktopRouteIdentity: PreferredCodeAttachment["desktopRouteIdentity"] = null,
): Promise<void> {
  await retireAttachmentBestEffort(
    () =>
      desktopRouteIdentity
        ? stopDirectCodeAttachment(directTunnelId, desktopRouteIdentity)
        : Promise.resolve(),
    () => releaseCodeAttachment(attachmentId),
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
  let ownedAttachmentId: string | null = null;
  let ownedDesktopRouteIdentity: PreferredCodeAttachment["desktopRouteIdentity"] =
    null;
  let ownedDirectTunnelId: string | null = null;
  let releasedDesktopRouteIdentity: PreferredCodeAttachment["desktopRouteIdentity"] =
    null;
  let releasePromise: Promise<void> | null = null;
  let preparedAtMs: number | null = null;
  let configuredAtMs: number | null = null;
  let configuredWorkbenchNonce: string | null = null;
  let editorError: string | null = null;
  let editorErrorStage: CodeWorkbenchStage = "endpoint";
  let expectedWorkbenchNonce: string | null = null;
  let activeWorkbenchNonce: string | null = null;
  let presentationNonce: string | null = null;
  let hasFileTarget = configureInitialFile;
  let navigationRevision = 0;
  let navigationController: AbortController | null = null;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryPromise: Promise<void> | null = null;
  const workbenchWaiters = new Set<{
    reject(error: Error): void;
    resolve(nonce: string): void;
  }>();

  const send = (response: DesktopExplorerWindowResponse) => {
    if (!disposed) channel.postMessage(response);
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
  const releaseOwnedEditor = (): Promise<void> => {
    if (!ownedAttachmentId || !ownedDirectTunnelId) {
      return Promise.resolve();
    }
    if (!releasePromise) {
      releasedDesktopRouteIdentity = ownedDesktopRouteIdentity;
      releasePromise = releasePreparedEditor(
        ownedAttachmentId,
        ownedDirectTunnelId,
        ownedDesktopRouteIdentity,
      );
    } else if (
      ownedDesktopRouteIdentity &&
      ownedDesktopRouteIdentity !== releasedDesktopRouteIdentity
    ) {
      const identity = ownedDesktopRouteIdentity;
      releasedDesktopRouteIdentity = identity;
      releasePromise = releasePromise.then(() =>
        stopDirectCodeAttachment(ownedDirectTunnelId, identity),
      );
    }
    return releasePromise;
  };
  let endpointGeneration = 0;
  let editorPromise: Promise<PreparedEditorAttachment>;
  const prepareEditor = (): Promise<PreparedEditorAttachment> => {
    const generation = ++endpointGeneration;
    const raw = (async (): Promise<PreparedEditorAttachment> => {
      preparationController.signal.throwIfAborted();
      const wire = await createProtectedExplorerCodeAttachment(
        context.explorer.id,
        hasFileTarget ? context.path : null,
        context.explorer.activeWorkerId,
        context.explorer.worktreeId,
        context.appearance,
      );
      if (generation !== endpointGeneration) {
        await releasePreparedEditor(wire.attachmentId, wire.tunnelId);
        throw new DOMException(
          "Explorer Code endpoint was superseded.",
          "AbortError",
        );
      }
      ownedAttachmentId = wire.attachmentId;
      ownedDirectTunnelId = wire.tunnelId;
      preparationController.signal.throwIfAborted();
      const preferred = await preferProtectedCodeAttachment(wire, {
        signal: preparationController.signal,
      });
      ownedDesktopRouteIdentity = preferred.desktopRouteIdentity;
      preparationController.signal.throwIfAborted();
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
        preparedAtMs = Date.now();
        const checkHealth = async () => {
          if (
            disposed ||
            generation !== endpointGeneration ||
            !result.directTunnelId
          ) {
            return;
          }
          const recovery = await recoverPreferredCodeAttachmentRoute(result, {
            signal: preparationController.signal,
          }).catch(() => "recovering" as const);
          if (disposed || generation !== endpointGeneration) return;
          if (recovery === "replace-required") {
            void recoverEditorAttachment(
              new Error("The protected editor route was replaced."),
            ).catch((recoveryError: unknown) =>
              reportEditorError(recoveryError, "endpoint"),
            );
            return;
          }
          healthTimer = setTimeout(checkHealth, 5_000);
        };
        if (result.directTunnelId) {
          healthTimer = setTimeout(checkHealth, 5_000);
        }
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
    return navigate.catch((error: unknown) => {
      if (controller.signal.aborted && !preparationController.signal.aborted) {
        return;
      }
      reportEditorError(error, path === null ? "presentation" : "file");
      throw error;
    });
  };

  const openFile = (path: string, requestedAtMs = Date.now()) => {
    preparationController.signal.throwIfAborted();
    hasFileTarget = true;
    context = { ...context, path, requestedAtMs };
    configuredAtMs = null;
    configuredWorkbenchNonce = null;
    editorError = null;
    send({ context, launchId, type: "launch.ready" });
    return scheduleConfiguration(path, requestedAtMs);
  };
  const recoverEditorAttachment = (reason: unknown): Promise<void> => {
    if (disposed || preparationController.signal.aborted) {
      return Promise.resolve();
    }
    if (recoveryPromise) return recoveryPromise;
    const failure = codeWorkbenchStageError("endpoint", reason);
    reportEditorError(failure, "endpoint");
    navigationController?.abort(
      new DOMException("Explorer Code attachment is recovering.", "AbortError"),
    );
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = null;
    activeWorkbenchNonce = null;
    expectedWorkbenchNonce = null;
    presentationNonce = null;
    configuredAtMs = null;
    configuredWorkbenchNonce = null;
    prepared = null;
    const staleAttachmentId = ownedAttachmentId;
    const staleDesktopRouteIdentity = ownedDesktopRouteIdentity;
    const staleDirectTunnelId = ownedDirectTunnelId;
    const replacement = (async () => {
      await releaseOwnedEditor();
      preparationController.signal.throwIfAborted();
      if (ownedAttachmentId === staleAttachmentId) ownedAttachmentId = null;
      if (ownedDesktopRouteIdentity === staleDesktopRouteIdentity) {
        ownedDesktopRouteIdentity = null;
      }
      if (ownedDirectTunnelId === staleDirectTunnelId) {
        ownedDirectTunnelId = null;
      }
      releasePromise = null;
      releasedDesktopRouteIdentity = null;
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
  const ready = configureInitialFile
    ? openFile(context.path, context.requestedAtMs)
    : scheduleConfiguration(null, context.requestedAtMs);
  void ready.catch(async (error: unknown) => {
    reportEditorError(error, configureInitialFile ? "file" : "presentation");
    await releaseOwnedEditor();
  });

  const dispose = (): Promise<void> => {
    if (!disposed) {
      disposed = true;
      navigationController?.abort(
        new DOMException("Explorer editor closed.", "AbortError"),
      );
      preparationController.abort(options.signal?.reason);
      if (healthTimer) clearTimeout(healthTimer);
      healthTimer = null;
      options.signal?.removeEventListener("abort", abortFromOwner);
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
