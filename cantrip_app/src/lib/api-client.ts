import { getActiveServerUrl } from "@/lib/server-connections";
import {
  type ClientSessionContext,
  getClientSession,
  notifyAuthenticationRequired,
  setClientSession,
} from "@/lib/client-session";

export class CantripApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
let csrfRecovery: Promise<boolean> | null = null;

async function recoverCsrfSession(): Promise<boolean> {
  if (csrfRecovery) return csrfRecovery;
  const previous = getClientSession();
  if (!previous || previous.authMode === "none") return false;

  csrfRecovery = (async () => {
    try {
      const response = await fetch(`${getActiveServerUrl()}/api/auth/session`, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return false;
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
        return false;
      }
      setClientSession({
        ...current,
        csrfToken: body.csrfToken,
        expiresAt: body.expiresAt,
        user: currentUser,
      });
      return true;
    } catch {
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
): Promise<unknown> {
  const response = await requestResponse(path, init);
  return response.status === 204 ? null : response.json();
}

export async function requestResponse(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const url = /^https?:\/\//u.test(path)
    ? path
    : `${getActiveServerUrl()}${path}`;
  let response = await sendRequest(url, method, init);

  if (!response.ok) {
    let body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (
      response.status === 403 &&
      body?.error === "CSRF validation failed." &&
      !SAFE_METHODS.has(method) &&
      !path.endsWith("/api/auth/session") &&
      (await recoverCsrfSession())
    ) {
      response = await sendRequest(url, method, init);
      if (response.ok) return response;
      body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
    }
    if (response.status === 401) {
      notifyAuthenticationRequired(
        body?.error ?? "Your Cantrip session has expired.",
      );
    }
    throw new CantripApiError(
      body?.error ?? `Cantrip Server returned HTTP ${response.status}.`,
      response.status,
    );
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
