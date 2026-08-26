import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodeAttachment,
  CodeProtectedAttachmentWire,
} from "@cantrip/protocol";

const mocks = vi.hoisted(() => ({
  acquireDesktopCodeTransport: vi.fn(),
  browserCodeAttachmentHealthy: vi.fn(),
  retainSharedBrowserCodeAttachment: vi.fn(),
  sharedBrowserCodeAttachmentHealthy: vi.fn(),
  invoke: vi.fn(),
  isTauri: vi.fn(),
  forceDesktopTunnelRelay: vi.fn(),
  explorerCodeSessionBindingCurrent: vi.fn(),
  listDesktopTunnelsWithOptions: vi.fn(),
  releaseDesktopCodeTransport: vi.fn(),
  startBrowserCodeAttachment: vi.fn(),
  startSharedBrowserCodeAttachment: vi.fn(),
  startDesktopTunnel: vi.fn(),
  stopBrowserCodeAttachment: vi.fn(),
  stopSharedBrowserCodeAttachment: vi.fn(),
  stopDesktopTunnel: vi.fn(),
  stopDesktopTunnelForward: vi.fn(),
  subscribeBrowserCodeAttachmentUnavailable: vi.fn(),
  subscribeDesktopTunnelForwardTerminal: vi.fn(),
  fetch: vi.fn(),
  clientLog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock("@/lib/desktop-tunnel", () => ({
  acquireDesktopCodeTransport: mocks.acquireDesktopCodeTransport,
  forceDesktopTunnelRelay: mocks.forceDesktopTunnelRelay,
  listDesktopTunnelsWithOptions: mocks.listDesktopTunnelsWithOptions,
  releaseDesktopCodeTransport: mocks.releaseDesktopCodeTransport,
  startDesktopTunnel: mocks.startDesktopTunnel,
  stopDesktopTunnel: mocks.stopDesktopTunnel,
  stopDesktopTunnelForward: mocks.stopDesktopTunnelForward,
  subscribeDesktopTunnelForwardTerminal:
    mocks.subscribeDesktopTunnelForwardTerminal,
}));

vi.mock("@/lib/browser-code-tunnel", () => ({
  browserCodeAttachmentHealthy: mocks.browserCodeAttachmentHealthy,
  retainSharedBrowserCodeAttachment: mocks.retainSharedBrowserCodeAttachment,
  sharedBrowserCodeAttachmentHealthy: mocks.sharedBrowserCodeAttachmentHealthy,
  startBrowserCodeAttachment: mocks.startBrowserCodeAttachment,
  startSharedBrowserCodeAttachment: mocks.startSharedBrowserCodeAttachment,
  stopBrowserCodeAttachment: mocks.stopBrowserCodeAttachment,
  stopSharedBrowserCodeAttachment: mocks.stopSharedBrowserCodeAttachment,
  subscribeBrowserCodeAttachmentUnavailable:
    mocks.subscribeBrowserCodeAttachmentUnavailable,
}));

vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { event: mocks.clientLog },
}));

vi.mock("@/lib/api", () => ({
  explorerCodeSessionBindingCurrent: mocks.explorerCodeSessionBindingCurrent,
}));

import {
  CODE_CONTROL_OPERATION_TIMEOUT_MS,
  CodeControlOperationTimeoutError,
  directCodeAttachmentHealthy,
  directCodeAttachmentHealthyWithin,
  desktopCodeStateForRuntime,
  openDirectCodeAttachmentFile,
  openDirectCodeAttachmentSettings,
  preferProtectedCodeAttachment,
  preferSharedProtectedCodeAttachment,
  recoverPreferredCodeAttachmentRoute,
  setDirectCodeAttachmentPresentation,
  setDirectCodeAttachmentTheme,
  retainSharedProtectedCodeAttachmentLease,
  stopDirectCodeAttachment,
  stopSharedProtectedCodeAttachment,
  subscribePreferredCodeAttachmentUnavailable,
  transportSafeErrorIdentity,
  waitForDirectCodeAttachmentReady,
} from "./desktop-code";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", { localStorage: {} as Storage });
  mocks.isTauri.mockReturnValue(true);
  mocks.explorerCodeSessionBindingCurrent.mockReturnValue(true);
  mocks.releaseDesktopCodeTransport.mockResolvedValue(true);
  mocks.retainSharedBrowserCodeAttachment.mockResolvedValue(undefined);
  mocks.stopSharedBrowserCodeAttachment.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue([]);
  mocks.listDesktopTunnelsWithOptions.mockResolvedValue([]);
  mocks.releaseDesktopCodeTransport.mockResolvedValue(true);
  mocks.stopDesktopTunnel.mockResolvedValue(undefined);
  mocks.subscribeBrowserCodeAttachmentUnavailable.mockReturnValue(
    () => undefined,
  );
  mocks.subscribeDesktopTunnelForwardTerminal.mockReturnValue(() => undefined);
  mocks.forceDesktopTunnelRelay.mockResolvedValue({
    attachmentId: "transport-1",
    diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
    localHost: "127.0.0.1",
    localPort: 52345,
    routeState: "relayed",
    relayFallbackAvailable: true,
    directCapabilityId: null,
    directFallbackReason: "connected-route-unusable",
    destinationRejectedCount: 1,
    lastDestinationRejectionCode: "protected-record-unavailable",
    tunnelId: "11111111-1111-4111-8111-111111111111",
  });
});

describe("shared desktop Code attachment", () => {
  function ownedAttachment() {
    const transportId = "11111111-1111-4111-8111-111111111111";
    return {
      attachment: {
        formatVersion: 2 as const,
        transport: {
          formatVersion: 2 as const,
          transportId,
          tunnelId: transportId,
          workerId: "worker-one",
          securityScopeId: "33333333-3333-4333-8333-333333333333",
          serverId: "server-one",
          serverControlPlaneGeneration: "44444444-4444-4444-8444-444444444444",
          protectedKeyRevision: 1,
          workerProcessGeneration: "55555555-5555-4555-8555-555555555555",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        session: {
          formatVersion: 2 as const,
          attachmentId: "66666666-6666-4666-8666-666666666666",
          transportId,
          sessionId: "22222222-2222-4222-8222-222222222222",
          routeGrant: "A".repeat(43),
          expiresAt: "2099-01-01T00:00:00.000Z",
          runtime: {
            sessionId: "22222222-2222-4222-8222-222222222222",
            status: "running" as const,
            editorBuild: {
              version: "1.109.5",
              upstreamRevision: "a".repeat(40),
              patchset: 1,
              fingerprint: "b".repeat(64),
            },
            processInstanceId: "process-one",
            bridgeConnected: true,
            dirtyEditors: [],
            workbench: {
              activeEditor: null,
              git: null,
              conflicts: [],
              savePolicy: "always" as const,
              agentStatus: "idle" as const,
            },
            startedAt: "2026-08-25T00:00:00.000Z",
            lastActivityAt: "2026-08-25T00:00:00.000Z",
            lastError: null,
          },
        },
      },
      binding: {
        identity: {
          accountId: "account-one",
          connectionId: "connection-one",
          generation: 1,
          incarnationId: "88888888-8888-4888-8888-888888888888",
          serverId: "server-one",
          serverUrl: "https://server.example.test",
          userId: "user-one",
        },
        serverUrl: "https://server.example.test",
      },
    };
  }

  function lease(leaseId: string) {
    return {
      forward: {
        attachmentId: "physical-attachment-one",
        diagnosticTraceId: "77777777-7777-4777-8777-777777777777",
        expiresAt: "2099-01-01T00:00:00.000Z",
        localHost: "127.0.0.1" as const,
        localPort: 52_345,
        routeState: "local-direct" as const,
        relayFallbackAvailable: true,
        directCapabilityId: "capability-one",
        directFallbackReason: null,
        destinationRejectedCount: 0,
        tunnelId: "11111111-1111-4111-8111-111111111111",
      },
      generation: "generation-one",
      leaseId,
      serverUrl: "https://server.example.test",
    };
  }

  it("retains attachment-to-lease ownership across hot module replacement", () => {
    const hotState = {};
    const first = desktopCodeStateForRuntime(hotState);
    const owned = ownedAttachment();
    const ownedLease = { ...lease("lease-hot"), binding: owned.binding };
    const leases = new Map([[ownedLease.leaseId, ownedLease]]);
    first.sharedProtectedAttachmentLeases.set(owned, leases);

    const reloaded = desktopCodeStateForRuntime(hotState);

    expect(reloaded).toBe(first);
    expect(reloaded.sharedProtectedAttachmentLeases.get(owned)).toBe(leases);
  });

  it("uses one session-specific route and fences overlapping lease cleanup", async () => {
    const owned = ownedAttachment();
    const firstLease = lease("lease-one");
    const secondLease = lease("lease-two");
    mocks.acquireDesktopCodeTransport
      .mockResolvedValueOnce(firstLease)
      .mockResolvedValueOnce(secondLease);
    mocks.fetch.mockResolvedValue({ ok: true });

    const first = await preferSharedProtectedCodeAttachment(owned);
    const second = await preferSharedProtectedCodeAttachment(owned);

    expect(first.attachment.url).toBe(
      `http://127.0.0.1:52345/sessions/${"A".repeat(43)}/code/`,
    );
    expect(first.sharedTransportLeaseId).toBe("lease-one");
    expect(second.sharedTransportLeaseId).toBe("lease-two");
    expect(mocks.acquireDesktopCodeTransport).toHaveBeenCalledTimes(2);

    await retainSharedProtectedCodeAttachmentLease(owned, "lease-two");
    expect(mocks.releaseDesktopCodeTransport).toHaveBeenCalledOnce();
    expect(mocks.releaseDesktopCodeTransport).toHaveBeenCalledWith(firstLease);

    await stopSharedProtectedCodeAttachment(owned, "lease-one");
    expect(mocks.releaseDesktopCodeTransport).toHaveBeenCalledOnce();

    await stopSharedProtectedCodeAttachment(owned, "lease-two");
    expect(mocks.releaseDesktopCodeTransport).toHaveBeenCalledTimes(2);
    expect(mocks.releaseDesktopCodeTransport).toHaveBeenLastCalledWith(
      secondLease,
    );
  });

  it("delegates browser shared-session leases without invoking native ownership", async () => {
    mocks.isTauri.mockReturnValue(false);
    const owned = ownedAttachment();
    mocks.startSharedBrowserCodeAttachment.mockResolvedValue({
      attachment: {
        attachmentId: owned.attachment.session.attachmentId,
        expiresAt: owned.attachment.session.expiresAt,
        runtime: owned.attachment.session.runtime,
        sessionId: owned.attachment.session.sessionId,
        url: "https://server.example.test/__cantrip_code/adapter/code/",
      },
      leaseId: "browser-lease-one",
      transportGeneration: "browser-generation-one",
    });

    const preferred = await preferSharedProtectedCodeAttachment(owned);

    expect(mocks.startSharedBrowserCodeAttachment).toHaveBeenCalledWith(owned, {
      signal: undefined,
    });
    expect(preferred).toMatchObject({
      directTunnelId: owned.attachment.transport.transportId,
      sharedOwnedAttachment: owned,
      sharedTransportGeneration: "browser-generation-one",
      sharedTransportLeaseId: "browser-lease-one",
      transportKind: "relay",
    });
    expect(mocks.acquireDesktopCodeTransport).not.toHaveBeenCalled();

    await stopSharedProtectedCodeAttachment(owned, "browser-lease-one");
    expect(mocks.stopSharedBrowserCodeAttachment).toHaveBeenCalledWith(
      owned,
      "browser-lease-one",
    );
  });
});

describe("recoverPreferredCodeAttachmentRoute", () => {
  const preferred = {
    attachment: {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      url: "http://127.0.0.1:52345/code/",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {},
    } as CodeAttachment,
    desktopRouteIdentity: {
      attachmentId: "transport-1",
      diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
      directCapabilityId: "capability-1",
    },
    directTunnelId: "11111111-1111-4111-8111-111111111111",
    transportKind: "local-direct" as const,
  };
  const directForward = {
    attachmentId: "transport-1",
    diagnosticTraceId: null,
    expiresAt: "2026-08-13T13:00:00.000Z",
    localHost: "127.0.0.1" as const,
    localPort: 52345,
    routeState: "local-direct" as const,
    relayFallbackAvailable: true,
    directCapabilityId: "capability-1",
    directFallbackReason: null,
    tunnelId: preferred.directTunnelId,
  };

  it("subscribes with the exact native forward identity", () => {
    let emitTerminal!: (event: {
      attachmentId: string;
      diagnosticTraceId: string | null;
      reasonCode: "attachment-invalidated" | "replaced" | "route-terminated";
      tunnelId: string;
    }) => void;
    const unlisten = vi.fn();
    mocks.subscribeDesktopTunnelForwardTerminal.mockImplementation(
      (_identity, listener) => {
        emitTerminal = listener;
        return unlisten;
      },
    );
    const unavailable = vi.fn();

    const unsubscribe = subscribePreferredCodeAttachmentUnavailable(
      preferred,
      unavailable,
    );
    expect(mocks.subscribeDesktopTunnelForwardTerminal).toHaveBeenCalledWith(
      {
        attachmentId: preferred.desktopRouteIdentity.attachmentId,
        diagnosticTraceId: preferred.desktopRouteIdentity.diagnosticTraceId,
        tunnelId: preferred.directTunnelId,
      },
      expect.any(Function),
    );
    emitTerminal({
      attachmentId: preferred.desktopRouteIdentity.attachmentId,
      diagnosticTraceId: preferred.desktopRouteIdentity.diagnosticTraceId,
      reasonCode: "route-terminated",
      tunnelId: preferred.directTunnelId,
    });

    expect(unavailable).toHaveBeenCalledOnce();
    unsubscribe();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("forces an exact connected-but-broken direct route to relay and probes the same attachment URL", async () => {
    mocks.listDesktopTunnelsWithOptions.mockResolvedValue([directForward]);
    mocks.fetch
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ ok: true });

    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "available",
    );

    expect(mocks.forceDesktopTunnelRelay).toHaveBeenCalledWith(directForward, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      1,
      new URL("http://127.0.0.1:52345/code/_cantrip/health"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      new URL("http://127.0.0.1:52345/code/_cantrip/health"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      3,
      new URL("http://127.0.0.1:52345/code/_cantrip/health"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.stopDesktopTunnel).not.toHaveBeenCalled();
    expect(preferred.attachment.attachmentId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(preferred.attachment.sessionId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(preferred.attachment.url).toBe("http://127.0.0.1:52345/code/");
  });

  it("retains the exact direct route when its immediate confirmation probe succeeds", async () => {
    mocks.listDesktopTunnelsWithOptions.mockResolvedValue([directForward]);
    mocks.fetch
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ ok: true });

    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "available",
    );

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
  });

  it("treats every authenticated HTTP response as reachable", async () => {
    mocks.listDesktopTunnelsWithOptions.mockResolvedValue([directForward]);
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "available",
    );
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
  });

  it("accepts a retired direct capability on the exact relayed attachment", async () => {
    mocks.listDesktopTunnelsWithOptions.mockResolvedValue([
      { ...directForward, directCapabilityId: null, routeState: "relayed" },
    ]);
    mocks.fetch.mockResolvedValueOnce({ ok: true });

    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "available",
    );
  });

  it("keeps transient native inspection and relay probe failures in recovery", async () => {
    mocks.listDesktopTunnelsWithOptions.mockRejectedValueOnce(
      new Error("Native IPC unavailable"),
    );

    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "recovering",
    );

    mocks.listDesktopTunnelsWithOptions.mockResolvedValue([
      { ...directForward, directCapabilityId: null, routeState: "relayed" },
    ]);
    mocks.fetch.mockRejectedValueOnce(new TypeError("Load failed"));
    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "recovering",
    );
    expect(mocks.stopDesktopTunnel).not.toHaveBeenCalled();
  });

  it("requires replacement only when the exact native forward is missing or replaced", async () => {
    mocks.listDesktopTunnelsWithOptions.mockResolvedValueOnce([]);
    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "replace-required",
    );

    mocks.listDesktopTunnelsWithOptions.mockResolvedValueOnce([
      { ...directForward, attachmentId: "replacement-transport" },
    ]);
    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "replace-required",
    );

    mocks.listDesktopTunnelsWithOptions.mockResolvedValueOnce([
      { ...directForward, directCapabilityId: "replacement-capability" },
    ]);
    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "replace-required",
    );
    mocks.listDesktopTunnelsWithOptions.mockResolvedValueOnce([
      {
        ...directForward,
        directCapabilityId: null,
        routeState: "degraded",
      },
    ]);
    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "recovering",
    );
    mocks.listDesktopTunnelsWithOptions.mockResolvedValueOnce([
      {
        ...directForward,
        directCapabilityId: "replacement-capability",
        routeState: "degraded",
      },
    ]);
    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "replace-required",
    );
    mocks.listDesktopTunnelsWithOptions.mockResolvedValueOnce([
      {
        ...directForward,
        directCapabilityId: "replacement-capability",
        routeState: "relayed",
      },
    ]);
    await expect(recoverPreferredCodeAttachmentRoute(preferred)).resolves.toBe(
      "replace-required",
    );
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
  });

  it("coalesces exact concurrent recovery by tunnel", async () => {
    let releaseHealth!: (response: { ok: boolean }) => void;
    mocks.listDesktopTunnelsWithOptions.mockResolvedValue([directForward]);
    mocks.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseHealth = resolve;
      }),
    );

    const first = recoverPreferredCodeAttachmentRoute(preferred);
    const second = recoverPreferredCodeAttachmentRoute(preferred);
    await vi.waitFor(() =>
      expect(mocks.listDesktopTunnelsWithOptions).toHaveBeenCalledOnce(),
    );
    releaseHealth({ ok: true });

    await expect(Promise.all([first, second])).resolves.toEqual([
      "available",
      "available",
    ]);
    expect(mocks.listDesktopTunnelsWithOptions).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});

describe("stopDirectCodeAttachment", () => {
  it("stops the local forward with the identity captured for the exact wire", async () => {
    const wire = {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      tunnelId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {},
    } as CodeProtectedAttachmentWire;
    mocks.startDesktopTunnel.mockResolvedValue({
      attachmentId: "transport-1",
      diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      tunnelId: wire.tunnelId,
    });
    mocks.invoke.mockResolvedValue([
      {
        directCapabilityId: "capability-1",
        routeState: "local-direct",
        tunnelId: wire.tunnelId,
      },
    ]);
    mocks.fetch.mockResolvedValue({ ok: true });
    await preferProtectedCodeAttachment(wire);

    await stopDirectCodeAttachment(wire);

    expect(mocks.stopDesktopTunnel).toHaveBeenCalledWith(
      wire.tunnelId,
      "transport-1",
      {
        attachmentId: "transport-1",
        diagnosticTraceId: "33333333-3333-4333-8333-333333333333",
        directCapabilityId: "capability-1",
      },
    );
  });
});

describe("openDirectCodeAttachmentFile", () => {
  it("aborts and rejects a noncooperative control fetch at the internal deadline", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      mocks.fetch.mockImplementation(
        (_input: URL, init?: RequestInit) =>
          new Promise(() => {
            requestSignal = init?.signal ?? undefined;
          }),
      );

      const request = openDirectCodeAttachmentFile(
        { url: "http://127.0.0.1:52345/code/" } as CodeAttachment,
        "src/hung.ts",
      );
      const rejected = expect(request).rejects.toBeInstanceOf(
        CodeControlOperationTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(CODE_CONTROL_OPERATION_TIMEOUT_MS);

      await rejected;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the internal deadline active while parsing the response body", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetch.mockResolvedValue({
        json: () => new Promise(() => undefined),
        ok: true,
      });

      const request = openDirectCodeAttachmentFile(
        { url: "http://127.0.0.1:52345/code/" } as CodeAttachment,
        "src/hung-body.ts",
      );
      const rejected = expect(request).rejects.toBeInstanceOf(
        CodeControlOperationTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(CODE_CONTROL_OPERATION_TIMEOUT_MS);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves caller cancellation ahead of the internal deadline", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let requestSignal: AbortSignal | undefined;
      mocks.fetch.mockImplementation(
        (_input: URL, init?: RequestInit) =>
          new Promise(() => {
            requestSignal = init?.signal ?? undefined;
          }),
      );
      const reason = new DOMException("Navigation changed.", "AbortError");
      const request = openDirectCodeAttachmentFile(
        { url: "http://127.0.0.1:52345/code/" } as CodeAttachment,
        "src/cancelled.ts",
        { signal: controller.signal },
      );
      const rejected = expect(request).rejects.toBe(reason);

      controller.abort(reason);

      await rejected;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

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
        signal: expect.any(AbortSignal),
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("openDirectCodeAttachmentSettings", () => {
  it("opens graphical settings through the protected local Code tunnel", async () => {
    mocks.fetch.mockResolvedValue({
      json: async () => ({ opened: true }),
      ok: true,
    });

    await expect(
      openDirectCodeAttachmentSettings({
        url: "http://127.0.0.1:52345/code/",
      } as CodeAttachment),
    ).resolves.toEqual({ opened: true });

    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:52345/code/_cantrip/open-settings"),
      {
        body: "{}",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
  });

  it("rejects malformed acknowledgements and forwards cancellation", async () => {
    const controller = new AbortController();
    mocks.fetch.mockResolvedValue({
      json: async () => ({ opened: false }),
      ok: true,
    });

    await expect(
      openDirectCodeAttachmentSettings(
        { url: "http://127.0.0.1:52345/code/" } as CodeAttachment,
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("setDirectCodeAttachmentPresentation", () => {
  it("bounds a noncooperative presentation control request", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetch.mockReturnValue(new Promise(() => undefined));
      const request = setDirectCodeAttachmentPresentation(
        { url: "http://127.0.0.1:52345/code/" } as CodeAttachment,
        "editor",
      );
      const rejected = expect(request).rejects.toBeInstanceOf(
        CodeControlOperationTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(CODE_CONTROL_OPERATION_TIMEOUT_MS);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

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
        signal: expect.any(AbortSignal),
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("setDirectCodeAttachmentTheme", () => {
  it("bounds a noncooperative theme control request", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetch.mockReturnValue(new Promise(() => undefined));
      const request = setDirectCodeAttachmentTheme(
        { url: "http://127.0.0.1:52345/code/" } as CodeAttachment,
        "pro-high-contrast-dark",
      );
      const rejected = expect(request).rejects.toBeInstanceOf(
        CodeControlOperationTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(CODE_CONTROL_OPERATION_TIMEOUT_MS);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates the existing attachment through follow-Cantrip mode", async () => {
    const attachment = {
      url: "http://127.0.0.1:52345/code/?workspace=%2Fworker%2Fproject.code-workspace",
    } as CodeAttachment;
    mocks.fetch.mockResolvedValue({
      json: async () => ({
        appearance: "pro-high-contrast-dark",
        themeMode: "follow-cantrip",
      }),
      ok: true,
    });

    await expect(
      setDirectCodeAttachmentTheme(attachment, "pro-high-contrast-dark"),
    ).resolves.toEqual({
      appearance: "pro-high-contrast-dark",
      themeMode: "follow-cantrip",
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:52345/code/_cantrip/theme"),
      {
        body: JSON.stringify({
          appearance: "pro-high-contrast-dark",
          themeMode: "follow-cantrip",
        }),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: expect.any(AbortSignal),
      },
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
  it("classifies the browser transport as relay without changing its tunnel identity", async () => {
    mocks.isTauri.mockReturnValue(false);
    mocks.startBrowserCodeAttachment.mockResolvedValue({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      url: "https://cantrip.test/__cantrip_code/11111111-1111-4111-8111-111111111111/code/",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {},
    });
    const wire = {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      tunnelId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2026-08-13T12:00:00.000Z",
      runtime: {},
    } as never;

    await expect(preferProtectedCodeAttachment(wire)).resolves.toMatchObject({
      directTunnelId: "11111111-1111-4111-8111-111111111111",
      transportKind: "relay",
    });
    expect(mocks.startBrowserCodeAttachment).toHaveBeenCalledWith(wire);
    expect(mocks.startDesktopTunnel).not.toHaveBeenCalled();
  });

  it("opens the protected generic tunnel at the worker-local Code path", async () => {
    const drainHealthBody = vi.fn().mockResolvedValue(new ArrayBuffer(0));
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
    mocks.fetch.mockResolvedValue({
      arrayBuffer: drainHealthBody,
      body: {},
      ok: true,
    });

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
    expect(preferred.transportKind).toBe("relay");
    expect(mocks.startDesktopTunnel).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        compatibilityTransport: "legacy",
        diagnosticTraceId: expect.any(String),
      },
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:52345/code/_cantrip/health"),
      {
        cache: "no-store",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      },
    );
    expect(drainHealthBody).toHaveBeenCalledOnce();
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

  it("classifies a healthy desktop direct route without changing its tunnel identity", async () => {
    mocks.startDesktopTunnel.mockResolvedValue({
      attachmentId: "transport-1",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "local-direct",
      relayFallbackAvailable: false,
      directCapabilityId: "capability-1",
      tunnelId: "11111111-1111-4111-8111-111111111111",
    });
    mocks.fetch.mockResolvedValue({ ok: true });

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
      transportKind: "local-direct",
    });
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
        transportKind: "relay",
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

  it("surfaces the native protected rejection code in the attachment error", async () => {
    vi.useFakeTimers();
    try {
      const direct = {
        attachmentId: "transport-1",
        localHost: "127.0.0.1",
        localPort: 52345,
        routeState: "local-direct",
        relayFallbackAvailable: false,
        directCapabilityId: "capability-1",
        tunnelId: "11111111-1111-4111-8111-111111111111",
      } as const;
      mocks.startDesktopTunnel.mockResolvedValue(direct);
      mocks.invoke.mockResolvedValue([
        {
          ...direct,
          destinationRejectedCount: 1,
          lastDestinationRejectionCode: "protected-record-unavailable",
        },
      ]);
      mocks.fetch.mockRejectedValue(new TypeError("Load failed"));

      const pending = preferProtectedCodeAttachment({
        attachmentId: "11111111-1111-4111-8111-111111111111",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2026-08-13T12:00:00.000Z",
        runtime: {},
      } as never);
      const rejected = expect(pending).rejects.toMatchObject({
        destinationRejectionCode: "protected-record-unavailable",
        message:
          "Cantrip Code transport was rejected (protected-record-unavailable).",
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.clientLog).toHaveBeenCalledWith(
        "warn",
        "Cantrip Code destination rejected",
        expect.objectContaining({
          event: "code.attachment.destination.rejected",
          reasonCode: "protected-record-unavailable",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back immediately on a fresh direct rejection and stops immediately on the relay rejection", async () => {
    const direct = {
      attachmentId: "transport-1",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      tunnelId: "11111111-1111-4111-8111-111111111111",
    } as const;
    mocks.startDesktopTunnel.mockResolvedValue(direct);
    mocks.fetch.mockRejectedValue(new TypeError("Load failed"));
    mocks.invoke
      .mockResolvedValueOnce([
        {
          ...direct,
          destinationRejectedCount: 1,
          lastDestinationRejectionCode: "protected-record-unavailable",
        },
      ])
      .mockResolvedValueOnce([
        {
          ...direct,
          routeState: "relayed",
          destinationRejectedCount: 1,
          lastDestinationRejectionCode: "protected-record-unavailable",
        },
      ])
      .mockResolvedValueOnce([
        {
          ...direct,
          routeState: "relayed",
          destinationRejectedCount: 2,
          lastDestinationRejectionCode: "protected-record-unavailable",
        },
      ])
      .mockResolvedValue([
        {
          ...direct,
          routeState: "relayed",
          destinationRejectedCount: 2,
          lastDestinationRejectionCode: "protected-record-unavailable",
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
    ).rejects.toMatchObject({
      destinationRejectionCode: "protected-record-unavailable",
    });

    expect(mocks.forceDesktopTunnelRelay).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
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
    expect(mocks.invoke).not.toHaveBeenCalled();
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

  it("preserves cancellation while native rejection state is still pending", async () => {
    mocks.startDesktopTunnel.mockResolvedValue({
      attachmentId: "transport-1",
      localHost: "127.0.0.1",
      localPort: 52345,
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      destinationRejectedCount: 0,
      tunnelId: "11111111-1111-4111-8111-111111111111",
    });
    mocks.fetch.mockRejectedValue(new TypeError("Load failed"));
    mocks.invoke.mockReturnValue(new Promise(() => undefined));
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

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    const cancelled = expect(pending).rejects.toBe(cancellation);
    controller.abort(cancellation);

    await cancelled;
    expect(mocks.forceDesktopTunnelRelay).not.toHaveBeenCalled();
    expect(mocks.stopDesktopTunnel).toHaveBeenCalledTimes(1);
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
