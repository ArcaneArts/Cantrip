import type {
  CodeAppearance,
  CodeAttachment,
  CodeProtectedAttachmentWire,
  CodeRuntimeStatus,
  CodeTabStatus,
  CodeTabSummary,
} from "@cantrip/protocol";
import { AlertTriangle, Code2, Loader2, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  CantripApiError,
  createProtectedCodeAttachment,
  getCodeRuntime,
  releaseCodeAttachment,
  saveAllCodeTab,
  setCodeTabTheme,
  stopCodeTab,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import {
  CODE_WORKBENCH_READY_TIMEOUT_MS,
  CodeWorkbenchFrameLoadTracker,
  codeWorkbenchStageError,
  createCodeWorkbenchFrameMount,
  isCodeWorkbenchReadyEvent,
} from "@/lib/code-workbench-frame";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  directCodeAttachmentHealthyWithin,
  preferProtectedCodeAttachment,
  stopDirectCodeAttachment,
} from "@/lib/desktop-code";
import {
  retireAttachmentBestEffort,
  SerializedAttachmentLifecycle,
} from "@/lib/serialized-attachment-lifecycle";

const MAX_RECONNECT_DELAY_MS = 15_000;
const CODE_RUNTIME_POLL_DELAY_MS = 500;
const CODE_RUNTIME_POLL_WINDOW_MS = 30_000;

export interface CodeHeaderState {
  attachmentExpiresAt: string | null;
  error: string | null;
  isBusy: boolean;
  runtime: CodeRuntimeStatus | null;
  status: CodeTabStatus | CodeRuntimeStatus["status"];
  reload(): void;
  prepareWorktreeChange(): Promise<boolean>;
  restart(): Promise<void>;
  resumeAfterWorktreeChange(): void;
  saveAll(): Promise<void>;
  stop(): Promise<void>;
}

export function codeReconnectDelayMs(attempt: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.max(0, attempt));
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

export function isDarkCodeAppearance(appearance: CodeAppearance): boolean {
  return appearance === "dark" || appearance.endsWith("-dark");
}

export function codeWorkbenchFrameClassName(ready: boolean): string {
  // WebKit may deprioritize a fully transparent child web view. Keep the
  // workbench rendering beneath the opaque startup cover so its remote
  // extension host can connect and acknowledge the configured theme.
  return `min-h-0 w-full flex-1 border-0 ${ready ? "" : "pointer-events-none"}`;
}

export function codeAttachmentUrlForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(
      /^\/code\/[A-Za-z0-9_-]+(?=\/|$)/u,
      "/code/[attachment]",
    );
    return `${url.origin}${path}`;
  } catch {
    return "[invalid Code attachment URL]";
  }
}

function logCodeEvent(
  level: "error" | "info" | "warn",
  event: string,
  details: Record<string, unknown>,
): void {
  const { error, lastError, url: _url, ...metadata } = details;
  const failure = error ?? lastError;
  clientLogger.event(level, `Cantrip Code ${event}`, {
    ...metadata,
    ...(failure === undefined || failure === null
      ? {}
      : operationalErrorMetadata(failure)),
    ...(lastError === undefined || lastError === null
      ? {}
      : { runtimeErrorPresent: true }),
    event: `surface.code.${event.replaceAll(" ", "-")}`,
    operation: "code-surface",
    subsystem: "code",
  });
}

function errorText(error: unknown): string {
  return errorMessage(error, "Cantrip Code could not open.");
}

function shouldRetry(error: unknown): boolean {
  return !(error instanceof CantripApiError) || error.status >= 500;
}

export function CodeView({
  active = true,
  appearance,
  codeTab,
  onChanged,
  onHeaderChange,
}: {
  active?: boolean;
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
  const [frameError, setFrameError] = useState<string | null>(null);
  const [frameFailureNonce, setFrameFailureNonce] = useState<string | null>(
    null,
  );
  const [frameReadyNonce, setFrameReadyNonce] = useState<string | null>(null);
  const [frameDocumentVersion, setFrameDocumentVersion] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [synchronizedThemeKey, setSynchronizedThemeKey] = useState<
    string | null
  >(null);
  const appearanceRef = useRef(appearance);
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
  const cancelConnectionRef = useRef<() => void>(() => undefined);
  const connectionGeneration = useRef(0);
  const frameFailureNonceRef = useRef<string | null>(null);
  const frameLoadsRef = useRef(new CodeWorkbenchFrameLoadTracker());
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
    let directHealthTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let ownedAttachmentId: string | null = null;
    let ownedDirectTunnelId: string | null = null;
    const cancelConnection = () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (directHealthTimer) clearTimeout(directHealthTimer);
    };
    cancelConnectionRef.current = cancelConnection;
    stopped.current = false;
    setAttachment(null);
    setActionError(null);
    setActionMessage(null);
    setBackgroundError(null);
    setConnectAttempt(0);
    setConnectError(null);
    setConnecting(false);
    setFrameError(null);
    setFrameFailureNonce(null);
    frameFailureNonceRef.current = null;
    setFrameReadyNonce(null);
    setRetrying(false);
    setSynchronizedThemeKey(null);

    const connect = async (attempt: number) => {
      if (cancelled || stopped.current) return;
      setConnecting(true);
      setConnectAttempt(attempt);
      const startedAt = performance.now();
      logCodeEvent("info", "attachment request started", {
        appearance: appearanceRef.current,
        attempt: attempt + 1,
        codeTabId: codeTab.id,
        generation,
        workerId: codeTab.activeWorkerId,
        worktreeId: codeTab.worktreeId,
      });
      try {
        const selected = await attachmentLifecycleRef.current!.replace(
          async () => {
            const wire = await createProtectedCodeAttachment(
              codeTab.id,
              codeTab.activeWorkerId,
              codeTab.worktreeId,
              appearanceRef.current,
            );
            ownedAttachmentId = wire.attachmentId;
            ownedDirectTunnelId = wire.tunnelId;
            return wire;
          },
          async (wire, signal) => ({
            preferred: await preferProtectedCodeAttachment(wire, { signal }),
          }),
        );
        if (!selected) return;
        const initialAttachment = selected.preferred.attachment;
        ownedAttachmentId = initialAttachment.attachmentId;
        logCodeEvent("info", "relay attachment created", {
          attachmentId: initialAttachment.attachmentId,
          bridgeConnected: initialAttachment.runtime.bridgeConnected,
          elapsedMs: Math.round(performance.now() - startedAt),
          sessionId: initialAttachment.sessionId,
          status: initialAttachment.runtime.status,
          url: codeAttachmentUrlForLog(initialAttachment.url),
        });
        const preferred = selected.preferred;
        const next = preferred.attachment;
        ownedDirectTunnelId = preferred.directTunnelId;
        if (cancelled || generation !== connectionGeneration.current) {
          await attachmentLifecycleRef.current!.retire(
            "Code connection superseded after preparation.",
          );
          return;
        }
        setAttachment(next);
        setBackgroundError(null);
        setConnectError(null);
        setConnecting(false);
        setRetrying(false);
        logCodeEvent("info", "attachment selected", {
          attachmentId: next.attachmentId,
          elapsedMs: Math.round(performance.now() - startedAt),
          sessionId: next.sessionId,
          transport: preferred.directTunnelId ? "direct" : "relay",
          url: codeAttachmentUrlForLog(next.url),
        });
        onChangedRef.current?.();
        if (preferred.directTunnelId) {
          let failures = 0;
          const checkDirectRoute = async () => {
            if (cancelled || !ownedDirectTunnelId) return;
            try {
              if (
                !(await directCodeAttachmentHealthyWithin(ownedDirectTunnelId))
              )
                throw new Error("Direct Code route is unavailable.");
              if (cancelled) return;
              failures = 0;
            } catch (error) {
              if (cancelled) return;
              failures += 1;
              logCodeEvent("warn", "direct attachment health check failed", {
                attachmentId: next.attachmentId,
                error: errorText(error),
                failures,
                sessionId: next.sessionId,
              });
              if (failures >= 2 && !cancelled) {
                reload();
                return;
              }
            }
            if (!cancelled)
              directHealthTimer = setTimeout(checkDirectRoute, 5_000);
          };
          directHealthTimer = setTimeout(checkDirectRoute, 5_000);
        }
      } catch (error) {
        ownedAttachmentId = null;
        ownedDirectTunnelId = null;
        if (cancelled || generation !== connectionGeneration.current) return;
        setConnectError(errorText(error));
        setConnecting(false);
        const retryable = shouldRetry(error);
        setRetrying(retryable);
        logCodeEvent("error", "attachment request failed", {
          attempt: attempt + 1,
          codeTabId: codeTab.id,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: errorText(error),
          retryable,
        });
        if (retryable) {
          retryTimer = setTimeout(
            () => void connect(attempt + 1),
            codeReconnectDelayMs(attempt),
          );
        }
      }
    };

    // Deferring the first request lets React StrictMode discard its probe
    // effect before any worker attachment is created in development.
    retryTimer = setTimeout(() => void connect(0), 0);
    return () => {
      cancelConnection();
      if (ownedAttachmentId) {
        logCodeEvent("info", "attachment released", {
          attachmentId: ownedAttachmentId,
          codeTabId: codeTab.id,
          directTunnelId: ownedDirectTunnelId,
          generation,
        });
      }
      void attachmentLifecycleRef.current!.retire(
        "Code connection superseded.",
      );
    };
  }, [codeTab.activeWorkerId, codeTab.id, codeTab.worktreeId, reloadVersion]);

  const frameMount = useMemo(
    () => (attachment ? createCodeWorkbenchFrameMount(attachment.url) : null),
    [attachment?.attachmentId, attachment?.url, frameDocumentVersion],
  );

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
      setFrameError(null);
      setFrameReadyNonce(frameMount.nonce);
      logCodeEvent("info", "workbench frame confirmed", {
        attachmentId: attachment?.attachmentId,
        sessionId: attachment?.sessionId,
      });
    };
    window.addEventListener("message", receiveReady);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const failure = codeWorkbenchStageError(
        "workbench",
        "The embedded editor timed out after its endpoint loaded.",
      );
      setFrameFailureNonce(frameMount.nonce);
      setFrameError(failure.message);
      logCodeEvent("error", "workbench frame readiness failed", {
        attachmentId: attachment?.attachmentId,
        error: failure.message,
        sessionId: attachment?.sessionId,
      });
    }, CODE_WORKBENCH_READY_TIMEOUT_MS);
    return () => {
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", receiveReady);
    };
  }, [
    attachment?.attachmentId,
    attachment?.sessionId,
    frameFailureNonce,
    frameMount,
  ]);

  useEffect(() => {
    if (!attachment) return;
    let cancelled = false;
    const themeKey = `${attachment.attachmentId}\0${appearance}`;
    const startedAt = performance.now();
    logCodeEvent("info", "theme synchronization started", {
      appearance,
      attachmentId: attachment.attachmentId,
      codeTabId: codeTab.id,
      sessionId: attachment.sessionId,
    });
    void setCodeTabTheme(codeTab.id, "follow-cantrip", appearance)
      .then(() => {
        if (!cancelled) {
          setBackgroundError(null);
          setSynchronizedThemeKey(themeKey);
          logCodeEvent("info", "theme synchronization completed", {
            appearance,
            attachmentId: attachment.attachmentId,
            elapsedMs: Math.round(performance.now() - startedAt),
            sessionId: attachment.sessionId,
          });
          onChangedRef.current?.();
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isCodeSessionUnavailableError(error)) {
          logCodeEvent("warn", "theme synchronization lost its session", {
            attachmentId: attachment.attachmentId,
            elapsedMs: Math.round(performance.now() - startedAt),
            error: errorText(error),
            sessionId: attachment.sessionId,
          });
          setBackgroundError(null);
          reload();
          return;
        }
        logCodeEvent("error", "theme synchronization failed", {
          appearance,
          attachmentId: attachment.attachmentId,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: errorText(error),
          sessionId: attachment.sessionId,
        });
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
    if (
      !attachment ||
      isCodeWorkbenchReady(attachment.runtime, attachment.sessionId)
    )
      return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const pollDeadline = Date.now() + CODE_RUNTIME_POLL_WINDOW_MS;
    let pollCount = 0;
    let latestRuntime = attachment.runtime;
    let previousSignature = "";
    let previousPollError = "";

    const pollRuntime = async () => {
      pollCount += 1;
      try {
        const runtime = await getCodeRuntime(codeTab.id, attachment.sessionId);
        if (cancelled) return;
        latestRuntime = runtime;
        const signature = JSON.stringify({
          bridgeConnected: runtime.bridgeConnected,
          lastError: runtime.lastError,
          processInstanceId: runtime.processInstanceId,
          sessionId: runtime.sessionId,
          status: runtime.status,
        });
        if (signature !== previousSignature) {
          previousSignature = signature;
          logCodeEvent("info", "runtime readiness changed", {
            attachmentId: attachment.attachmentId,
            bridgeConnected: runtime.bridgeConnected,
            lastError: runtime.lastError,
            pollCount,
            processInstanceId: runtime.processInstanceId,
            requestedSessionId: attachment.sessionId,
            runtimeSessionId: runtime.sessionId,
            status: runtime.status,
          });
        }
        if (isCodeWorkbenchReady(runtime, attachment.sessionId)) {
          setAttachment((current) =>
            current?.attachmentId === attachment.attachmentId
              ? { ...current, runtime }
              : current,
          );
          logCodeEvent("info", "workbench bridge confirmed", {
            attachmentId: attachment.attachmentId,
            pollCount,
            processInstanceId: runtime.processInstanceId,
            sessionId: attachment.sessionId,
          });
          return;
        }
      } catch (error) {
        if (cancelled) return;
        const message = errorText(error);
        if (message !== previousPollError) {
          previousPollError = message;
          logCodeEvent("warn", "runtime readiness poll failed", {
            attachmentId: attachment.attachmentId,
            error: message,
            pollCount,
            sessionId: attachment.sessionId,
          });
        }
      }
      if (Date.now() < pollDeadline) {
        pollTimer = setTimeout(pollRuntime, CODE_RUNTIME_POLL_DELAY_MS);
      } else {
        logCodeEvent("warn", "workbench readiness deadline expired", {
          attachmentId: attachment.attachmentId,
          bridgeConnected: latestRuntime.bridgeConnected,
          lastError: latestRuntime.lastError,
          pollCount,
          processInstanceId: latestRuntime.processInstanceId,
          requestedSessionId: attachment.sessionId,
          runtimeSessionId: latestRuntime.sessionId,
          status: latestRuntime.status,
        });
      }
    };

    void pollRuntime();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [attachment, codeTab.id]);

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

  const prepareWorktreeChange = useCallback(async () => {
    setBusyAction("worktree");
    setActionError(null);
    setActionMessage(null);
    let paused = false;
    try {
      const result = await saveAllCodeTab(codeTab.id);
      if (result.failed.length > 0) {
        throw new Error(
          `Could not save ${result.failed.length} editor${result.failed.length === 1 ? "" : "s"}: ${result.failed[0]?.message ?? "Unknown error"}`,
        );
      }
      stopped.current = true;
      paused = true;
      connectionGeneration.current += 1;
      cancelConnectionRef.current();
      setAttachment(null);
      await attachmentLifecycleRef.current!.retire(
        "Code worktree change started.",
      );
      try {
        await stopCodeTab(codeTab.id);
      } catch (error) {
        if (!isCodeSessionUnavailableError(error)) throw error;
      }
      setConnectError(null);
      setConnecting(false);
      setRetrying(false);
      onChangedRef.current?.();
      return true;
    } catch (error) {
      setActionError(errorText(error));
      if (paused) {
        stopped.current = false;
        setReloadVersion((version) => version + 1);
      }
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [codeTab.id]);

  const resumeAfterWorktreeChange = useCallback(() => {
    stopped.current = false;
    setAttachment(null);
    setConnectError(null);
    setReloadVersion((version) => version + 1);
  }, []);

  const stop = useCallback(
    () =>
      runAction("stop", async () => {
        stopped.current = true;
        connectionGeneration.current += 1;
        cancelConnectionRef.current();
        setAttachment(null);
        await attachmentLifecycleRef.current!.retire("Code editor stopped.");
        try {
          await stopCodeTab(codeTab.id);
        } catch (error) {
          if (!isCodeSessionUnavailableError(error)) throw error;
        }
        setConnectError(null);
        setConnecting(false);
        setRetrying(false);
        setActionMessage("Editor stopped.");
      }),
    [codeTab.id, runAction],
  );

  const restart = useCallback(
    () =>
      runAction("restart", async () => {
        stopped.current = true;
        connectionGeneration.current += 1;
        cancelConnectionRef.current();
        setAttachment(null);
        await attachmentLifecycleRef.current!.retire("Code editor restarted.");
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
      error: actionError ?? connectError ?? frameError ?? backgroundError,
      isBusy:
        busyAction !== null ||
        connecting ||
        (!attachment && retrying && !stopped.current),
      runtime: attachment?.runtime ?? null,
      status:
        attachment?.runtime.status ??
        (stopped.current ? "stopped" : codeTab.status),
      reload,
      prepareWorktreeChange,
      restart,
      resumeAfterWorktreeChange,
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
      frameError,
      reload,
      prepareWorktreeChange,
      restart,
      retrying,
      resumeAfterWorktreeChange,
      saveAll,
      stop,
    ],
  );

  useEffect(() => {
    if (active) onHeaderChange?.(header);
  }, [active, header, onHeaderChange]);
  useEffect(
    () => () => {
      if (active) onHeaderChange?.(null);
    },
    [active, onHeaderChange],
  );

  const workbenchReady = attachment
    ? synchronizedThemeKey === `${attachment.attachmentId}\0${appearance}` &&
      isCodeWorkbenchReady(attachment.runtime, attachment.sessionId) &&
      frameReadyNonce === frameMount?.nonce
    : false;
  const darkWorkbench = isDarkCodeAppearance(appearance);
  const workbenchBackdrop = darkWorkbench ? "#000000" : "#ffffff";
  const workbenchForeground = darkWorkbench ? "#f4f4f5" : "#18181b";
  const workbenchMuted = darkWorkbench ? "#a1a1aa" : "#71717a";

  return (
    <div
      aria-hidden={!active}
      className={`relative min-h-0 flex-1 overflow-hidden bg-background ${active ? "flex" : "hidden"}`}
      data-elite-global={active && workbenchReady ? "" : undefined}
      data-slot="code-view"
    >
      {attachment ? (
        <>
          <iframe
            key={frameMount?.nonce}
            allow="clipboard-read; clipboard-write"
            aria-hidden={!workbenchReady}
            className={codeWorkbenchFrameClassName(workbenchReady)}
            referrerPolicy="no-referrer"
            ref={frameRef}
            src={frameMount?.url}
            style={{ backgroundColor: workbenchBackdrop }}
            title={`${codeTab.title} — Cantrip Code`}
            onError={() => {
              if (!frameMount) return;
              frameFailureNonceRef.current = frameMount.nonce;
              const failure = codeWorkbenchStageError(
                "frame",
                "The embedded editor document could not load.",
              );
              setFrameFailureNonce(frameMount.nonce);
              setFrameError(failure.message);
              logCodeEvent("error", "workbench frame failed to load", {
                attachmentId: attachment.attachmentId,
                error: failure.message,
                sessionId: attachment.sessionId,
                url: codeAttachmentUrlForLog(attachment.url),
              });
            }}
            onLoad={() => {
              if (
                frameMount &&
                frameLoadsRef.current.observe(frameMount.nonce)
              ) {
                setFrameReadyNonce(null);
                setFrameFailureNonce(null);
                frameFailureNonceRef.current = null;
                setFrameError(null);
                setFrameDocumentVersion((version) => version + 1);
                logCodeEvent("warn", "workbench frame reloaded", {
                  attachmentId: attachment.attachmentId,
                  sessionId: attachment.sessionId,
                });
                return;
              }
              logCodeEvent("info", "workbench frame load event", {
                attachmentId: attachment.attachmentId,
                bridgeConnected: attachment.runtime.bridgeConnected,
                sessionId: attachment.sessionId,
                url: codeAttachmentUrlForLog(attachment.url),
              });
            }}
          />
          {!workbenchReady ? (
            <div
              className="absolute inset-0 z-10 grid place-items-center p-6 text-center"
              data-slot="code-workbench-startup-cover"
              style={{
                backgroundColor: workbenchBackdrop,
                color: workbenchForeground,
              }}
            >
              <div className="max-w-md">
                {frameError ? (
                  <AlertTriangle className="mx-auto size-5 text-destructive" />
                ) : (
                  <Loader2 className="mx-auto size-5 animate-spin" />
                )}
                <h2 className="mt-4 font-semibold">
                  {frameError
                    ? "Cantrip Code did not render"
                    : "Starting Cantrip Code"}
                </h2>
                <p
                  className="mt-2 text-sm leading-6"
                  style={{ color: workbenchMuted }}
                >
                  {frameError ??
                    "Connecting the editor to this worktree and applying your appearance settings."}
                </p>
                {frameError ? (
                  <Button className="mt-4" onClick={reload} variant="outline">
                    <RefreshCw className="size-4" />
                    Retry now
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
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
