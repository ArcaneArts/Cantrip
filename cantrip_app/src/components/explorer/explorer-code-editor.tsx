import type {
  CodeAppearance,
  CodeProtectedAttachmentWire,
} from "@cantrip/protocol";
import { isTauri } from "@tauri-apps/api/core";
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
  CodeControlOperationTimeoutError,
  CodeAttachmentHealthError,
  openDirectCodeAttachmentFile,
  preferProtectedCodeAttachment,
  preferSharedProtectedCodeAttachment,
  recoverPreferredCodeAttachmentRoute,
  retainSharedProtectedCodeAttachmentLease,
  setDirectCodeAttachmentPresentation,
  setDirectCodeAttachmentTheme,
  stopDirectCodeAttachment,
  stopSharedProtectedCodeAttachment,
  subscribePreferredCodeAttachmentUnavailable,
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

const FILE_OPEN_RETRY_DELAY_MS = 250;
const FILE_OPEN_RECONNECT_LIMIT = 1;
const FILE_OPEN_TIMEOUT_MS = 3_000;
const THEME_UPDATE_RETRY_DELAY_MS = 500;
const SHARED_SESSION_RENEWAL_MAX_DELAY_MS = 5 * 60_000;
const SHARED_SESSION_RENEWAL_MIN_DELAY_MS = 30_000;
const AUTOMATIC_REPLACEMENT_EXHAUSTED_MESSAGE =
  "Cantrip Code could not restore this editor automatically. Retry to reconnect.";
const SHARED_TRANSPORT_FALLBACK_CODES = new Set([
  "shared-code-transport-requires-single-server",
  "shared-code-transport-unsupported",
]);
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

export function allowsLegacyExplorerCodeFallback(error: unknown): boolean {
  return (
    error instanceof CantripApiError &&
    error.status === 409 &&
    error.code !== null &&
    SHARED_TRANSPORT_FALLBACK_CODES.has(error.code)
  );
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
): "error" | "recover-route" | "replace-attachment" | "retry" {
  const controlTimeout = isCodeControlOperationTimeout(error);
  const transient = isTransientFileOpenFailure(error);
  if (controlTimeout) return "replace-attachment";
  if (attempt === 0 && transient) return "retry";
  if (transient && automaticReconnects < FILE_OPEN_RECONNECT_LIMIT) {
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
  explorerId,
  onLifecycleChange,
  onReady,
  onWorkbenchReadinessChange,
  path,
  worktreeId,
  workerId,
  workerOnline = true,
}: {
  active?: boolean;
  appearance: CodeAppearance;
  explorerId: string;
  onLifecycleChange?(actions: ExplorerCodeEditorLifecycleActions | null): void;
  onReady?: () => void;
  onWorkbenchReadinessChange?(ready: boolean): void;
  path: string | null;
  worktreeId: string;
  workerId: string;
  workerOnline?: boolean;
}) {
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
  const [workbenchReadyKey, setWorkbenchReadyKey] = useState<string | null>(
    null,
  );
  const [reloadVersion, setReloadVersion] = useState(0);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [closing, setClosing] = useState(false);
  const [navigationRecoveryAttempt, setNavigationRecoveryAttempt] = useState(0);
  const [themeRecoveryAttempt, setThemeRecoveryAttempt] = useState(0);
  const [sharedTransportRecoveryAttempt, setSharedTransportRecoveryAttempt] =
    useState(0);
  const automaticReconnectsRef = useRef(0);
  const automaticReplacementCountRef = useRef(0);
  const automaticReplacementPendingRef = useRef(false);
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
  const navigationRetryCountRef = useRef(0);
  const navigationRetryIdentityRef = useRef<string | null>(null);
  const navigationRetryPendingRef = useRef(false);
  const navigationRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastSharedRecoveryAttemptRef = useRef(0);
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
  const onWorkbenchReadinessChangeRef = useRef(onWorkbenchReadinessChange);
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
    appearanceRef.current = appearance;
    bindingKeyRef.current = bindingKey;
    frameMountRef.current = frameMount;
    onReadyRef.current = onReady;
    onWorkbenchReadinessChangeRef.current = onWorkbenchReadinessChange;
    pathRef.current = path;
    preferredAttachmentRef.current = preferredAttachment;
    workerOnlineRef.current = workerOnline;
  }, [
    appearance,
    bindingKey,
    frameMount,
    onReady,
    onWorkbenchReadinessChange,
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
  const workbenchReady = Boolean(
    !closing &&
    frameReady &&
    workbenchGenerationKey !== null &&
    workbenchReadyKey === workbenchGenerationKey,
  );
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
    !closing &&
    path !== null &&
    frameReady &&
    readyKey !== null &&
    readyKey === requestedReadyKey,
  );
  const editorDiagnosticStateRef = useRef({
    active,
    closing,
    hasAttachment: preferredAttachment !== null,
    pathPresent: path !== null,
    ready,
  });
  editorDiagnosticStateRef.current = {
    active,
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
    startLaunchTiming(path, "request-superseded");
  }, [path, startLaunchTiming]);

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
    onWorkbenchReadinessChangeRef.current?.(workbenchReady);
  }, [workbenchReady]);

  useEffect(() => {
    if (!ready || !preferredAttachment) return;
    launchTimingRef.current?.complete({
      attachmentId: preferredAttachment.attachment.attachmentId,
      sessionId: preferredAttachment.attachment.sessionId,
      transportKind: preferredAttachment.transportKind,
    });
    onReadyRef.current?.();
  }, [preferredAttachment, ready]);

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
    automaticReplacementCountRef.current = 0;
    automaticReplacementPendingRef.current = true;
    setError(null);
    setReloadVersion((version) => version + 1);
  }, [startLaunchTiming]);

  const requestAutomaticReplacement = useCallback(
    (expectedBindingKey: string): boolean => {
      if (
        closingRef.current ||
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
        closingRef.current ||
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
        closingRef.current ||
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
        clientLogger.info("Explorer Code attachment replacement requested", {
          ...explorerFileIntentContext(explorerId),
          editorInstanceId,
          event: "code.editor.attachment.replace-requested",
          explorerId,
          operation: "replace-attachment",
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
                !isTauri() && allowsLegacyExplorerCodeFallback(sharedError);
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
          if (
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
    if (closing || !preferredAttachment) return;
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
    appearance,
    closing,
    explorerId,
    preferredAttachment,
    themeRecoveryAttempt,
  ]);

  useEffect(() => {
    automaticReconnectsRef.current = 0;
  }, [path]);

  useEffect(() => {
    if (closing || !preferredAttachment) return;
    return subscribePreferredCodeAttachmentUnavailable(
      preferredAttachment,
      () => {
        if (preferredAttachment.sharedOwnedAttachment) {
          setSharedTransportRecoveryAttempt((attempt) => attempt + 1);
          return;
        }
        requestAutomaticReplacement(bindingKey);
      },
    );
  }, [bindingKey, closing, preferredAttachment, requestAutomaticReplacement]);

  useEffect(() => {
    if (
      closing ||
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
            "Shared Cantrip Code recovery omitted its exact native lease.",
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
        setPreferredAttachment(recovered);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) requestAutomaticReplacement(expectedBindingKey);
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
    requestAutomaticReplacement,
    sharedTransportRecoveryAttempt,
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
        if (
          renewalError instanceof CantripApiError &&
          [401, 403, 404, 409, 410].includes(renewalError.status)
        ) {
          requestAutomaticReplacement(bindingKey);
          return;
        }
        const expiresInMs =
          Date.parse(current.attachment.session.expiresAt) - Date.now();
        if (expiresInMs <= SHARED_SESSION_RENEWAL_MIN_DELAY_MS) {
          requestAutomaticReplacement(bindingKey);
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
  }, [bindingKey, closing, preferredAttachment, requestAutomaticReplacement]);

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
    };
    window.addEventListener("message", receiveReady);
    const timeout = setTimeout(() => {
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
    return () => {
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", receiveReady);
    };
  }, [
    bindingKey,
    editorInstanceId,
    explorerId,
    frameFailureNonce,
    frameMount,
    scheduleFrameRetry,
    workerId,
    worktreeId,
  ]);

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
    let presentationRecorded = false;
    const markWorkbenchReady = () => {
      if (workbenchGenerationKey) {
        setWorkbenchReadyKey(workbenchGenerationKey);
      }
    };
    const recordCachedPresentation = () => {
      if (presentationRecorded) return;
      presentationRecorded = true;
      markWorkbenchReady();
      launchTimingRef.current?.milestone("presentation-ready", {
        attachmentId: preferredAttachment.attachment.attachmentId,
        reused: true,
      });
    };
    const setPresentation = async () => {
      const presentationTiming =
        launchTimingRef.current?.beginPhase("presentation-ready");
      try {
        await setDirectCodeAttachmentPresentation(
          preferredAttachment.attachment,
          "editor",
          { signal: navigationController.signal },
        );
        presentationRecorded = true;
        markWorkbenchReady();
        presentationTiming?.complete({
          attachmentId: preferredAttachment.attachment.attachmentId,
          reused: false,
        });
      } catch (presentationError) {
        presentationTiming?.fail(presentationError);
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
            recordCachedPresentation();
            markWorkbenchReady();
            resetNavigationRetry();
            setError(null);
            setReadyKey(null);
            launchTimingRef.current?.complete({
              attachmentId: preferredAttachment.attachment.attachmentId,
              prewarmed: true,
              sessionId: preferredAttachment.attachment.sessionId,
              transportKind: preferredAttachment.transportKind,
            });
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
            recordCachedPresentation();
            const fileTiming = launchTimingRef.current?.beginPhase("file-open");
            try {
              const opened = await openDirectCodeAttachmentFile(
                preferredAttachment.attachment,
                path,
                {
                  signal: navigationController.signal,
                  timeoutMs: FILE_OPEN_TIMEOUT_MS,
                },
              );
              fileTiming?.complete({
                attachmentId: preferredAttachment.attachment.attachmentId,
                openAttempt: attempt + 1,
              });
              return opened;
            } catch (fileError) {
              fileTiming?.fail(fileError, { openAttempt: attempt + 1 });
              throw codeWorkbenchStageError("file", fileError);
            }
          },
          presentation: presentationRef.current,
          setPresentation,
          signal: navigationController.signal,
        });
        if (!cancelled && result.relativePath === path) {
          markWorkbenchReady();
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
        if (recovery === "replace-attachment") {
          requestAutomaticReplacement(bindingKey);
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
        launchTimingRef.current?.fail(
          explorerCodeLaunchFailurePhase(openError, "file-open"),
          openError,
          { openAttempt: attempt + 1 },
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
