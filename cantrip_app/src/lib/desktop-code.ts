import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  codeOpenFileResultSchema,
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
  startDesktopTunnel,
  stopDesktopTunnel,
  stopDesktopTunnelForward,
} from "@/lib/desktop-tunnel";

export interface PreferredCodeAttachment {
  attachment: CodeAttachment;
  directTunnelId: string | null;
}

const protectedAttachmentIds = new Map<string, string>();
const CODE_ATTACHMENT_HEALTH_ATTEMPTS = 100;
const CODE_ATTACHMENT_HEALTH_RETRY_MS = 50;
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

export async function waitForDirectCodeAttachmentReady(
  attachment: Pick<CodeAttachment, "url">,
  options: {
    attachmentId?: string;
    attempts?: number;
    diagnosticTraceId?: string;
    retryDelayMs?: number;
    sessionId?: string;
    tunnelId?: string;
  } = {},
): Promise<void> {
  const attempts = Math.max(
    1,
    options.attempts ?? CODE_ATTACHMENT_HEALTH_ATTEMPTS,
  );
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? CODE_ATTACHMENT_HEALTH_RETRY_MS,
  );
  const diagnosticTraceId = options.diagnosticTraceId ?? crypto.randomUUID();
  const endpoint = new URL("_cantrip/health", attachment.url);
  const startedAtMs = Date.now();
  let lastError: unknown = new Error("Cantrip Code is unavailable.");
  let lastAttemptKind = "network-error";
  let lastStatusCode: number | undefined;
  clientLogger.event("info", "Cantrip Code health check started", {
    attachmentId: options.attachmentId,
    attemptCount: attempts,
    diagnosticTraceId,
    event: "code.attachment.health.started",
    operation: "check-health",
    status: "started",
    subsystem: "code",
    sessionId: options.sessionId,
    tunnelId: options.tunnelId,
  });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "omit",
      });
      if (response.ok) {
        clientLogger.event("info", "Cantrip Code health check completed", {
          attachmentId: options.attachmentId,
          attemptCount: attempt + 1,
          attemptKind: "http-response",
          diagnosticTraceId,
          durationMs: Date.now() - startedAtMs,
          event: "code.attachment.health.completed",
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
      lastError = new Error(`Cantrip Code returned HTTP ${response.status}.`);
    } catch (error) {
      lastAttemptKind = "network-error";
      lastStatusCode = undefined;
      lastError = error;
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  clientLogger.event("warn", "Cantrip Code health check failed", {
    ...transportSafeErrorIdentity(lastError),
    attemptCount: attempts,
    attemptKind: lastAttemptKind,
    attachmentId: options.attachmentId,
    diagnosticTraceId,
    durationMs: Date.now() - startedAtMs,
    event: "code.attachment.health.failed",
    operation: "check-health",
    reasonCode: lastAttemptKind,
    status: "failed",
    ...(lastStatusCode === undefined ? {} : { statusCode: lastStatusCode }),
    subsystem: "code",
    sessionId: options.sessionId,
    tunnelId: options.tunnelId,
  });
  throw lastError;
}

export async function preferProtectedCodeAttachment(
  wire: CodeProtectedAttachmentWire,
): Promise<PreferredCodeAttachment> {
  if (!isTauri()) {
    return {
      attachment: await startBrowserCodeAttachment(wire),
      directTunnelId: wire.tunnelId,
    };
  }
  const diagnosticTraceId = crypto.randomUUID();
  const forward = await startDesktopTunnel(wire.tunnelId, {
    diagnosticTraceId,
  });
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
    await waitForDirectCodeAttachmentReady(attachment, {
      attachmentId: wire.attachmentId,
      diagnosticTraceId,
      sessionId: wire.sessionId,
      tunnelId: wire.tunnelId,
    });
    protectedAttachmentIds.set(wire.tunnelId, forward.attachmentId);
    return {
      attachment,
      directTunnelId: wire.tunnelId,
    };
  } catch (error) {
    await stopDesktopTunnel(wire.tunnelId, forward.attachmentId).catch(
      () => undefined,
    );
    throw error;
  }
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

export async function openDirectCodeAttachmentFile(
  attachment: CodeAttachment,
  relativePath: string,
): Promise<CodeOpenFileResult> {
  const endpoint = new URL("_cantrip/open-file", attachment.url);
  const response = await fetch(endpoint, {
    body: JSON.stringify({ relativePath }),
    credentials: "omit",
    headers: { "content-type": "application/json" },
    method: "POST",
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
}

export async function setDirectCodeAttachmentPresentation(
  attachment: CodeAttachment,
  presentation: "editor",
): Promise<CodePresentationUpdate> {
  const endpoint = new URL("_cantrip/presentation", attachment.url);
  const response = await fetch(endpoint, {
    body: JSON.stringify({ presentation }),
    credentials: "omit",
    headers: { "content-type": "application/json" },
    method: "POST",
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
}

export async function stopDirectCodeAttachment(
  tunnelId: string | null,
): Promise<void> {
  if (!tunnelId) return;
  if (!isTauri()) {
    await stopBrowserCodeAttachment(tunnelId).catch(() => undefined);
    return;
  }
  const protectedAttachmentId = protectedAttachmentIds.get(tunnelId);
  if (protectedAttachmentId) {
    protectedAttachmentIds.delete(tunnelId);
    await stopDesktopTunnel(tunnelId, protectedAttachmentId).catch(
      () => undefined,
    );
    return;
  }
  await stopDesktopTunnelForward(tunnelId);
}
