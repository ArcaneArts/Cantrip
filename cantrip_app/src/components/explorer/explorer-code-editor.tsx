import type {
  CodeAppearance,
  CodeProtectedAttachmentWire,
} from "@cantrip/protocol";
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
import { SerialTaskQueue } from "@/lib/serial-task-queue";
import {
  retireAttachmentBestEffort,
  SerializedAttachmentLifecycle,
} from "@/lib/serialized-attachment-lifecycle";

const FILE_OPEN_RETRY_DELAY_MS = 250;
const FILE_OPEN_RECONNECT_LIMIT = 1;

function shouldRetryFileOpen(error: unknown): boolean {
  return /(?:failed to fetch|load failed|network|not connected|unavailable)/iu.test(
    errorMessage(error, ""),
  );
}

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
  const automaticReconnectsRef = useRef(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const navigationQueueRef = useRef(new SerialTaskQueue());
  const attachmentLifecycleRef =
    useRef<SerializedAttachmentLifecycle<CodeProtectedAttachmentWire> | null>(
      null,
    );
  attachmentLifecycleRef.current ??=
    new SerializedAttachmentLifecycle<CodeProtectedAttachmentWire>((wire) =>
      retireAttachmentBestEffort(
        () => stopDirectCodeAttachment(wire.tunnelId),
        () => releaseCodeAttachment(wire.attachmentId),
      ),
    );
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    setPreferredAttachment(null);
    setError(null);
    setReady(false);

    const connect = async () => {
      try {
        const preferred = await attachmentLifecycleRef.current!.replace(
          () =>
            createProtectedExplorerCodeAttachment(
              explorerId,
              pathRef.current,
              workerId,
              appearance,
            ),
          (wire, signal) =>
            preferProtectedCodeAttachment(wire, {
              signal,
            }),
        );
        if (!cancelled && preferred) setPreferredAttachment(preferred);
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

    startTimer = setTimeout(() => {
      void connect();
    }, 0);
    return () => {
      cancelled = true;
      if (startTimer) clearTimeout(startTimer);
      void attachmentLifecycleRef.current!.retire(
        "Explorer Code connection superseded.",
      );
    };
  }, [appearance, explorerId, reloadVersion, workerId]);

  useEffect(() => {
    automaticReconnectsRef.current = 0;
  }, [path]);

  useEffect(() => {
    if (!preferredAttachment) return;
    const navigationController = new AbortController();
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    setReady(false);
    const openFile = async (attempt: number) => {
      try {
        await setDirectCodeAttachmentPresentation(
          preferredAttachment.attachment,
          "editor",
          { signal: navigationController.signal },
        );
        const result = await openDirectCodeAttachmentFile(
          preferredAttachment.attachment,
          path,
          { signal: navigationController.signal },
        );
        if (!cancelled && result.relativePath === path) {
          automaticReconnectsRef.current = 0;
          setError(null);
          setReady(true);
        }
      } catch (openError) {
        if (cancelled) return;
        if (attempt === 0 && shouldRetryFileOpen(openError)) {
          retryTimer = setTimeout(
            () => void openFile(attempt + 1),
            FILE_OPEN_RETRY_DELAY_MS,
          );
          return;
        }
        if (
          shouldRetryFileOpen(openError) &&
          automaticReconnectsRef.current < FILE_OPEN_RECONNECT_LIMIT
        ) {
          automaticReconnectsRef.current += 1;
          reload();
          return;
        }
        setError(
          errorMessage(openError, "Cantrip Code could not open this file."),
        );
      }
    };
    void navigationQueueRef.current.run(async () => {
      if (!cancelled) await openFile(0);
    });
    return () => {
      cancelled = true;
      navigationController.abort(
        new DOMException("Explorer Code navigation superseded.", "AbortError"),
      );
      if (retryTimer) clearTimeout(retryTimer);
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
