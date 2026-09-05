import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRouteTemplate, request, requestResponse } from "./api-client";
import {
  clearClientSession,
  getClientSession,
  getClientSessionIdentitySnapshot,
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
  it("does not send a bound request after its account lifetime changes", async () => {
    setClientSession({
      authMode: "accounts",
      csrfToken: "c".repeat(32),
      expiresAt: null,
      serverId: "server-one",
      user,
    });
    const expectedIdentity = getClientSessionIdentitySnapshot()!;
    setClientSession({
      authMode: "accounts",
      csrfToken: "d".repeat(32),
      expiresAt: null,
      serverId: "server-one",
      user: { ...user, id: "account-two" },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      request(
        "/api/bound",
        { method: "POST", body: "{}" },
        { expectedIdentity },
      ),
    ).rejects.toMatchObject({ code: "client-identity-changed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never signs out a new account when a bound old request returns a delayed 401 body", async () => {
    setClientSession({
      authMode: "accounts",
      csrfToken: "c".repeat(32),
      expiresAt: null,
      serverId: "server-one",
      user,
    });
    const expectedIdentity = getClientSessionIdentitySnapshot()!;
    let finish!: (value: unknown) => void;
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    const response = new Response(null, { status: 401 });
    vi.spyOn(response, "json").mockReturnValue(body);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const listener = vi.fn();
    const unsubscribe = onAuthenticationRequired(listener);
    try {
      const pending = request("/api/bound", undefined, { expectedIdentity });
      await Promise.resolve();
      setClientSession({
        authMode: "accounts",
        csrfToken: "d".repeat(32),
        expiresAt: null,
        serverId: "server-one",
        user: { ...user, id: "account-two" },
      });
      finish({ error: "Old account expired." });
      await expect(pending).rejects.toMatchObject({
        code: "client-identity-changed",
      });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("rejects a delayed bound JSON success after signing out and back into the same account", async () => {
    const session = {
      authMode: "accounts" as const,
      csrfToken: "c".repeat(32),
      expiresAt: null,
      serverId: "server-one",
      user,
    };
    setClientSession(session);
    const expectedIdentity = getClientSessionIdentitySnapshot()!;
    let finish!: (value: unknown) => void;
    const response = new Response();
    vi.spyOn(response, "json").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const pending = request("/api/bound", undefined, { expectedIdentity });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    clearClientSession();
    setClientSession(session);
    finish({ private: "old account data" });
    await expect(pending).rejects.toMatchObject({
      code: "client-identity-changed",
    });
  });

  it("never automatically replays a bound mutation after a CSRF rejection", async () => {
    setClientSession({
      authMode: "accounts",
      csrfToken: "c".repeat(32),
      expiresAt: null,
      serverId: "server-one",
      user,
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "CSRF validation failed." }), {
        status: 403,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      request(
        "/api/bound",
        { method: "POST", body: "{}" },
        { expectedIdentity: getClientSessionIdentitySnapshot()! },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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

  it("includes the first safe schema issue in invalid-body errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Invalid request body",
            issues: [
              {
                code: "custom",
                message:
                  "Choose either a legacy worktreeId or an execution target.",
                path: [],
              },
            ],
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      request("/api/projects/project-one/terminals"),
    ).rejects.toMatchObject({
      message:
        "Invalid request body: Choose either a legacy worktreeId or an execution target.",
      status: 400,
    });
  });

  it("retains structured failure context in failed-request diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "project-source-unavailable",
            error: "Project source is unavailable.",
            failureStage: "worker-share-open",
            requestId: "body-request-1",
            workerId: "worker-one",
            workerRequestId: "worker-request-1",
          }),
          {
            status: 502,
            headers: {
              "content-type": "application/json",
              "x-request-id": "http-request-1",
            },
          },
        ),
      ),
    );

    await expect(
      request(
        "/api/explorers/11a148ef-be4b-4d61-a23e-53682c891f45/code-attachments",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toMatchObject({
      code: "project-source-unavailable",
      failureStage: "worker-share-open",
      requestId: "http-request-1",
      status: 502,
      workerId: "worker-one",
      workerRequestId: "worker-request-1",
    });

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
      failureStage: "worker-share-open",
      reasonCode: "project-source-unavailable",
      requestId: "http-request-1",
      statusCode: 502,
      workerId: "worker-one",
      workerRequestId: "worker-request-1",
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
