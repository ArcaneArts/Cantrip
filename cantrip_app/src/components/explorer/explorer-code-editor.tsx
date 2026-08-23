import type { CodeAppearance } from "@cantrip/protocol";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  codeWorkbenchFrameClassName,
  isCodeAttachmentUnavailableMessage,
  isDarkCodeAppearance,
} from "@/components/code/code-view";
import { Button } from "@/components/ui/button";
import {
  CantripApiError,
  createCodeAttachment,
  createCodeTab,
  createExplorerCodeAttachment,
  deleteCodeTab,
  openCodeAttachmentFile,
  releaseCodeAttachment,
} from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import { INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE } from "@/lib/code-tab-visibility";
import {
  openDirectCodeAttachmentFile,
  preferDirectCodeAttachment,
  setDirectCodeAttachmentPresentation,
  stopDirectCodeAttachment,
  type PreferredCodeAttachment,
} from "@/lib/desktop-code";
import { errorMessage } from "@/lib/error-message";

export function isUnregisteredEditorRouteError(error: unknown): boolean {
  return (
    error instanceof CantripApiError &&
    error.status === 404 &&
    error.message === "Not Found"
  );
}

export async function createEditorAttachmentWithCompatibilityFallback<T>(
  create: () => Promise<T>,
  createCompatibilityAttachment: () => Promise<T>,
): Promise<{ attachment: T; compatibilityFallback: boolean }> {
  try {
    return { attachment: await create(), compatibilityFallback: false };
  } catch (error) {
    if (!isUnregisteredEditorRouteError(error)) throw error;
    return {
      attachment: await createCompatibilityAttachment(),
      compatibilityFallback: true,
    };
  }
}

interface ExplorerPreferredCodeAttachment extends PreferredCodeAttachment {
  compatibilityFallback: boolean;
}

export function ExplorerCodeEditor({
  appearance,
  explorerId,
  path,
  projectId,
  worktreeId,
}: {
  appearance: CodeAppearance;
  explorerId: string;
  path: string;
  projectId: string;
  worktreeId: string;
}) {
  const [preferredAttachment, setPreferredAttachment] =
    useState<ExplorerPreferredCodeAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const reload = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attachmentId: string | null = null;
    let compatibilityCodeTabId: string | null = null;
    let directTunnelId: string | null = null;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    setPreferredAttachment(null);
    setError(null);
    setReady(false);

    const connect = async () => {
      try {
        const result = await createEditorAttachmentWithCompatibilityFallback(
          () => createExplorerCodeAttachment(explorerId, path, appearance),
          async () => {
            // Explorer-only attachments were added after ordinary Code
            // attachments. Keep newer desktop clients usable while a selected
            // hosted server is still rolling forward, then remove the
            // compatibility tab with the popout.
            const codeTab = await createCodeTab(
              projectId,
              INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE,
              worktreeId,
            );
            compatibilityCodeTabId = codeTab.id;
            try {
              return await createCodeAttachment(codeTab.id, appearance);
            } catch (error) {
              compatibilityCodeTabId = null;
              await deleteCodeTab(codeTab.id).catch(() => undefined);
              throw error;
            }
          },
        );
        const relay = result.attachment;
        if (result.compatibilityFallback) {
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
        attachmentId = relay.attachmentId;
        const preferred = await preferDirectCodeAttachment(relay).catch(() => ({
          attachment: relay,
          directTunnelId: null,
        }));
        directTunnelId = preferred.directTunnelId;
        if (cancelled) {
          await stopDirectCodeAttachment(directTunnelId);
          if (compatibilityCodeTabId) {
            await deleteCodeTab(compatibilityCodeTabId).catch(() => undefined);
          } else {
            await releaseCodeAttachment(relay.attachmentId).catch(
              () => undefined,
            );
          }
          return;
        }
        setPreferredAttachment({
          ...preferred,
          compatibilityFallback: result.compatibilityFallback,
        });
      } catch (connectError) {
        if (!cancelled) {
          setError(
            errorMessage(
              connectError,
              "Cantrip Code could not open this file.",
            ),
          );
        }
      }
    };

    startTimer = setTimeout(() => void connect(), 0);
    return () => {
      cancelled = true;
      if (startTimer) clearTimeout(startTimer);
      void stopDirectCodeAttachment(directTunnelId);
      if (compatibilityCodeTabId) {
        void deleteCodeTab(compatibilityCodeTabId).catch(() => undefined);
      } else if (attachmentId) {
        void releaseCodeAttachment(attachmentId).catch(() => undefined);
      }
    };
  }, [appearance, explorerId, path, projectId, reloadVersion, worktreeId]);

  useEffect(() => {
    if (!preferredAttachment) return;
    let cancelled = false;
    const preparePresentation = preferredAttachment.compatibilityFallback
      ? preferredAttachment.directTunnelId
        ? setDirectCodeAttachmentPresentation(
            preferredAttachment.attachment,
            "editor",
          )
        : Promise.reject(
            new Error(
              "This server is too old to open an Explorer editor without a desktop worker tunnel.",
            ),
          )
      : Promise.resolve();
    void preparePresentation
      .then(() =>
        preferredAttachment.directTunnelId
          ? openDirectCodeAttachmentFile(preferredAttachment.attachment, path)
          : openCodeAttachmentFile(
              preferredAttachment.attachment.attachmentId,
              path,
            ),
      )
      .then((result) => {
        if (!cancelled && result.relativePath === path) {
          setError(null);
          setReady(true);
        }
      })
      .catch((openError: unknown) => {
        if (!cancelled) {
          setError(
            errorMessage(openError, "Cantrip Code could not open this file."),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, preferredAttachment]);

  useEffect(() => {
    if (!preferredAttachment) return;
    const attachmentOrigin = new URL(preferredAttachment.attachment.url).origin;
    const recover = (event: MessageEvent<unknown>) => {
      if (
        event.origin === attachmentOrigin &&
        event.source === frameRef.current?.contentWindow &&
        isCodeAttachmentUnavailableMessage(event.data)
      ) {
        reload();
      }
    };
    window.addEventListener("message", recover);
    return () => window.removeEventListener("message", recover);
  }, [preferredAttachment, reload]);

  return (
    <section
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-slot="explorer-code-editor"
    >
      {preferredAttachment ? (
        <iframe
          allow="clipboard-read; clipboard-write"
          className={codeWorkbenchFrameClassName(ready)}
          ref={frameRef}
          src={preferredAttachment.attachment.url}
          title={`Cantrip Code — ${path}`}
        />
      ) : null}

      {!ready ? (
        <div
          className="absolute inset-0 grid place-items-center bg-background p-6"
          data-code-editor-cover={
            isDarkCodeAppearance(appearance) ? "dark" : "light"
          }
        >
          {error ? (
            <div className="flex max-w-lg flex-col items-center gap-4 text-center">
              <AlertTriangle className="size-5 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
              <Button onClick={reload} size="sm" variant="outline">
                <RefreshCw className="size-4" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Opening in Cantrip Code…
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
