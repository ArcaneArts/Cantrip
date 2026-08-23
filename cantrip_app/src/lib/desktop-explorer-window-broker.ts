import type { CodeAttachment } from "@cantrip/protocol";

import {
  createCodeAttachment,
  createCodeTab,
  createExplorerCodeAttachment,
  deleteCodeTab,
  getExplorerFile,
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

interface PreparedEditorAttachment {
  attachment: CodeAttachment;
  compatibilityCodeTabId: string | null;
  directTunnelId: string | null;
}

export interface DesktopExplorerWindowBroker {
  dispose(): Promise<void>;
  launchId: string;
}

async function releasePreparedEditor(
  prepared: PreparedEditorAttachment,
): Promise<void> {
  await stopDirectCodeAttachment(prepared.directTunnelId);
  if (prepared.compatibilityCodeTabId) {
    await deleteCodeTab(prepared.compatibilityCodeTabId).catch(() => undefined);
    return;
  }
  await releaseCodeAttachment(prepared.attachment.attachmentId).catch(
    () => undefined,
  );
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
      const codeTab = await createCodeTab(
        context.explorer.projectId,
        INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE,
        context.explorer.worktreeId,
      );
      compatibilityCodeTabId = codeTab.id;
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
    if (directTunnelId) {
      await setDirectCodeAttachmentPresentation(attachment, "editor");
      await openDirectCodeAttachmentFile(attachment, context.path);
    } else {
      await openCodeAttachmentFile(attachment.attachmentId, context.path);
    }
    return { attachment, compatibilityCodeTabId, directTunnelId };
  } catch (error) {
    if (directTunnelId) await stopDirectCodeAttachment(directTunnelId);
    if (compatibilityCodeTabId) {
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
): DesktopExplorerWindowBroker {
  const launchId = crypto.randomUUID();
  const context: DesktopExplorerWindowContext = {
    ...input,
    requestedAtMs: Date.now(),
  };
  const channel = new BroadcastChannel(
    desktopExplorerWindowChannelName(launchId),
  );
  let disposed = false;
  let prepared: PreparedEditorAttachment | null = null;
  let editorError: string | null = null;

  const send = (response: DesktopExplorerWindowResponse) => {
    if (!disposed) channel.postMessage(response);
  };
  const editorPromise = prepareEditorAttachment(context)
    .then((result) => {
      prepared = result;
      send({
        attachment: result.attachment,
        launchId,
        preparedAtMs: Date.now(),
        type: "editor.ready",
      });
      return result;
    })
    .catch((error: unknown) => {
      editorError = errorMessage(
        error,
        "Cantrip Code could not open this file.",
      );
      send({ error: editorError, launchId, type: "editor.failed" });
      return null;
    });

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
          preparedAtMs: Date.now(),
          type: "editor.ready",
        });
      } else if (editorError) {
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
    async dispose() {
      if (disposed) return;
      disposed = true;
      channel.close();
      const result = prepared ?? (await editorPromise);
      if (result) await releasePreparedEditor(result);
    },
  };
}
