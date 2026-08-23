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
  createProtectedExplorerCodeAttachment,
  releaseCodeAttachment,
} from "@/lib/api";
import {
  openDirectCodeAttachmentFile,
  preferProtectedCodeAttachment,
  setDirectCodeAttachmentPresentation,
  stopDirectCodeAttachment,
  type PreferredCodeAttachment,
} from "@/lib/desktop-code";
import { errorMessage } from "@/lib/error-message";

export function ExplorerCodeEditor({
  appearance,
  explorerId,
  path,
  workerId,
}: {
  appearance: CodeAppearance;
  explorerId: string;
  path: string;
  workerId: string;
}) {
  const [preferredAttachment, setPreferredAttachment] =
    useState<PreferredCodeAttachment | null>(null);
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

    setPreferredAttachment(null);
    setError(null);
    setReady(false);

    const connect = async () => {
      try {
        const wire = await createProtectedExplorerCodeAttachment(
          explorerId,
          path,
          workerId,
          appearance,
        );
        attachmentId = wire.attachmentId;
        const preferred = await preferProtectedCodeAttachment(wire);
        directTunnelId = preferred.directTunnelId;
        if (cancelled) {
          await stopDirectCodeAttachment(directTunnelId);
          await releaseCodeAttachment(wire.attachmentId).catch(() => undefined);
          return;
        }
        setPreferredAttachment(preferred);
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
  }, [appearance, explorerId, path, reloadVersion, workerId]);

  useEffect(() => {
    if (!preferredAttachment) return;
    let cancelled = false;
    const preparePresentation = setDirectCodeAttachmentPresentation(
      preferredAttachment.attachment,
      "editor",
    );
    void preparePresentation
      .then(() =>
        openDirectCodeAttachmentFile(preferredAttachment.attachment, path),
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
