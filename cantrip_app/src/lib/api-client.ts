import { getActiveServerUrl } from "@/lib/server-connections";
import {
  getClientSession,
  notifyAuthenticationRequired,
} from "@/lib/client-session";

export class CantripApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
  const session = getClientSession();
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (session?.csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-cantrip-csrf", session.csrfToken);
  }
  const url = /^https?:\/\//u.test(path)
    ? path
    : `${getActiveServerUrl()}${path}`;
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
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
