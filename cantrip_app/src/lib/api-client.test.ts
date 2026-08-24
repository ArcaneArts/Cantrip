import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRouteTemplate, request, requestResponse } from "./api-client";
import {
  clearClientSession,
  getClientSession,
  onAuthenticationRequired,
  scopedClientStorageKey,
  setClientSession,
} from "./client-session";
import { clearClientLogs, readClientLogs } from "./client-log-relay";

const user = {
  id: "account-one",
  kind: "account" as const,
  displayName: "Account One",
  email: "one@example.com",
  role: "member" as const,
};

afterEach(() => {
  clearClientSession();
  clearClientLogs();
  vi.unstubAllGlobals();
});

describe("authenticated API client", () => {
  it("reduces operational request metadata to a query-free route template", () => {
    expect(
      apiRouteTemplate(
        "https://winterhold.cantrip.test/api/projects/11a148ef-be4b-4d61-a23e-53682c891f45/chats/42?access_token=unsafe#private",
      ),
    ).toBe("/api/projects/:id/chats/:id");
    expect(apiRouteTemplate("/api/workers/desktop-local/logs?cursor=8")).toBe(
      "/api/workers/desktop-local/logs",
    );
  });

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

  it("preserves a safe machine-readable API error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "provider-reauth-required",
            error: "Sign in again.",
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(request("/api/provider-quota")).rejects.toMatchObject({
      code: "provider-reauth-required",
      message: "Sign in again.",
      status: 409,
    });
  });

  it("retains a sanitized route and status in failed-request diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      request(
        "/api/explorers/11a148ef-be4b-4d61-a23e-53682c891f45/code-attachments",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const failure = readClientLogs().records.find(
      (record) =>
        typeof record.context === "object" &&
        record.context !== null &&
        "event" in record.context &&
        record.context.event === "api.request.failed",
    );
    expect(failure?.context).toMatchObject({
      method: "POST",
      path: "/api/explorers/:id/code-attachments",
      reasonCode: "http-404",
      statusCode: 404,
    });
  });

  it("can return an explicitly allowed conflict response for compare-and-set APIs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ created: false }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const response = await requestResponse(
      "/api/encryption/profile/initialize",
      { method: "POST", body: "{}" },
      [409],
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ created: false });
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
