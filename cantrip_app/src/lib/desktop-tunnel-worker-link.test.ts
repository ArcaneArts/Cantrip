import type {
  WorkerLinkChannelCloseCode,
  WorkerLinkRoute,
  WorkerLinkTunnelRoute,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startDesktopTunnelWorkerLinkForward,
  stopDesktopTunnelWorkerLinkForward,
  type DesktopTunnelWorkerLinkDependencies,
} from "./desktop-tunnel-worker-link";
import type {
  OpenTunnelWorkerLinkOptions,
  TunnelWorkerLinkConnection,
} from "./tunnel-worker-link";

const tunnelId = "tunnel-1";
const attachmentId = "attachment-1";

function route(grantId = "grant-1"): WorkerLinkTunnelRoute {
  return {
    tunnelId,
    attachmentId,
    sourceEndpointId: `worker-link-client:${grantId}`,
    destinationEndpointId: "worker-link-worker:worker-1",
    target: { kind: "tcp", host: "127.0.0.1", port: 4321 },
  };
}

class FakeConnection implements TunnelWorkerLinkConnection {
  readonly bufferedAmount = 0;
  readonly activate = vi.fn();
  readonly close = vi.fn((_code?: WorkerLinkChannelCloseCode) => undefined);
  readonly send = vi.fn((_frame: Uint8Array) => true);

  constructor(
    readonly route: WorkerLinkRoute,
    readonly tunnelRoute: WorkerLinkTunnelRoute,
  ) {}
}

class FakeSocket {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState = 1;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly binaryWrites: Uint8Array[] = [];

  constructor() {
    queueMicrotask(() => this.onopen?.({} as Event));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({} as CloseEvent));
  }

  send(data: ArrayBuffer | string): void {
    if (typeof data === "string") {
      const initialize = JSON.parse(data) as {
        identity: { attachmentId: string; tunnelId: string };
      };
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            type: "ready",
            attachmentId: initialize.identity.attachmentId,
            tunnelId: initialize.identity.tunnelId,
          }),
        } as MessageEvent<string>),
      );
      return;
    }
    this.binaryWrites.push(new Uint8Array(data).slice());
  }

  receive(frame: Uint8Array): void {
    this.onmessage?.({
      data: frame.slice().buffer,
    } as MessageEvent<ArrayBuffer>);
  }
}

function setup(routes: WorkerLinkRoute[] = ["local"]) {
  const sockets: FakeSocket[] = [];
  const connections: FakeConnection[] = [];
  const linkOptions: OpenTunnelWorkerLinkOptions[] = [];
  const invoke = vi.fn(async (command: string) => {
    if (command === "prepare_worker_link_tunnel_forward") {
      return {
        bridge: { token: "b".repeat(43), url: "ws://127.0.0.1:43123/" },
        forward: {
          attachmentId,
          diagnosticTraceId: null,
          expiresAt: "2099-01-01T00:00:00.000Z",
          localHost: "127.0.0.1",
          localPort: 41234,
          routeState: "degraded",
          relayFallbackAvailable: false,
          directCapabilityId: null,
          directFallbackReason: null,
          tunnelId,
        },
      };
    }
    if (
      command === "update_worker_link_tunnel_forward_route" ||
      command === "stop_tunnel_forward"
    ) {
      return undefined;
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const dependencies: DesktopTunnelWorkerLinkDependencies = {
    invoke,
    now: Date.now,
    openLink: vi.fn(async (options) => {
      linkOptions.push(options);
      const selected = routes[connections.length] ?? "relay";
      const connection = new FakeConnection(
        selected,
        route(`grant-${connections.length + 1}`),
      );
      connections.push(connection);
      return connection;
    }),
    openSocket: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    schedule: setTimeout,
    cancelSchedule: clearTimeout,
  };
  return { connections, dependencies, invoke, linkOptions, sockets };
}

function input() {
  return {
    attachmentId,
    dataProtection: {
      formatVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      key: "k".repeat(43),
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    serverUrl: "https://cantrip.example",
    tunnelId,
    workerId: "worker-1",
  };
}

afterEach(async () => {
  await stopDesktopTunnelWorkerLinkForward(tunnelId);
  vi.useRealTimers();
});

describe("desktop tunnel WorkerLink bridge", () => {
  it("binds the native listener once and pumps framed bytes through WorkerLink", async () => {
    const fixture = setup();
    const summary = await startDesktopTunnelWorkerLinkForward(
      input(),
      fixture.dependencies,
    );
    expect(summary).toMatchObject({
      localPort: 41234,
      routeState: "local-direct",
    });
    expect(fixture.connections[0]!.activate).toHaveBeenCalledOnce();

    const workerFrame = new Uint8Array([1, 2, 3]);
    await fixture.linkOptions[0]!.onFrame(workerFrame);
    expect(fixture.sockets[0]!.binaryWrites).toEqual([workerFrame]);

    const nativeFrame = new Uint8Array([4, 5, 6]);
    fixture.sockets[0]!.receive(nativeFrame);
    expect(fixture.connections[0]!.send).toHaveBeenCalledWith(nativeFrame);
    fixture.linkOptions[0]!.onRouteChanged?.("relay");
    await vi.waitFor(() =>
      expect(fixture.invoke).toHaveBeenCalledWith(
        "update_worker_link_tunnel_forward_route",
        { attachmentId, route: "relay", tunnelId },
      ),
    );
  });

  it("reopens only the WorkerLink stream after a route failure", async () => {
    vi.useFakeTimers();
    const fixture = setup(["local", "relay"]);
    await startDesktopTunnelWorkerLinkForward(input(), fixture.dependencies);

    fixture.linkOptions[0]!.onClose("endpoint-disconnected");
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(fixture.connections).toHaveLength(2));

    expect(
      fixture.invoke.mock.calls.filter(
        ([command]) => command === "prepare_worker_link_tunnel_forward",
      ),
    ).toHaveLength(1);
    expect(fixture.sockets).toHaveLength(2);
    expect(fixture.connections[1]!.activate).toHaveBeenCalledOnce();
  });

  it.each(["lan", "wan"] satisfies WorkerLinkRoute[])(
    "preserves the native listener while renderer traffic uses %s",
    async (route) => {
      const fixture = setup([route]);
      const summary = await startDesktopTunnelWorkerLinkForward(
        input(),
        fixture.dependencies,
      );

      expect(summary).toMatchObject({
        localPort: 41234,
        routeState: "local-direct",
      });
      expect(fixture.connections[0]!.route).toBe(route);
      expect(fixture.connections[0]!.activate).toHaveBeenCalledOnce();
      expect(fixture.sockets).toHaveLength(1);
    },
  );
});
