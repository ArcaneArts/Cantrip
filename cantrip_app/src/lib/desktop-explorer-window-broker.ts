import type { CodeAttachment } from "@cantrip/protocol";

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
  setDirectCodeAttachmentPresentation,
  stopDirectCodeAttachment,
} from "@/lib/desktop-code";
import {
  desktopExplorerWindowChannelName,
  isDesktopExplorerWindowRequest,
  type DesktopExplorerWindowContext,
  type DesktopExplorerWindowResponse,
} from "@/lib/desktop-explorer-window-protocol";
import { errorMessage } from "@/lib/error-message";

interface PreparedEditorAttachment {
  attachment: CodeAttachment;
  directTunnelId: string | null;
}

export interface DesktopExplorerWindowBroker {
  dispose(): Promise<void>;
  readonly failed: boolean;
  launchId: string;
  openFile(path: string, requestedAtMs?: number): Promise<void>;
  ready: Promise<void>;
}

export interface DesktopExplorerWindowBrokerOptions {
  configureInitialFile?: boolean;
  requireDirectBridge?: boolean;
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
): Promise<void> {
  await Promise.allSettled([
    stopDirectCodeAttachment(directTunnelId),
    releaseCodeAttachment(attachmentId),
  ]);
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
  let ownedDirectTunnelId: string | null = null;
  let releasePromise: Promise<void> | null = null;
  let preparedAtMs: number | null = null;
  let configuredAtMs: number | null = null;
  let editorError: string | null = null;
  let frameLoaded = false;
  let resolveFrameLoaded!: () => void;
  const frameLoadedPromise = new Promise<void>((resolve) => {
    resolveFrameLoaded = resolve;
  });

  const send = (response: DesktopExplorerWindowResponse) => {
    if (!disposed) channel.postMessage(response);
  };
  const reportEditorError = (error: unknown) => {
    if (disposed || preparationController.signal.aborted) return;
    const message = errorMessage(
      error,
      "Cantrip Code could not open this file.",
    );
    if (message === editorError) return;
    editorError = message;
    send({ error: message, launchId, type: "editor.failed" });
  };
  const releaseOwnedEditor = (): Promise<void> => {
    if (!ownedAttachmentId || !ownedDirectTunnelId) {
      return Promise.resolve();
    }
    releasePromise ??= releasePreparedEditor(
      ownedAttachmentId,
      ownedDirectTunnelId,
    );
    return releasePromise;
  };
  const rawEditorPromise = (async (): Promise<PreparedEditorAttachment> => {
    preparationController.signal.throwIfAborted();
    const wire = await createProtectedExplorerCodeAttachment(
      context.explorer.id,
      configureInitialFile ? context.path : null,
      context.explorer.activeWorkerId,
      context.explorer.worktreeId,
      context.appearance,
    );
    ownedAttachmentId = wire.attachmentId;
    ownedDirectTunnelId = wire.tunnelId;
    preparationController.signal.throwIfAborted();
    const preferred = await preferProtectedCodeAttachment(wire, {
      signal: preparationController.signal,
    });
    preparationController.signal.throwIfAborted();
    return {
      attachment: preferred.attachment,
      directTunnelId: wire.tunnelId,
    };
  })().catch(async (error: unknown) => {
    await releaseOwnedEditor();
    throw error;
  });
  const editorPromise = waitForAbortable(
    rawEditorPromise,
    preparationController.signal,
  )
    .then((result) => {
      preparationController.signal.throwIfAborted();
      prepared = result;
      preparedAtMs = Date.now();
      send({
        attachment: result.attachment,
        launchId,
        preparedAtMs,
        type: "editor.ready",
      });
      return result;
    })
    .catch((error: unknown) => {
      if (preparationController.signal.aborted) throw error;
      reportEditorError(error);
      return null;
    });
  const bridgeReady = editorPromise.then(async (result) => {
    if (!result) throw new Error(editorError ?? "Cantrip Code is unavailable.");
    await waitForAbortable(frameLoadedPromise, preparationController.signal);
    await retryEditorControl(
      () =>
        setDirectCodeAttachmentPresentation(result.attachment, "editor", {
          signal: preparationController.signal,
        }),
      preparationController.signal,
    );
    return result;
  });
  let navigationQueue = Promise.resolve();
  const openFile = (path: string, requestedAtMs = Date.now()) => {
    const navigate = navigationQueue.then(async () => {
      preparationController.signal.throwIfAborted();
      const result = await bridgeReady;
      preparationController.signal.throwIfAborted();
      context = { ...context, path, requestedAtMs };
      configuredAtMs = null;
      editorError = null;
      send({ context, launchId, type: "launch.ready" });
      await retryEditorControl(
        () =>
          openDirectCodeAttachmentFile(result.attachment, path, {
            signal: preparationController.signal,
          }),
        preparationController.signal,
      );
      preparationController.signal.throwIfAborted();
      configuredAtMs = Date.now();
      send({ configuredAtMs, launchId, type: "editor.configured" });
    });
    navigationQueue = navigate.catch(() => undefined);
    return navigate.catch((error: unknown) => {
      reportEditorError(error);
      throw error;
    });
  };
  const ready = configureInitialFile
    ? openFile(context.path, context.requestedAtMs)
    : bridgeReady.then(() => undefined);
  void ready.catch((error: unknown) => reportEditorError(error));

  const dispose = (): Promise<void> => {
    if (!disposed) {
      disposed = true;
      preparationController.abort(options.signal?.reason);
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
          type: "editor.ready",
        });
      }
      if (configuredAtMs !== null) {
        send({ configuredAtMs, launchId, type: "editor.configured" });
      }
      if (editorError) {
        send({ error: editorError, launchId, type: "editor.failed" });
      }
      return;
    }
    if (request.type === "editor.frame-loaded") {
      if (!frameLoaded) {
        frameLoaded = true;
        resolveFrameLoaded();
      }
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
