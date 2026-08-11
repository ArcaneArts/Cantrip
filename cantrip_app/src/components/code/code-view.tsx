import type {
  CodeAppearance,
  CodeAttachment,
  CodeRuntimeStatus,
  CodeTabStatus,
  CodeTabSummary,
} from "@cantrip/protocol";
import { AlertTriangle, Code2, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { SurfaceLoadingVeil } from "@/components/ui/surface-loading-veil";
import {
  CantripApiError,
  createCodeAttachment,
  getCodeRuntime,
  releaseCodeAttachment,
  saveAllCodeTab,
  setCodeTabTheme,
  stopCodeTab,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

const MAX_RECONNECT_DELAY_MS = 15_000;
const CODE_RUNTIME_POLL_DELAY_MS = 500;
const CODE_FRAME_REVEAL_FALLBACK_MS = 30_000;
const ATTACHMENT_UNAVAILABLE_MESSAGE = "cantrip-code-attachment-unavailable-v1";

export interface CodeHeaderState {
  attachmentExpiresAt: string | null;
  error: string | null;
  isBusy: boolean;
  runtime: CodeRuntimeStatus | null;
  status: CodeTabStatus | CodeRuntimeStatus["status"];
  reload(): void;
  restart(): Promise<void>;
  saveAll(): Promise<void>;
  stop(): Promise<void>;
}

export function codeReconnectDelayMs(attempt: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.max(0, attempt));
}

export function isCodeAttachmentUnavailableMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === ATTACHMENT_UNAVAILABLE_MESSAGE
  );
}

export function isCodeSessionUnavailableError(error: unknown): boolean {
  return (
    error instanceof CantripApiError &&
    error.status >= 500 &&
    /^Cantrip Code session .+ is not open\.$/u.test(error.message)
  );
}

export function isCodeWorkbenchReady(
  runtime: CodeRuntimeStatus,
  sessionId: string,
): boolean {
  return runtime.sessionId === sessionId && runtime.bridgeConnected;
}

function errorText(error: unknown): string {
  return errorMessage(error, "Cantrip Code could not open.");
}

function shouldRetry(error: unknown): boolean {
  return !(error instanceof CantripApiError) || error.status >= 500;
}

export function CodeView({
  appearance,
  codeTab,
  onChanged,
  onHeaderChange,
}: {
  appearance: CodeAppearance;
  codeTab: CodeTabSummary;
  onChanged?(): void;
  onHeaderChange?(state: CodeHeaderState | null): void;
}) {
  const [attachment, setAttachment] = useState<CodeAttachment | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameReadyToReveal, setFrameReadyToReveal] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const appearanceRef = useRef(appearance);
  const connectionGeneration = useRef(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stopped = useRef(false);
  const onChangedRef = useRef(onChanged);

  appearanceRef.current = appearance;
  onChangedRef.current = onChanged;

  const reload = useCallback(() => {
    stopped.current = false;
    setReloadVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    const generation = ++connectionGeneration.current;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let ownedAttachmentId: string | null = null;
    stopped.current = false;
    setAttachment(null);
    setActionError(null);
    setActionMessage(null);
    setBackgroundError(null);
    setConnectAttempt(0);
    setConnectError(null);
    setConnecting(false);
    setRetrying(false);
    setFrameLoaded(false);
    setFrameReadyToReveal(false);

    const connect = async (attempt: number) => {
      if (cancelled || stopped.current) return;
      setConnecting(true);
      setConnectAttempt(attempt);
      try {
        const next = await createCodeAttachment(
          codeTab.id,
          appearanceRef.current,
        );
        if (cancelled || generation !== connectionGeneration.current) {
          void releaseCodeAttachment(next.attachmentId).catch(() => undefined);
          return;
        }
        ownedAttachmentId = next.attachmentId;
        setAttachment(next);
        setBackgroundError(null);
        setConnectError(null);
        setConnecting(false);
        setRetrying(false);
        setFrameLoaded(false);
        setFrameReadyToReveal(false);
        onChangedRef.current?.();
      } catch (error) {
        if (cancelled || generation !== connectionGeneration.current) return;
        setConnectError(errorText(error));
        setConnecting(false);
        const retryable = shouldRetry(error);
        setRetrying(retryable);
        if (retryable) {
          retryTimer = setTimeout(
            () => void connect(attempt + 1),
            codeReconnectDelayMs(attempt),
          );
        }
      }
    };

    void connect(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ownedAttachmentId) {
        void releaseCodeAttachment(ownedAttachmentId).catch(() => undefined);
      }
    };
  }, [codeTab.activeWorkerId, codeTab.id, codeTab.worktreeId, reloadVersion]);

  useEffect(() => {
    if (!attachment) return;
    const attachmentOrigin = new URL(attachment.url).origin;
    const recover = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== attachmentOrigin ||
        event.source !== frameRef.current?.contentWindow ||
        !isCodeAttachmentUnavailableMessage(event.data)
      ) {
        return;
      }
      reload();
    };
    window.addEventListener("message", recover);
    return () => window.removeEventListener("message", recover);
  }, [attachment, reload]);

  useEffect(() => {
    if (!attachment) return;
    let cancelled = false;
    void setCodeTabTheme(codeTab.id, "follow-cantrip", appearance)
      .then(() => {
        if (!cancelled) {
          setBackgroundError(null);
          onChangedRef.current?.();
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isCodeSessionUnavailableError(error)) {
          setBackgroundError(null);
          reload();
          return;
        }
        setBackgroundError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [appearance, attachment?.attachmentId, codeTab.id, reload]);

  useEffect(() => {
    if (!actionMessage) return;
    const timeout = setTimeout(() => setActionMessage(null), 2_500);
    return () => clearTimeout(timeout);
  }, [actionMessage]);

  useEffect(() => {
    if (!attachment || !frameLoaded || frameReadyToReveal) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const revealFallback = setTimeout(
      () => setFrameReadyToReveal(true),
      CODE_FRAME_REVEAL_FALLBACK_MS,
    );

    const pollRuntime = async () => {
      try {
        const runtime = await getCodeRuntime(codeTab.id, attachment.sessionId);
        if (cancelled) return;
        if (isCodeWorkbenchReady(runtime, attachment.sessionId)) {
          setAttachment((current) =>
            current?.attachmentId === attachment.attachmentId
              ? { ...current, runtime }
              : current,
          );
          setFrameReadyToReveal(true);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      pollTimer = setTimeout(pollRuntime, CODE_RUNTIME_POLL_DELAY_MS);
    };

    void pollRuntime();
    return () => {
      cancelled = true;
      clearTimeout(revealFallback);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [attachment, codeTab.id, frameLoaded, frameReadyToReveal]);

  const runAction = useCallback(
    async (name: string, action: () => Promise<void>) => {
      setBusyAction(name);
      setActionError(null);
      setActionMessage(null);
      try {
        await action();
        onChangedRef.current?.();
      } catch (error) {
        setActionError(errorText(error));
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const saveAll = useCallback(
    () =>
      runAction("save", async () => {
        const result = await saveAllCodeTab(codeTab.id);
        if (result.failed.length > 0) {
          throw new Error(
            `Could not save ${result.failed.length} editor${result.failed.length === 1 ? "" : "s"}: ${result.failed[0]?.message ?? "Unknown error"}`,
          );
        }
        setActionMessage(
          result.saved.length > 0
            ? `Saved ${result.saved.length} file${result.saved.length === 1 ? "" : "s"}.`
            : "All editors are saved.",
        );
      }),
    [codeTab.id, runAction],
  );

  const stop = useCallback(
    () =>
      runAction("stop", async () => {
        stopped.current = true;
        connectionGeneration.current += 1;
        try {
          await stopCodeTab(codeTab.id);
        } catch (error) {
          if (!isCodeSessionUnavailableError(error)) throw error;
        }
        setAttachment(null);
        setFrameLoaded(false);
        setFrameReadyToReveal(false);
        setConnectError(null);
        setActionMessage("Editor stopped.");
      }),
    [codeTab.id, runAction],
  );

  const restart = useCallback(
    () =>
      runAction("restart", async () => {
        stopped.current = true;
        connectionGeneration.current += 1;
        try {
          await stopCodeTab(codeTab.id);
        } catch (error) {
          if (!isCodeSessionUnavailableError(error)) throw error;
        }
        stopped.current = false;
        setReloadVersion((version) => version + 1);
      }),
    [codeTab.id, runAction],
  );

  const header = useMemo<CodeHeaderState>(
    () => ({
      attachmentExpiresAt: attachment?.expiresAt ?? null,
      error: actionError ?? connectError ?? backgroundError,
      isBusy:
        busyAction !== null ||
        connecting ||
        (!attachment && retrying && !stopped.current),
      runtime: attachment?.runtime ?? null,
      status:
        attachment?.runtime.status ??
        (stopped.current ? "stopped" : codeTab.status),
      reload,
      restart,
      saveAll,
      stop,
    }),
    [
      actionError,
      attachment,
      backgroundError,
      busyAction,
      codeTab.status,
      connectError,
      connecting,
      reload,
      restart,
      retrying,
      saveAll,
      stop,
    ],
  );

  useEffect(() => {
    onHeaderChange?.(header);
  }, [header, onHeaderChange]);
  useEffect(() => () => onHeaderChange?.(null), [onHeaderChange]);

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-slot="code-view"
    >
      {attachment ? (
        <>
          <iframe
            key={attachment.attachmentId}
            allow="clipboard-read; clipboard-write"
            className="min-h-0 w-full flex-1 border-0 bg-transparent"
            onLoad={() => setFrameLoaded(true)}
            referrerPolicy="no-referrer"
            ref={frameRef}
            src={attachment.url}
            title={`${codeTab.title} — Cantrip Code`}
          />
          <SurfaceLoadingVeil
            label="Loading the browser-native workbench…"
            visible={!frameReadyToReveal}
          />
        </>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <div className="max-w-md">
            <div className="mx-auto grid size-12 place-items-center">
              {connectError && !retrying ? (
                <AlertTriangle className="size-5 text-destructive" />
              ) : stopped.current ? (
                <Code2 className="size-5" />
              ) : (
                <Loader2 className="size-5 animate-spin" />
              )}
            </div>
            <h2 className="mt-4 font-semibold">
              {stopped.current
                ? "Editor stopped"
                : connectError && retrying
                  ? "Reconnecting to Cantrip Code"
                  : connectError
                    ? "Cantrip Code is unavailable"
                    : "Starting Cantrip Code"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {connectError
                ? `${connectError}${connectAttempt > 0 ? ` Retrying (attempt ${connectAttempt + 1})…` : ""}`
                : stopped.current
                  ? "The persistent profile and workspace state remain on the worker."
                  : "The worker is opening the pinned editor build and this worktree workspace."}
            </p>
            <Button
              className="mt-4"
              variant={connectError ? "outline" : "default"}
              onClick={reload}
            >
              <RefreshCw className="size-4" />
              {stopped.current ? "Start editor" : "Retry now"}
            </Button>
          </div>
        </div>
      )}

      {actionError || actionMessage ? (
        <div
          className={`absolute bottom-4 left-1/2 z-20 max-w-lg -translate-x-1/2 rounded-lg border bg-popover px-4 py-2 text-xs shadow-xl ${actionError ? "text-destructive" : "text-popover-foreground"}`}
        >
          {actionError ?? actionMessage}
        </div>
      ) : null}
    </div>
  );
}
