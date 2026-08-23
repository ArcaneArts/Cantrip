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
}

const editorControlRetryDelaysMs = [250, 750] as const;

function isTransientEditorControlError(error: unknown): boolean {
  return /(?:failed to fetch|load failed|network|not connected|unavailable)/iu.test(
    errorMessage(error, ""),
  );
}

async function retryEditorControl<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryDelayMs = editorControlRetryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isTransientEditorControlError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function releasePreparedEditor(
  prepared: PreparedEditorAttachment,
): Promise<void> {
  await Promise.allSettled([
    stopDirectCodeAttachment(prepared.directTunnelId),
    releaseCodeAttachment(prepared.attachment.attachmentId),
  ]);
}

async function prepareEditorAttachment(
  context: DesktopExplorerWindowContext,
): Promise<PreparedEditorAttachment> {
  const wire = await createProtectedExplorerCodeAttachment(
    context.explorer.id,
    context.path,
    context.explorer.activeWorkerId,
    context.appearance,
  );
  try {
    const preferred = await preferProtectedCodeAttachment(wire);
    return {
      attachment: preferred.attachment,
      directTunnelId: wire.tunnelId,
    };
  } catch (error) {
    await stopDirectCodeAttachment(wire.tunnelId);
    await releaseCodeAttachment(wire.attachmentId).catch(() => undefined);
    throw error;
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
  let disposed = false;
  let prepared: PreparedEditorAttachment | null = null;
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
    const message = errorMessage(
      error,
      "Cantrip Code could not open this file.",
    );
    if (message === editorError) return;
    editorError = message;
    send({ error: message, launchId, type: "editor.failed" });
  };
  const editorPromise = prepareEditorAttachment(context)
    .then((result) => {
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
      reportEditorError(error);
      return null;
    });
  const bridgeReady = editorPromise.then(async (result) => {
    if (!result) throw new Error(editorError ?? "Cantrip Code is unavailable.");
    await frameLoadedPromise;
    await retryEditorControl(() =>
      setDirectCodeAttachmentPresentation(result.attachment, "editor"),
    );
    return result;
  });
  let navigationQueue = Promise.resolve();
  const openFile = (path: string, requestedAtMs = Date.now()) => {
    const navigate = navigationQueue.then(async () => {
      const result = await bridgeReady;
      context = { ...context, path, requestedAtMs };
      configuredAtMs = null;
      editorError = null;
      send({ context, launchId, type: "launch.ready" });
      await retryEditorControl(() =>
        openDirectCodeAttachmentFile(result.attachment, path),
      );
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
    async dispose() {
      if (disposed) return;
      disposed = true;
      channel.close();
      const result = prepared ?? (await editorPromise);
      if (result) await releasePreparedEditor(result);
    },
  };
}
