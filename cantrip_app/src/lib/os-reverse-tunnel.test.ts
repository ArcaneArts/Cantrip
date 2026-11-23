import { afterEach, describe, expect, it, vi } from "vitest";
import type { TunnelWorkerLinkConnection } from "./tunnel-worker-link";
import type { OsReverseTunnelDependencies } from "./os-reverse-tunnel";
vi.mock("./api-client", () => ({
  request: vi.fn(),
  BOUND_API_REQUEST_BEHAVIOR: {},
}));
vi.mock("./api/tunnels", () => ({
  createTunnelAttachment: vi.fn(),
  deleteTunnelAttachment: vi.fn(),
  getTunnelTransportConfiguration: vi.fn(),
}));
vi.mock("./server-connections", () => ({
  getActiveServerUrl: () => "https://server.test",
}));
vi.mock("./worker-link", () => ({ workerLinkManager: {} }));
vi.mock("./tunnel-worker-link", () => ({ openTunnelWorkerLink: vi.fn() }));
import {
  osReverseTunnelSnapshot,
  startOsReverseTunnel,
  stopOsReverseTunnel,
} from "./os-reverse-tunnel";

const serverUrl = "https://server.test";
function fixture() {
  const source = {
    bindingId: "binding",
    worktreeId: "worktree",
    bindingGeneration: "binding-generation",
    attachmentGeneration: "attachment-generation",
    runtimeGeneration: "runtime",
  };
  const configuration = vi.fn(async () => ({
    workerId: "worker",
    revision: 7,
    source: {
      kind: "worker-os-listener" as const,
      workerId: "worker",
      source,
      port: 51566,
    },
    destination: {
      kind: "worker-tcp" as const,
      workerId: "worker",
      host: "127.0.0.1" as const,
      port: 51458,
    },
    dataProtection: {
      formatVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      key: "sensitive-key",
    },
  }));
  const connection = {
    bufferedAmount: 0,
    bridgeAuthority: {
      accountSessionId: "fixture",
      channelId: "fixture",
      clientInstanceId: "fixture",
      connectionId: "fixture",
      grantGeneration: 1,
      grantId: "fixture",
      ownerId: "fixture",
      routeGeneration: 1,
      serverGeneration: "fixture",
      serverId: "fixture",
      sessionId: "fixture",
      workerId: "worker",
      workerProcessGeneration: "fixture",
    },
    tunnelRoute: {
      tunnelId: "fixture",
      attachmentId: "fixture",
      sourceEndpointId: "fixture",
      destinationEndpointId: "fixture",
      target: { kind: "tcp", host: "127.0.0.1", port: 51458 },
    },
    route: "relay" as const,
    activate: vi.fn(),
    send: vi.fn(() => true),
    close: vi.fn(),
    keepAlive: vi.fn(() => true),
  } satisfies TunnelWorkerLinkConnection;
  let callbacks: Parameters<OsReverseTunnelDependencies["open"]>[0] | undefined;
  const dependencies = {
    configuration,
    create: vi.fn<OsReverseTunnelDependencies["create"]>(async () => ({
      attachmentId: crypto.randomUUID(),
      tunnelId: "fixture",
      secret: "fixture",
      connectPath: "/fixture",
      secretExpiresAt: new Date(Date.now() + 60000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    })),
    remove: vi.fn(async () => {}),
    open: vi.fn<OsReverseTunnelDependencies["open"]>(async (options) => {
      callbacks = options;
      return connection;
    }),
  } satisfies OsReverseTunnelDependencies;
  const id = crypto.randomUUID();
  return {
    id,
    dependencies,
    configuration,
    connection,
    close: () => callbacks!.onClose("endpoint-disconnected"),
    start: () => startOsReverseTunnel(id, { serverUrl, dependencies }),
  };
}
afterEach(async () => {
  for (const item of osReverseTunnelSnapshot())
    await stopOsReverseTunnel(item.tunnelId, item.serverUrl).catch(() => {});
  vi.useRealTimers();
});
describe("Worker-owned guest listener control", () => {
  it("pins the direction and revision and keeps an idle control channel alive", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const summary = await f.start();
    expect(summary.status).toBe("active");
    expect(f.dependencies.create).toHaveBeenCalledWith(
      f.id,
      expect.objectContaining({ kind: "worker-listener", expectedRevision: 7 }),
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.connection.keepAlive).toHaveBeenCalledTimes(3);
    await stopOsReverseTunnel(f.id, serverUrl);
    expect(f.dependencies.remove).toHaveBeenCalledWith(summary.attachmentId);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.connection.keepAlive).toHaveBeenCalledTimes(3);
  });
  it("rejects a saved route that changed back to an incoming service before attachment", async () => {
    const f = fixture();
    f.configuration.mockImplementationOnce(
      async () =>
        ({
          ...(await fixture().configuration()),
          source: { kind: "desktop-loopback" },
        }) as never,
    );
    await expect(f.start()).rejects.toThrow("no longer listens");
    expect(f.dependencies.create).not.toHaveBeenCalled();
  });
  it("deletes a late attachment when Stop wins against Start", async () => {
    const f = fixture();
    let release!: (
      value: Awaited<ReturnType<OsReverseTunnelDependencies["create"]>>,
    ) => void;
    f.dependencies.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const starting = f.start();
    const rejected = expect(starting).rejects.toThrow("retired");
    await vi.waitFor(() => expect(f.dependencies.create).toHaveBeenCalled());
    const stopping = stopOsReverseTunnel(f.id, serverUrl);
    const attachmentId = crypto.randomUUID();
    release({
      attachmentId,
      tunnelId: f.id,
      secret: "fixture",
      connectPath: "/fixture",
      secretExpiresAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    });
    await stopping;
    await rejected;
    expect(f.dependencies.remove).toHaveBeenCalledWith(attachmentId);
    expect(f.dependencies.open).not.toHaveBeenCalled();
  });
  it("closes a late channel and never resurrects a stopped listener", async () => {
    const f = fixture();
    let release!: (value: typeof f.connection) => void;
    f.dependencies.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const starting = f.start();
    const rejected = expect(starting).rejects.toThrow("retired");
    await vi.waitFor(() => expect(f.dependencies.open).toHaveBeenCalled());
    const stopping = stopOsReverseTunnel(f.id, serverUrl);
    release(f.connection);
    await stopping;
    await rejected;
    expect(f.connection.close).toHaveBeenCalled();
    expect(f.connection.activate).not.toHaveBeenCalled();
    expect(
      osReverseTunnelSnapshot().find((item) => item.tunnelId === f.id),
    ).toBeUndefined();
  });
  it("retires a disconnected listener and uses a new client identity for replacement", async () => {
    const f = fixture();
    await f.start();
    f.close();
    await vi.waitFor(() => expect(f.dependencies.remove).toHaveBeenCalled());
    await f.start();
    const clients = f.dependencies.create.mock.calls.map(
      (call) => call[1].clientId,
    );
    expect(new Set(clients).size).toBe(2);
  });
  it("retains a failed cleanup for an explicit retry", async () => {
    const f = fixture();
    await f.start();
    f.dependencies.remove.mockRejectedValueOnce(
      new Error("cleanup unavailable"),
    );
    await expect(stopOsReverseTunnel(f.id, serverUrl)).rejects.toThrow(
      "cleanup unavailable",
    );
    expect(
      osReverseTunnelSnapshot().find((item) => item.tunnelId === f.id)?.status,
    ).toBe("failed");
    await stopOsReverseTunnel(f.id, serverUrl);
    expect(f.dependencies.remove).toHaveBeenCalledTimes(2);
  });
});
