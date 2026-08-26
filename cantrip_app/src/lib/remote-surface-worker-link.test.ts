import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  encodeWorkerLinkRemoteSurfaceChunk,
  WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
  WorkerLinkRemoteSurfaceFrameAssembler,
  type RemoteSurfaceFrameHeader,
  type WorkerLinkChannelCloseCode,
  type WorkerLinkResourceGrant,
  type WorkerLinkRoute,
  type WorkerLinkSession,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RemoteSurfaceWorkerLinkClient,
  remoteSurfaceWorkerLinkRouteLabel,
  type RemoteSurfaceWorkerLinkDependencies,
  type RemoteSurfaceWorkerLinkRoutes,
} from "./remote-surface-worker-link";
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

function session(): WorkerLinkSession {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
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
    preferredRoute: "local",
  };
}

function grant(
  activeSession: WorkerLinkSession,
  streamKind: "browser" | "desktop" = "browser",
): WorkerLinkResourceGrant {
  return {
    binding: {
      grantId: crypto.randomUUID(),
      grantGeneration: 1,
      sessionId: activeSession.sessionId,
      identity: activeSession.identity,
      resource: {
        kind: streamKind === "browser" ? "browser" : "remote-desktop",
        resourceId: `${streamKind}-1`,
        attachmentId: crypto.randomUUID(),
      },
      lanes: ["interactive", "realtime"],
      operations: ["stream:open", "stream:read", "stream:write"],
      maxChannels: 2,
      lease: {
        ...activeSession.lease,
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    },
    token: "a".repeat(43),
  };
}

class FakeStream implements WorkerLinkStream {
  readonly channelId = crypto.randomUUID();
  readonly connectionId = crypto.randomUUID();
  readonly acknowledgements: number[] = [];
  readonly closeListeners = new Set<WorkerLinkStreamCloseListener>();
  readonly dataListeners = new Set<WorkerLinkDataListener>();
  readonly errorListeners = new Set<WorkerLinkStreamErrorListener>();
  readonly halfCloseListeners = new Set<WorkerLinkStreamHalfCloseListener>();
  readonly writableListeners = new Set<WorkerLinkStreamWritableListener>();
  readonly writes: Uint8Array[] = [];
  writable = true;

  constructor(
    readonly lane: "interactive" | "realtime",
    readonly route: WorkerLinkRoute,
  ) {}

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

  receive(payload: Uint8Array): void {
    for (const listener of this.dataListeners) listener(payload);
  }
}

function chunks(frame: Uint8Array, frameId: number): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < frame.byteLength;) {
    const end = Math.min(
      frame.byteLength,
      offset + WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES,
    );
    result.push(
      encodeWorkerLinkRemoteSurfaceChunk({
        frameId,
        frameLength: frame.byteLength,
        offset,
        payload: frame.subarray(offset, end),
      }),
    );
    offset = end;
  }
  return result;
}

function setup(
  routes: RemoteSurfaceWorkerLinkRoutes = {
    interactive: "local",
    realtime: "local",
  },
  streamKind: "browser" | "desktop" = "browser",
) {
  const activeSession = session();
  const grants: WorkerLinkResourceGrant[] = [];
  const streamSets: Array<{
    interactive: FakeStream;
    realtime: FakeStream;
  }> = [];
  const release = vi.fn();
  const link: WorkerLink = {
    preferredRoute: routes.interactive,
    session: activeSession,
    workerId: "worker-1",
    onRouteChanged: vi.fn(() => () => undefined),
    openStream: vi.fn(async (_grant, lane) => {
      if (lane === "interactive") {
        streamSets.push({
          interactive: new FakeStream("interactive", routes.interactive),
          realtime: new FakeStream("realtime", routes.realtime),
        });
      }
      const streams = streamSets.at(-1)!;
      return lane === "interactive" ? streams.interactive : streams.realtime;
    }),
    reprobe: vi.fn(async () => undefined),
  };
  const dependencies: RemoteSurfaceWorkerLinkDependencies = {
    createGrant: vi.fn(async () => {
      const created = grant(activeSession, streamKind);
      grants.push(created);
      return created;
    }),
    manager: {
      acquire: vi.fn(async () => ({ link, release })),
    },
    now: () => now,
    openPayload: vi.fn(async ({ protectedPayload }) =>
      protectedPayload.slice(),
    ),
    protectPayload: vi.fn(async ({ payload }) => payload.slice()),
    renewGrant: vi.fn(async () => grants.at(-1)!.binding.lease),
    revokeGrant: vi.fn(async () => undefined),
  };
  const states: string[] = [];
  const errors: Array<string | null> = [];
  const frames: Array<{
    header: RemoteSurfaceFrameHeader;
    payload: Uint8Array;
  }> = [];
  const readyRoutes: RemoteSurfaceWorkerLinkRoutes[] = [];
  const client = new RemoteSurfaceWorkerLinkClient(
    {
      messages: {
        connectionError: "connection failed",
        invalidFrame: "invalid frame",
      },
      onConnectionState: (state) => states.push(state),
      onError: (error) => errors.push(error),
      onFrame: (frame) => {
        frames.push(frame);
      },
      onReady: (selected) => readyRoutes.push(selected),
      streamKind,
      surfaceId: `${streamKind}-1`,
      surfaceKind: streamKind === "browser" ? "browser" : "remote-desktop",
      viewport: () => ({ width: 1_280, height: 720, devicePixelRatio: 2 }),
      workerId: "worker-1",
    },
    dependencies,
  );
  return {
    client,
    dependencies,
    errors,
    frames,
    grants,
    readyRoutes,
    release,
    states,
    streamSets,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Remote Surface WorkerLink client", () => {
  it("accepts an exact Remote Desktop grant through the same client", async () => {
    const fixture = setup({ interactive: "local", realtime: "lan" }, "desktop");
    fixture.client.start();
    await vi.waitFor(() => expect(fixture.readyRoutes).toHaveLength(1));
    expect(fixture.grants[0]!.binding.resource).toMatchObject({
      kind: "remote-desktop",
      resourceId: "desktop-1",
      attachmentId: expect.any(String),
    });
    expect(fixture.dependencies.createGrant).toHaveBeenCalledWith(
      fixture.grants[0]!.binding.sessionId,
      "desktop-1",
      { width: 1_280, height: 720, devicePixelRatio: 2 },
    );
    expect(fixture.client.send("control", new Uint8Array([1, 2, 3]))).toBe(
      true,
    );
    await vi.waitFor(() =>
      expect(fixture.dependencies.protectPayload).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            surfaceKind: "desktop",
            surfaceId: "desktop-1",
            channel: "control",
            direction: "client-to-worker",
          }),
        }),
      ),
    );
    fixture.client.close();
  });

  it("opens both lanes, exposes their effective routes, and fragments control", async () => {
    const fixture = setup({ interactive: "lan", realtime: "relay" });
    fixture.client.start();
    await vi.waitFor(() => expect(fixture.readyRoutes).toHaveLength(1));
    expect(fixture.readyRoutes[0]).toEqual({
      interactive: "lan",
      realtime: "relay",
    });
    expect(remoteSurfaceWorkerLinkRouteLabel(fixture.readyRoutes[0]!)).toBe(
      "interactive:lan,realtime:relay",
    );

    const payload = new Uint8Array(
      WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES + 1,
    ).fill(7);
    expect(fixture.client.send("control", payload)).toBe(true);
    const interactive = fixture.streamSets[0]!.interactive;
    await vi.waitFor(() =>
      expect(interactive.writes.length).toBeGreaterThan(1),
    );
    const assembler = new WorkerLinkRemoteSurfaceFrameAssembler();
    let assembled: Uint8Array | null = null;
    for (const part of interactive.writes) assembled = assembler.push(part);
    const decoded = decodeRemoteSurfaceFrame(assembled!);
    expect(decoded.header).toMatchObject({
      attachmentId: fixture.grants[0]!.binding.resource.attachmentId,
      channel: "control",
      sequence: 0,
      surfaceId: "browser-1",
    });
    expect(decoded.payload).toEqual(payload);
    fixture.client.close();
  });

  it("reassembles lane-bound inbound frames and returns chunk credit", async () => {
    const fixture = setup();
    fixture.client.start();
    await vi.waitFor(() => expect(fixture.readyRoutes).toHaveLength(1));
    const grant = fixture.grants[0]!;
    const payload = new Uint8Array(
      WORKER_LINK_REMOTE_SURFACE_CHUNK_PAYLOAD_BYTES + 5,
    ).fill(3);
    const encoded = encodeRemoteSurfaceFrame(
      {
        protocolVersion: 1,
        surfaceId: "browser-1",
        attachmentId: grant.binding.resource.attachmentId!,
        sequence: 0,
        channel: "frame",
      },
      payload,
    );
    const parts = chunks(encoded, 9);
    const realtime = fixture.streamSets[0]!.realtime;
    for (const part of parts) realtime.receive(part);
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(1));
    expect(fixture.frames[0]!.payload).toEqual(payload);
    expect(realtime.acknowledgements).toEqual(
      parts.map((part) => part.byteLength),
    );
    fixture.client.close();
  });

  it("reacquires authority after a lane disconnect", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.client.start();
    await vi.waitFor(() => expect(fixture.readyRoutes).toHaveLength(1));
    fixture.streamSets[0]!.interactive.close("endpoint-disconnected");
    expect(fixture.states.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(fixture.readyRoutes).toHaveLength(2));
    expect(fixture.grants).toHaveLength(2);
    expect(fixture.dependencies.revokeGrant).toHaveBeenCalledWith(
      fixture.grants[0]!.binding.sessionId,
      fixture.grants[0]!.binding.grantId,
    );
    fixture.client.close();
  });

  it("fails closed when a frame escapes its authorized lane", async () => {
    const fixture = setup();
    fixture.client.start();
    await vi.waitFor(() => expect(fixture.readyRoutes).toHaveLength(1));
    const grant = fixture.grants[0]!;
    const encoded = encodeRemoteSurfaceFrame(
      {
        protocolVersion: 1,
        surfaceId: "browser-1",
        attachmentId: grant.binding.resource.attachmentId!,
        sequence: 0,
        channel: "frame",
      },
      new Uint8Array([1, 2, 3]),
    );
    for (const part of chunks(encoded, 2)) {
      fixture.streamSets[0]!.interactive.receive(part);
    }
    await vi.waitFor(() => expect(fixture.errors).toContain("invalid frame"));
    expect(fixture.dependencies.revokeGrant).toHaveBeenCalledWith(
      grant.binding.sessionId,
      grant.binding.grantId,
    );
    fixture.client.close();
  });

  it("renews the exact attachment grant before its lease expires", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.client.start();
    await vi.waitFor(() => expect(fixture.readyRoutes).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fixture.dependencies.renewGrant).toHaveBeenCalledWith(
      fixture.grants[0]!.binding.sessionId,
      fixture.grants[0]!.binding.grantId,
    );
    fixture.client.close();
  });
});
