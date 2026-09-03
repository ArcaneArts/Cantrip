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
import {
  ExplorerCodeLaunchTiming,
  type ExplorerCodeLaunchPhase,
  type ExplorerCodeLaunchPhaseTiming,
} from "@/components/explorer/explorer-code-launch-timing";
import { Button } from "@/components/ui/button";
import { bindBrowserCodeAttachmentFrame } from "@/lib/browser-code-tunnel";
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
  createProtectedExplorerCodeSessionAttachment,
  releaseProtectedExplorerCodeSessionAttachment,
  renewProtectedExplorerCodeSessionAttachment,
  releaseCodeAttachment,
  type BoundExplorerCodeSessionAttachment,
} from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import {
  CodeAttachmentHealthError,
  openDirectCodeAttachmentFile,
  preferProtectedCodeAttachment,
  preferSharedProtectedCodeAttachment,
  retainSharedProtectedCodeAttachmentLease,
  setDirectCodeAttachmentPresentation,
  setDirectCodeAttachmentTheme,
  stopDirectCodeAttachment,
  stopSharedProtectedCodeAttachment,
  subscribePreferredCodeAttachmentUnavailable,
  shouldUseLegacyProtectedCodeAttachmentFallback,
  type PreferredCodeAttachment,
} from "@/lib/desktop-code";
import { errorMessage } from "@/lib/error-message";
import { explorerFileIntentContext } from "@/lib/explorer-lifecycle-trace";
import { SerialTaskQueue } from "@/lib/serial-task-queue";
import {
  DeferredEffectCleanup,
  retireAttachmentBestEffort,
  SerializedAttachmentLifecycle,
} from "@/lib/serialized-attachment-lifecycle";

const THEME_UPDATE_RETRY_DELAY_MS = 500;
const SHARED_SESSION_RENEWAL_MAX_DELAY_MS = 5 * 60_000;
const SHARED_SESSION_RENEWAL_MIN_DELAY_MS = 30_000;
const SHARED_TRANSPORT_RECOVERY_FAILED_MESSAGE =
  "Cantrip Code transport could not reconnect. Retry to reconnect this editor session.";
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

type ExplorerCodeAttachmentOwnership =
  CodeProtectedAttachmentWire | BoundExplorerCodeSessionAttachment;

export interface ExplorerCodeEditorLifecycleActions {
  cancelClose(): void;
  prepareClose(): Promise<void>;
}

function sharedExplorerCodeAttachment(
  owned: ExplorerCodeAttachmentOwnership,
): owned is BoundExplorerCodeSessionAttachment {
  return "attachment" in owned;
}

function explorerCodeOwnershipTimingDetails(
  owned: ExplorerCodeAttachmentOwnership,
): Record<string, unknown> {
  if (sharedExplorerCodeAttachment(owned)) {
    return {
      attachmentId: owned.attachment.session.attachmentId,
      sessionId: owned.attachment.session.sessionId,
      sharedTransport: true,
      tunnelId: owned.attachment.transport.transportId,
    };
  }
  return {
    attachmentId: owned.attachmentId,
    sessionId: owned.sessionId,
    sharedTransport: false,
    tunnelId: owned.tunnelId,
  };
}

function explorerCodeLaunchFailurePhase(
  error: unknown,
  fallback: ExplorerCodeLaunchPhase,
): ExplorerCodeLaunchPhase {
  if (!error || typeof error !== "object") return fallback;
  const stage = Reflect.get(error, "stage");
  if (stage === "file") return "file-open";
  if (stage === "frame") return "frame-document";
  if (stage === "presentation") return "presentation-ready";
  if (stage === "workbench") return "workbench-ready";
  return fallback;
}

async function retireExplorerCodeAttachment(
  owned: ExplorerCodeAttachmentOwnership,
): Promise<void> {
  if (sharedExplorerCodeAttachment(owned)) {
    await retireAttachmentBestEffort(
      () => stopSharedProtectedCodeAttachment(owned),
      () => releaseProtectedExplorerCodeSessionAttachment(owned),
    );
    return;
  }
  await retireAttachmentBestEffort(
    () => stopDirectCodeAttachment(owned),
    () => releaseCodeAttachment(owned.attachmentId),
  );
}

export function ExplorerCodeEditor({
  active = true,
  appearance,
  backgroundWarmup = false,
  explorerId,
  onLifecycleChange,
  onReady,
  path,
  worktreeId,
  workerId,
  workerOnline = true,
}: {
  active?: boolean;
  appearance: CodeAppearance;
  backgroundWarmup?: boolean;
  explorerId: string;
  onLifecycleChange?(actions: ExplorerCodeEditorLifecycleActions | null): void;
  onReady?: () => void;
  path: string | null;
  worktreeId: string;
  workerId: string;
  workerOnline?: boolean;
}) {
  const startupEligible = active || backgroundWarmup;
  const editorInstanceId = useRef(crypto.randomUUID()).current;
  const editorIdentityRef = useRef({ explorerId, workerId, worktreeId });
  editorIdentityRef.current = { explorerId, workerId, worktreeId };
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
  const [closing, setClosing] = useState(false);
  const [navigationAttempt, setNavigationAttempt] = useState(0);
  const [themeRecoveryAttempt, setThemeRecoveryAttempt] = useState(0);
  const [sharedTransportRecoveryAttempt, setSharedTransportRecoveryAttempt] =
    useState(0);
  const startupEligibleRef = useRef(startupEligible);
  const appearanceRef = useRef(appearance);
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
  const frameDocumentTimingRef = useRef<{
    nonce: string;
    timing: ExplorerCodeLaunchPhaseTiming;
  } | null>(null);
  const workbenchReadyTimingRef = useRef<{
    nonce: string;
    timing: ExplorerCodeLaunchPhaseTiming;
  } | null>(null);
  const launchTimingRef = useRef<ExplorerCodeLaunchTiming | null>(null);
  const frameReadyRef = useRef(false);
  const closingRef = useRef(false);
  const closeCommitResolverRef = useRef<(() => void) | null>(null);
  const closePromiseRef = useRef<Promise<void> | null>(null);
  const navigationQueueRef = useRef(new SerialTaskQueue());
  const lastSharedRecoveryAttemptRef = useRef(0);
  const sharedTransportUnavailableRef = useRef(false);
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
  const previousStartupEligibleRef = useRef(startupEligible);
  const previousPathRef = useRef(path);
  const onReadyRef = useRef(onReady);
  const workerOnlineRef = useRef(workerOnline);
  const attachmentLifecycleRef =
    useRef<SerializedAttachmentLifecycle<ExplorerCodeAttachmentOwnership> | null>(
      null,
    );
  attachmentLifecycleRef.current ??=
    new SerializedAttachmentLifecycle<ExplorerCodeAttachmentOwnership>(
      retireExplorerCodeAttachment,
    );
  const attachmentEffectCleanupRef = useRef<DeferredEffectCleanup | null>(null);
  attachmentEffectCleanupRef.current ??= new DeferredEffectCleanup();
  const editorUnmountCleanupRef = useRef<DeferredEffectCleanup | null>(null);
  editorUnmountCleanupRef.current ??= new DeferredEffectCleanup();
  const prepareClose = useCallback((): Promise<void> => {
    if (closePromiseRef.current) return closePromiseRef.current;
    const identity = editorIdentityRef.current;
    clientLogger.info("Explorer Code attachment retirement requested", {
      ...explorerFileIntentContext(identity.explorerId),
      editorInstanceId,
      event: "code.editor.attachment.retirement-requested",
      explorerId: identity.explorerId,
      operation: "retire-attachment",
      reasonCode: "surface-closing",
      retirementKind: "prepared-close",
      status: "started",
      subsystem: "code",
      workerId: identity.workerId,
      worktreeId: identity.worktreeId,
    });
    closingRef.current = true;
    attachmentEffectCleanupRef.current!.cancel();
    const committed = new Promise<void>((resolve) => {
      closeCommitResolverRef.current = resolve;
    });
    const closePromise = (async () => {
      setClosing(true);
      await committed;
      await attachmentLifecycleRef.current!.retire(
        "Explorer Code surface is closing.",
      );
    })();
    closePromiseRef.current = closePromise;
    return closePromise;
  }, [editorInstanceId]);
  const cancelClose = useCallback(() => {
    if (!closingRef.current) return;
    const identity = editorIdentityRef.current;
    clientLogger.info("Explorer Code prepared close cancelled", {
      ...explorerFileIntentContext(identity.explorerId),
      editorInstanceId,
      event: "code.editor.close.cancelled",
      explorerId: identity.explorerId,
      operation: "cancel-close",
      reasonCode: "surface-retained",
      status: "cancelled",
      subsystem: "code",
      workerId: identity.workerId,
      worktreeId: identity.worktreeId,
    });
    closingRef.current = false;
    closeCommitResolverRef.current?.();
    closeCommitResolverRef.current = null;
    closePromiseRef.current = null;
    setClosing(false);
  }, [editorInstanceId]);
  const pathRef = useRef(path);
  const bindingKey = explorerCodeEditorBindingKey({
    explorerId,
    reloadVersion,
    workerId,
    worktreeId,
  });
  const bindingKeyRef = useRef(bindingKey);
  const frameMount = useMemo(
    () =>
      !closing && preferredAttachment
        ? createCodeWorkbenchFrameMount(preferredAttachment.attachment.url)
        : null,
    [
      closing,
      preferredAttachment?.attachment.attachmentId,
      preferredAttachment?.attachment.url,
      frameDocumentVersion,
    ],
  );
  const preferredAttachmentRef = useRef(preferredAttachment);
  const frameMountRef = useRef(frameMount);
  useLayoutEffect(() => {
    startupEligibleRef.current = startupEligible;
    appearanceRef.current = appearance;
    bindingKeyRef.current = bindingKey;
    frameMountRef.current = frameMount;
    onReadyRef.current = onReady;
    pathRef.current = path;
    preferredAttachmentRef.current = preferredAttachment;
    workerOnlineRef.current = workerOnline;
  }, [
    startupEligible,
    appearance,
    bindingKey,
    frameMount,
    onReady,
    path,
    preferredAttachment,
    workerOnline,
  ]);
  useLayoutEffect(() => {
    if (!preferredAttachment || !frameMount) return;
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    return bindBrowserCodeAttachmentFrame(
      preferredAttachment.attachment.attachmentId,
      frame,
      frameMount.nonce,
    );
  }, [frameMount, preferredAttachment]);
  const frameReady =
    frameMount !== null && frameReadyNonce === frameMount.nonce;
  const workbenchGenerationKey =
    preferredAttachment && frameMount
      ? [
          bindingKey,
          preferredAttachment.attachment.attachmentId,
          frameMount.nonce,
        ].join("\0")
      : null;
  const ready = Boolean(
    !closing &&
    path !== null &&
    frameReady &&
    workbenchGenerationKey !== null &&
    readyKey !== null &&
    readyKey === workbenchGenerationKey,
  );
  const editorDiagnosticStateRef = useRef({
    active,
    backgroundWarmup,
    closing,
    hasAttachment: preferredAttachment !== null,
    pathPresent: path !== null,
    ready,
  });
  editorDiagnosticStateRef.current = {
    active,
    backgroundWarmup,
    closing,
    hasAttachment: preferredAttachment !== null,
    pathPresent: path !== null,
    ready,
  };

  useLayoutEffect(() => {
    frameReadyRef.current = frameReady;
  }, [frameReady]);

  const startLaunchTiming = useCallback(
    (requestedPath: string | null, previousReasonCode: string) => {
      launchTimingRef.current?.cancel(previousReasonCode);
      launchTimingRef.current = new ExplorerCodeLaunchTiming({
        ...explorerFileIntentContext(explorerId),
        attachmentReadyAtRequest: preferredAttachmentRef.current !== null,
        editorInstanceId,
        explorerId,
        launchKind: requestedPath === null ? "prewarm" : "file",
        workerId,
        workerOnlineAtRequest: workerOnlineRef.current,
        workbenchReadyAtRequest: frameReadyRef.current,
        worktreeId,
      });
    },
    [editorInstanceId, explorerId, workerId, worktreeId],
  );

  useLayoutEffect(() => {
    if (startupEligible) startLaunchTiming(path, "request-superseded");
  }, [path, startLaunchTiming, startupEligible]);

  useEffect(() => {
    const effectLease = editorUnmountCleanupRef.current!.retain();
    clientLogger.info("Explorer Code editor mounted", {
      ...explorerFileIntentContext(explorerId),
      ...editorDiagnosticStateRef.current,
      editorInstanceId,
      event: "code.editor.lifecycle.mounted",
      explorerId,
      lifecycleKind: "mounted",
      operation: "mount-editor",
      status: "completed",
      subsystem: "code",
      workerId,
      worktreeId,
    });
    return () => {
      editorUnmountCleanupRef.current!.release(effectLease, () => {
        launchTimingRef.current?.cancel("surface-unmounted");
        launchTimingRef.current = null;
        clientLogger.info("Explorer Code editor unmounted", {
          ...explorerFileIntentContext(explorerId),
          ...editorDiagnosticStateRef.current,
          editorInstanceId,
          event: "code.editor.lifecycle.unmounted",
          explorerId,
          lifecycleKind: "unmounted",
          operation: "unmount-editor",
          reasonCode: "react-unmount",
          status: "completed",
          subsystem: "code",
          workerId,
          worktreeId,
        });
      });
    };
  }, [editorInstanceId, explorerId, workerId, worktreeId]);

  useEffect(() => {
    clientLogger.info("Explorer Code editor lifecycle state observed", {
      ...explorerFileIntentContext(explorerId),
      ...editorDiagnosticStateRef.current,
      editorInstanceId,
      event: "code.editor.lifecycle.observed",
      explorerId,
      lifecycleKind: "updated",
      operation: "observe-editor",
      status: "observed",
      subsystem: "code",
      workerId,
      worktreeId,
    });
  }, [
    active,
    backgroundWarmup,
    closing,
    editorInstanceId,
    explorerId,
    path,
    preferredAttachment,
    ready,
    workerId,
    worktreeId,
  ]);

  useEffect(() => {
    onLifecycleChange?.({ cancelClose, prepareClose });
    return () => onLifecycleChange?.(null);
  }, [cancelClose, onLifecycleChange, prepareClose]);
  useEffect(
    () => () => {
      closeCommitResolverRef.current?.();
      closeCommitResolverRef.current = null;
    },
    [],
  );

  const reload = useCallback(() => {
    if (closingRef.current) return;
    startLaunchTiming(pathRef.current, "manual-retry");
    if (
      sharedTransportUnavailableRef.current &&
      preferredAttachmentRef.current?.sharedOwnedAttachment
    ) {
      setError(null);
      setSharedTransportRecoveryAttempt((attempt) => attempt + 1);
      return;
    }
    if (
      preferredAttachmentRef.current &&
      frameReadyRef.current &&
      pathRef.current !== null
    ) {
      setError(null);
      setNavigationAttempt((attempt) => attempt + 1);
      return;
    }
    setError(null);
    setReloadVersion((version) => version + 1);
  }, [startLaunchTiming]);

  const consumeConnectionRetry = useCallback(
    (expectedBindingKey: string): boolean => {
      if (
        closingRef.current ||
        !startupEligibleRef.current ||
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
      if (closingRef.current || bindingKeyRef.current !== expectedBindingKey) {
        return false;
      }
      if (!startupEligibleRef.current) {
        pendingConnectionWakeRef.current = true;
        return false;
      }
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
        closingRef.current ||
        !startupEligibleRef.current ||
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
        closingRef.current ||
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
      if (
        frameRetryTimerRef.current ||
        !startupEligibleRef.current ||
        !workerOnlineRef.current
      ) {
        return;
      }
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

  useEffect(() => {
    connectionRetryCountRef.current = 0;
    connectionRetryableRef.current = false;
    connectionStartedRef.current = false;
    connectionInFlightRef.current = false;
    pendingConnectionWakeRef.current = false;
    frameRetryCountRef.current = 0;
    frameRetryPendingRef.current = false;
    sharedTransportUnavailableRef.current = false;
    for (const timerRef of [connectionRetryTimerRef, frameRetryTimerRef]) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      for (const timerRef of [connectionRetryTimerRef, frameRetryTimerRef]) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [bindingKey]);

  useEffect(() => {
    const effectLease = attachmentEffectCleanupRef.current!.retain();
    if (closing) return;
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
      if (!startupEligibleRef.current) {
        connectionRetryableRef.current = true;
        pendingConnectionWakeRef.current = true;
        return;
      }
      if (!workerOnlineRef.current) {
        connectionRetryableRef.current = true;
        pendingConnectionWakeRef.current = true;
        return;
      }
      connectionInFlightRef.current = true;
      connectionStartedRef.current = true;
      const connectionAppearance = appearanceRef.current;
      let failurePhase: ExplorerCodeLaunchPhase = "session-route";
      try {
        clientLogger.info("Explorer Code attachment connection requested", {
          ...explorerFileIntentContext(explorerId),
          editorInstanceId,
          event: "code.editor.attachment.connect-requested",
          explorerId,
          operation: "connect-attachment",
          reasonCode: "connection-effect-started",
          status: "started",
          subsystem: "code",
          workerId,
          worktreeId,
        });
        const preferred = await attachmentLifecycleRef.current!.replace(
          async () => {
            const sharedTiming =
              launchTimingRef.current?.beginPhase("session-route");
            try {
              const shared = await createProtectedExplorerCodeSessionAttachment(
                explorerId,
                pathRef.current,
                workerId,
                worktreeId,
                connectionAppearance,
              );
              sharedTiming?.complete(
                explorerCodeOwnershipTimingDetails(shared),
              );
              return shared;
            } catch (sharedError) {
              const fallbackToLegacy =
                shouldUseLegacyProtectedCodeAttachmentFallback(sharedError);
              if (fallbackToLegacy) {
                sharedTiming?.cancel("legacy-fallback");
              } else {
                sharedTiming?.fail(sharedError);
              }
              if (!fallbackToLegacy) throw sharedError;
              const legacyTiming =
                launchTimingRef.current?.beginPhase("session-route");
              try {
                const legacy = await createProtectedExplorerCodeAttachment(
                  explorerId,
                  pathRef.current,
                  workerId,
                  worktreeId,
                  connectionAppearance,
                );
                legacyTiming?.complete(
                  explorerCodeOwnershipTimingDetails(legacy),
                );
                return legacy;
              } catch (legacyError) {
                legacyTiming?.fail(legacyError, { fallbackToLegacy: true });
                throw legacyError;
              }
            }
          },
          async (owned, signal) => {
            failurePhase = "transport-ready";
            const transportTiming =
              launchTimingRef.current?.beginPhase("transport-ready");
            try {
              const preferred = sharedExplorerCodeAttachment(owned)
                ? await preferSharedProtectedCodeAttachment(owned, { signal })
                : await preferProtectedCodeAttachment(owned, { signal });
              transportTiming?.complete({
                attachmentId: preferred.attachment.attachmentId,
                sessionId: preferred.attachment.sessionId,
                sharedTransportGeneration:
                  preferred.sharedTransportGeneration ?? null,
                transportKind: preferred.transportKind,
              });
              return preferred;
            } catch (transportError) {
              transportTiming?.fail(transportError);
              throw transportError;
            }
          },
        );
        if (!cancelled && !closingRef.current && preferred) {
          connectionInFlightRef.current = false;
          connectionRetryableRef.current = false;
          connectionRetryCountRef.current = 0;
          pendingConnectionWakeRef.current = false;
          preferredAppearanceRef.current = {
            appearance: connectionAppearance,
            attachmentId: preferred.attachment.attachmentId,
          };
          setPreferredAttachment(preferred);
          clientLogger.info("Explorer Code attachment bound", {
            ...explorerFileIntentContext(explorerId),
            attachmentId: preferred.attachment.attachmentId,
            editorInstanceId,
            event: "code.editor.attachment.bound",
            explorerId,
            operation: "bind-attachment",
            sessionId: preferred.attachment.sessionId,
            status: "completed",
            subsystem: "code",
            transportKind: preferred.transportKind,
            workerId,
            worktreeId,
          });
        }
      } catch (connectError) {
        if (!cancelled && !closingRef.current) {
          connectionInFlightRef.current = false;
          const retryable =
            isRetryableExplorerCodeConnectionError(connectError);
          let willRetry = false;
          connectionRetryableRef.current = retryable;
          setError(
            errorMessage(
              connectError,
              "Cantrip Code could not open this file.",
            ),
          );
          if (retryable && !startupEligibleRef.current) {
            willRetry = true;
            pendingConnectionWakeRef.current = true;
          } else if (
            retryable &&
            pendingConnectionWakeRef.current &&
            workerOnlineRef.current
          ) {
            willRetry = true;
            pendingConnectionWakeRef.current = false;
            requestConnectionRetry(bindingKey);
          } else if (
            retryable &&
            connectionRetryCountRef.current <
              EXPLORER_CODE_AUTOMATIC_RETRY_LIMIT
          ) {
            willRetry = true;
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
          if (!willRetry) {
            launchTimingRef.current?.fail(failurePhase, connectError, {
              retryable,
            });
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
      attachmentEffectCleanupRef.current!.release(effectLease, async () => {
        clientLogger.info("Explorer Code attachment retirement requested", {
          ...explorerFileIntentContext(explorerId),
          editorInstanceId,
          event: "code.editor.attachment.retirement-requested",
          explorerId,
          operation: "retire-attachment",
          reasonCode: "connection-effect-cleanup",
          retirementKind: "effect-cleanup",
          status: "started",
          subsystem: "code",
          workerId,
          worktreeId,
        });
        await attachmentLifecycleRef.current!.retire(
          "Explorer Code connection superseded.",
        );
      });
    };
  }, [
    bindingKey,
    closing,
    connectionAttempt,
    editorInstanceId,
    explorerId,
    requestConnectionRetry,
    workerId,
    worktreeId,
  ]);

  useEffect(() => {
    if (closingRef.current) return;
    const wasOnline = previousWorkerOnlineRef.current;
    previousWorkerOnlineRef.current = workerOnline;
    if (!startupEligibleRef.current) return;
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
    if (
      sharedTransportUnavailableRef.current &&
      preferredAttachment?.sharedOwnedAttachment
    ) {
      setSharedTransportRecoveryAttempt((attempt) => attempt + 1);
      return;
    }
    if (preferredAttachment) {
      requestFrameRetry(bindingKey, frameMount?.nonce ?? null);
      return;
    }
    requestConnectionRetry(bindingKey);
  }, [
    bindingKey,
    frameMount?.nonce,
    preferredAttachment,
    requestConnectionRetry,
    requestFrameRetry,
    workerOnline,
  ]);

  useEffect(() => {
    if (closingRef.current) return;
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
    if (closingRef.current) return;
    const wasStartupEligible = previousStartupEligibleRef.current;
    previousStartupEligibleRef.current = startupEligible;
    if (wasStartupEligible || !startupEligible) return;
    if (
      sharedTransportUnavailableRef.current &&
      preferredAttachment?.sharedOwnedAttachment
    ) {
      setSharedTransportRecoveryAttempt((attempt) => attempt + 1);
      return;
    }
    if (!preferredAttachment) {
      requestConnectionRetry(bindingKey);
      return;
    }
    requestFrameRetry(bindingKey, frameMount?.nonce ?? null);
  }, [
    bindingKey,
    frameMount?.nonce,
    preferredAttachment,
    requestConnectionRetry,
    requestFrameRetry,
    startupEligible,
  ]);

  useEffect(() => {
    if (
      closing ||
      !active ||
      !preferredAttachment ||
      sharedTransportUnavailableRef.current
    ) {
      return;
    }
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
  }, [
    active,
    appearance,
    closing,
    explorerId,
    preferredAttachment,
    themeRecoveryAttempt,
  ]);

  useEffect(() => {
    if (closing || !preferredAttachment) return;
    return subscribePreferredCodeAttachmentUnavailable(
      preferredAttachment,
      () => {
        if (preferredAttachment.sharedOwnedAttachment) {
          sharedTransportUnavailableRef.current = true;
          setReadyKey(null);
          setError(null);
          if (startupEligibleRef.current) {
            setSharedTransportRecoveryAttempt((attempt) => attempt + 1);
          }
          return;
        }
        setFrameReadyNonce(null);
        setReadyKey(null);
        setError(
          "Cantrip Code transport closed. Retry to reconnect this editor.",
        );
      },
    );
  }, [closing, preferredAttachment]);

  useEffect(() => {
    if (
      closing ||
      !startupEligible ||
      !workerOnline ||
      sharedTransportRecoveryAttempt === 0 ||
      sharedTransportRecoveryAttempt <= lastSharedRecoveryAttemptRef.current
    ) {
      return;
    }
    const owned = preferredAttachment?.sharedOwnedAttachment;
    if (!owned) return;
    lastSharedRecoveryAttemptRef.current = sharedTransportRecoveryAttempt;
    const expectedBindingKey = bindingKey;
    const controller = new AbortController();
    let cancelled = false;
    void preferSharedProtectedCodeAttachment(owned, {
      signal: controller.signal,
    })
      .then(async (recovered) => {
        if (cancelled || bindingKeyRef.current !== expectedBindingKey) {
          return stopSharedProtectedCodeAttachment(
            owned,
            recovered.sharedTransportLeaseId,
          );
        }
        if (!recovered.sharedTransportLeaseId) {
          throw new Error(
            "Shared Cantrip Code recovery omitted its exact transport lease.",
          );
        }
        await retainSharedProtectedCodeAttachmentLease(
          owned,
          recovered.sharedTransportLeaseId,
        );
        if (cancelled || bindingKeyRef.current !== expectedBindingKey) {
          return stopSharedProtectedCodeAttachment(
            owned,
            recovered.sharedTransportLeaseId,
          );
        }
        sharedTransportUnavailableRef.current = false;
        setPreferredAttachment(recovered);
        setError(null);
        setThemeRecoveryAttempt((attempt) => attempt + 1);
        setNavigationAttempt((attempt) => attempt + 1);
      })
      .catch((recoveryError: unknown) => {
        if (cancelled || bindingKeyRef.current !== expectedBindingKey) return;
        setError(
          errorMessage(recoveryError, SHARED_TRANSPORT_RECOVERY_FAILED_MESSAGE),
        );
      });
    return () => {
      cancelled = true;
      controller.abort(
        new DOMException(
          "Shared Cantrip Code recovery superseded.",
          "AbortError",
        ),
      );
    };
  }, [
    bindingKey,
    closing,
    preferredAttachment,
    sharedTransportRecoveryAttempt,
    startupEligible,
    workerOnline,
  ]);

  useEffect(() => {
    const initial = preferredAttachment?.sharedOwnedAttachment;
    if (closing || !initial) return;
    let current = initial;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delayMs?: number) => {
      if (cancelled) return;
      const expiresInMs =
        Date.parse(current.attachment.session.expiresAt) - Date.now();
      const delay =
        delayMs ??
        Math.min(
          SHARED_SESSION_RENEWAL_MAX_DELAY_MS,
          Math.max(
            SHARED_SESSION_RENEWAL_MIN_DELAY_MS,
            Math.floor(expiresInMs / 2),
          ),
        );
      timer = setTimeout(() => void renew(), delay);
    };
    const renew = async () => {
      try {
        current = await renewProtectedExplorerCodeSessionAttachment(current, {
          signal: AbortSignal.timeout(10_000),
        });
        schedule();
      } catch (renewalError) {
        if (cancelled) return;
        const authoritative =
          renewalError instanceof CantripApiError &&
          [401, 403, 404, 409, 410].includes(renewalError.status);
        const expiresInMs =
          Date.parse(current.attachment.session.expiresAt) - Date.now();
        if (
          authoritative ||
          expiresInMs <= SHARED_SESSION_RENEWAL_MIN_DELAY_MS
        ) {
          setReadyKey(null);
          setError(
            errorMessage(
              renewalError,
              "Cantrip Code session expired. Retry to reconnect this editor.",
            ),
          );
          return;
        }
        schedule(
          Math.min(SHARED_SESSION_RENEWAL_MIN_DELAY_MS, expiresInMs / 2),
        );
      }
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [closing, preferredAttachment]);

  useEffect(() => {
    frameRetryCountRef.current = 0;
    frameRetryPendingRef.current = false;
    if (frameRetryTimerRef.current) {
      clearTimeout(frameRetryTimerRef.current);
      frameRetryTimerRef.current = null;
    }
  }, [preferredAttachment?.attachment.attachmentId]);

  useLayoutEffect(() => {
    if (!frameMount) return;
    const timing = launchTimingRef.current;
    if (!timing) return;
    const frameDocument = {
      nonce: frameMount.nonce,
      timing: timing.beginPhase("frame-document"),
    };
    const workbenchReady = {
      nonce: frameMount.nonce,
      timing: timing.beginPhase("workbench-ready"),
    };
    frameDocumentTimingRef.current = frameDocument;
    workbenchReadyTimingRef.current = workbenchReady;
    return () => {
      frameDocument.timing.cancel("frame-replaced");
      workbenchReady.timing.cancel("frame-replaced");
      if (frameDocumentTimingRef.current === frameDocument) {
        frameDocumentTimingRef.current = null;
      }
      if (workbenchReadyTimingRef.current === workbenchReady) {
        workbenchReadyTimingRef.current = null;
      }
    };
  }, [frameMount]);

  useLayoutEffect(() => {
    if (!frameMount || frameFailureNonce === frameMount.nonce) return;
    if (frameFailureNonceRef.current !== frameMount.nonce) {
      frameFailureNonceRef.current = null;
    }
    let settled = frameReadyNonce === frameMount.nonce;
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
      frameRetryCountRef.current = 0;
      frameRetryPendingRef.current = false;
      if (frameRetryTimerRef.current) {
        clearTimeout(frameRetryTimerRef.current);
        frameRetryTimerRef.current = null;
      }
      setError(null);
      clientLogger.info("Explorer Code workbench ready message received", {
        ...explorerFileIntentContext(explorerId),
        attachmentId: preferredAttachmentRef.current?.attachment.attachmentId,
        editorInstanceId,
        event: "code.editor.workbench.ready-received",
        explorerId,
        operation: "receive-workbench-ready",
        status: "completed",
        subsystem: "code",
        workerId,
        worktreeId,
      });
      if (workbenchReadyTimingRef.current?.nonce === frameMount.nonce) {
        workbenchReadyTimingRef.current.timing.complete({
          attachmentId: preferredAttachmentRef.current?.attachment.attachmentId,
        });
        workbenchReadyTimingRef.current = null;
      }
      setFrameReadyNonce(frameMount.nonce);
      if (pathRef.current === null) {
        const preferred = preferredAttachmentRef.current;
        launchTimingRef.current?.complete({
          attachmentId: preferred?.attachment.attachmentId,
          prewarmed: true,
          sessionId: preferred?.attachment.sessionId,
          transportKind: preferred?.transportKind,
        });
      }
    };
    window.addEventListener("message", receiveReady);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    if (startupEligible && !settled) {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = codeWorkbenchStageError(
          "workbench",
          "The embedded editor timed out after its endpoint loaded.",
        );
        if (workbenchReadyTimingRef.current?.nonce === frameMount.nonce) {
          workbenchReadyTimingRef.current.timing.fail(timeoutError, {
            retryScheduled: true,
          });
          workbenchReadyTimingRef.current = null;
        }
        setFrameFailureNonce(frameMount.nonce);
        setError(timeoutError.message);
        scheduleFrameRetry(bindingKey, frameMount.nonce);
      }, CODE_WORKBENCH_READY_TIMEOUT_MS);
    }
    return () => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      window.removeEventListener("message", receiveReady);
    };
  }, [
    bindingKey,
    editorInstanceId,
    explorerId,
    frameFailureNonce,
    frameMount,
    frameReadyNonce,
    scheduleFrameRetry,
    startupEligible,
    workerId,
    worktreeId,
  ]);

  useEffect(() => {
    if (
      !active ||
      !preferredAttachment ||
      !frameReady ||
      !frameMount ||
      !workbenchGenerationKey ||
      (path !== null && readyKey !== workbenchGenerationKey) ||
      sharedTransportUnavailableRef.current
    ) {
      return;
    }
    const presentationController = new AbortController();
    let cancelled = false;
    let applied = false;
    const presentationTiming =
      launchTimingRef.current?.beginPhase("presentation-ready");
    void presentationRef.current
      .ensure(
        frameMount.nonce,
        async () => {
          applied = true;
          await setDirectCodeAttachmentPresentation(
            preferredAttachment.attachment,
            "editor",
            { signal: presentationController.signal },
          );
        },
        presentationController.signal,
      )
      .then(() => {
        if (cancelled) return;
        presentationTiming?.complete({
          attachmentId: preferredAttachment.attachment.attachmentId,
          reused: !applied,
        });
        if (pathRef.current === null) {
          launchTimingRef.current?.complete({
            attachmentId: preferredAttachment.attachment.attachmentId,
            prewarmed: true,
            sessionId: preferredAttachment.attachment.sessionId,
            transportKind: preferredAttachment.transportKind,
          });
        }
      })
      .catch((presentationError: unknown) => {
        if (cancelled || presentationController.signal.aborted) return;
        presentationTiming?.fail(presentationError);
        clientLogger.event(
          "warn",
          "Cantrip Code presentation update failed without blocking the editor",
          {
            attachmentId: preferredAttachment.attachment.attachmentId,
            event: "code.editor.presentation.failed",
            operation: "set-presentation",
            status: "failed",
            subsystem: "code",
          },
        );
        if (pathRef.current === null) {
          launchTimingRef.current?.complete({
            attachmentId: preferredAttachment.attachment.attachmentId,
            presentationApplied: false,
            prewarmed: true,
            sessionId: preferredAttachment.attachment.sessionId,
            transportKind: preferredAttachment.transportKind,
          });
        }
      });
    return () => {
      cancelled = true;
      presentationController.abort(
        new DOMException(
          "Explorer Code presentation superseded.",
          "AbortError",
        ),
      );
    };
  }, [
    active,
    frameMount,
    frameReady,
    path,
    preferredAttachment,
    readyKey,
    workbenchGenerationKey,
  ]);

  useEffect(() => {
    if (
      !active ||
      !preferredAttachment ||
      !frameReady ||
      !frameMount ||
      !workbenchGenerationKey ||
      path === null ||
      sharedTransportUnavailableRef.current
    ) {
      return;
    }
    const navigationController = new AbortController();
    let cancelled = false;
    setError(null);
    void navigationQueueRef.current.run(async () => {
      if (cancelled) return;
      const fileTiming = launchTimingRef.current?.beginPhase("file-open");
      try {
        const result = await openDirectCodeAttachmentFile(
          preferredAttachment.attachment,
          path,
          { signal: navigationController.signal },
        );
        if (cancelled) return;
        if (result.relativePath !== path) {
          throw codeWorkbenchStageError(
            "file",
            `Worker acknowledged ${result.relativePath} instead of ${path}.`,
          );
        }
        fileTiming?.complete({
          attachmentId: preferredAttachment.attachment.attachmentId,
          openAttempt: 1,
        });
        setError(null);
        setReadyKey(workbenchGenerationKey);
        launchTimingRef.current?.complete({
          attachmentId: preferredAttachment.attachment.attachmentId,
          sessionId: preferredAttachment.attachment.sessionId,
          transportKind: preferredAttachment.transportKind,
        });
        onReadyRef.current?.();
      } catch (openError) {
        if (cancelled) return;
        fileTiming?.fail(openError, { openAttempt: 1 });
        setReadyKey(null);
        setError(
          errorMessage(openError, "Cantrip Code could not open this file."),
        );
        launchTimingRef.current?.fail(
          explorerCodeLaunchFailurePhase(openError, "file-open"),
          openError,
          { openAttempt: 1 },
        );
      }
    });
    return () => {
      cancelled = true;
      navigationController.abort(
        new DOMException("Explorer Code navigation superseded.", "AbortError"),
      );
    };
  }, [
    active,
    frameMount,
    frameReady,
    navigationAttempt,
    path,
    preferredAttachment,
    workbenchGenerationKey,
  ]);

  useEffect(() => {
    if (!closing) return;
    // This effect is intentionally declared after connection, theme,
    // recovery, renewal, frame, and navigation effects. Their close-state
    // cleanups quiesce first; only then may the delete caller retire the
    // serialized attachment and continue to the server surface deletion.
    closeCommitResolverRef.current?.();
    closeCommitResolverRef.current = null;
  }, [closing]);

  return (
    <section
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-slot="explorer-code-editor"
    >
      {!closing && preferredAttachment ? (
        <iframe
          key={frameMount?.nonce}
          allow="clipboard-read; clipboard-write"
          aria-hidden={!ready}
          className={codeWorkbenchFrameClassName(ready)}
          onError={() => {
            if (!frameMount) return;
            const frameError = codeWorkbenchStageError(
              "frame",
              "The embedded editor document could not load.",
            );
            if (frameDocumentTimingRef.current?.nonce === frameMount.nonce) {
              frameDocumentTimingRef.current.timing.fail(frameError, {
                retryScheduled: true,
              });
              frameDocumentTimingRef.current = null;
            }
            if (workbenchReadyTimingRef.current?.nonce === frameMount.nonce) {
              workbenchReadyTimingRef.current.timing.cancel(
                "frame-load-failed",
              );
              workbenchReadyTimingRef.current = null;
            }
            frameFailureNonceRef.current = frameMount.nonce;
            setFrameFailureNonce(frameMount.nonce);
            setError(frameError.message);
            scheduleFrameRetry(bindingKey, frameMount.nonce);
          }}
          onLoad={() => {
            if (!frameMount) {
              return;
            }
            const repeated = frameLoadsRef.current.observe(frameMount.nonce);
            clientLogger.info("Explorer Code frame document loaded", {
              ...explorerFileIntentContext(explorerId),
              attachmentId: preferredAttachment.attachment.attachmentId,
              attemptKind: repeated ? "repeated-document" : "initial-document",
              editorInstanceId,
              event: "code.editor.frame.loaded",
              explorerId,
              operation: "load-frame-document",
              status: "completed",
              subsystem: "code",
              workerId,
              worktreeId,
            });
            if (!repeated) return;
            if (frameDocumentTimingRef.current?.nonce === frameMount.nonce) {
              frameDocumentTimingRef.current.timing.complete({
                attachmentId: preferredAttachment.attachment.attachmentId,
              });
              frameDocumentTimingRef.current = null;
            }
            setFrameReadyNonce(null);
            setFrameFailureNonce(null);
            frameFailureNonceRef.current = null;
            setReadyKey(null);
            setError(null);
            if (!startupEligibleRef.current) {
              frameRetryPendingRef.current = true;
              return;
            }
            setFrameDocumentVersion((version) => version + 1);
          }}
          ref={frameRef}
          referrerPolicy="no-referrer"
          src={frameMount?.url}
          tabIndex={ready ? 0 : -1}
          title={path ? `Cantrip Code — ${path}` : "Cantrip Code"}
        />
      ) : null}

      {!closing && !ready ? (
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
