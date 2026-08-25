import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  codeOpenFileResultSchema,
  codeOpenSettingsResultSchema,
  codePresentationUpdateSchema,
  type CodeAttachment,
  type CodeProtectedAttachmentWire,
  type CodeOpenFileResult,
  type CodePresentationUpdate,
} from "@cantrip/protocol";

import {
  browserCodeAttachmentHealthy,
  startBrowserCodeAttachment,
  stopBrowserCodeAttachment,
} from "@/lib/browser-code-tunnel";
import { clientLogger } from "@/lib/client-log-relay";
import {
  forceDesktopTunnelRelay,
  listDesktopTunnelsWithOptions,
  startDesktopTunnel,
  stopDesktopTunnel,
  type DesktopTunnelDestinationRejectionCode,
  type DesktopTunnelForwardIdentity,
  type DesktopTunnelForwardSummary,
} from "@/lib/desktop-tunnel";

export interface PreferredCodeAttachment {
  attachment: CodeAttachment;
  desktopRouteIdentity: DesktopTunnelForwardIdentity | null;
  directTunnelId: string | null;
  transportKind: "local-direct" | "relay";
}

export type CodeAttachmentRouteRecoveryState =
  "available" | "recovering" | "replace-required";

const protectedAttachmentIdentities = new WeakMap<
  object,
  DesktopTunnelForwardIdentity
>();
const CODE_ATTACHMENT_HEALTH_ATTEMPTS = 100;
const CODE_ATTACHMENT_HEALTH_RETRY_MS = 50;
const CODE_ATTACHMENT_HEALTH_ATTEMPT_TIMEOUT_MS = 750;
const CODE_ATTACHMENT_HEALTH_TOTAL_TIMEOUT_MS = 8_000;
const CODE_ATTACHMENT_DIRECT_HEALTH_TIMEOUT_MS = 2_500;
const CODE_ATTACHMENT_ROUTE_PROBE_TIMEOUT_MS = 1_000;
const CODE_ATTACHMENT_ROUTE_RECOVERY_TIMEOUT_MS = 10_000;
export const CODE_CONTROL_OPERATION_TIMEOUT_MS = 10_000;
const MAX_CODE_ATTACHMENT_HEALTH_ATTEMPTS = 100;
const MAX_CODE_ATTACHMENT_HEALTH_ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_CODE_ATTACHMENT_HEALTH_RETRY_MS = 1_000;
const MAX_CODE_ATTACHMENT_HEALTH_TOTAL_TIMEOUT_MS = 10_000;
const TRANSPORT_ERROR_CLASSES = new Set([
  "AbortError",
  "DOMException",
  "Error",
  "FetchError",
  "NetworkError",
  "TimeoutError",
  "TypeError",
]);
const TRANSPORT_ERROR_CODES = new Set([
  "ABORT_ERR",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_CANCELED",
  "ERR_NETWORK",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const routeRecoveries = new Map<
  string,
  {
    identityKey: string;
    operation: Promise<CodeAttachmentRouteRecoveryState>;
  }
>();

function transportErrorProperty(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}

export function transportSafeErrorIdentity(error: unknown): {
  errorClass: string;
  errorCode?: string;
  errorStatus?: number;
} {
  const candidateName = transportErrorProperty(error, "name");
  const errorClass =
    typeof candidateName === "string" &&
    TRANSPORT_ERROR_CLASSES.has(candidateName)
      ? candidateName
      : "Error";
  const candidateCode = transportErrorProperty(error, "code");
  const candidateStatus = transportErrorProperty(error, "status");
  return {
    errorClass,
    ...(typeof candidateCode === "string" &&
    TRANSPORT_ERROR_CODES.has(candidateCode)
      ? { errorCode: candidateCode }
      : {}),
    ...(typeof candidateStatus === "number" && Number.isFinite(candidateStatus)
      ? { errorStatus: candidateStatus }
      : {}),
  };
}

export type CodeAttachmentHealthFailureKind =
  "attempt-timeout" | "http-response" | "network-error" | "total-timeout";

export class CodeAttachmentHealthError extends Error {
  readonly attemptCount: number;
  readonly destinationRejectionCode?: DesktopTunnelDestinationRejectionCode;
  readonly failureKind: CodeAttachmentHealthFailureKind;
  readonly statusCode?: number;

  constructor(options: {
    attemptCount: number;
    cause?: unknown;
    destinationRejectionCode?: DesktopTunnelDestinationRejectionCode;
    failureKind: CodeAttachmentHealthFailureKind;
    statusCode?: number;
  }) {
    super(
      options.destinationRejectionCode
        ? `Cantrip Code transport was rejected (${options.destinationRejectionCode}).`
        : options.failureKind === "http-response"
          ? `Cantrip Code returned HTTP ${options.statusCode ?? 500}.`
          : options.failureKind === "network-error"
            ? "Cantrip Code could not be reached."
            : "Cantrip Code did not respond before the readiness deadline.",
      { cause: options.cause },
    );
    this.name = "CodeAttachmentHealthError";
    this.attemptCount = options.attemptCount;
    this.destinationRejectionCode = options.destinationRejectionCode;
    this.failureKind = options.failureKind;
    this.statusCode = options.statusCode;
  }

  get relayFallbackEligible(): boolean {
    return this.failureKind !== "http-response";
  }
}

export class CodeControlOperationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs = CODE_CONTROL_OPERATION_TIMEOUT_MS) {
    super("Cantrip Code control request timed out.");
    this.name = "CodeControlOperationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

async function boundedCodeControlOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const timeoutController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  let rejectFromAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectFromAbort = reject;
  });
  const onAbort = () =>
    rejectFromAbort(
      signal.reason ??
        new DOMException("The operation was aborted.", "AbortError"),
    );
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timeout = setTimeout(() => {
    timeoutController.abort(new CodeControlOperationTimeoutError());
  }, CODE_CONTROL_OPERATION_TIMEOUT_MS);
  try {
    return await Promise.race([operation(signal), aborted]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

function withDestinationRejection(
  error: unknown,
  destinationRejectionCode:
    DesktopTunnelDestinationRejectionCode | null | undefined,
): unknown {
  if (
    !destinationRejectionCode ||
    !(error instanceof CodeAttachmentHealthError)
  ) {
    return error;
  }
  if (error.destinationRejectionCode === destinationRejectionCode) return error;
  return new CodeAttachmentHealthError({
    attemptCount: error.attemptCount,
    cause: error,
    destinationRejectionCode,
    failureKind: error.failureKind,
    statusCode: error.statusCode,
  });
}

interface DesktopTunnelRejectionSnapshot {
  count: number;
  code: DesktopTunnelDestinationRejectionCode | null;
}

async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function currentDestinationRejectionSnapshot(
  tunnelId: string,
  signal?: AbortSignal,
): Promise<DesktopTunnelRejectionSnapshot> {
  const current = (
    await awaitWithAbort(
      invoke<
        Array<{
          destinationRejectedCount?: number;
          lastDestinationRejectionCode?: DesktopTunnelDestinationRejectionCode | null;
          tunnelId: string;
        }>
      >("list_tunnel_forwards").catch(() => []),
      signal,
    )
  ).find((candidate) => candidate.tunnelId === tunnelId);
  return {
    code: current?.lastDestinationRejectionCode ?? null,
    count: current?.destinationRejectedCount ?? 0,
  };
}

async function currentDestinationRejection(
  tunnelId: string,
  fallback: DesktopTunnelDestinationRejectionCode | null | undefined,
  signal?: AbortSignal,
): Promise<DesktopTunnelDestinationRejectionCode | null> {
  return (
    (await currentDestinationRejectionSnapshot(tunnelId, signal)).code ??
    fallback ??
    null
  );
}

class CodeAttachmentAttemptTimeout extends Error {}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  minimum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function monotonicNow(): number {
  return performance.now();
}

async function fetchCodeAttachmentHealth(
  endpoint: URL,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectCallerAbort: ((reason?: unknown) => void) | undefined;
  const onCallerAbort = () => {
    controller.abort();
    rejectCallerAbort?.(signal?.reason);
  };
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    return await Promise.race([
      fetch(endpoint, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new CodeAttachmentAttemptTimeout());
          controller.abort();
        }, timeoutMs);
      }),
      ...(signal
        ? [
            new Promise<never>((_, reject) => {
              rejectCallerAbort = reject;
              if (signal.aborted) onCallerAbort();
            }),
          ]
        : []),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

async function abortableDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function waitForDirectCodeAttachmentReady(
  attachment: Pick<CodeAttachment, "url">,
  options: {
    attachmentId?: string;
    attemptTimeoutMs?: number;
    attempts?: number;
    diagnosticTraceId?: string;
    destinationRejectionBaseline?: number;
    healthPhase?: "direct" | "initial" | "relay";
    retryDelayMs?: number;
    signal?: AbortSignal;
    sessionId?: string;
    totalTimeoutMs?: number;
    tunnelId?: string;
  } = {},
): Promise<void> {
  const attempts = boundedInteger(
    options.attempts,
    CODE_ATTACHMENT_HEALTH_ATTEMPTS,
    MAX_CODE_ATTACHMENT_HEALTH_ATTEMPTS,
    1,
  );
  const attemptTimeoutMs = boundedInteger(
    options.attemptTimeoutMs,
    CODE_ATTACHMENT_HEALTH_ATTEMPT_TIMEOUT_MS,
    MAX_CODE_ATTACHMENT_HEALTH_ATTEMPT_TIMEOUT_MS,
    1,
  );
  const retryDelayMs = boundedInteger(
    options.retryDelayMs,
    CODE_ATTACHMENT_HEALTH_RETRY_MS,
    MAX_CODE_ATTACHMENT_HEALTH_RETRY_MS,
    0,
  );
  const totalTimeoutMs = boundedInteger(
    options.totalTimeoutMs,
    CODE_ATTACHMENT_HEALTH_TOTAL_TIMEOUT_MS,
    MAX_CODE_ATTACHMENT_HEALTH_TOTAL_TIMEOUT_MS,
    1,
  );
  const diagnosticTraceId = options.diagnosticTraceId ?? crypto.randomUUID();
  const endpoint = new URL("_cantrip/health", attachment.url);
  const startedAtMs = monotonicNow();
  const deadlineMs = startedAtMs + totalTimeoutMs;
  let lastError: unknown = new Error("Cantrip Code is unavailable.");
  let lastAttemptKind: CodeAttachmentHealthFailureKind = "network-error";
  let lastStatusCode: number | undefined;
  let attempted = 0;
  const initialRejectionCount =
    typeof options.destinationRejectionBaseline === "number" &&
    Number.isSafeInteger(options.destinationRejectionBaseline) &&
    options.destinationRejectionBaseline >= 0
      ? options.destinationRejectionBaseline
      : 0;
  clientLogger.event("info", "Cantrip Code health check started", {
    attachmentId: options.attachmentId,
    attemptLimit: attempts,
    attemptTimeoutMs,
    diagnosticTraceId,
    event: "code.attachment.health.started",
    healthPhase: options.healthPhase ?? "initial",
    operation: "check-health",
    status: "started",
    subsystem: "code",
    sessionId: options.sessionId,
    totalTimeoutMs,
    tunnelId: options.tunnelId,
  });
  let cancellationLogged = false;
  const throwIfCancelled = (): void => {
    if (!options.signal?.aborted) return;
    if (!cancellationLogged) {
      cancellationLogged = true;
      clientLogger.event("info", "Cantrip Code health check cancelled", {
        attachmentId: options.attachmentId,
        attemptCount: attempted,
        diagnosticTraceId,
        durationMs: Math.round(monotonicNow() - startedAtMs),
        event: "code.attachment.health.cancelled",
        healthPhase: options.healthPhase ?? "initial",
        operation: "check-health",
        reasonCode: "cancelled",
        status: "cancelled",
        subsystem: "code",
        sessionId: options.sessionId,
        tunnelId: options.tunnelId,
      });
    }
    options.signal.throwIfAborted();
  };
  throwIfCancelled();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingMs = deadlineMs - monotonicNow();
    if (remainingMs <= 0) {
      lastAttemptKind = "total-timeout";
      break;
    }
    attempted = attempt + 1;
    try {
      const response = await fetchCodeAttachmentHealth(
        endpoint,
        Math.max(1, Math.min(attemptTimeoutMs, remainingMs)),
        options.signal,
      );
      if (response.ok) {
        clientLogger.event("info", "Cantrip Code health check completed", {
          attachmentId: options.attachmentId,
          attemptCount: attempted,
          attemptKind: "http-response",
          diagnosticTraceId,
          durationMs: Math.round(monotonicNow() - startedAtMs),
          event: "code.attachment.health.completed",
          healthPhase: options.healthPhase ?? "initial",
          operation: "check-health",
          status: "completed",
          subsystem: "code",
          sessionId: options.sessionId,
          tunnelId: options.tunnelId,
        });
        return;
      }
      lastAttemptKind = "http-response";
      lastStatusCode = response.status;
      lastError = new CodeAttachmentHealthError({
        attemptCount: attempted,
        failureKind: "http-response",
        statusCode: response.status,
      });
      break;
    } catch (error) {
      throwIfCancelled();
      lastAttemptKind =
        error instanceof CodeAttachmentAttemptTimeout
          ? monotonicNow() >= deadlineMs
            ? "total-timeout"
            : "attempt-timeout"
          : "network-error";
      lastStatusCode = undefined;
      lastError = error;
      if (options.tunnelId) {
        const rejection = await currentDestinationRejectionSnapshot(
          options.tunnelId,
          options.signal,
        );
        throwIfCancelled();
        if (rejection.code && rejection.count > initialRejectionCount) {
          lastError = new CodeAttachmentHealthError({
            attemptCount: attempted,
            cause: error,
            destinationRejectionCode: rejection.code,
            failureKind: lastAttemptKind,
          });
          break;
        }
      }
    }
    if (attempt + 1 < attempts && monotonicNow() < deadlineMs) {
      try {
        await abortableDelay(
          Math.max(0, Math.min(retryDelayMs, deadlineMs - monotonicNow())),
          options.signal,
        );
      } catch (error) {
        throwIfCancelled();
        throw error;
      }
    }
  }
  if (monotonicNow() >= deadlineMs && lastAttemptKind !== "http-response") {
    lastAttemptKind = "total-timeout";
  }
  const healthError =
    lastError instanceof CodeAttachmentHealthError
      ? lastError
      : new CodeAttachmentHealthError({
          attemptCount: attempted,
          cause: lastError,
          failureKind: lastAttemptKind,
        });
  clientLogger.event("warn", "Cantrip Code health check failed", {
    ...transportSafeErrorIdentity(lastError),
    attemptCount: attempted,
    attemptKind: lastAttemptKind,
    attachmentId: options.attachmentId,
    diagnosticTraceId,
    durationMs: Math.round(monotonicNow() - startedAtMs),
    event: "code.attachment.health.failed",
    healthPhase: options.healthPhase ?? "initial",
    operation: "check-health",
    reasonCode: lastAttemptKind,
    status: "failed",
    ...(lastStatusCode === undefined ? {} : { statusCode: lastStatusCode }),
    subsystem: "code",
    sessionId: options.sessionId,
    tunnelId: options.tunnelId,
  });
  throw healthError;
}

export async function preferProtectedCodeAttachment(
  wire: CodeProtectedAttachmentWire,
  options: { signal?: AbortSignal } = {},
): Promise<PreferredCodeAttachment> {
  options.signal?.throwIfAborted();
  if (!isTauri()) {
    return {
      attachment: await startBrowserCodeAttachment(wire),
      desktopRouteIdentity: null,
      directTunnelId: wire.tunnelId,
      transportKind: "relay",
    };
  }
  const diagnosticTraceId = crypto.randomUUID();
  let forward = await startDesktopTunnel(wire.tunnelId, {
    diagnosticTraceId,
  });
  const readinessStartedAtMs = monotonicNow();
  try {
    const url = new URL(
      `http://${forward.localHost}:${forward.localPort}/code/`,
    );
    if (wire.runtime.workspaceUri) {
      const workspace = new URL(wire.runtime.workspaceUri);
      if (workspace.protocol !== "file:") {
        throw new Error("Cantrip Code supplied an invalid workspace URI.");
      }
      url.searchParams.set("workspace", decodeURIComponent(workspace.pathname));
    }
    const attachment = {
      attachmentId: wire.attachmentId,
      sessionId: wire.sessionId,
      url: url.toString(),
      expiresAt: wire.expiresAt,
      runtime: wire.runtime,
    } satisfies CodeAttachment;
    try {
      await waitForDirectCodeAttachmentReady(attachment, {
        attachmentId: wire.attachmentId,
        diagnosticTraceId,
        destinationRejectionBaseline: forward.destinationRejectedCount ?? 0,
        healthPhase: forward.routeState === "local-direct" ? "direct" : "relay",
        sessionId: wire.sessionId,
        signal: options.signal,
        totalTimeoutMs:
          forward.routeState === "local-direct"
            ? CODE_ATTACHMENT_DIRECT_HEALTH_TIMEOUT_MS
            : CODE_ATTACHMENT_HEALTH_TOTAL_TIMEOUT_MS,
        tunnelId: wire.tunnelId,
      });
      if (
        forward.routeState === "local-direct" &&
        forward.relayFallbackAvailable
      ) {
        const currentRoute = (
          await invoke<Array<{ routeState: string; tunnelId: string }>>(
            "list_tunnel_forwards",
          )
        ).find((candidate) => candidate.tunnelId === wire.tunnelId);
        if (!currentRoute) {
          throw new Error("The desktop tunnel stopped during Code readiness.");
        }
        if (
          currentRoute.routeState === "relayed" ||
          currentRoute.routeState === "degraded"
        ) {
          forward = await forceDesktopTunnelRelay(forward, {
            signal: options.signal,
          });
          const remainingHealthMs = Math.floor(
            CODE_ATTACHMENT_HEALTH_TOTAL_TIMEOUT_MS -
              (monotonicNow() - readinessStartedAtMs),
          );
          if (remainingHealthMs <= 0) {
            throw new CodeAttachmentHealthError({
              attemptCount: 0,
              failureKind: "total-timeout",
            });
          }
          await waitForDirectCodeAttachmentReady(attachment, {
            attachmentId: wire.attachmentId,
            diagnosticTraceId,
            destinationRejectionBaseline: forward.destinationRejectedCount ?? 0,
            healthPhase: "relay",
            sessionId: wire.sessionId,
            signal: options.signal,
            totalTimeoutMs: remainingHealthMs,
            tunnelId: wire.tunnelId,
          });
        } else if (currentRoute.routeState !== "local-direct") {
          throw new Error(
            "The desktop tunnel returned an invalid route state.",
          );
        }
      }
    } catch (error) {
      if (!(error instanceof CodeAttachmentHealthError)) {
        throw error;
      }
      const destinationRejectionCode = await currentDestinationRejection(
        wire.tunnelId,
        forward.lastDestinationRejectionCode,
        options.signal,
      );
      options.signal?.throwIfAborted();
      if (destinationRejectionCode) {
        clientLogger.event("warn", "Cantrip Code destination rejected", {
          attachmentId: wire.attachmentId,
          diagnosticTraceId,
          event: "code.attachment.destination.rejected",
          operation: "check-health",
          reasonCode: destinationRejectionCode,
          sessionId: wire.sessionId,
          status: "rejected",
          subsystem: "code",
          tunnelId: wire.tunnelId,
        });
      }
      if (
        !error.relayFallbackEligible ||
        forward.routeState !== "local-direct" ||
        !forward.relayFallbackAvailable
      ) {
        throw withDestinationRejection(error, destinationRejectionCode);
      }
      forward = await forceDesktopTunnelRelay(forward, {
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
      const remainingHealthMs = Math.floor(
        CODE_ATTACHMENT_HEALTH_TOTAL_TIMEOUT_MS -
          (monotonicNow() - readinessStartedAtMs),
      );
      if (remainingHealthMs <= 0) {
        throw new CodeAttachmentHealthError({
          attemptCount: 0,
          cause: error,
          failureKind: "total-timeout",
        });
      }
      try {
        await waitForDirectCodeAttachmentReady(attachment, {
          attachmentId: wire.attachmentId,
          diagnosticTraceId,
          destinationRejectionBaseline: forward.destinationRejectedCount ?? 0,
          healthPhase: "relay",
          sessionId: wire.sessionId,
          signal: options.signal,
          totalTimeoutMs: remainingHealthMs,
          tunnelId: wire.tunnelId,
        });
      } catch (relayError) {
        if (!(relayError instanceof CodeAttachmentHealthError)) {
          throw relayError;
        }
        const relayDestinationRejection = await currentDestinationRejection(
          wire.tunnelId,
          forward.lastDestinationRejectionCode ?? destinationRejectionCode,
          options.signal,
        );
        options.signal?.throwIfAborted();
        throw withDestinationRejection(relayError, relayDestinationRejection);
      }
    }
    const desktopRouteIdentity = {
      attachmentId: forward.attachmentId,
      directCapabilityId: forward.directCapabilityId,
    };
    protectedAttachmentIdentities.set(wire, desktopRouteIdentity);
    return {
      attachment,
      desktopRouteIdentity,
      directTunnelId: wire.tunnelId,
      transportKind:
        forward.routeState === "local-direct" ? "local-direct" : "relay",
    };
  } catch (error) {
    await stopDesktopTunnel(wire.tunnelId, forward.attachmentId, {
      attachmentId: forward.attachmentId,
      directCapabilityId: forward.directCapabilityId,
    }).catch(() => undefined);
    throw error;
  }
}

async function codeAttachmentRouteResponds(
  attachment: Pick<CodeAttachment, "url">,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await fetchCodeAttachmentHealth(
      new URL("_cantrip/health", attachment.url),
      CODE_ATTACHMENT_ROUTE_PROBE_TIMEOUT_MS,
      signal,
    );
    // The route is reachable once the authenticated endpoint responds. A Code
    // 5xx is an application failure, not evidence that the tunnel is broken.
    return true;
  } catch {
    return false;
  }
}

function desktopRouteIdentityKey(preferred: PreferredCodeAttachment): string {
  const identity = preferred.desktopRouteIdentity;
  return [
    preferred.attachment.attachmentId,
    identity?.attachmentId ?? "browser",
    identity?.directCapabilityId ?? "none",
  ].join("\0");
}

function exactDesktopForward(
  preferred: PreferredCodeAttachment,
  forwards: readonly DesktopTunnelForwardSummary[],
): DesktopTunnelForwardSummary | null | "mismatch" {
  const tunnelId = preferred.directTunnelId;
  const identity = preferred.desktopRouteIdentity;
  if (!tunnelId || !identity) return "mismatch";
  const forward = forwards.find((candidate) => candidate.tunnelId === tunnelId);
  if (!forward) return null;
  if (forward.attachmentId !== identity.attachmentId) return "mismatch";
  const capabilityMatches =
    forward.directCapabilityId === identity.directCapabilityId;
  const capabilityRetiredAfterFallback =
    identity.directCapabilityId !== null &&
    forward.directCapabilityId === null &&
    (forward.routeState === "degraded" || forward.routeState === "relayed");
  if (!capabilityMatches && !capabilityRetiredAfterFallback) {
    return "mismatch";
  }
  // A successful direct-to-relay fallback retires the capability, so a
  // relayed forward is expected to report directCapabilityId=null.
  return forward;
}

async function performPreferredCodeAttachmentRouteRecovery(
  preferred: PreferredCodeAttachment,
): Promise<CodeAttachmentRouteRecoveryState> {
  const tunnelId = preferred.directTunnelId;
  if (!tunnelId) return "available";
  if (!isTauri()) {
    try {
      return (await browserCodeAttachmentHealthy(tunnelId))
        ? "available"
        : "replace-required";
    } catch {
      return "recovering";
    }
  }
  if (!preferred.desktopRouteIdentity) return "replace-required";

  const signal = AbortSignal.timeout(CODE_ATTACHMENT_ROUTE_RECOVERY_TIMEOUT_MS);
  let forwards: DesktopTunnelForwardSummary[];
  try {
    forwards = await listDesktopTunnelsWithOptions({ signal });
  } catch {
    return "recovering";
  }
  const exact = exactDesktopForward(preferred, forwards);
  if (exact === null || exact === "mismatch") return "replace-required";
  if (exact.routeState === "degraded") return "recovering";
  if (await codeAttachmentRouteResponds(preferred.attachment, signal)) {
    return "available";
  }
  if (
    exact.routeState !== "local-direct" ||
    !exact.relayFallbackAvailable ||
    !exact.directCapabilityId
  ) {
    return "recovering";
  }
  if (await codeAttachmentRouteResponds(preferred.attachment, signal)) {
    return "available";
  }

  try {
    const relayed = await forceDesktopTunnelRelay(exact, { signal });
    if (
      relayed.tunnelId !== tunnelId ||
      relayed.attachmentId !== preferred.desktopRouteIdentity.attachmentId ||
      relayed.routeState !== "relayed"
    ) {
      return "replace-required";
    }
    return (await codeAttachmentRouteResponds(preferred.attachment, signal))
      ? "available"
      : "recovering";
  } catch {
    return "recovering";
  }
}

export function recoverPreferredCodeAttachmentRoute(
  preferred: PreferredCodeAttachment,
  options: { signal?: AbortSignal } = {},
): Promise<CodeAttachmentRouteRecoveryState> {
  options.signal?.throwIfAborted();
  const tunnelId = preferred.directTunnelId;
  if (!tunnelId) return Promise.resolve("available");
  const identityKey = desktopRouteIdentityKey(preferred);
  const existing = routeRecoveries.get(tunnelId);
  if (existing) {
    return existing.identityKey === identityKey
      ? awaitWithAbort(existing.operation, options.signal)
      : Promise.resolve("replace-required");
  }
  const operation = performPreferredCodeAttachmentRouteRecovery(
    preferred,
  ).finally(() => {
    if (routeRecoveries.get(tunnelId)?.operation === operation) {
      routeRecoveries.delete(tunnelId);
    }
  });
  routeRecoveries.set(tunnelId, { identityKey, operation });
  return awaitWithAbort(operation, options.signal);
}

export async function directCodeAttachmentHealthy(
  tunnelId: string,
): Promise<boolean> {
  if (!isTauri()) return browserCodeAttachmentHealthy(tunnelId);
  const forwards = await invoke<
    Array<{ routeState: string; tunnelId: string }>
  >("list_tunnel_forwards");
  return forwards.some(
    (forward) =>
      forward.tunnelId === tunnelId && forward.routeState !== "degraded",
  );
}

export async function directCodeAttachmentHealthyWithin(
  tunnelId: string,
  timeoutMs = CODE_ATTACHMENT_DIRECT_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      directCodeAttachmentHealthy(tunnelId),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function openDirectCodeAttachmentFile(
  attachment: CodeAttachment,
  relativePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<CodeOpenFileResult> {
  const endpoint = new URL("_cantrip/open-file", attachment.url);
  return boundedCodeControlOperation(async (signal) => {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ relativePath }),
      credentials: "omit",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : "Cantrip Code could not open this file.";
      throw new Error(message);
    }
    return codeOpenFileResultSchema.parse(body);
  }, options);
}

export async function openDirectCodeAttachmentSettings(
  attachment: CodeAttachment,
  options: { signal?: AbortSignal } = {},
) {
  const endpoint = new URL("_cantrip/open-settings", attachment.url);
  const response = await fetch(endpoint, {
    body: JSON.stringify({}),
    credentials: "omit",
    headers: { "content-type": "application/json" },
    method: "POST",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "Cantrip Code could not open graphical settings.";
    throw new Error(message);
  }
  return codeOpenSettingsResultSchema.parse(body);
}

export async function setDirectCodeAttachmentPresentation(
  attachment: CodeAttachment,
  presentation: "editor",
  options: { signal?: AbortSignal } = {},
): Promise<CodePresentationUpdate> {
  const endpoint = new URL("_cantrip/presentation", attachment.url);
  return boundedCodeControlOperation(async (signal) => {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ presentation }),
      credentials: "omit",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : "Cantrip Code could not enter editor-only mode.";
      throw new Error(message);
    }
    return codePresentationUpdateSchema.parse(body);
  }, options);
}

export async function stopDirectCodeAttachment(
  target: string | null | Pick<CodeProtectedAttachmentWire, "tunnelId">,
  expectedIdentity?: DesktopTunnelForwardIdentity | null,
): Promise<void> {
  const tunnelId =
    typeof target === "string" ? target : (target?.tunnelId ?? null);
  if (!tunnelId) return;
  if (!isTauri()) {
    await stopBrowserCodeAttachment(tunnelId).catch(() => undefined);
    return;
  }
  const exactIdentity =
    expectedIdentity !== undefined
      ? expectedIdentity
      : typeof target === "object" && target !== null
        ? (protectedAttachmentIdentities.get(target) ?? null)
        : null;
  if (!exactIdentity) return;
  if (typeof target === "object" && target !== null) {
    protectedAttachmentIdentities.delete(target);
  }
  await stopDesktopTunnel(
    tunnelId,
    exactIdentity.attachmentId,
    exactIdentity,
  ).catch(() => undefined);
}
