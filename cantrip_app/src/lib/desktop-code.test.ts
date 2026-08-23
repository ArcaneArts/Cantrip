import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeAttachment } from "@cantrip/protocol";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  forceDesktopTunnelRelay: vi.fn(),
  startDesktopTunnel: vi.fn(),
  stopDesktopTunnel: vi.fn(),
  stopDesktopTunnelForward: vi.fn(),
  fetch: vi.fn(),
  clientLog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock("@/lib/desktop-tunnel", () => ({
  forceDesktopTunnelRelay: mocks.forceDesktopTunnelRelay,
  startDesktopTunnel: mocks.startDesktopTunnel,
  stopDesktopTunnel: mocks.stopDesktopTunnel,
  stopDesktopTunnelForward: mocks.stopDesktopTunnelForward,
}));

vi.mock("@/lib/browser-code-tunnel", () => ({
  browserCodeAttachmentHealthy: vi.fn(),
  startBrowserCodeAttachment: vi.fn(),
  stopBrowserCodeAttachment: vi.fn(),
}));

vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { event: mocks.clientLog },
}));

import {
  directCodeAttachmentHealthy,
  directCodeAttachmentHealthyWithin,
  openDirectCodeAttachmentFile,
  preferProtectedCodeAttachment,
  setDirectCodeAttachmentPresentation,
  transportSafeErrorIdentity,
  waitForDirectCodeAttachmentReady,
} from "./desktop-code";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", { localStorage: {} as Storage });
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockResolvedValue([]);
  mocks.stopDesktopTunnel.mockResolvedValue(undefined);
  mocks.forceDesktopTunnelRelay.mockResolvedValue({
    attachmentId: "transport-1",
    diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
    localHost: "127.0.0.1",
    localPort: 52345,
    routeState: "relayed",
    relayFallbackAvailable: true,
    directCapabilityId: null,
    directFallbackReason: "connected-route-unusable",
    tunnelId: "11111111-1111-4111-8111-111111111111",
  });
});

describe("openDirectCodeAttachmentFile", () => {
  it("opens the file through the worker-backed local Code tunnel", async () => {
    const attachment = {
      attachmentId: "attachment-1",
      sessionId: "session-1",
      url: "http://127.0.0.1:52345/code/?workspace=%2Fworker%2Fproject.code-workspace",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {},
    } as CodeAttachment;
    mocks.fetch.mockResolvedValue({
      json: async () => ({ relativePath: "src/index.ts" }),
      ok: true,
    });

    await expect(
      openDirectCodeAttachmentFile(attachment, "src/index.ts"),
    ).resolves.toEqual({ relativePath: "src/index.ts" });

    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:52345/code/_cantrip/open-file"),
      {
        body: JSON.stringify({ relativePath: "src/index.ts" }),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
  });

  it("surfaces a worker control error", async () => {
    mocks.fetch.mockResolvedValue({
      json: async () => ({ error: "File no longer exists." }),
      ok: false,
    });

    await expect(
      openDirectCodeAttachmentFile(
        {
          url: "http://127.0.0.1:52345/code/",
        } as CodeAttachment,
        "removed.ts",
      ),
    ).rejects.toThrow("File no longer exists.");
  });

  it("forwards caller cancellation to the file control request", async () => {
    const controller = new AbortController();
    mocks.fetch.mockResolvedValue({
      json: async () => ({ relativePath: "src/index.ts" }),
      ok: true,
    });

    await openDirectCodeAttachmentFile(
      { url: "http://127.0.0.1:52345/code/" } as CodeAttachment,
      "src/index.ts",
      { signal: controller.signal },
    );

    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("setDirectCodeAttachmentPresentation", () => {
  it("switches the local compatibility session into editor-only mode", async () => {
    const attachment = {
      url: "http://127.0.0.1:52345/code/?workspace=%2Fworker%2Fproject.code-workspace",
    } as CodeAttachment;
    mocks.fetch.mockResolvedValue({
      json: async () => ({ presentation: "editor" }),
      ok: true,
    });

    await expect(
      setDirectCodeAttachmentPresentation(attachment, "editor"),
    ).resolves.toEqual({ presentation: "editor" });

    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:52345/code/_cantrip/presentation"),
      {
        body: JSON.stringify({ presentation: "editor" }),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
  });

  it("forwards caller cancellation to the presentation control request", async () => {
    const controller = new AbortController();
    mocks.fetch.mockResolvedValue({
      json: async () => ({ presentation: "editor" }),
      ok: true,
    });

    await setDirectCodeAttachmentPresentation(
      { url: "http://127.0.0.1:52345/code/" } as CodeAttachment,
      "editor",
      { signal: controller.signal },
    );

    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("directCodeAttachmentHealthy", () => {
  it("uses native tunnel state instead of a WebView HTTP fetch", async () => {
    mocks.invoke.mockResolvedValue([
      { tunnelId: "other", routeState: "local-direct" },
      { tunnelId: "code-1", routeState: "local-direct" },
    ]);

    await expect(directCodeAttachmentHealthy("code-1")).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("list_tunnel_forwards");
  });

  it("rejects a missing or degraded direct tunnel", async () => {
    mocks.invoke.mockResolvedValue([
      { tunnelId: "code-1", routeState: "degraded" },
    ]);

    await expect(directCodeAttachmentHealthy("code-1")).resolves.toBe(false);
  });

  it("bounds periodic tunnel health and treats failures as unhealthy", async () => {
    vi.useFakeTimers();
    try {
      mocks.invoke.mockReturnValue(new Promise(() => undefined));
      const health = directCodeAttachmentHealthyWithin("code-1", 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(health).resolves.toBe(false);

      mocks.invoke.mockRejectedValue(new Error("native state unavailable"));
      await expect(
        directCodeAttachmentHealthyWithin("code-1", 100),
      ).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("preferProtectedCodeAttachment", () => {
  it("opens the protected generic tunnel at the worker-local Code path", async () => {
    mocks.startDesktopTunnel.mockResolvedValue({
      attachmentId: "transport-1",
      diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "relayed",
      relayFallbackAvailable: true,
      directCapabilityId: null,
      tunnelId: "11111111-1111-4111-8111-111111111111",
    });
    mocks.fetch.mockResolvedValue({ ok: true });

    const preferred = await preferProtectedCodeAttachment({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      tunnelId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {
        workspaceUri: "file:///worker/project.code-workspace",
      },
    } as never);

    expect(preferred.attachment.url).toBe(
      "http://127.0.0.1:52345/code/?workspace=%2Fworker%2Fproject.code-workspace",
    );
    expect(preferred.directTunnelId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.startDesktopTunnel).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { diagnosticTraceId: expect.any(String) },
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:52345/code/_cantrip/health"),
      {
        cache: "no-store",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      },
    );
    const diagnosticTraceId = mocks.startDesktopTunnel.mock.calls[0]?.[1]
      ?.diagnosticTraceId as string;
    expect(mocks.clientLog).toHaveBeenCalledWith(
      "info",
      "Cantrip Code health check completed",
      expect.objectContaining({
        diagnosticTraceId,
        event: "code.attachment.health.completed",
      }),
    );
  });

  it("switches an unusable connected direct route to relay exactly once", async () => {
    vi.useFakeTimers();
    try {
      mocks.startDesktopTunnel.mockResolvedValue({
        attachmentId: "transport-1",
        diagnosticTraceId: null,
        localHost: "127.0.0.1",
        localPort: 52345,
        routeState: "local-direct",
        relayFallbackAvailable: true,
        directCapabilityId: "capability-1",
        directFallbackReason: null,
        tunnelId: "11111111-1111-4111-8111-111111111111",
      });
      mocks.fetch.mockImplementation(() =>
        mocks.fetch.mock.calls.length <= 4
          ? new Promise(() => undefined)
          : Promise.resolve({ ok: true }),
      );

      const preferred = preferProtectedCodeAttachment({
        attachmentId: "11111111-1111-4111-8111-111111111111",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2026-08-13T12:00:00.000Z",
        runtime: {},
      } as never);
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(preferred).resolves.toMatchObject({
        directTunnelId: "11111111-1111-4111-8111-111111111111",
      });
      expect(mocks.forceDesktopTunnelRelay).toHaveBeenCalledTimes(1);
      expect(mocks.fetch).toHaveBeenCalledTimes(5);
      expect(mocks.stopDesktopTunnel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back after an HTTP response proves the selected route is usable", async () => {
    mocks.startDesktopTunnel.mockResolvedValue({
      attachmentId: "transport-1",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      tunnelId: "11111111-1111-4111-8111-111111111111",
    });
    mocks.fetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(
      preferProtectedCodeAttachment({
        attachmentId: "11111111-1111-4111-8111-111111111111",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2026-08-13T12:00:00.000Z",
        runtime: {},
      } as never),
    ).rejects.toMatchObject({ failureKind: "http-response" });
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
    expect(mocks.stopDesktopTunnel).toHaveBeenCalledTimes(1);
  });

  it("retires direct state when native disconnected to relay during health retries", async () => {
    const direct = {
      attachmentId: "transport-1",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      tunnelId: "11111111-1111-4111-8111-111111111111",
    };
    mocks.startDesktopTunnel.mockResolvedValue(direct);
    mocks.fetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    mocks.invoke.mockResolvedValue([
      {
        ...direct,
        routeState: "relayed",
      },
    ]);

    await expect(
      preferProtectedCodeAttachment({
        attachmentId: "11111111-1111-4111-8111-111111111111",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2026-08-13T12:00:00.000Z",
        runtime: {},
      } as never),
    ).resolves.toMatchObject({
      directTunnelId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mocks.forceDesktopTunnelRelay).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.clientLog).toHaveBeenCalledWith(
      "info",
      "Cantrip Code health check completed",
      expect.objectContaining({ healthPhase: "relay" }),
    );
  });

  it("does not expose an autonomously selected relay until relay health succeeds", async () => {
    const direct = {
      attachmentId: "transport-1",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      tunnelId: "11111111-1111-4111-8111-111111111111",
    };
    mocks.startDesktopTunnel.mockResolvedValue(direct);
    mocks.fetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    mocks.invoke.mockResolvedValue([{ ...direct, routeState: "relayed" }]);

    await expect(
      preferProtectedCodeAttachment({
        attachmentId: "11111111-1111-4111-8111-111111111111",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2026-08-13T12:00:00.000Z",
        runtime: {},
      } as never),
    ).rejects.toMatchObject({ failureKind: "http-response" });
    expect(mocks.forceDesktopTunnelRelay).toHaveBeenCalledTimes(1);
    expect(mocks.stopDesktopTunnel).toHaveBeenCalledTimes(1);
  });

  it("preserves caller cancellation and never turns it into relay fallback", async () => {
    mocks.startDesktopTunnel.mockResolvedValue({
      attachmentId: "transport-1",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      tunnelId: "11111111-1111-4111-8111-111111111111",
    });
    mocks.fetch.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const cancellation = new DOMException("superseded", "AbortError");
    const pending = preferProtectedCodeAttachment(
      {
        attachmentId: "11111111-1111-4111-8111-111111111111",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2026-08-13T12:00:00.000Z",
        runtime: {},
      } as never,
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    const cancelled = expect(pending).rejects.toBe(cancellation);
    controller.abort(cancellation);

    await cancelled;
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
    expect(mocks.stopDesktopTunnel).toHaveBeenCalledTimes(1);
    expect(mocks.clientLog).toHaveBeenCalledWith(
      "info",
      "Cantrip Code health check cancelled",
      expect.objectContaining({
        event: "code.attachment.health.cancelled",
        reasonCode: "cancelled",
      }),
    );
  });
});

describe("waitForDirectCodeAttachmentReady", () => {
  it("retries a loopback startup race before exposing the attachment", async () => {
    mocks.fetch
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ ok: true });

    await expect(
      waitForDirectCodeAttachmentReady(
        { url: "http://127.0.0.1:52345/code/" },
        {
          attempts: 2,
          diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
          retryDelayMs: 0,
        },
      ),
    ).resolves.toBeUndefined();

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.clientLog).toHaveBeenCalledWith(
      "info",
      "Cantrip Code health check completed",
      expect.objectContaining({
        attemptCount: 2,
        diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("records a normalized failure without logging the loopback URL or error message", async () => {
    mocks.fetch.mockRejectedValue(
      new TypeError("Load failed at a private URL"),
    );

    await expect(
      waitForDirectCodeAttachmentReady(
        { url: "http://127.0.0.1:52345/code/" },
        {
          attachmentId: "11111111-1111-4111-8111-111111111111",
          attempts: 1,
          diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
          retryDelayMs: 0,
          sessionId: "22222222-2222-4222-8222-222222222222",
          tunnelId: "44444444-4444-4444-8444-444444444444",
        },
      ),
    ).rejects.toMatchObject({
      cause: expect.any(TypeError),
      failureKind: "network-error",
    });

    const failure = mocks.clientLog.mock.calls.find(
      ([, , context]) => context.event === "code.attachment.health.failed",
    );
    expect(failure).toEqual([
      "warn",
      "Cantrip Code health check failed",
      expect.objectContaining({
        attemptCount: 1,
        attemptKind: "network-error",
        attachmentId: "11111111-1111-4111-8111-111111111111",
        diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
        errorClass: "TypeError",
        reasonCode: "network-error",
        sessionId: "22222222-2222-4222-8222-222222222222",
        tunnelId: "44444444-4444-4444-8444-444444444444",
      }),
    ]);
    expect(JSON.stringify(failure)).not.toContain("127.0.0.1");
    expect(JSON.stringify(failure)).not.toContain("Load failed");
  });

  it("drops hostile alphanumeric error identities while retaining allowlisted network identity", async () => {
    const hostileName = "SecretLookingClassAlpha123";
    const hostileCode = "SecretLookingCodeBeta456";
    const error = new Error("private transport failure") as Error & {
      code: string;
      status: number;
    };
    error.name = hostileName;
    error.code = hostileCode;
    error.status = 503;
    mocks.fetch.mockRejectedValue(error);

    await expect(
      waitForDirectCodeAttachmentReady(
        { url: "http://127.0.0.1:52345/code/" },
        { attempts: 1, retryDelayMs: 0 },
      ),
    ).rejects.toMatchObject({ cause: error, failureKind: "network-error" });

    const failure = mocks.clientLog.mock.calls.find(
      ([, , context]) => context.event === "code.attachment.health.failed",
    );
    expect(failure?.[2]).toEqual(
      expect.objectContaining({
        errorClass: "Error",
        errorStatus: 503,
      }),
    );
    expect(failure?.[2]).not.toHaveProperty("errorCode");
    expect(JSON.stringify(failure)).not.toContain(hostileName);
    expect(JSON.stringify(failure)).not.toContain(hostileCode);
    expect(transportSafeErrorIdentity(new TypeError("Load failed"))).toEqual({
      errorClass: "TypeError",
    });
    expect(
      transportSafeErrorIdentity(
        Object.assign(new TypeError("Load failed"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toEqual({ errorClass: "TypeError", errorCode: "ECONNREFUSED" });
  });

  it("bounds a non-cooperative fetch by both attempt and total deadlines", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetch.mockImplementation(() => new Promise(() => undefined));
      const pending = waitForDirectCodeAttachmentReady(
        { url: "http://127.0.0.1:52345/code/" },
        {
          attempts: 100,
          attemptTimeoutMs: 100,
          retryDelayMs: 50,
          totalTimeoutMs: 250,
        },
      );
      const rejected = expect(pending).rejects.toMatchObject({
        failureKind: "total-timeout",
      });

      await vi.advanceTimersByTimeAsync(300);

      await rejected;
      expect(mocks.fetch.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
