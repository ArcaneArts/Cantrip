import type { CodeAttachment } from "@cantrip/protocol";

import {
  createCodeAttachment,
  createCodeTab,
  createExplorerCodeAttachment,
  deleteCodeTab,
  getExplorerFile,
  getInternalExplorerEditorCodeTabs,
  loadExplorerMedia,
  openCodeAttachmentFile,
  releaseCodeAttachment,
  saveExplorerFile,
} from "@/lib/api";
import { CantripApiError } from "@/lib/api-client";
import { clientLogger } from "@/lib/client-log-relay";
import { INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE } from "@/lib/code-tab-visibility";
import {
  openDirectCodeAttachmentFile,
  preferDirectCodeAttachment,
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
import {
  isActiveExplorerEditorCodeTab,
  registerActiveExplorerEditorCodeTab,
  unregisterActiveExplorerEditorCodeTab,
} from "@/lib/explorer-editor-session-registry";

interface PreparedEditorAttachment {
  attachment: CodeAttachment;
  compatibilityCodeTabId: string | null;
  directTunnelId: string | null;
}

export interface DesktopExplorerWindowBroker {
  dispose(): Promise<void>;
  launchId: string;
  openFile(path: string, requestedAtMs?: number): Promise<void>;
  ready: Promise<void>;
}

export interface DesktopExplorerWindowBrokerOptions {
  configureInitialFile?: boolean;
  requireDirectBridge?: boolean;
}

async function releasePreparedEditor(
  prepared: PreparedEditorAttachment,
): Promise<void> {
  if (prepared.compatibilityCodeTabId) {
    unregisterActiveExplorerEditorCodeTab(prepared.compatibilityCodeTabId);
  }
  await Promise.allSettled([
    stopDirectCodeAttachment(prepared.directTunnelId),
    prepared.compatibilityCodeTabId
      ? deleteCodeTab(prepared.compatibilityCodeTabId)
      : releaseCodeAttachment(prepared.attachment.attachmentId),
  ]);
}

async function removeStaleEditorCodeTabs(projectId: string): Promise<void> {
  const staleTabs = (await getInternalExplorerEditorCodeTabs(projectId)).filter(
    (codeTab) => !isActiveExplorerEditorCodeTab(codeTab.id),
  );
  if (staleTabs.length === 0) return;
  void Promise.allSettled(
    staleTabs.map((codeTab) => deleteCodeTab(codeTab.id)),
  ).then((results) => {
    const failed = results.filter((result) => result.status === "rejected");
    clientLogger.warn("Stale Explorer editor session cleanup finished", {
      counts: { failed: failed.length, sessions: staleTabs.length },
      event: "surface.explorer.editor.stale-sessions-removed",
      operation: "recover-editor-sessions",
      reasonCode: "orphaned-editor-window",
      status: failed.length === 0 ? "completed" : "degraded",
      subsystem: "explorer",
    });
  });
}

async function prepareEditorAttachment(
  context: DesktopExplorerWindowContext,
): Promise<PreparedEditorAttachment> {
  let attachment: CodeAttachment | null = null;
  let compatibilityCodeTabId: string | null = null;
  let directTunnelId: string | null = null;
  try {
    try {
      attachment = await createExplorerCodeAttachment(
        context.explorer.id,
        context.path,
        context.appearance,
      );
    } catch (error) {
      if (
        !(error instanceof CantripApiError) ||
        error.status !== 404 ||
        error.message !== "Not Found"
      ) {
        throw error;
      }
      await removeStaleEditorCodeTabs(context.explorer.projectId);
      const codeTab = await createCodeTab(
        context.explorer.projectId,
        INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE,
        context.explorer.worktreeId,
      );
      compatibilityCodeTabId = codeTab.id;
      registerActiveExplorerEditorCodeTab(codeTab.id);
      attachment = await createCodeAttachment(codeTab.id, context.appearance);
      clientLogger.warn(
        "Explorer editor used the legacy server compatibility path",
        {
          event: "surface.explorer.editor.compatibility-fallback",
          operation: "create-code-attachment",
          reasonCode: "server-version-skew",
          status: "completed",
          subsystem: "explorer",
        },
      );
    }
    const preferred = await preferDirectCodeAttachment(attachment);
    attachment = preferred.attachment;
    directTunnelId = preferred.directTunnelId;
    if (compatibilityCodeTabId && !directTunnelId) {
      throw new Error(
        "This server is too old to open an Explorer editor without a desktop worker tunnel.",
      );
    }
    return { attachment, compatibilityCodeTabId, directTunnelId };
  } catch (error) {
    if (directTunnelId) await stopDirectCodeAttachment(directTunnelId);
    if (compatibilityCodeTabId) {
      unregisterActiveExplorerEditorCodeTab(compatibilityCodeTabId);
      await deleteCodeTab(compatibilityCodeTabId).catch(() => undefined);
    } else if (attachment) {
      await releaseCodeAttachment(attachment.attachmentId).catch(
        () => undefined,
      );
    }
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
    if (result.directTunnelId) {
      await setDirectCodeAttachmentPresentation(result.attachment, "editor");
    } else if (options.requireDirectBridge) {
      throw new Error(
        "Cantrip Code could not establish a direct prewarmed editor bridge.",
      );
    }
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
      await (result.directTunnelId
        ? openDirectCodeAttachmentFile(result.attachment, path)
        : openCodeAttachmentFile(result.attachment.attachmentId, path));
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
