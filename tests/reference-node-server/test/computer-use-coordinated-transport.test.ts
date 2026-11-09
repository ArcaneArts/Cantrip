import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  CUA_CONTROL_BYTES,
  type ComputerUseRequest,
} from "@cantrip/protocol/computer-use";
import {
  workerRequestEnvelopeSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryRelayCoordinatorBackend,
  InMemoryRelayCoordinator,
  type RelayCoordinationMessage,
} from "../src/coordination/relay-coordinator.js";
import { CoordinatedWorkerBridge } from "../src/workers/coordinated-bridge.js";

const day = 24 * 60 * 60_000;
const continuity = {
  ownerId: "owner",
  credentialId: "credential",
  workerProcessGeneration: "process",
};
function input(
  bytes = 16,
  operation: ComputerUseRequest["operation"] = "input.perform",
): WorkerCommand {
  return {
    type: "computer-use.operation",
    serverId: "server",
    chatId: "chat",
    executionLaneId: "lane",
    request: {
      operationId: randomUUID(),
      operation,
      protectedContent: {
        formatVersion: 1,
        domain: "client-control-content",
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12).toString("base64url"),
          ciphertext: Buffer.alloc(bytes).toString("base64url"),
        },
      },
    },
  };
}
class Socket extends EventEmitter {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: ReturnType<typeof workerRequestEnvelopeSchema.parse>[] = [];
  send(data: string | Uint8Array) {
    this.sent.push(workerRequestEnvelopeSchema.parse(JSON.parse(String(data))));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  reply(index: number, result: unknown) {
    this.emit(
      "message",
      JSON.stringify({
        kind: "response",
        requestId: this.sent[index]!.requestId,
        ok: true,
        result,
      }),
      false,
    );
  }
}
async function fixture() {
  const backend = createInMemoryRelayCoordinatorBackend();
  // Keep test presence valid across a simulated day; production refreshes it.
  const coordinators = ["a", "b"].map(
    (id) => new InMemoryRelayCoordinator(id, backend, 2 * day),
  );
  await Promise.all(coordinators.map((coordinator) => coordinator.start()));
  const bridges = coordinators.map(
    (coordinator) =>
      new CoordinatedWorkerBridge({
        coordinator,
        resolveOwnerId: async () => "owner",
      }),
  );
  const messages: RelayCoordinationMessage[] = [];
  const unsubscribe = coordinators[0]!.subscribe((message) => {
    messages.push(message);
  });
  const socket = new Socket();
  await bridges[1]!.attach("worker", socket, "owner", continuity);
  return {
    backend,
    coordinators,
    bridges,
    socket,
    messages,
    async close() {
      await Promise.all(bridges.map((bridge) => bridge.close()));
      unsubscribe();
      await Promise.all(coordinators.map((coordinator) => coordinator.close()));
    },
  };
}

describe("computer-use cross-instance transport", () => {
  it("retires the remote request when the requesting relay becomes the local owner", async () => {
    const f = await fixture();
    const old = f.bridges[0]!.request("worker", input(), {
      ownerId: "owner",
      timeoutMs: null,
    });
    void old.catch(() => undefined);
    let fresh: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
      await f.coordinators[1]!.close();
      const replacement = new Socket();
      await f.bridges[0]!.attach("worker", replacement, "owner");
      expect(f.bridges[0]!.stats().activeRequests).toBe(0);
      await expect(old).rejects.toThrow("unavailable");
      fresh = f.bridges[0]!.request("worker", input(), {
        ownerId: "owner",
        timeoutMs: null,
      });
      void fresh.catch(() => undefined);
      await vi.waitFor(() => expect(replacement.sent).toHaveLength(1));
      replacement.reply(0, { local: true });
      await expect(fresh).resolves.toEqual({ local: true });
      expect(f.socket.sent).toHaveLength(1);
    } finally {
      await f.close();
      await old.catch(() => undefined);
      await fresh?.catch(() => undefined);
    }
  });

  it("does not let a delayed ownership lookup retire a newer request", async () => {
    const f = await fixture();
    const coordinator = new InMemoryRelayCoordinator("c", f.backend, 2 * day);
    await coordinator.start();
    const bridge = new CoordinatedWorkerBridge({
      coordinator,
      resolveOwnerId: async () => "owner",
    });
    const old = f.bridges[0]!.request("worker", input(), {
      ownerId: "owner",
      timeoutMs: null,
    });
    void old.catch(() => undefined);
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let late: Promise<void> | undefined;
    let fresh: Promise<unknown> | undefined;
    let lookup: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
      const previous = await f.coordinators[0]!.findWorker("worker");
      lookup = vi
        .spyOn(f.coordinators[0]!, "findWorker")
        .mockImplementationOnce(async () => {
          arrived();
          await held;
          return previous;
        });
      late = coordinator.publish({
        kind: "worker-presence",
        action: "online",
        presence: {
          ...previous!,
          instanceId: "c",
          connectionId: "old-announcement",
        },
      });
      await lookupStarted;
      const replacement = new Socket();
      await bridge.attach("worker", replacement, "owner");
      await expect(old).rejects.toThrow();
      fresh = f.bridges[0]!.request("worker", input(), {
        ownerId: "owner",
        timeoutMs: null,
      });
      void fresh.catch(() => undefined);
      await vi.waitFor(() => expect(replacement.sent).toHaveLength(1));
      release();
      await late;
      expect(f.bridges[0]!.stats().activeRequests).toBe(1);
      replacement.reply(0, { fresh: true });
      await expect(fresh).resolves.toEqual({ fresh: true });
    } finally {
      release();
      await late;
      lookup?.mockRestore();
      await bridge.close();
      await coordinator.close();
      await f.close();
      await old.catch(() => undefined);
      await fresh?.catch(() => undefined);
    }
  });

  it("does not cancel a live request on delayed foreign presence announcements", async () => {
    const f = await fixture();
    const coordinator = new InMemoryRelayCoordinator("c", f.backend);
    await coordinator.start();
    const pending = f.bridges[0]!.request("worker", input(), {
      ownerId: "owner",
      timeoutMs: null,
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
      const presence = {
        workerId: "worker",
        ownerId: "owner",
        connectionId: "retired",
        instanceId: "c",
        expiresAt: Date.now() + day,
      };
      await coordinator.publish({
        kind: "worker-presence",
        action: "online",
        presence,
      });
      await coordinator.publish({
        kind: "worker-presence",
        action: "offline",
        presence,
      });
      expect(f.bridges[0]!.stats().activeRequests).toBe(1);
      f.socket.reply(0, { completed: true });
      await expect(pending).resolves.toEqual({ completed: true });
      expect(f.socket.sent).toHaveLength(1);
    } finally {
      await coordinator.close();
      await f.close();
      await pending.catch(() => undefined);
    }
  });

  it("preserves untimed input through same-process socket recovery without replay", async () => {
    const f = await fixture();
    const pending = f.bridges[0]!.request("worker", input(), {
      ownerId: "owner",
      timeoutMs: null,
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
      const requestId = f.socket.sent[0]!.requestId;
      f.socket.close();
      const replacement = new Socket();
      await f.bridges[1]!.attach("worker", replacement, "owner", continuity);
      expect(replacement.sent).toHaveLength(0);
      expect(f.bridges[0]!.stats().activeRequests).toBe(1);
      replacement.emit(
        "message",
        JSON.stringify({
          kind: "response",
          requestId,
          ok: true,
          result: { recovered: true },
        }),
        false,
      );
      await expect(pending).resolves.toEqual({ recovered: true });
      expect(f.socket.sent).toHaveLength(1);
    } finally {
      await f.close();
      await pending.catch(() => undefined);
    }
  });

  it("accepts events and results only from the relay that owns the pending request", async () => {
    const f = await fixture();
    const coordinator = new InMemoryRelayCoordinator("c", f.backend);
    await coordinator.start();
    const publications = vi.spyOn(f.coordinators[0]!, "publish");
    const events: unknown[] = [];
    const pending = f.bridges[0]!.request("worker", input(), {
      ownerId: "owner",
      timeoutMs: null,
      onEvent: (event) => {
        events.push(event);
      },
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
      const request = publications.mock.calls
        .map(([message]) => message)
        .find((message) => message.kind === "worker-command-request")!;
      if (request.kind !== "worker-command-request")
        throw new Error("Missing relay request");
      await coordinator.publish({
        kind: "worker-command-event",
        requestId: request.requestId,
        targetInstanceId: "a",
        event: { type: "terminal.ready" },
      });
      await coordinator.publish({
        kind: "worker-command-response",
        requestId: request.requestId,
        targetInstanceId: "a",
        ok: true,
        result: { foreign: true },
      });
      expect(events).toEqual([]);
      expect(f.bridges[0]!.stats().activeRequests).toBe(1);
      f.socket.reply(0, { actual: true });
      await expect(pending).resolves.toEqual({ actual: true });
    } finally {
      publications.mockRestore();
      await coordinator.close();
      await f.close();
      await pending.catch(() => undefined);
    }
  });

  it("settles untimed requests on confirmed owner loss without replaying input", async () => {
    const f = await fixture();
    const pending = f.bridges[0]!.request("worker", input(), {
      ownerId: "owner",
      timeoutMs: null,
    });
    const rejected = expect(pending).rejects.toThrow("unavailable");
    try {
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
      const claim = await f.coordinators[1]!.findWorker("worker");
      await f.coordinators[1]!.releaseWorker("worker", claim!.connectionId);
      expect(f.bridges[0]!.stats().activeRequests).toBe(0);
      await rejected;
      expect(f.socket.sent).toHaveLength(1);
    } finally {
      await f.close();
      await rejected.catch(() => undefined);
    }
  });

  it("retires the old owner's untimed request and accepts a new request on its replacement", async () => {
    const f = await fixture();
    const coordinator = new InMemoryRelayCoordinator("c", f.backend, 2 * day);
    await coordinator.start();
    const bridge = new CoordinatedWorkerBridge({
      coordinator,
      resolveOwnerId: async () => "owner",
    });
    const pending = f.bridges[0]!.request("worker", input(), {
      ownerId: "owner",
      timeoutMs: null,
    });
    const rejected = expect(pending).rejects.toThrow("unavailable");
    try {
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
      const replacement = new Socket();
      // The old relay is gone, so it cannot return a local-disconnect response.
      await f.coordinators[1]!.close();
      await bridge.attach("worker", replacement, "owner");
      expect(f.bridges[0]!.stats().activeRequests).toBe(0);
      await rejected;
      const fresh = f.bridges[0]!.request("worker", input(), {
        ownerId: "owner",
        timeoutMs: null,
      });
      await vi.waitFor(() => expect(replacement.sent).toHaveLength(1));
      replacement.reply(0, { fresh: true });
      await expect(fresh).resolves.toEqual({ fresh: true });
      expect(f.socket.sent).toHaveLength(1);
    } finally {
      await bridge.close();
      await coordinator.close();
      await f.close();
      await rejected.catch(() => undefined);
    }
  });

  it("forwards the maximum opaque CUA request across coordination and a real worker socket", async () => {
    const f = await fixture();
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: 8 * 1024 * 1024,
    });
    await once(server, "listening");
    const connection = once(server, "connection");
    const worker = new WebSocket(
      `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    await once(worker, "open");
    const [socket] = await connection;
    await f.bridges[1]!.attach("real-worker", socket, "owner");
    let received: WorkerCommand | undefined;
    worker.on("message", (raw) => {
      const message = workerRequestEnvelopeSchema.parse(
        JSON.parse(raw.toString()),
      );
      received = message.command;
      worker.send(
        JSON.stringify({
          kind: "response",
          requestId: message.requestId,
          ok: true,
          result: { delivered: true },
        }),
      );
    });
    try {
      const command = input(CUA_CONTROL_BYTES + 16);
      await expect(
        f.bridges[0]!.request("real-worker", command, {
          ownerId: "owner",
          timeoutMs: 10_000,
        }),
      ).resolves.toEqual({ delivered: true });
      expect(received).toEqual(command);
      await expect(
        f.coordinators[0]!.publish({
          kind: "live-publication",
          publication: "x".repeat(32 * 1024 * 1024),
        }),
      ).rejects.toThrow("size limit");
    } finally {
      worker.terminate();
      socket.terminate();
      await f.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it("keeps untimed input alive beyond a day, admits Stop, and accepts fresh late events and completion", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = await fixture();
    const events: unknown[] = [];
    let settled = false;
    const pending = f.bridges[0]!.request("worker", input(), {
      ownerId: "owner",
      timeoutMs: null,
      onEvent: (event) => {
        events.push(event);
      },
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(day + 1);
      expect(settled).toBe(false);
      const stopped = f.bridges[0]!.request(
        "worker",
        input(16, "session.close"),
        { ownerId: "owner", timeoutMs: 30_000 },
      );
      await vi.waitFor(() => expect(f.socket.sent).toHaveLength(2));
      f.socket.reply(1, { closed: true });
      await expect(stopped).resolves.toEqual({ closed: true });
      f.socket.emit(
        "message",
        JSON.stringify({
          kind: "event",
          requestId: f.socket.sent[0]!.requestId,
          event: { type: "terminal.ready" },
        }),
        false,
      );
      f.socket.reply(0, { completed: true });
      await expect(pending).resolves.toEqual({ completed: true });
      expect(events).toEqual([{ type: "terminal.ready" }]);
      expect(f.socket.sent).toHaveLength(2);
      expect(f.bridges[0]!.stats().activeRequests).toBe(0);
      expect(
        f.messages
          .filter((message) => message.kind === "worker-command-response")
          .every((message) => message.expiresAt > Date.now()),
      ).toBe(true);
    } finally {
      await f.close();
      await pending.catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
