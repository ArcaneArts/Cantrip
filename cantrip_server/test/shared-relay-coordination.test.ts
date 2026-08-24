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
import type { WorkerConnectionContinuityIdentity } from "../src/workers/bridge.js";

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

const continuityIdentity: WorkerConnectionContinuityIdentity = {
  credentialId: "credential-1",
  ownerId: "owner-1",
  workerProcessGeneration: "process-1",
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

  it("preserves a legacy relayed command when neither socket asserts continuity", async () => {
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
    const firstSocket = new TestWorkerSocket();
    await bridgeB.attach("worker-1", firstSocket, "owner-1");

    const response = bridgeA.request(
      "worker-1",
      { type: "code.probe" },
      { ownerId: "owner-1" },
    );
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    const workerRequest = workerRequestEnvelopeSchema.parse(
      JSON.parse(String(firstSocket.sent[0])),
    );
    firstSocket.close(1006, "transient network loss");
    const replacementSocket = new TestWorkerSocket();
    await bridgeB.attach("worker-1", replacementSocket, "owner-1");
    replacementSocket.emit(
      "message",
      JSON.stringify({
        kind: "response",
        requestId: workerRequest.requestId,
        ok: true,
        result: { recovered: true },
      }),
      false,
    );

    await expect(response).resolves.toEqual({ recovered: true });
    await bridgeA.close();
    await bridgeB.close();
    await Promise.all([coordinatorA.close(), coordinatorB.close()]);
  });

  it("reuses one fenced claim and one subscription set across repeated same-generation flaps", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinator = new InMemoryRelayCoordinator("instance-a", backend);
    await coordinator.start();
    const bridge = new CoordinatedWorkerBridge({
      coordinator,
      reconnectGraceMs: 10,
      resolveOwnerId: async () => "owner-1",
    });
    const reconnecting = vi.fn();
    const offline = vi.fn();
    bridge.subscribeWorkerDisconnect("worker-1", reconnecting);
    bridge.subscribeWorkerOffline("worker-1", offline);
    const firstSocket = new TestWorkerSocket();
    await bridge.attach("worker-1", firstSocket, "owner-1", continuityIdentity);
    const firstClaim = await coordinator.findWorker("worker-1");

    firstSocket.close(1006, "first flap");
    expect(reconnecting).toHaveBeenCalledOnce();
    expect(offline).not.toHaveBeenCalled();
    const replacementSocket = new TestWorkerSocket();
    await bridge.attach(
      "worker-1",
      replacementSocket,
      "owner-1",
      continuityIdentity,
    );
    expect((await coordinator.findWorker("worker-1"))?.connectionId).toBe(
      firstClaim?.connectionId,
    );

    replacementSocket.close(1006, "second flap");
    expect(reconnecting).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(offline).toHaveBeenCalledOnce());
    expect(await coordinator.findWorker("worker-1")).toBeNull();

    await bridge.close();
    await coordinator.close();
  });

  it("does not let a stale refresh completion replace the newest socket", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinator = new InMemoryRelayCoordinator("instance-a", backend);
    await coordinator.start();
    const bridge = new CoordinatedWorkerBridge({
      coordinator,
      resolveOwnerId: async () => "owner-1",
    });
    const firstSocket = new TestWorkerSocket();
    await bridge.attach("worker-1", firstSocket, "owner-1", continuityIdentity);

    let refreshStarted: (() => void) | undefined;
    let finishRefresh: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refreshWorker = coordinator.refreshWorker.bind(coordinator);
    vi.spyOn(coordinator, "refreshWorker").mockImplementationOnce(
      async (workerId, connectionId) => {
        refreshStarted?.();
        await gate;
        return refreshWorker(workerId, connectionId);
      },
    );

    const staleSocket = new TestWorkerSocket();
    const staleAttach = bridge.attach(
      "worker-1",
      staleSocket,
      "owner-1",
      continuityIdentity,
    );
    await started;
    const currentSocket = new TestWorkerSocket();
    await bridge.attach(
      "worker-1",
      currentSocket,
      "owner-1",
      continuityIdentity,
    );
    finishRefresh?.();
    await staleAttach;

    expect(staleSocket.closes).toContainEqual({
      code: 1012,
      reason: "Worker connection was superseded",
    });
    expect(currentSocket.readyState).toBe(1);
    const response = bridge.request("worker-1", { type: "code.probe" });
    const workerRequest = workerRequestEnvelopeSchema.parse(
      JSON.parse(String(currentSocket.sent.at(-1))),
    );
    currentSocket.emit(
      "message",
      JSON.stringify({
        kind: "response",
        requestId: workerRequest.requestId,
        ok: true,
        result: { current: true },
      }),
      false,
    );
    await expect(response).resolves.toEqual({ current: true });

    await bridge.close();
    await coordinator.close();
  });

  it("terminates a mismatched local continuity identity with a non-recoverable close", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinator = new InMemoryRelayCoordinator("instance-a", backend);
    await coordinator.start();
    const bridge = new CoordinatedWorkerBridge({
      coordinator,
      resolveOwnerId: async () => "owner-1",
    });
    const reconnecting = vi.fn();
    const offline = vi.fn();
    bridge.subscribeWorkerDisconnect("worker-1", reconnecting);
    bridge.subscribeWorkerOffline("worker-1", offline);
    const oldSocket = new TestWorkerSocket();
    await bridge.attach("worker-1", oldSocket, "owner-1", continuityIdentity);

    const replacementSocket = new TestWorkerSocket();
    await bridge.attach("worker-1", replacementSocket, "owner-1", {
      ...continuityIdentity,
      credentialId: "credential-2",
    });

    expect(oldSocket.closes).toContainEqual({
      code: 1008,
      reason: "Worker continuity identity changed",
    });
    expect(reconnecting).toHaveBeenCalledOnce();
    expect(offline).toHaveBeenCalledOnce();
    expect(bridge.isConnected("worker-1")).toBe(true);

    await bridge.close();
    await coordinator.close();
  });

  it("ignores a stale offline publication after a newer relay generation is active", async () => {
    const backend = createInMemoryRelayCoordinatorBackend();
    const coordinatorA = new InMemoryRelayCoordinator("instance-a", backend);
    const coordinatorB = new InMemoryRelayCoordinator("instance-b", backend);
    const coordinatorC = new InMemoryRelayCoordinator("instance-c", backend);
    await Promise.all([
      coordinatorA.start(),
      coordinatorB.start(),
      coordinatorC.start(),
    ]);
    const resolveOwnerId = async () => "owner-1";
    const observer = new CoordinatedWorkerBridge({
      coordinator: coordinatorA,
      resolveOwnerId,
    });
    const oldOwner = new CoordinatedWorkerBridge({
      coordinator: coordinatorB,
      resolveOwnerId,
    });
    const newOwner = new CoordinatedWorkerBridge({
      coordinator: coordinatorC,
      resolveOwnerId,
    });
    const offline = vi.fn();
    observer.subscribeWorkerOffline("worker-1", offline);
    await oldOwner.attach(
      "worker-1",
      new TestWorkerSocket(),
      "owner-1",
      continuityIdentity,
    );
    const stalePresence = await coordinatorB.findWorker("worker-1");
    expect(stalePresence).not.toBeNull();

    await newOwner.attach("worker-1", new TestWorkerSocket(), "owner-1", {
      ...continuityIdentity,
      workerProcessGeneration: "process-2",
    });
    await coordinatorB.publish({
      kind: "worker-presence",
      action: "offline",
      presence: stalePresence!,
    });

    expect(offline).not.toHaveBeenCalled();
    expect(observer.isConnected("worker-1")).toBe(true);
    expect((await coordinatorA.findWorker("worker-1"))?.instanceId).toBe(
      "instance-c",
    );

    await Promise.all([observer.close(), oldOwner.close(), newOwner.close()]);
    await Promise.all([
      coordinatorA.close(),
      coordinatorB.close(),
      coordinatorC.close(),
    ]);
  });

  it("rejects a relayed streaming command when its event consumer fails", async () => {
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

    const response = bridgeA.request(
      "worker-1",
      { type: "code.probe" },
      {
        ownerId: "owner-1",
        timeoutMs: 100,
        onEvent: () => {
          throw new Error("remote terminal relay consumer failed");
        },
      },
    );
    await vi.waitFor(() => expect(workerSocket.sent).toHaveLength(1));
    const workerRequest = workerRequestEnvelopeSchema.parse(
      JSON.parse(String(workerSocket.sent[0])),
    );
    workerSocket.emit(
      "message",
      JSON.stringify({
        kind: "event",
        requestId: workerRequest.requestId,
        event: { type: "terminal.ready" },
      }),
      false,
    );

    await expect(response).rejects.toThrow(
      "remote terminal relay consumer failed",
    );
    expect(bridgeA.stats().activeRequests).toBe(0);

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
