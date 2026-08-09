import { getActiveServerUrl } from "@/lib/server-connections";

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
  const response = await fetch(`${getActiveServerUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new CantripApiError(
      body?.error ?? `Cantrip Server returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return response.status === 204 ? null : response.json();
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
