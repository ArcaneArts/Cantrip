import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const tunnelContent = vi.hoisted(() => ({
  open: vi.fn(),
}));
const tunnelProtection = vi.hoisted(() => ({
  seal: vi.fn(),
}));

vi.mock("../src/tunnel-content-encryption.js", () => ({
  openWorkerTunnelContentRecord: tunnelContent.open,
}));
vi.mock("../src/tunnel-data-protection.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/tunnel-data-protection.js")>();
  tunnelProtection.seal.mockImplementation(actual.sealTunnelDataFrame);
  return { ...actual, sealTunnelDataFrame: tunnelProtection.seal };
});

import type { CodeDirectEndpointManager } from "../src/code/direct-endpoint.js";
import { subscribeWorkerLogs } from "../src/logger.js";
import type { ProjectShareManager } from "../src/project-share-manager.js";
import { TunnelDestinationRouter } from "../src/tunnel-destination-router.js";
import type { TunnelTcpDestinationAdapter } from "../src/tunnel-tcp-adapter.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const subscriptions: Array<() => void> = [];

afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  vi.clearAllMocks();
});

function protectedConnect(
  overrides: Partial<
    Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>
  > = {},
): Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }> {
  return {
    protocolVersion: 1,
    tunnelId: "tunnel-1",
    attachmentId: "attachment-1",
    sourceEndpointId: "desktop:attachment-1",
    destinationEndpointId: "worker:worker-1",
    connectionId: "connection-1",
    sequence: 0,
    kind: "connect",
    initialCreditBytes: 1_024,
    target: {
      kind: "protected-tunnel",
      targetKind: "code",
      recordId: "tunnel-1",
      protectedRecord: {
        operationId: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        protectedContent: {
          formatVersion: 1,
          domain: "tunnel-content",
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      },
    },
    ...overrides,
  };
}

function closeConnection(
  header: TunnelDataPlaneFrameHeader,
): Extract<TunnelDataPlaneFrameHeader, { kind: "close" }> {
  return {
    protocolVersion: header.protocolVersion,
    tunnelId: header.tunnelId,
    attachmentId: header.attachmentId,
    sourceEndpointId: header.sourceEndpointId,
    destinationEndpointId: header.destinationEndpointId,
    connectionId: header.connectionId,
    sequence: header.sequence + 1,
    kind: "close",
    code: "endpoint-disconnected",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function fixture() {
  const tcp = {
    close: vi.fn(),
    disconnect: vi.fn(),
    failProtectedFrame: vi.fn(),
    failProtectedOutputFrame: vi.fn(),
    handleFrame: vi.fn(),
    setFrameEmitter: vi.fn(),
  } as unknown as TunnelTcpDestinationAdapter;
  const projectShares = {
    get: vi.fn().mockReturnValue(null),
    open: vi.fn(),
  } as unknown as ProjectShareManager;
  const codeEndpoints = {
    bindProtectedConnection: vi.fn(),
    prepareProtected: vi.fn(),
    prepareSharedProtected: vi.fn(),
  } as unknown as CodeDirectEndpointManager;
  const encryption = {
    componentKey: vi.fn(() => ({ key: new Uint8Array(32), keyRevision: 1 })),
    ownerId: vi.fn(() => "owner-1"),
    serverIdentity: vi.fn(() => "https://cantrip.test"),
  } as unknown as WorkerEncryptionService;
  const emitted = vi.fn(() => true);
  const router = new TunnelDestinationRouter(
    tcp,
    projectShares,
    codeEndpoints,
    encryption,
    "worker-1",
  );
  router.setFrameEmitter(emitted, async () => true);
  const records: Array<{ context?: unknown }> = [];
  const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
  subscriptions.push(unsubscribe);
  return { codeEndpoints, emitted, projectShares, records, router, tcp };
}

function codeContent() {
  return {
    name: "Code",
    description: null,
    source: { kind: "desktop-loopback" as const },
    destination: {
      kind: "worker-code" as const,
      workerId: "worker-1",
      resourceId: "tunnel-1",
      sessionId: "session-1",
    },
    dataProtection: {
      formatVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      key: "A".repeat(43),
    },
  };
}

function sharedCodeContent() {
  return {
    ...codeContent(),
    destination: {
      kind: "worker-code-transport" as const,
      workerId: "worker-1",
      resourceId: "tunnel-1",
    },
  };
}

function chatShareContent() {
  return {
    name: "Chat scratch files",
    description: null,
    source: { kind: "desktop-loopback" as const },
    destination: {
      kind: "worker-chat-share" as const,
      workerId: "worker-1",
      resourceId: "tunnel-1",
      chatId: "22222222-2222-4222-8222-222222222222",
      rootId: "33333333-3333-4333-8333-333333333333",
      publicBasePath: `/project-shares/${"x".repeat(43)}`,
      publicOrigin: "http://127.0.0.1" as const,
      username: "cantrip-chat",
      password: "a-secure-random-password-value",
      realm: "Cantrip Chat Share",
    },
    dataProtection: {
      formatVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      key: "A".repeat(43),
    },
  };
}

describe("TunnelDestinationRouter protected target diagnostics", () => {
  it("closes an unsealable protected response without retrying it as congestion", async () => {
    tunnelContent.open.mockResolvedValue(codeContent());
    const { codeEndpoints, emitted, router, tcp } = fixture();
    vi.mocked(codeEndpoints.prepareProtected).mockResolvedValue({
      kind: "tcp",
      host: "127.0.0.1",
      port: 43_210,
    });
    const connect = protectedConnect();
    router.handleFrame(connect, new Uint8Array());
    await vi.waitFor(() => expect(tcp.handleFrame).toHaveBeenCalledOnce());
    const emitTcp = vi.mocked(tcp.setFrameEmitter).mock.calls[0]?.[0];
    if (!emitTcp) throw new Error("TCP emitter was not installed.");
    const response: TunnelDataPlaneFrameHeader = {
      protocolVersion: 1,
      tunnelId: connect.tunnelId,
      attachmentId: connect.attachmentId,
      sourceEndpointId: connect.sourceEndpointId,
      destinationEndpointId: connect.destinationEndpointId,
      connectionId: connect.connectionId,
      sequence: 1,
      kind: "data",
      direction: "destination-to-source",
    };
    tunnelProtection.seal.mockImplementationOnce(() => {
      throw new Error("seal unavailable");
    });

    expect(emitTcp(response, new Uint8Array([1]))).toBe(true);
    expect(tcp.failProtectedOutputFrame).toHaveBeenCalledWith(response);
    expect(emitted).not.toHaveBeenCalled();
  });

  it("uses relay correlation carried by the destination connect frame", async () => {
    tunnelContent.open.mockRejectedValue(new Error("record unavailable"));
    const { emitted, records, router } = fixture();
    const diagnosticTraceId = "99999999-9999-4999-8999-999999999999";
    const header = { ...protectedConnect(), diagnosticTraceId };

    router.handleFrame(header, new Uint8Array());

    await vi.waitFor(() => expect(emitted).toHaveBeenCalledOnce());
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "tunnel.protected-target.rejected",
            diagnosticTraceId,
          }),
        }),
      ]),
    );
  });

  it("correlates a validated Code target through endpoint preparation", async () => {
    tunnelContent.open.mockResolvedValue(codeContent());
    const { codeEndpoints, records, router, tcp } = fixture();
    vi.mocked(codeEndpoints.prepareProtected).mockResolvedValue({
      kind: "tcp",
      host: "127.0.0.1",
      port: 43_210,
    });
    const header = protectedConnect();
    header.diagnosticTraceId = "11111111-1111-4111-8111-111111111111";
    const diagnosticTraceId = "22222222-2222-4222-8222-222222222222";

    router.handleFrame(header, new Uint8Array(), { diagnosticTraceId });

    await vi.waitFor(() =>
      expect(codeEndpoints.prepareProtected).toHaveBeenCalledWith(
        "tunnel-1",
        "session-1",
        {
          attachmentId: "attachment-1",
          connectionId: "connection-1",
          diagnosticTraceId,
        },
      ),
    );
    expect(tcp.handleFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "connect",
        target: { kind: "tcp", host: "127.0.0.1", port: 43_210 },
      }),
      new Uint8Array(),
      expect.any(Function),
    );
    const onConnected = vi.mocked(tcp.handleFrame).mock.calls[0]?.[2];
    expect(onConnected).toBeTypeOf("function");
    onConnected?.(54_321);
    expect(codeEndpoints.bindProtectedConnection).toHaveBeenCalledWith(
      "tunnel-1",
      43_210,
      54_321,
      {
        attachmentId: "attachment-1",
        connectionId: "connection-1",
        diagnosticTraceId,
      },
    );
    expect(records).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "tunnel.protected-target.routed",
          }),
        }),
      ]),
    );
  });

  it("hands an authorized shared Code transport to one session-independent endpoint", async () => {
    const { codeEndpoints, router, tcp } = fixture();
    vi.mocked(codeEndpoints.prepareSharedProtected).mockResolvedValue({
      kind: "tcp",
      host: "127.0.0.1",
      port: 43_211,
    });
    const header = protectedConnect();
    if (header.target.kind !== "protected-tunnel") {
      throw new Error("Expected a protected tunnel target.");
    }
    const transportId = header.target.protectedRecord.operationId;
    header.tunnelId = transportId;
    header.target.recordId = transportId;
    tunnelContent.open.mockResolvedValue({
      ...sharedCodeContent(),
      destination: {
        ...sharedCodeContent().destination,
        resourceId: transportId,
      },
    });
    const diagnosticTraceId = "22222222-2222-4222-8222-222222222222";

    router.handleFrame(header, new Uint8Array(), { diagnosticTraceId });

    await vi.waitFor(() =>
      expect(codeEndpoints.prepareSharedProtected).toHaveBeenCalledWith(
        transportId,
        {
          ownerId: "owner-1",
          protectedKeyRevision: 1,
          serverId: "https://cantrip.test",
        },
        {
          attachmentId: "attachment-1",
          connectionId: "connection-1",
          diagnosticTraceId,
        },
      ),
    );
    expect(codeEndpoints.prepareProtected).not.toHaveBeenCalled();
    expect(tcp.handleFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "connect",
        target: { kind: "tcp", host: "127.0.0.1", port: 43_211 },
      }),
      new Uint8Array(),
      expect.any(Function),
    );
  });

  it("rejects a shared Code record whose resource escaped its tunnel", async () => {
    const { codeEndpoints, emitted, router, tcp } = fixture();
    const header = protectedConnect();
    if (header.target.kind !== "protected-tunnel") {
      throw new Error("Expected a protected tunnel target.");
    }
    const transportId = header.target.protectedRecord.operationId;
    header.tunnelId = transportId;
    header.target.recordId = transportId;
    tunnelContent.open.mockResolvedValue({
      ...sharedCodeContent(),
      destination: {
        ...sharedCodeContent().destination,
        resourceId: "another-tunnel",
      },
    });

    router.handleFrame(header, new Uint8Array());

    await vi.waitFor(() => expect(emitted).toHaveBeenCalledOnce());
    expect(codeEndpoints.prepareSharedProtected).not.toHaveBeenCalled();
    expect(tcp.handleFrame).not.toHaveBeenCalled();
  });

  it("routes a Chat share only after its exact root-bound share was prepared", async () => {
    const content = chatShareContent();
    tunnelContent.open.mockResolvedValue(content);
    const { projectShares, router, tcp } = fixture();
    const descriptor = {
      shareId: "tunnel-1",
      protocol: "webdav" as const,
      publicBasePath: content.destination.publicBasePath,
      publicOrigin: "http://127.0.0.1" as const,
      loopbackHost: "127.0.0.1" as const,
      loopbackPort: 43_210,
      username: content.destination.username,
      password: content.destination.password,
      realm: content.destination.realm,
    };
    vi.mocked(projectShares.get).mockReturnValue(descriptor);
    const header = protectedConnect();
    if (header.target.kind !== "protected-tunnel") {
      throw new Error("Expected a protected test target.");
    }
    header.target.targetKind = "project-share";

    router.handleFrame(header, new Uint8Array());

    await vi.waitFor(() => expect(tcp.handleFrame).toHaveBeenCalledOnce());
    expect(projectShares.get).toHaveBeenCalledWith("tunnel-1");
    expect(projectShares.open).not.toHaveBeenCalled();
    expect(tcp.handleFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "tcp", host: "127.0.0.1", port: 43_210 },
      }),
      new Uint8Array(),
      undefined,
    );
  });

  it("records a binding-specific reason without attempting decryption", async () => {
    const { emitted, records, router } = fixture();
    const header = protectedConnect();
    if (header.target.kind !== "protected-tunnel") {
      throw new Error("Expected a protected test target.");
    }
    header.target.recordId = "another-tunnel";

    const diagnosticTraceId = "22222222-2222-4222-8222-222222222222";
    router.handleFrame(header, new Uint8Array(), { diagnosticTraceId });
    router.handleFrame(header, new Uint8Array(), { diagnosticTraceId });

    await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(2));
    expect(tunnelContent.open).not.toHaveBeenCalled();
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rejected",
        code: "protected-target-invalid",
      }),
      new Uint8Array(),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "tunnel.protected-target.rejected",
            reasonCode: "invalid-target-binding",
            diagnosticTraceId,
            tunnelId: "tunnel-1",
            connectionId: "connection-1",
          }),
        }),
      ]),
    );
    expect(
      records.filter(
        (record) =>
          (record.context as { event?: unknown } | undefined)?.event ===
          "tunnel.protected-target.rejected",
      ),
    ).toHaveLength(1);
  });

  it("preserves protected record authentication failures", async () => {
    tunnelContent.open.mockRejectedValue(
      Object.assign(new Error("record could not be authenticated"), {
        code: "AUTH_FAILED",
      }),
    );
    const { emitted, records, router } = fixture();

    const diagnosticTraceId = "22222222-2222-4222-8222-222222222222";
    router.handleFrame(protectedConnect(), new Uint8Array(), {
      diagnosticTraceId,
    });

    await vi.waitFor(() => expect(emitted).toHaveBeenCalledOnce());
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rejected",
        code: "protected-record-unavailable",
      }),
      new Uint8Array(),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "tunnel.protected-target.rejected",
            reasonCode: "protected-record-open-failed",
            errorCode: "AUTH_FAILED",
            diagnosticTraceId,
            tunnelId: "tunnel-1",
            connectionId: "connection-1",
          }),
        }),
      ]),
    );
  });

  it("preserves the Code endpoint preparation failure stage", async () => {
    tunnelContent.open.mockResolvedValue(codeContent());
    const { codeEndpoints, emitted, records, router } = fixture();
    vi.mocked(codeEndpoints.prepareProtected).mockRejectedValue(
      Object.assign(new Error("endpoint unavailable"), { code: "EADDRINUSE" }),
    );

    const diagnosticTraceId = "22222222-2222-4222-8222-222222222222";
    router.handleFrame(protectedConnect(), new Uint8Array(), {
      diagnosticTraceId,
    });

    await vi.waitFor(() => expect(emitted).toHaveBeenCalledOnce());
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rejected",
        code: "protected-endpoint-unavailable",
      }),
      new Uint8Array(),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "tunnel.protected-target.rejected",
            reasonCode: "code-endpoint-preparation-failed",
            errorCode: "EADDRINUSE",
            diagnosticTraceId,
            sessionId: "session-1",
            tunnelId: "tunnel-1",
            connectionId: "connection-1",
          }),
        }),
      ]),
    );
  });

  it("cancels a delayed protected record open and permits a fresh connection", async () => {
    const firstRecord = deferred<ReturnType<typeof codeContent>>();
    tunnelContent.open
      .mockImplementationOnce(() => firstRecord.promise)
      .mockResolvedValue(codeContent());
    const { codeEndpoints, emitted, router, tcp } = fixture();
    vi.mocked(codeEndpoints.prepareProtected).mockResolvedValue({
      kind: "tcp",
      host: "127.0.0.1",
      port: 43_210,
    });
    const first = protectedConnect();

    router.handleFrame(first, new Uint8Array());
    await vi.waitFor(() => expect(tunnelContent.open).toHaveBeenCalledOnce());
    router.handleFrame(closeConnection(first), new Uint8Array());
    expect(codeEndpoints.prepareProtected).not.toHaveBeenCalled();
    expect(tcp.handleFrame).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();

    const second = protectedConnect();
    router.handleFrame(second, new Uint8Array());
    await vi.waitFor(() => expect(tcp.handleFrame).toHaveBeenCalledOnce());
    firstRecord.resolve(codeContent());
    await nextTurn();

    expect(codeEndpoints.prepareProtected).toHaveBeenCalledOnce();
    expect(tcp.handleFrame).toHaveBeenCalledOnce();
    expect(tcp.handleFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-1",
        target: { kind: "tcp", host: "127.0.0.1", port: 43_210 },
      }),
      new Uint8Array(),
      expect.any(Function),
    );
  });

  it("cancels delayed Code preparation without binding or leaking into a fresh connection", async () => {
    tunnelContent.open.mockResolvedValue(codeContent());
    const firstEndpoint = deferred<{
      kind: "tcp";
      host: string;
      port: number;
    }>();
    const { codeEndpoints, emitted, router, tcp } = fixture();
    vi.mocked(codeEndpoints.prepareProtected)
      .mockImplementationOnce(() => firstEndpoint.promise)
      .mockResolvedValue({
        kind: "tcp",
        host: "127.0.0.1",
        port: 43_211,
      });
    const first = protectedConnect();

    router.handleFrame(first, new Uint8Array());
    await vi.waitFor(() =>
      expect(codeEndpoints.prepareProtected).toHaveBeenCalledOnce(),
    );
    router.handleFrame(closeConnection(first), new Uint8Array());
    firstEndpoint.resolve({
      kind: "tcp",
      host: "127.0.0.1",
      port: 43_210,
    });
    await nextTurn();

    expect(tcp.handleFrame).not.toHaveBeenCalled();
    expect(codeEndpoints.bindProtectedConnection).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();

    const second = protectedConnect({ connectionId: "connection-2" });
    router.handleFrame(second, new Uint8Array());
    await vi.waitFor(() => expect(tcp.handleFrame).toHaveBeenCalledOnce());
    const onConnected = vi.mocked(tcp.handleFrame).mock.calls[0]?.[2];
    onConnected?.(54_321);
    expect(codeEndpoints.bindProtectedConnection).toHaveBeenCalledWith(
      "tunnel-1",
      43_211,
      54_321,
      expect.objectContaining({ connectionId: "connection-2" }),
    );
  });

  it("invalidates delayed protected preparation when the router disconnects", async () => {
    tunnelContent.open.mockResolvedValue(codeContent());
    const endpoint = deferred<{
      kind: "tcp";
      host: string;
      port: number;
    }>();
    const { codeEndpoints, emitted, router, tcp } = fixture();
    vi.mocked(codeEndpoints.prepareProtected).mockReturnValue(endpoint.promise);

    router.handleFrame(protectedConnect(), new Uint8Array());
    await vi.waitFor(() =>
      expect(codeEndpoints.prepareProtected).toHaveBeenCalledOnce(),
    );
    router.disconnect();
    endpoint.resolve({ kind: "tcp", host: "127.0.0.1", port: 43_210 });
    await nextTurn();

    expect(tcp.disconnect).toHaveBeenCalledOnce();
    expect(tcp.handleFrame).not.toHaveBeenCalled();
    expect(codeEndpoints.bindProtectedConnection).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
  });
});
