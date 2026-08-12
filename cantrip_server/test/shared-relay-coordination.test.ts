import {
  appLiveClientMessageSchema,
  appLiveServerMessageSchema,
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  workerRequestEnvelopeSchema,
  type AppLiveClientMessage,
  type AppLiveServerMessage,
  type RemoteSurfaceFrameHeader,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  createInMemoryRelayCoordinatorBackend,
  InMemoryRelayCoordinator,
} from "../src/coordination/relay-coordinator.js";
import { AppLiveHub, type AppLiveSocket } from "../src/live/hub.js";
import { CoordinatedWorkerBridge } from "../src/workers/coordinated-bridge.js";

class TestWorkerSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly sent: Array<string | Uint8Array> = [];
  readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }
}

class TestLiveSocket implements AppLiveSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: AppLiveServerMessage[] = [];
  readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }

  send(data: string): void {
    this.sent.push(appLiveServerMessageSchema.parse(JSON.parse(data)));
  }

  receive(message: AppLiveClientMessage): void {
    this.emit(
      "message",
      JSON.stringify(appLiveClientMessageSchema.parse(message)),
      false,
    );
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }
}

const settle = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("shared relay coordination", () => {
  it("routes commands and binary frames between server instances", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinatorA = new InMemoryRelayCoordinator("instance-a", backend);
    const coordinatorB = new InMemoryRelayCoordinator("instance-b", backend);
    await Promise.all([coordinatorA.start(), coordinatorB.start()]);
    const resolveOwnerId = async () => "owner-1";
    const bridgeA = new CoordinatedWorkerBridge({
      coordinator: coordinatorA,
      resolveOwnerId,
    });
    const bridgeB = new CoordinatedWorkerBridge({
      coordinator: coordinatorB,
      resolveOwnerId,
    });
    const workerSocket = new TestWorkerSocket();
    await bridgeB.attach("worker-1", workerSocket, "owner-1");

    expect(bridgeA.isConnected("worker-1")).toBe(true);
    const request = bridgeA.request(
      "worker-1",
      { type: "code.probe" },
      { ownerId: "owner-1" },
    );
    await vi.waitFor(() => expect(workerSocket.sent).toHaveLength(1));
    const workerRequest = workerRequestEnvelopeSchema.parse(
      JSON.parse(String(workerSocket.sent[0])),
    );
    workerSocket.emit(
      "message",
      JSON.stringify({
        kind: "response",
        requestId: workerRequest.requestId,
        ok: true,
        result: { available: true },
      }),
      false,
    );
    await expect(request).resolves.toEqual({ available: true });

    const header: RemoteSurfaceFrameHeader = {
      protocolVersion: 1,
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
      sequence: 1,
      channel: "control",
    };
    expect(
      bridgeA.sendSurfaceFrame("worker-1", header, new Uint8Array([1, 2])),
    ).toBe(true);
    await vi.waitFor(() => expect(workerSocket.sent).toHaveLength(2));
    expect(
      decodeRemoteSurfaceFrame(workerSocket.sent[1] as Uint8Array),
    ).toEqual({ header, payload: new Uint8Array([1, 2]) });

    const received = vi.fn();
    bridgeA.subscribeSurfaceFrames("worker-1", received);
    workerSocket.emit(
      "message",
      encodeRemoteSurfaceFrame(
        { ...header, sequence: 2 },
        new Uint8Array([3, 4]),
      ),
      true,
    );
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledWith(
        { ...header, sequence: 2 },
        new Uint8Array([3, 4]),
      ),
    );

    await bridgeA.close();
    await bridgeB.close();
    await Promise.all([coordinatorA.close(), coordinatorB.close()]);
  });

  it("makes the newest duplicate worker connection authoritative", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinatorA = new InMemoryRelayCoordinator("instance-a", backend);
    const coordinatorB = new InMemoryRelayCoordinator("instance-b", backend);
    await Promise.all([coordinatorA.start(), coordinatorB.start()]);
    const resolveOwnerId = async () => "owner-1";
    const bridgeA = new CoordinatedWorkerBridge({
      coordinator: coordinatorA,
      resolveOwnerId,
    });
    const bridgeB = new CoordinatedWorkerBridge({
      coordinator: coordinatorB,
      resolveOwnerId,
    });
    const oldSocket = new TestWorkerSocket();
    const newSocket = new TestWorkerSocket();
    await bridgeB.attach("worker-1", oldSocket, "owner-1");
    await bridgeA.attach("worker-1", newSocket, "owner-1");

    await vi.waitFor(() => expect(oldSocket.readyState).toBe(3));
    expect((await coordinatorB.findWorker("worker-1"))?.instanceId).toBe(
      "instance-a",
    );
    expect(newSocket.readyState).toBe(1);

    await bridgeA.close();
    await bridgeB.close();
    await Promise.all([coordinatorA.close(), coordinatorB.close()]);
  });

  it("fans live invalidations out to clients on another instance", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinatorA = new InMemoryRelayCoordinator("instance-a", backend);
    const coordinatorB = new InMemoryRelayCoordinator("instance-b", backend);
    await Promise.all([coordinatorA.start(), coordinatorB.start()]);
    const hubA = new AppLiveHub({
      publishExternal: (publication) =>
        coordinatorA.publish({ kind: "live-publication", publication }),
    });
    const hubB = new AppLiveHub();
    const unsubscribe = coordinatorB.subscribe((message) => {
      if (message.kind === "live-publication") {
        hubB.receiveExternal(message.publication);
      }
    });
    const socket = new TestLiveSocket();
    hubB.attach(socket, {
      ownerId: "owner-1",
      authorizeScope: () => true,
    });
    socket.receive({
      type: "initialize",
      protocolVersion: 1,
      client: { id: "client-1", name: "Test", version: "1" },
      resume: null,
    });
    socket.receive({
      type: "subscribe",
      requestId: "subscribe-1",
      scopes: [{ kind: "current-user" }],
    });
    await settle();

    hubA.publish({
      ownerId: "owner-1",
      scope: { kind: "current-user" },
      resource: "project",
      action: "updated",
      entityId: "project-1",
      revision: 1,
      payload: null,
    });
    await vi.waitFor(() =>
      expect(socket.sent).toContainEqual(
        expect.objectContaining({
          type: "event",
          resource: "project",
          entityId: "project-1",
        }),
      ),
    );

    unsubscribe();
    hubA.close();
    hubB.close();
    await Promise.all([coordinatorA.close(), coordinatorB.close()]);
  });
});
