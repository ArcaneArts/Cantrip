import type {
  WorkerLinkChannelCloseCode,
  WorkerLinkRoute,
  WorkerLinkTunnelRoute,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  createBrowserCodeWorkerLinkSocket,
  type BrowserCodeWorkerLinkSocketDependencies,
} from "./browser-code-worker-link-socket";
import type { TunnelWorkerLinkConnection } from "./tunnel-worker-link";

const route: WorkerLinkTunnelRoute = {
  attachmentId: "attachment-1",
  destinationEndpointId: "worker-link-worker:worker-1",
  sourceEndpointId: "worker-link-client:grant-1",
  target: { host: "127.0.0.1", kind: "tcp", port: 4321 },
  tunnelId: "tunnel-1",
};

class FakeConnection implements TunnelWorkerLinkConnection {
  readonly bridgeAuthority = {
    accountSessionId: "account-session-1",
    channelId: "11111111-1111-4111-8111-111111111111",
    clientInstanceId: "client-instance-1",
    connectionId: "22222222-2222-4222-8222-222222222222",
    grantGeneration: 1,
    grantId: "33333333-3333-4333-8333-333333333333",
    ownerId: "owner-1",
    routeGeneration: 1,
    serverGeneration: "server-generation-1",
    serverId: "server-1",
    sessionId: "44444444-4444-4444-8444-444444444444",
    workerId: "worker-1",
    workerProcessGeneration: "worker-generation-1",
  };
  readonly activate = vi.fn();
  readonly bufferedAmount = 0;
  readonly close = vi.fn((_code?: WorkerLinkChannelCloseCode) => undefined);
  readonly send = vi.fn((_frame: Uint8Array) => true);
  readonly tunnelRoute = route;

  constructor(readonly route: WorkerLinkRoute) {}
}

function setup(
  selectedRoute: WorkerLinkRoute = "relay",
  queue: BrowserCodeWorkerLinkSocketDependencies["queue"] = queueMicrotask,
) {
  const connection = new FakeConnection(selectedRoute);
  let options:
    Parameters<BrowserCodeWorkerLinkSocketDependencies["openLink"]>[0] | null =
    null;
  const dependencies: BrowserCodeWorkerLinkSocketDependencies = {
    openLink: vi.fn(async (input) => {
      options = input;
      return connection;
    }),
    queue,
  };
  const socket = createBrowserCodeWorkerLinkSocket(
    {
      attachmentId: route.attachmentId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      tunnelId: route.tunnelId,
      workerId: "worker-1",
    },
    dependencies,
  );
  return { connection, dependencies, options: () => options, socket };
}

describe("browser Code WorkerLink socket", () => {
  it.each(["lan", "wan", "relay"] satisfies WorkerLinkRoute[])(
    "adapts a %s WorkerLink stream to the existing Code socket boundary",
    async (selectedRoute) => {
      const fixture = setup(selectedRoute);
      await new Promise<void>((resolve) =>
        fixture.socket.addEventListener("open", () => resolve(), {
          once: true,
        }),
      );
      const messages: unknown[] = [];
      fixture.socket.setMessageConsumer!(async (event) => {
        messages.push(event.data);
      });

      fixture.socket.send(
        JSON.stringify({ type: "initialize", clientId: "web-code:client-1" }),
      );
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(JSON.parse(messages[0] as string)).toEqual({
        type: "ready",
        attachmentId: route.attachmentId,
        destinationEndpointId: route.destinationEndpointId,
        expiresAt: "2099-01-01T00:00:00.000Z",
        sourceEndpointId: route.sourceEndpointId,
        tunnelId: route.tunnelId,
      });
      await vi.waitFor(() =>
        expect(fixture.connection.activate).toHaveBeenCalledOnce(),
      );

      fixture.socket.send(new Uint8Array([1, 2, 3]).buffer);
      expect(fixture.connection.send).toHaveBeenCalledWith(
        new Uint8Array([1, 2, 3]),
      );
      await fixture.options()!.onFrame(new Uint8Array([4, 5, 6]));
      expect(messages[1]).toEqual(new Uint8Array([4, 5, 6]).buffer);
      expect(fixture.connection.route).toBe(selectedRoute);
    },
  );

  it("maps authorization expiry to the existing protected-transport recovery signal", async () => {
    const fixture = setup();
    await new Promise<void>((resolve) =>
      fixture.socket.addEventListener("open", () => resolve(), { once: true }),
    );
    const closed = new Promise<CloseEvent>((resolve) =>
      fixture.socket.addEventListener(
        "close",
        (event) => resolve(event as CloseEvent),
        { once: true },
      ),
    );

    fixture.options()!.onClose("lifetime-expired");

    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it("invokes the browser scheduler without an illegal receiver", async () => {
    const queue = vi.fn(function (
      this: unknown,
      callback: () => void,
    ): void {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      callback();
    });
    const fixture = setup("relay", queue);
    await new Promise<void>((resolve) =>
      fixture.socket.addEventListener("open", () => resolve(), { once: true }),
    );
    fixture.socket.setMessageConsumer!(async () => undefined);

    fixture.socket.send(
      JSON.stringify({ type: "initialize", clientId: "web-code:client-1" }),
    );

    await vi.waitFor(() =>
      expect(fixture.connection.activate).toHaveBeenCalledOnce(),
    );
    expect(queue).toHaveBeenCalledOnce();
  });

  it("does not acknowledge WorkerLink input until the Code consumer drains it", async () => {
    const fixture = setup();
    await new Promise<void>((resolve) =>
      fixture.socket.addEventListener("open", () => resolve(), { once: true }),
    );
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.socket.setMessageConsumer!(async () => drained);

    const delivery = fixture.options()!.onFrame(new Uint8Array([7, 8, 9]));
    let settled = false;
    void Promise.resolve(delivery).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await delivery;
    expect(settled).toBe(true);
  });
});
