import { afterEach, describe, expect, it, vi } from "vitest";

import { request } from "./api-client";
import {
  clearClientSession,
  getClientSession,
  onAuthenticationRequired,
  scopedClientStorageKey,
  setClientSession,
} from "./client-session";

const user = {
  id: "account-one",
  kind: "account" as const,
  displayName: "Account One",
  email: "one@example.com",
  role: "member" as const,
};

afterEach(() => {
  clearClientSession();
  vi.unstubAllGlobals();
});

describe("authenticated API client", () => {
  it("keeps CSRF material in memory and sends it only on mutations", async () => {
    setClientSession({
      authMode: "accounts",
      csrfToken: "c".repeat(32),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverId: "server-one",
      user,
    });
    const fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await request("/api/read");
    await request("/api/write", { method: "POST", body: "{}" });

    expect(
      new Headers(fetch.mock.calls[0]![1]!.headers).has("x-cantrip-csrf"),
    ).toBe(false);
    expect(
      new Headers(fetch.mock.calls[1]![1]!.headers).get("x-cantrip-csrf"),
    ).toBe("c".repeat(32));
    expect(fetch.mock.calls[1]![1]).toMatchObject({ credentials: "include" });
    expect(scopedClientStorageKey("cache")).toContain("account-one");
  });

  it("notifies the application immediately when a live session expires", async () => {
    setClientSession({
      authMode: "accounts",
      csrfToken: "c".repeat(32),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverId: "server-one",
      user,
    });
    const listener = vi.fn();
    const unsubscribe = onAuthenticationRequired(listener);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Authentication is required." }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(request("/api/projects")).rejects.toMatchObject({
      status: 401,
    });
    expect(listener).toHaveBeenCalledWith("Authentication is required.");
    unsubscribe();
  });

  it("refreshes a stale CSRF token once and retries the rejected mutation", async () => {
    setClientSession({
      authMode: "accounts",
      csrfToken: "s".repeat(32),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverId: "server-one",
      user,
    });
    const refreshedToken = "n".repeat(32);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "CSRF validation failed." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            currentUser: user,
            csrfToken: refreshedToken,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      request("/api/workers/worker-one", { method: "DELETE" }),
    ).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1]![0]).toBe("/api/auth/session");
    expect(
      new Headers(fetch.mock.calls[0]![1]!.headers).get("x-cantrip-csrf"),
    ).toBe("s".repeat(32));
    expect(
      new Headers(fetch.mock.calls[2]![1]!.headers).get("x-cantrip-csrf"),
    ).toBe(refreshedToken);
    expect(getClientSession()?.csrfToken).toBe(refreshedToken);
  });
});
