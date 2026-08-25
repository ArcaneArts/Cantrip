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
import {
  CODE_WORKBENCH_READY_TIMEOUT_MS,
  CodeWorkbenchFrameLoadTracker,
  codeWorkbenchStageError,
  createCodeWorkbenchFrameMount,
  isCodeWorkbenchReadyEvent,
} from "@/lib/code-workbench-frame";
import {
  CantripApiError,
  createProtectedExplorerCodeAttachment,
  releaseCodeAttachment,
} from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import {
  CodeControlOperationTimeoutError,
  CodeAttachmentHealthError,
  openDirectCodeAttachmentFile,
  preferProtectedCodeAttachment,
  recoverPreferredCodeAttachmentRoute,
  setDirectCodeAttachmentPresentation,
  setDirectCodeAttachmentTheme,
  stopDirectCodeAttachment,
  subscribePreferredCodeAttachmentUnavailable,
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
const THEME_UPDATE_RETRY_DELAY_MS = 500;
const AUTOMATIC_REPLACEMENT_EXHAUSTED_MESSAGE =
  "Cantrip Code could not restore this editor automatically. Retry to reconnect.";
export const EXPLORER_CODE_RETRY_BASE_DELAY_MS = 500;
export const EXPLORER_CODE_RETRY_MAX_DELAY_MS = 15_000;
export const EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT = 6;

export function explorerCodeEditorRetryDelayMs(attempt: number): number {
  return Math.min(
    EXPLORER_CODE_RETRY_MAX_DELAY_MS,
    EXPLORER_CODE_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
  );
}

function transportFailureMessage(error: unknown): string {
  return errorMessage(error, "");
}

export function isRetryableExplorerCodeConnectionError(
  error: unknown,
): boolean {
  const visited = new Set<unknown>();
  let candidate = error;
  while (candidate instanceof Error && !visited.has(candidate)) {
    if (candidate instanceof CantripApiError) return candidate.status >= 500;
    if (candidate instanceof CodeAttachmentHealthError) return true;
    if (
      candidate.name !== "AbortError" &&
      /(?:failed to fetch|load failed|network|not connected|unavailable|could not be reached|timed out|timeout|disconnected|offline|stopped during code readiness|relay disconnected during startup)/iu.test(
        transportFailureMessage(candidate),
      )
    ) {
      return true;
    }
    visited.add(candidate);
    candidate = candidate.cause;
  }
  return false;
}

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
  return /(?:failed to fetch|load failed|network|not connected|unavailable|timed out|timeout|disconnected|offline)/iu.test(
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
  explorerId: string;
  reloadVersion: number;
  workerId: string;
  worktreeId: string;
}): string {
  return [
    input.explorerId,
    input.worktreeId,
    input.workerId,
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
  active = true,
  appearance,
  explorerId,
  onReady,
  path,
  worktreeId,
  workerId,
  workerOnline = true,
}: {
  active?: boolean;
  appearance: CodeAppearance;
  explorerId: string;
  onReady?: () => void;
  path: string | null;
  worktreeId: string;
  workerId: string;
  workerOnline?: boolean;
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
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [navigationRecoveryAttempt, setNavigationRecoveryAttempt] = useState(0);
  const [themeRecoveryAttempt, setThemeRecoveryAttempt] = useState(0);
  const automaticReconnectsRef = useRef(0);
  const automaticReplacementCountRef = useRef(0);
  const automaticReplacementPendingRef = useRef(false);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const connectionInFlightRef = useRef(false);
  const connectionRetryCountRef = useRef(0);
  const connectionRetryableRef = useRef(false);
  const connectionStartedRef = useRef(false);
  const connectionRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const frameRetryCountRef = useRef(0);
  const frameRetryPendingRef = useRef(false);
  const frameRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameFailureNonceRef = useRef<string | null>(null);
  const frameLoadsRef = useRef(new CodeWorkbenchFrameLoadTracker());
  const frameRef = useRef<HTMLIFrameElement>(null);
  const navigationQueueRef = useRef(new SerialTaskQueue());
  const navigationRetryCountRef = useRef(0);
  const navigationRetryIdentityRef = useRef<string | null>(null);
  const navigationRetryPendingRef = useRef(false);
  const navigationRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingConnectionWakeRef = useRef(false);
  const pendingThemeRef = useRef<{
    appearance: CodeAppearance;
    attachmentId: string;
  } | null>(null);
  const presentationRef = useRef(new ExplorerCodePresentationCache());
  const preferredAppearanceRef = useRef<{
    appearance: CodeAppearance;
    attachmentId: string;
  } | null>(null);
  const previousWorkerOnlineRef = useRef(workerOnline);
  const previousActiveRef = useRef(active);
  const previousPathRef = useRef(path);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const workerOnlineRef = useRef(workerOnline);
  workerOnlineRef.current = workerOnline;
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
    explorerId,
    reloadVersion,
    workerId,
    worktreeId,
  });
  const bindingKeyRef = useRef(bindingKey);
  bindingKeyRef.current = bindingKey;
  const requestedReadyKey = preferredAttachment
    ? path === null
      ? null
      : explorerCodeEditorReadyKey(
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
  const preferredAttachmentRef = useRef(preferredAttachment);
  preferredAttachmentRef.current = preferredAttachment;
  const frameMountRef = useRef(frameMount);
  frameMountRef.current = frameMount;
  const frameReady =
    frameMount !== null && frameReadyNonce === frameMount.nonce;
  const navigationIdentity =
    preferredAttachment && frameMount
      ? [
          bindingKey,
          preferredAttachment.attachment.attachmentId,
          frameMount.nonce,
          path ?? "<prewarm>",
        ].join("\0")
      : null;
  const ready = Boolean(
    path !== null &&
    frameReady &&
    readyKey !== null &&
    readyKey === requestedReadyKey,
  );

  useEffect(() => {
    if (ready) onReadyRef.current?.();
  }, [ready]);

  const reload = useCallback(() => {
    automaticReplacementCountRef.current = 0;
    automaticReplacementPendingRef.current = true;
    setError(null);
    setReloadVersion((version) => version + 1);
  }, []);

  const requestAutomaticReplacement = useCallback(
    (expectedBindingKey: string): boolean => {
      if (
        bindingKeyRef.current !== expectedBindingKey ||
        automaticReplacementPendingRef.current
      ) {
        return false;
      }
      if (
        automaticReplacementCountRef.current >=
        EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT
      ) {
        setError(AUTOMATIC_REPLACEMENT_EXHAUSTED_MESSAGE);
        return false;
      }
      automaticReplacementCountRef.current += 1;
      automaticReplacementPendingRef.current = true;
      setReloadVersion((version) => version + 1);
      return true;
    },
    [],
  );

  const consumeConnectionRetry = useCallback(
    (expectedBindingKey: string): boolean => {
      if (
        bindingKeyRef.current !== expectedBindingKey ||
        connectionRetryCountRef.current >= EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT
      ) {
        return false;
      }
      connectionRetryCountRef.current += 1;
      return true;
    },
    [],
  );

  const requestConnectionRetry = useCallback(
    (expectedBindingKey: string): boolean => {
      if (bindingKeyRef.current !== expectedBindingKey) return false;
      if (connectionInFlightRef.current) {
        pendingConnectionWakeRef.current =
          connectionRetryCountRef.current < EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT;
        return false;
      }
      if (!connectionRetryableRef.current) return false;
      if (!workerOnlineRef.current) {
        pendingConnectionWakeRef.current = true;
        return false;
      }
      if (connectionRetryTimerRef.current) {
        clearTimeout(connectionRetryTimerRef.current);
        connectionRetryTimerRef.current = null;
      }
      if (
        connectionStartedRef.current &&
        !consumeConnectionRetry(expectedBindingKey)
      ) {
        pendingConnectionWakeRef.current = false;
        return false;
      }
      pendingConnectionWakeRef.current = false;
      connectionRetryableRef.current = false;
      setConnectionAttempt((attempt) => attempt + 1);
      return true;
    },
    [consumeConnectionRetry],
  );

  const requestFrameRetry = useCallback(
    (expectedBindingKey: string, expectedNonce: string | null): boolean => {
      if (
        bindingKeyRef.current !== expectedBindingKey ||
        expectedNonce === null ||
        frameMountRef.current?.nonce !== expectedNonce ||
        !frameRetryPendingRef.current ||
        !preferredAttachmentRef.current
      ) {
        return false;
      }
      if (!workerOnlineRef.current) return false;
      if (frameRetryCountRef.current >= EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT) {
        frameRetryPendingRef.current = false;
        return false;
      }
      frameRetryCountRef.current += 1;
      if (frameRetryTimerRef.current) {
        clearTimeout(frameRetryTimerRef.current);
        frameRetryTimerRef.current = null;
      }
      frameRetryPendingRef.current = false;
      frameFailureNonceRef.current = null;
      setFrameFailureNonce(null);
      setError(null);
      setFrameDocumentVersion((version) => version + 1);
      return true;
    },
    [],
  );

  const scheduleFrameRetry = useCallback(
    (expectedBindingKey: string, expectedNonce: string) => {
      if (
        bindingKeyRef.current !== expectedBindingKey ||
        frameMountRef.current?.nonce !== expectedNonce
      ) {
        return;
      }
      if (frameRetryCountRef.current >= EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT) {
        frameRetryPendingRef.current = false;
        return;
      }
      frameRetryPendingRef.current = true;
      if (frameRetryTimerRef.current || !workerOnlineRef.current) return;
      const delay = explorerCodeEditorRetryDelayMs(frameRetryCountRef.current);
      const timer = setTimeout(() => {
        if (frameRetryTimerRef.current !== timer) return;
        frameRetryTimerRef.current = null;
        requestFrameRetry(expectedBindingKey, expectedNonce);
      }, delay);
      frameRetryTimerRef.current = timer;
    },
    [requestFrameRetry],
  );

  const requestNavigationRetry = useCallback(
    (expectedNavigationIdentity: string | null): boolean => {
      if (
        expectedNavigationIdentity === null ||
        navigationRetryIdentityRef.current !== expectedNavigationIdentity ||
        !navigationRetryPendingRef.current ||
        !workerOnlineRef.current
      ) {
        return false;
      }
      if (
        navigationRetryCountRef.current >= EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT
      ) {
        navigationRetryPendingRef.current = false;
        return false;
      }
      navigationRetryCountRef.current += 1;
      if (navigationRetryTimerRef.current) {
        clearTimeout(navigationRetryTimerRef.current);
        navigationRetryTimerRef.current = null;
      }
      navigationRetryPendingRef.current = false;
      setNavigationRecoveryAttempt((attempt) => attempt + 1);
      return true;
    },
    [],
  );

  useEffect(() => {
    automaticReplacementPendingRef.current = false;
    connectionRetryCountRef.current = 0;
    connectionRetryableRef.current = false;
    connectionStartedRef.current = false;
    connectionInFlightRef.current = false;
    pendingConnectionWakeRef.current = false;
    frameRetryCountRef.current = 0;
    frameRetryPendingRef.current = false;
    navigationRetryCountRef.current = 0;
    navigationRetryIdentityRef.current = null;
    navigationRetryPendingRef.current = false;
    for (const timerRef of [
      connectionRetryTimerRef,
      frameRetryTimerRef,
      navigationRetryTimerRef,
    ]) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      for (const timerRef of [
        connectionRetryTimerRef,
        frameRetryTimerRef,
        navigationRetryTimerRef,
      ]) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [bindingKey]);

  useEffect(() => {
    automaticReplacementCountRef.current = 0;
    automaticReplacementPendingRef.current = false;
  }, [explorerId, workerId, worktreeId]);

  useEffect(() => {
    let cancelled = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    setPreferredAttachment(null);
    setError(null);
    setFrameFailureNonce(null);
    frameFailureNonceRef.current = null;
    setFrameReadyNonce(null);
    setReadyKey(null);
    pendingThemeRef.current = null;
    preferredAppearanceRef.current = null;

    const connect = async () => {
      if (!workerOnlineRef.current) {
        connectionRetryableRef.current = true;
        pendingConnectionWakeRef.current = true;
        return;
      }
      connectionInFlightRef.current = true;
      connectionStartedRef.current = true;
      const connectionAppearance = appearanceRef.current;
      try {
        const preferred = await attachmentLifecycleRef.current!.replace(
          () =>
            createProtectedExplorerCodeAttachment(
              explorerId,
              pathRef.current,
              workerId,
              worktreeId,
              connectionAppearance,
            ),
          (wire, signal) =>
            preferProtectedCodeAttachment(wire, {
              signal,
            }),
        );
        if (!cancelled && preferred) {
          connectionInFlightRef.current = false;
          connectionRetryableRef.current = false;
          connectionRetryCountRef.current = 0;
          pendingConnectionWakeRef.current = false;
          preferredAppearanceRef.current = {
            appearance: connectionAppearance,
            attachmentId: preferred.attachment.attachmentId,
          };
          setPreferredAttachment(preferred);
        }
      } catch (connectError) {
        if (!cancelled) {
          connectionInFlightRef.current = false;
          const retryable =
            isRetryableExplorerCodeConnectionError(connectError);
          connectionRetryableRef.current = retryable;
          setError(
            errorMessage(
              connectError,
              "Cantrip Code could not open this file.",
            ),
          );
          if (
            retryable &&
            pendingConnectionWakeRef.current &&
            workerOnlineRef.current
          ) {
            pendingConnectionWakeRef.current = false;
            requestConnectionRetry(bindingKey);
          } else if (
            retryable &&
            connectionRetryCountRef.current <
              EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT
          ) {
            const delay = explorerCodeEditorRetryDelayMs(
              connectionRetryCountRef.current,
            );
            retryTimer = setTimeout(() => {
              if (cancelled) return;
              if (connectionRetryTimerRef.current === retryTimer) {
                connectionRetryTimerRef.current = null;
              }
              if (!workerOnlineRef.current) {
                pendingConnectionWakeRef.current = true;
                return;
              }
              requestConnectionRetry(bindingKey);
            }, delay);
            connectionRetryTimerRef.current = retryTimer;
          }
        }
      } finally {
        if (!cancelled) connectionInFlightRef.current = false;
      }
    };

    startTimer = setTimeout(() => {
      void connect();
    }, 0);
    return () => {
      cancelled = true;
      if (startTimer) clearTimeout(startTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (connectionRetryTimerRef.current === retryTimer) {
        connectionRetryTimerRef.current = null;
      }
      connectionInFlightRef.current = false;
      void attachmentLifecycleRef.current!.retire(
        "Explorer Code connection superseded.",
      );
    };
  }, [
    bindingKey,
    connectionAttempt,
    explorerId,
    requestConnectionRetry,
    workerId,
    worktreeId,
  ]);

  useEffect(() => {
    const wasOnline = previousWorkerOnlineRef.current;
    previousWorkerOnlineRef.current = workerOnline;
    if (
      !wasOnline &&
      workerOnline &&
      preferredAttachment &&
      pendingThemeRef.current?.attachmentId ===
        preferredAttachment.attachment.attachmentId
    ) {
      setThemeRecoveryAttempt((attempt) => attempt + 1);
    }
    if (wasOnline || !workerOnline) return;
    if (preferredAttachment) {
      requestFrameRetry(bindingKey, frameMount?.nonce ?? null);
      requestNavigationRetry(navigationIdentity);
      return;
    }
    requestConnectionRetry(bindingKey);
  }, [
    bindingKey,
    frameMount?.nonce,
    navigationIdentity,
    preferredAttachment,
    requestConnectionRetry,
    requestFrameRetry,
    requestNavigationRetry,
    workerOnline,
  ]);

  useEffect(() => {
    const previousPath = previousPathRef.current;
    previousPathRef.current = path;
    if (previousPath !== null || path === null) return;
    if (!preferredAttachment) {
      requestConnectionRetry(bindingKey);
      return;
    }
    requestFrameRetry(bindingKey, frameMount?.nonce ?? null);
  }, [
    bindingKey,
    frameMount?.nonce,
    path,
    preferredAttachment,
    requestConnectionRetry,
    requestFrameRetry,
  ]);

  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    if (wasActive || !active) return;
    if (!preferredAttachment) {
      requestConnectionRetry(bindingKey);
      return;
    }
    requestFrameRetry(bindingKey, frameMount?.nonce ?? null);
    requestNavigationRetry(navigationIdentity);
  }, [
    active,
    bindingKey,
    frameMount?.nonce,
    navigationIdentity,
    preferredAttachment,
    requestConnectionRetry,
    requestFrameRetry,
    requestNavigationRetry,
  ]);

  useEffect(() => {
    if (!preferredAttachment) return;
    const attachmentId = preferredAttachment.attachment.attachmentId;
    if (
      preferredAppearanceRef.current?.attachmentId === attachmentId &&
      preferredAppearanceRef.current.appearance === appearance
    ) {
      return;
    }
    pendingThemeRef.current = { appearance, attachmentId };
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const updateTheme = async (attempt: number) => {
      try {
        await setDirectCodeAttachmentTheme(
          preferredAttachment.attachment,
          appearance,
          { signal: controller.signal },
        );
        if (!cancelled) {
          preferredAppearanceRef.current = { appearance, attachmentId };
          if (
            pendingThemeRef.current?.attachmentId === attachmentId &&
            pendingThemeRef.current.appearance === appearance
          ) {
            pendingThemeRef.current = null;
          }
        }
      } catch {
        if (cancelled) return;
        if (attempt === 0) {
          retryTimer = setTimeout(
            () => void updateTheme(1),
            THEME_UPDATE_RETRY_DELAY_MS,
          );
          return;
        }
        pendingThemeRef.current = { appearance, attachmentId };
        clientLogger.warn("Cantrip Code theme update failed", {
          event: "code.attachment.theme.failed",
          operation: "set-theme",
          reasonCode: "control-request-failed",
          status: "failed",
          subsystem: "code",
          surfaceId: explorerId,
        });
      }
    };
    void updateTheme(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort(
        new DOMException(
          "Explorer Code theme update superseded.",
          "AbortError",
        ),
      );
    };
  }, [appearance, explorerId, preferredAttachment, themeRecoveryAttempt]);

  useEffect(() => {
    automaticReconnectsRef.current = 0;
  }, [path]);

  useEffect(() => {
    if (!preferredAttachment) return;
    return subscribePreferredCodeAttachmentUnavailable(
      preferredAttachment,
      () => requestAutomaticReplacement(bindingKey),
    );
  }, [bindingKey, preferredAttachment, requestAutomaticReplacement]);

  useEffect(() => {
    frameRetryCountRef.current = 0;
    frameRetryPendingRef.current = false;
    if (frameRetryTimerRef.current) {
      clearTimeout(frameRetryTimerRef.current);
      frameRetryTimerRef.current = null;
    }
  }, [preferredAttachment?.attachment.attachmentId]);

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
      automaticReplacementCountRef.current = 0;
      automaticReplacementPendingRef.current = false;
      frameRetryCountRef.current = 0;
      frameRetryPendingRef.current = false;
      if (frameRetryTimerRef.current) {
        clearTimeout(frameRetryTimerRef.current);
        frameRetryTimerRef.current = null;
      }
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
      scheduleFrameRetry(bindingKey, frameMount.nonce);
    }, CODE_WORKBENCH_READY_TIMEOUT_MS);
    return () => {
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", receiveReady);
    };
  }, [bindingKey, frameFailureNonce, frameMount, scheduleFrameRetry]);

  useEffect(() => {
    if (!preferredAttachment || !frameReady || !frameMount) return;
    const navigationController = new AbortController();
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    if (navigationIdentity === null) return;
    if (navigationRetryIdentityRef.current !== navigationIdentity) {
      navigationRetryIdentityRef.current = navigationIdentity;
      navigationRetryCountRef.current = 0;
      navigationRetryPendingRef.current = false;
      if (navigationRetryTimerRef.current) {
        clearTimeout(navigationRetryTimerRef.current);
        navigationRetryTimerRef.current = null;
      }
    }
    setError(null);
    const setPresentation = async () => {
      try {
        await setDirectCodeAttachmentPresentation(
          preferredAttachment.attachment,
          "editor",
          { signal: navigationController.signal },
        );
      } catch (presentationError) {
        throw codeWorkbenchStageError("presentation", presentationError);
      }
    };
    const cleanup = () => {
      cancelled = true;
      navigationController.abort(
        new DOMException("Explorer Code navigation superseded.", "AbortError"),
      );
      if (retryTimer) clearTimeout(retryTimer);
      if (navigationRetryTimerRef.current === retryTimer) {
        navigationRetryTimerRef.current = null;
      }
    };
    const resetNavigationRetry = () => {
      navigationRetryCountRef.current = 0;
      navigationRetryPendingRef.current = false;
      if (navigationRetryTimerRef.current) {
        clearTimeout(navigationRetryTimerRef.current);
        navigationRetryTimerRef.current = null;
      }
    };
    const scheduleNavigationRetry = (
      failure: unknown,
      fallbackMessage: string,
    ): boolean => {
      if (
        !isCodeControlOperationTimeout(failure) &&
        !isTransientFileOpenFailure(failure)
      ) {
        return false;
      }
      setError(errorMessage(failure, fallbackMessage));
      if (
        navigationRetryCountRef.current >= EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT
      ) {
        navigationRetryPendingRef.current = false;
        return true;
      }
      navigationRetryPendingRef.current = true;
      if (!workerOnlineRef.current) return true;
      if (navigationRetryTimerRef.current) return true;
      const delay = explorerCodeEditorRetryDelayMs(
        navigationRetryCountRef.current,
      );
      retryTimer = setTimeout(() => {
        if (
          cancelled ||
          navigationRetryIdentityRef.current !== navigationIdentity ||
          navigationRetryTimerRef.current !== retryTimer
        ) {
          return;
        }
        navigationRetryTimerRef.current = null;
        requestNavigationRetry(navigationIdentity);
      }, delay);
      navigationRetryTimerRef.current = retryTimer;
      return true;
    };

    if (path === null) {
      void navigationQueueRef.current.run(async () => {
        if (cancelled) return;
        try {
          await presentationRef.current.ensure(
            frameMount.nonce,
            setPresentation,
            navigationController.signal,
          );
          if (!cancelled) {
            resetNavigationRetry();
            setError(null);
            setReadyKey(null);
          }
        } catch (presentationError) {
          if (!cancelled) {
            if (
              scheduleNavigationRetry(
                presentationError,
                "Cantrip Code could not prepare the editor.",
              )
            ) {
              return;
            }
            setError(
              errorMessage(
                presentationError,
                "Cantrip Code could not prepare the editor.",
              ),
            );
          }
        }
      });
      return cleanup;
    }

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
          setPresentation,
          signal: navigationController.signal,
        });
        if (!cancelled && result.relativePath === path) {
          automaticReconnectsRef.current = 0;
          resetNavigationRetry();
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
            requestAutomaticReplacement(bindingKey);
            return;
          }
          automaticReconnectsRef.current += 1;
          retryTimer = setTimeout(
            () => void openFile(attempt + 1),
            routeRecovery === "available" ? FILE_OPEN_RETRY_DELAY_MS : 1_000,
          );
          return;
        }
        if (
          scheduleNavigationRetry(
            openError,
            "Cantrip Code could not open this file.",
          )
        ) {
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
    return cleanup;
  }, [
    bindingKey,
    frameMount,
    frameReady,
    navigationIdentity,
    navigationRecoveryAttempt,
    path,
    preferredAttachment,
    requestAutomaticReplacement,
    requestNavigationRetry,
  ]);

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
            scheduleFrameRetry(bindingKey, frameMount.nonce);
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
          title={path ? `Cantrip Code — ${path}` : "Cantrip Code"}
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
