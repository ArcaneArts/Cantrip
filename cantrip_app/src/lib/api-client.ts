import {
  getActiveServerConnection,
  getActiveServerUrl,
} from "@/lib/server-connections";
import {
  type ClientSessionContext,
  getClientSession,
  notifyAuthenticationRequired,
  setClientSession,
} from "@/lib/client-session";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";

export class CantripApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

interface ApiErrorBody {
  code?: string;
  error?: string;
  issues?: unknown;
}

function validationIssueDetail(issues: unknown): string | null {
  if (!Array.isArray(issues)) return null;
  const first = issues[0];
  if (typeof first !== "object" || first === null) return null;
  const message = "message" in first ? first.message : null;
  if (typeof message !== "string" || !message.trim()) return null;
  const rawPath = "path" in first ? first.path : null;
  const path = Array.isArray(rawPath)
    ? rawPath
        .filter(
          (segment): segment is number | string =>
            typeof segment === "number" || typeof segment === "string",
        )
        .join(".")
    : "";
  return path ? `${path}: ${message}` : message;
}

function apiErrorMessage(body: ApiErrorBody | null, status: number): string {
  const fallback = `Cantrip Server returned HTTP ${status}.`;
  if (!body?.error) return fallback;
  if (body.error !== "Invalid request body") return body.error;
  const detail = validationIssueDetail(body.issues);
  return detail ? `${body.error}: ${detail}` : body.error;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
let csrfRecovery: Promise<boolean> | null = null;

const identifierSegment =
  /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|\d+)$/iu;

/** Removes origins, queries, and resource identifiers before a route enters logs. */
export function apiRouteTemplate(path: string): string {
  let pathname: string;
  try {
    pathname = new URL(path, "http://cantrip.invalid").pathname;
  } catch {
    return "<invalid-route>";
  }
  return pathname
    .split("/")
    .map((segment) =>
      identifierSegment.test(segment) ||
      (/^[A-Za-z0-9_-]{20,}$/u.test(segment) && !segment.includes("."))
        ? ":id"
        : segment,
    )
    .join("/");
}

function responseRequestId(response: Response): string | undefined {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("x-cantrip-request-id") ??
    undefined
  );
}

async function recoverCsrfSession(): Promise<boolean> {
  if (csrfRecovery) return csrfRecovery;
  const previous = getClientSession();
  if (!previous || previous.authMode === "none") return false;

  csrfRecovery = (async () => {
    const startedAt = performance.now();
    clientLogger.info("Recovering the client CSRF session", {
      event: "session.csrf.recovery.started",
      operation: "recover-session",
      subsystem: "authentication",
    });
    try {
      const response = await fetch(`${getActiveServerUrl()}/api/auth/session`, {
        credentials: "include",
        headers: requestHeaders(undefined, "GET"),
      });
      if (!response.ok) {
        clientLogger.warn("Client CSRF session recovery was rejected", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "session.csrf.recovery.failed",
          operation: "recover-session",
          reasonCode: `http-${response.status}`,
          status: "failed",
          subsystem: "authentication",
        });
        return false;
      }
      const body = (await response.json()) as {
        csrfToken?: unknown;
        currentUser?: unknown;
        expiresAt?: unknown;
      };
      const currentUser = body.currentUser as
        ClientSessionContext["user"] | null | undefined;
      const current = getClientSession();
      if (
        !current ||
        current.serverId !== previous.serverId ||
        current.user.id !== previous.user.id ||
        !currentUser ||
        currentUser.id !== previous.user.id ||
        typeof body.csrfToken !== "string" ||
        body.csrfToken.length < 32 ||
        typeof body.expiresAt !== "string"
      ) {
        clientLogger.warn("Client CSRF session recovery was incompatible", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "session.csrf.recovery.failed",
          operation: "recover-session",
          reasonCode: "invalid-session-response",
          status: "failed",
          subsystem: "authentication",
        });
        return false;
      }
      setClientSession({
        ...current,
        csrfToken: body.csrfToken,
        expiresAt: body.expiresAt,
        user: currentUser,
      });
      clientLogger.info("Client CSRF session recovered", {
        durationMs: Math.round(performance.now() - startedAt),
        event: "session.csrf.recovery.completed",
        operation: "recover-session",
        status: "completed",
        subsystem: "authentication",
      });
      return true;
    } catch (error) {
      clientLogger.warn("Client CSRF session recovery failed", {
        durationMs: Math.round(performance.now() - startedAt),
        ...operationalErrorMetadata(error),
        event: "session.csrf.recovery.failed",
        operation: "recover-session",
        reasonCode: "network-error",
        status: "failed",
        subsystem: "authentication",
      });
      return false;
    }
  })().finally(() => {
    csrfRecovery = null;
  });
  return csrfRecovery;
}

function requestHeaders(
  init: RequestInit | undefined,
  method: string,
): Headers {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const session = getClientSession();
  const expectedAccountId = getActiveServerConnection()?.accountId;
  if (expectedAccountId) {
    headers.set("x-cantrip-account-id", expectedAccountId);
  }
  if (session?.csrfToken && !SAFE_METHODS.has(method)) {
    headers.set("x-cantrip-csrf", session.csrfToken);
  }
  return headers;
}

function sendRequest(
  url: string,
  method: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: requestHeaders(init, method),
  });
}

export async function request(
  path: string,
  init?: RequestInit,
  behavior: { allowCsrfRecovery?: boolean } = {},
): Promise<unknown> {
  const response = await requestResponse(path, init, [], behavior);
  return response.status === 204 ? null : response.json();
}

export async function requestResponse(
  path: string,
  init?: RequestInit,
  allowedStatuses: readonly number[] = [],
  behavior: { allowCsrfRecovery?: boolean } = {},
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const url = /^https?:\/\//u.test(path)
    ? path
    : `${getActiveServerUrl()}${path}`;
  const route = apiRouteTemplate(path);
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await sendRequest(url, method, init);
  } catch (error) {
    clientLogger.rateLimited(
      `api:${method}:${route}:network`,
      "error",
      "Cantrip API request failed before a response",
      {
        durationMs: Math.round(performance.now() - startedAt),
        ...operationalErrorMetadata(error),
        event: "api.request.failed",
        method,
        operation: "request",
        path: route,
        reasonCode: "network-error",
        status: "failed",
        subsystem: "api",
      },
    );
    throw error;
  }

  if (!response.ok && !allowedStatuses.includes(response.status)) {
    let body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (
      response.status === 403 &&
      body?.error === "CSRF validation failed." &&
      !SAFE_METHODS.has(method) &&
      !path.endsWith("/api/auth/session") &&
      behavior.allowCsrfRecovery !== false &&
      (await recoverCsrfSession())
    ) {
      clientLogger.info("Retrying Cantrip API request after CSRF recovery", {
        durationMs: Math.round(performance.now() - startedAt),
        event: "api.request.retry",
        method,
        operation: "request",
        path: route,
        reasonCode: "csrf-recovered",
        subsystem: "api",
      });
      response = await sendRequest(url, method, init);
      if (response.ok) return response;
      body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    }
    if (response.status === 401) {
      notifyAuthenticationRequired(
        body?.error ?? "Your Cantrip session has expired.",
      );
    }
    clientLogger.rateLimited(
      `api:${method}:${route}:${response.status}`,
      response.status >= 500 ? "error" : "warn",
      "Cantrip API request returned an error",
      {
        durationMs: Math.round(performance.now() - startedAt),
        event: "api.request.failed",
        method,
        operation: "request",
        path: route,
        reasonCode: `http-${response.status}`,
        requestId: responseRequestId(response),
        statusCode: response.status,
        subsystem: "api",
      },
    );
    throw new CantripApiError(
      apiErrorMessage(body, response.status),
      response.status,
      body?.code ?? null,
    );
  }
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs >= 2_000) {
    clientLogger.debug("Slow Cantrip API request completed", {
      durationMs,
      event: "api.request.slow",
      method,
      operation: "request",
      path: route,
      requestId: responseRequestId(response),
      statusCode: response.status,
      subsystem: "api",
    });
  }
  return response;
}

export function post(path: string, body: unknown): Promise<unknown> {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

export function withQuery(
  path: string,
  input: Record<string, boolean | number | string | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}
