import type {
  TerminalClientMessage,
  WorkerLinkChannelCloseCode,
  WorkerLinkResourceGrant,
  WorkerLinkRoute,
  WorkerLinkSession,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openTerminalWorkerLink,
  type TerminalWorkerLinkDependencies,
} from "./terminal-worker-link";
import type {
  WorkerLink,
  WorkerLinkDataListener,
  WorkerLinkStream,
  WorkerLinkStreamCloseListener,
  WorkerLinkStreamErrorListener,
  WorkerLinkStreamHalfCloseListener,
  WorkerLinkStreamWritableListener,
} from "./worker-link";

const now = Date.parse("2026-08-26T12:00:00.000Z");
const operationId = "11111111-1111-4111-8111-111111111111";

function session(preferredRoute: WorkerLinkRoute = "local"): WorkerLinkSession {
  return {
    sessionId: "22222222-2222-4222-8222-222222222222",
    identity: {
      serverId: "server-1",
      serverGeneration: "server-generation-1",
      ownerId: "owner-1",
      accountSessionId: "account-session-1",
      clientInstanceId: "client-instance-1",
      workerId: "worker-1",
      workerProcessGeneration: "worker-generation-1",
    },
    lease: {
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 120_000).toISOString(),
      absoluteExpiresAt: new Date(now + 3_600_000).toISOString(),
    },
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled: ["local", "lan", "wan", "relay"],
    },
    routeGeneration: 1,
    preferredRoute,
  };
}

function grant(activeSession: WorkerLinkSession): WorkerLinkResourceGrant {
  return {
    binding: {
      grantId: "33333333-3333-4333-8333-333333333333",
      grantGeneration: 1,
      sessionId: activeSession.sessionId,
      identity: activeSession.identity,
      resource: {
        kind: "terminal",
        resourceId: "terminal-1",
        attachmentId: operationId,
      },
      lanes: ["interactive"],
      operations: ["stream:open", "stream:read", "stream:write"],
      maxChannels: 1,
      lease: {
        ...activeSession.lease,
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    },
    token: "a".repeat(43),
  };
}

class FakeStream implements WorkerLinkStream {
  readonly channelId = "44444444-4444-4444-8444-444444444444";
  readonly connectionId = "55555555-5555-4555-8555-555555555555";
  readonly lane = "interactive" as const;
  writable = true;
  readonly writes: Uint8Array[] = [];
  readonly acknowledgements: number[] = [];
  readonly closeListeners = new Set<WorkerLinkStreamCloseListener>();
  readonly dataListeners = new Set<WorkerLinkDataListener>();
  readonly errorListeners = new Set<WorkerLinkStreamErrorListener>();
  readonly halfCloseListeners = new Set<WorkerLinkStreamHalfCloseListener>();
  readonly writableListeners = new Set<WorkerLinkStreamWritableListener>();

  constructor(readonly route: WorkerLinkRoute) {}

  acknowledge(bytes: number): boolean {
    this.acknowledgements.push(bytes);
    return true;
  }

  close(code: WorkerLinkChannelCloseCode = "normal"): void {
    for (const listener of [...this.closeListeners]) listener(code);
  }

  halfClose(): boolean {
    return true;
  }

  onClose(listener: WorkerLinkStreamCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onData(listener: WorkerLinkDataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onError(listener: WorkerLinkStreamErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onHalfClose(listener: WorkerLinkStreamHalfCloseListener): () => void {
    this.halfCloseListeners.add(listener);
    return () => this.halfCloseListeners.delete(listener);
  }

  onWritable(listener: WorkerLinkStreamWritableListener): () => void {
    this.writableListeners.add(listener);
    return () => this.writableListeners.delete(listener);
  }

  write(payload: Uint8Array): boolean {
    if (!this.writable) return false;
    this.writes.push(payload.slice());
    return true;
  }

  receive(message: unknown): Uint8Array {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    for (const listener of this.dataListeners) listener(payload);
    return payload;
  }

  makeWritable(): void {
    this.writable = true;
    for (const listener of this.writableListeners) listener();
  }
}

function setup(route: WorkerLinkRoute = "local") {
  const activeSession = session(route);
  const activeGrant = grant(activeSession);
  const stream = new FakeStream(route);
  const release = vi.fn();
  const link: WorkerLink = {
    preferredRoute: route,
    session: activeSession,
    workerId: "worker-1",
    onRouteChanged: (listener) => {
      listener({
        preferredRoute: route,
        effectiveRoute: route,
        routeGeneration: 1,
        latencyMs: 1,
        fallbackReason: null,
        changedAt: new Date(now).toISOString(),
      });
      return () => undefined;
    },
    openEventSubscription: vi.fn(async () => stream),
    openStream: vi.fn(async () => stream),
    reprobe: vi.fn(async () => undefined),
  };
  const dependencies: TerminalWorkerLinkDependencies = {
    createGrant: vi.fn(async () => activeGrant),
    manager: { acquire: vi.fn(async () => ({ link, release })) },
    now: () => now,
    renewGrant: vi.fn(async () => activeGrant.binding.lease),
    revokeGrant: vi.fn(async () => undefined),
  };
  return { activeGrant, dependencies, link, release, stream };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Terminal WorkerLink client", () => {
  it("buffers frames until activation and returns credit after consumption", async () => {
    const fixture = setup();
    const messages: unknown[] = [];
    const connection = await openTerminalWorkerLink(
      {
        onClose: vi.fn(),
        onMessage: async (message) => {
          messages.push(message);
        },
        operationId,
        terminalId: "terminal-1",
        workerId: "worker-1",
      },
      fixture.dependencies,
    );
    const payload = fixture.stream.receive({ type: "ready" });
    await Promise.resolve();
    expect(messages).toHaveLength(0);
    expect(fixture.stream.acknowledgements).toHaveLength(0);

    connection.activate();
    await vi.waitFor(() => expect(messages).toEqual([{ type: "ready" }]));
    expect(fixture.stream.acknowledgements).toEqual([payload.byteLength]);
    expect(connection.route).toBe("local");
    connection.close();
    expect(fixture.dependencies.revokeGrant).toHaveBeenCalledWith(
      fixture.activeGrant.binding.sessionId,
      fixture.activeGrant.binding.grantId,
    );
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("queues ordered Terminal messages until stream credit returns", async () => {
    const fixture = setup();
    fixture.stream.writable = false;
    const connection = await openTerminalWorkerLink(
      {
        onClose: vi.fn(),
        onMessage: vi.fn(),
        operationId,
        terminalId: "terminal-1",
        workerId: "worker-1",
      },
      fixture.dependencies,
    );
    const first: TerminalClientMessage = {
      type: "resize",
      cols: 80,
      rows: 24,
    };
    const second: TerminalClientMessage = {
      type: "resize",
      cols: 132,
      rows: 40,
    };
    expect(connection.send(first)).toBe(true);
    expect(connection.send(second)).toBe(true);
    expect(fixture.stream.writes).toHaveLength(0);

    fixture.stream.makeWritable();
    expect(
      fixture.stream.writes.map((payload) =>
        JSON.parse(new TextDecoder().decode(payload)),
      ),
    ).toEqual([first, second]);
    connection.close();
  });

  it.each(["lan", "wan", "relay"] satisfies WorkerLinkRoute[])(
    "uses the same grant and stream boundary when the manager selects %s",
    async (route) => {
      const fixture = setup(route);
      const connection = await openTerminalWorkerLink(
        {
          onClose: vi.fn(),
          onMessage: vi.fn(),
          operationId,
          terminalId: "terminal-1",
          workerId: "worker-1",
        },
        fixture.dependencies,
      );

      expect(connection.route).toBe(route);
      expect(fixture.dependencies.createGrant).toHaveBeenCalledWith(
        fixture.activeGrant.binding.sessionId,
        "terminal-1",
        operationId,
      );
      expect(fixture.link.openStream).toHaveBeenCalledWith(
        fixture.activeGrant,
        "interactive",
      );
      connection.close();
    },
  );

  it("releases the shared link and grant when stream opening fails", async () => {
    const fixture = setup();
    vi.mocked(fixture.link.openStream).mockRejectedValueOnce(
      new Error("stream rejected"),
    );
    await expect(
      openTerminalWorkerLink(
        {
          onClose: vi.fn(),
          onMessage: vi.fn(),
          operationId,
          terminalId: "terminal-1",
          workerId: "worker-1",
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow("stream rejected");
    expect(fixture.dependencies.revokeGrant).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
