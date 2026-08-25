import type {
  CodeAppearance,
  CodeProtectedAttachmentWire,
} from "@cantrip/protocol";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  codeWorkbenchFrameClassName,
  isDarkCodeAppearance,
} from "@/components/code/code-view";
import { Button } from "@/components/ui/button";
import { subscribeBrowserCodeAttachmentUnavailable } from "@/lib/browser-code-tunnel";
import {
  CODE_WORKBENCH_READY_TIMEOUT_MS,
  CodeWorkbenchFrameLoadTracker,
  codeWorkbenchStageError,
  createCodeWorkbenchFrameMount,
  isCodeWorkbenchReadyEvent,
} from "@/lib/code-workbench-frame";
import {
  createProtectedExplorerCodeAttachment,
  releaseCodeAttachment,
} from "@/lib/api";
import {
  CodeControlOperationTimeoutError,
  openDirectCodeAttachmentFile,
  preferProtectedCodeAttachment,
  recoverPreferredCodeAttachmentRoute,
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
const ATTACHMENT_HEALTH_INTERVAL_MS = 5_000;

function isCodeControlOperationTimeout(error: unknown): boolean {
  const visited = new Set<unknown>();
  let candidate = error;
  while (candidate instanceof Error && !visited.has(candidate)) {
    if (candidate instanceof CodeControlOperationTimeoutError) return true;
    visited.add(candidate);
    candidate = candidate.cause;
  }
  return false;
}

function isTransientFileOpenFailure(error: unknown): boolean {
  return /(?:failed to fetch|load failed|network|not connected|unavailable)/iu.test(
    errorMessage(error, ""),
  );
}

export function explorerCodeEditorOpenRecovery(
  error: unknown,
  attempt: number,
  automaticReconnects: number,
): "error" | "recover-route" | "retry" {
  const controlTimeout = isCodeControlOperationTimeout(error);
  const transient = isTransientFileOpenFailure(error);
  if (attempt === 0 && (controlTimeout || transient)) return "retry";
  if (
    (controlTimeout || transient) &&
    automaticReconnects < FILE_OPEN_RECONNECT_LIMIT
  ) {
    return "recover-route";
  }
  return "error";
}

export class ExplorerCodePresentationCache {
  #nonce: string | null = null;

  async ensure(
    nonce: string,
    apply: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.#nonce === nonce) return;
    await apply();
    signal.throwIfAborted();
    this.#nonce = nonce;
  }
}

export async function configureExplorerCodeEditorNavigation<TResult>(options: {
  frameNonce: string;
  openFile(): Promise<TResult>;
  presentation: ExplorerCodePresentationCache;
  setPresentation(): Promise<void>;
  signal: AbortSignal;
}): Promise<TResult> {
  await options.presentation.ensure(
    options.frameNonce,
    options.setPresentation,
    options.signal,
  );
  options.signal.throwIfAborted();
  return options.openFile();
}

export function explorerCodeEditorBindingKey(input: {
  appearance: CodeAppearance;
  explorerId: string;
  reloadVersion: number;
  workerId: string;
  worktreeId: string;
}): string {
  return [
    input.explorerId,
    input.worktreeId,
    input.workerId,
    input.appearance,
    input.reloadVersion,
  ].join("\0");
}

export function explorerCodeEditorReadyKey(
  attachmentId: string,
  path: string,
  bindingKey: string,
): string {
  return `${bindingKey}\0${attachmentId}\0${path}`;
}

export function ExplorerCodeEditor({
  appearance,
  explorerId,
  path,
  worktreeId,
  workerId,
}: {
  appearance: CodeAppearance;
  explorerId: string;
  path: string;
  worktreeId: string;
  workerId: string;
}) {
  const [preferredAttachment, setPreferredAttachment] =
    useState<PreferredCodeAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameFailureNonce, setFrameFailureNonce] = useState<string | null>(
    null,
  );
  const [frameReadyNonce, setFrameReadyNonce] = useState<string | null>(null);
  const [frameDocumentVersion, setFrameDocumentVersion] = useState(0);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const automaticReconnectsRef = useRef(0);
  const frameFailureNonceRef = useRef<string | null>(null);
  const frameLoadsRef = useRef(new CodeWorkbenchFrameLoadTracker());
  const frameRef = useRef<HTMLIFrameElement>(null);
  const navigationQueueRef = useRef(new SerialTaskQueue());
  const presentationRef = useRef(new ExplorerCodePresentationCache());
  const attachmentLifecycleRef =
    useRef<SerializedAttachmentLifecycle<CodeProtectedAttachmentWire> | null>(
      null,
    );
  attachmentLifecycleRef.current ??=
    new SerializedAttachmentLifecycle<CodeProtectedAttachmentWire>((wire) =>
      retireAttachmentBestEffort(
        () => stopDirectCodeAttachment(wire),
        () => releaseCodeAttachment(wire.attachmentId),
      ),
    );
  const pathRef = useRef(path);
  pathRef.current = path;
  const bindingKey = explorerCodeEditorBindingKey({
    appearance,
    explorerId,
    reloadVersion,
    workerId,
    worktreeId,
  });
  const requestedReadyKey = preferredAttachment
    ? explorerCodeEditorReadyKey(
        preferredAttachment.attachment.attachmentId,
        path,
        bindingKey,
      )
    : null;
  const frameMount = useMemo(
    () =>
      preferredAttachment
        ? createCodeWorkbenchFrameMount(preferredAttachment.attachment.url)
        : null,
    [
      preferredAttachment?.attachment.attachmentId,
      preferredAttachment?.attachment.url,
      frameDocumentVersion,
    ],
  );
  const frameReady =
    frameMount !== null && frameReadyNonce === frameMount.nonce;
  const ready =
    frameReady && readyKey !== null && readyKey === requestedReadyKey;

  const reload = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    setPreferredAttachment(null);
    setError(null);
    setFrameFailureNonce(null);
    frameFailureNonceRef.current = null;
    setFrameReadyNonce(null);
    setReadyKey(null);

    const connect = async () => {
      try {
        const preferred = await attachmentLifecycleRef.current!.replace(
          () =>
            createProtectedExplorerCodeAttachment(
              explorerId,
              pathRef.current,
              workerId,
              worktreeId,
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
  }, [appearance, bindingKey, explorerId, workerId, worktreeId]);

  useEffect(() => {
    automaticReconnectsRef.current = 0;
  }, [path]);

  useEffect(() => {
    if (!preferredAttachment?.directTunnelId) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const recovery = await recoverPreferredCodeAttachmentRoute(
        preferredAttachment,
        { signal: controller.signal },
      ).catch(() => "recovering" as const);
      if (cancelled) return;
      if (recovery === "replace-required") {
        reload();
        return;
      }
      timer = setTimeout(check, ATTACHMENT_HEALTH_INTERVAL_MS);
    };
    timer = setTimeout(check, ATTACHMENT_HEALTH_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort(
        new DOMException(
          "Explorer Code health check superseded.",
          "AbortError",
        ),
      );
      if (timer) clearTimeout(timer);
    };
  }, [preferredAttachment, reload]);

  useEffect(() => {
    const tunnelId = preferredAttachment?.directTunnelId;
    if (!tunnelId) return;
    return subscribeBrowserCodeAttachmentUnavailable((event) => {
      if (event.tunnelId === tunnelId) reload();
    });
  }, [preferredAttachment?.directTunnelId, reload]);

  useLayoutEffect(() => {
    setFrameReadyNonce(null);
    if (!frameMount || frameFailureNonce === frameMount.nonce) return;
    if (frameFailureNonceRef.current !== frameMount.nonce) {
      frameFailureNonceRef.current = null;
    }
    let settled = false;
    const receiveReady = (event: MessageEvent<unknown>) => {
      if (
        settled ||
        frameFailureNonceRef.current === frameMount.nonce ||
        !isCodeWorkbenchReadyEvent(
          event,
          frameRef.current?.contentWindow ?? null,
          frameMount,
        )
      ) {
        return;
      }
      settled = true;
      frameFailureNonceRef.current = frameMount.nonce;
      setError(null);
      setFrameReadyNonce(frameMount.nonce);
    };
    window.addEventListener("message", receiveReady);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      setFrameFailureNonce(frameMount.nonce);
      setError(
        codeWorkbenchStageError(
          "workbench",
          "The embedded editor timed out after its endpoint loaded.",
        ).message,
      );
    }, CODE_WORKBENCH_READY_TIMEOUT_MS);
    return () => {
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", receiveReady);
    };
  }, [frameFailureNonce, frameMount]);

  useEffect(() => {
    if (!preferredAttachment || !frameReady || !frameMount) return;
    const navigationController = new AbortController();
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    const navigationReadyKey = explorerCodeEditorReadyKey(
      preferredAttachment.attachment.attachmentId,
      path,
      bindingKey,
    );
    const openFile = async (attempt: number) => {
      try {
        const result = await configureExplorerCodeEditorNavigation({
          frameNonce: frameMount.nonce,
          openFile: async () => {
            try {
              return await openDirectCodeAttachmentFile(
                preferredAttachment.attachment,
                path,
                { signal: navigationController.signal },
              );
            } catch (fileError) {
              throw codeWorkbenchStageError("file", fileError);
            }
          },
          presentation: presentationRef.current,
          setPresentation: async () => {
            try {
              await setDirectCodeAttachmentPresentation(
                preferredAttachment.attachment,
                "editor",
                { signal: navigationController.signal },
              );
            } catch (presentationError) {
              throw codeWorkbenchStageError("presentation", presentationError);
            }
          },
          signal: navigationController.signal,
        });
        if (!cancelled && result.relativePath === path) {
          automaticReconnectsRef.current = 0;
          setError(null);
          setReadyKey(navigationReadyKey);
        } else if (!cancelled) {
          throw codeWorkbenchStageError(
            "file",
            `Worker acknowledged ${result.relativePath} instead of ${path}.`,
          );
        }
      } catch (openError) {
        if (cancelled) return;
        const recovery = explorerCodeEditorOpenRecovery(
          openError,
          attempt,
          automaticReconnectsRef.current,
        );
        if (recovery === "retry") {
          retryTimer = setTimeout(
            () => void openFile(attempt + 1),
            FILE_OPEN_RETRY_DELAY_MS,
          );
          return;
        }
        if (recovery === "recover-route") {
          const routeRecovery = await recoverPreferredCodeAttachmentRoute(
            preferredAttachment,
            { signal: navigationController.signal },
          ).catch(() => "recovering" as const);
          if (cancelled) return;
          if (routeRecovery === "replace-required") {
            automaticReconnectsRef.current += 1;
            reload();
            return;
          }
          automaticReconnectsRef.current += 1;
          retryTimer = setTimeout(
            () => void openFile(attempt + 1),
            routeRecovery === "available" ? FILE_OPEN_RETRY_DELAY_MS : 1_000,
          );
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
  }, [bindingKey, frameMount, frameReady, path, preferredAttachment]);

  return (
    <section
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-slot="explorer-code-editor"
    >
      {preferredAttachment ? (
        <iframe
          key={frameMount?.nonce}
          allow="clipboard-read; clipboard-write"
          aria-hidden={!ready}
          className={codeWorkbenchFrameClassName(ready)}
          onError={() => {
            if (!frameMount) return;
            frameFailureNonceRef.current = frameMount.nonce;
            setFrameFailureNonce(frameMount.nonce);
            setError(
              codeWorkbenchStageError(
                "frame",
                "The embedded editor document could not load.",
              ).message,
            );
          }}
          onLoad={() => {
            if (
              !frameMount ||
              !frameLoadsRef.current.observe(frameMount.nonce)
            ) {
              return;
            }
            setFrameReadyNonce(null);
            setFrameFailureNonce(null);
            frameFailureNonceRef.current = null;
            setReadyKey(null);
            setError(null);
            setFrameDocumentVersion((version) => version + 1);
          }}
          ref={frameRef}
          referrerPolicy="no-referrer"
          src={frameMount?.url}
          tabIndex={ready ? 0 : -1}
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
