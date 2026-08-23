import type { CodeAppearance, CodeAttachment } from "@cantrip/protocol";
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
  createExplorerCodeAttachment,
  openCodeAttachmentFile,
  releaseCodeAttachment,
} from "@/lib/api";
import {
  preferDirectCodeAttachment,
  stopDirectCodeAttachment,
} from "@/lib/desktop-code";
import { errorMessage } from "@/lib/error-message";

const EDITOR_ROUTE_RETRY_DELAYS_MS = [150, 350, 750, 1_500] as const;

export function isUnregisteredEditorRouteError(error: unknown): boolean {
  return (
    error instanceof CantripApiError &&
    error.status === 404 &&
    error.message === "Not Found"
  );
}

export async function createEditorAttachmentWithRouteRetry<T>(
  create: () => Promise<T>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await create();
    } catch (error) {
      if (!isUnregisteredEditorRouteError(error)) throw error;
      const delayMs = EDITOR_ROUTE_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        throw new CantripApiError(
          "The connected Cantrip Server has not loaded Explorer editor support. Restart Cantrip, then retry.",
          503,
        );
      }
      await wait(delayMs);
    }
  }
}

export function ExplorerCodeEditor({
  appearance,
  explorerId,
  path,
}: {
  appearance: CodeAppearance;
  explorerId: string;
  path: string;
}) {
  const [attachment, setAttachment] = useState<CodeAttachment | null>(null);
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
    let directTunnelId: string | null = null;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    setAttachment(null);
    setError(null);
    setReady(false);

    const connect = async () => {
      try {
        const relay = await createEditorAttachmentWithRouteRetry(() =>
          createExplorerCodeAttachment(explorerId, path, appearance),
        );
        attachmentId = relay.attachmentId;
        const preferred = await preferDirectCodeAttachment(relay).catch(() => ({
          attachment: relay,
          directTunnelId: null,
        }));
        directTunnelId = preferred.directTunnelId;
        if (cancelled) {
          await stopDirectCodeAttachment(directTunnelId);
          await releaseCodeAttachment(relay.attachmentId).catch(
            () => undefined,
          );
          return;
        }
        setAttachment(preferred.attachment);
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
      if (attachmentId) {
        void releaseCodeAttachment(attachmentId).catch(() => undefined);
      }
    };
  }, [appearance, explorerId, path, reloadVersion]);

  useEffect(() => {
    if (!attachment) return;
    let cancelled = false;
    void openCodeAttachmentFile(attachment.attachmentId, path)
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
  }, [attachment, path]);

  useEffect(() => {
    if (!attachment) return;
    const attachmentOrigin = new URL(attachment.url).origin;
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
  }, [attachment, reload]);

  return (
    <section
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-slot="explorer-code-editor"
    >
      {attachment ? (
        <iframe
          allow="clipboard-read; clipboard-write"
          className={codeWorkbenchFrameClassName(ready)}
          ref={frameRef}
          src={attachment.url}
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
