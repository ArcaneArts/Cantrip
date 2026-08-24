import {
  decodeRemoteSurfaceFrame,
  decodeTunnelDataPlaneFrame,
  encodeRemoteSurfaceFrame,
  encodeTunnelDataPlaneFrame,
  workerEventEnvelopeSchema,
  workerNotificationEnvelopeSchema,
  workerResponseEnvelopeSchema,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import {
  createServiceLogEmitter,
  type ServiceLogRecordInput,
} from "@cantrip/logging";
import { describe, expect, it, vi } from "vitest";

import {
  WorkerBridge,
  type WorkerConnectionContinuityIdentity,
} from "../src/workers/bridge.js";

class TestWorkerSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

  close(code?: number, reason?: string): void {
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

class RejectingActivationSocket extends TestWorkerSocket {
  activate(): boolean {
    this.readyState = 3;
    return false;
  }

  canActivate(): boolean {
    return true;
  }
}

class AttachmentVisibilitySocket extends TestWorkerSocket {
  readonly commandReadyStates: boolean[] = [];
  dispatch: Promise<void> | null = null;
  #readyPublished = false;

  constructor(private readonly bridge: WorkerBridge) {
    super();
  }

  activate(): boolean {
    this.dispatch = this.bridge
      .request("worker-1", { type: "code.probe" })
      .then(
        () => undefined,
        () => undefined,
      );
    return true;
  }

  publishReady(): boolean {
    this.#readyPublished = true;
    return true;
  }

  override send(data: string | Uint8Array): void {
    this.commandReadyStates.push(this.#readyPublished);
    super.send(data);
  }
}

const header: RemoteSurfaceFrameHeader = {
  protocolVersion: 1,
  surfaceId: "surface-1",
  attachmentId: "attachment-1",
  sequence: 0,
  channel: "control",
};

const continuityIdentity: WorkerConnectionContinuityIdentity = {
  credentialId: "credential-1",
  ownerId: "owner-1",
  workerProcessGeneration: "process-1",
};

describe("WorkerBridge Remote Surface transport", () => {
  it("publishes readiness before attachment becomes command-visible", async () => {
    const bridge = new WorkerBridge();
    const socket = new AttachmentVisibilitySocket(bridge);

    expect(
      bridge.attach("worker-1", socket, "owner-1", continuityIdentity),
    ).toBe(true);
    expect(socket.commandReadyStates).toEqual([true]);

    bridge.close();
    await socket.dispatch;
  });

  it("logs command lifecycle metadata without command payloads", async () => {
    const records: ServiceLogRecordInput[] = [];
    const logger = createServiceLogEmitter("server-test", {
      onRecord: (record) => records.push(record),
    });
    const bridge = new WorkerBridge(1_000, logger);
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);

    const secretInput = "super-secret-terminal-input";
    const response = bridge.request("worker-1", {
      type: "terminal.input",
      terminalId: "terminal-1",
      serverId: "https://cantrip.example",
      operationId: "operation-1",
      sequence: 0,
      complete: true,
      protectedData: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    });
    const request = JSON.parse(String(socket.sent.at(-1))) as {
      requestId: string;
    };
    socket.emit(
      "message",
      JSON.stringify(
        workerResponseEnvelopeSchema.parse({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { accepted: true },
        }),
      ),
      false,
    );

    await expect(response).resolves.toEqual({ accepted: true });
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("worker.command.dispatched");
    expect(serialized).toContain("worker.command.completed");
    expect(serialized).toContain("terminal.input");
    expect(serialized).not.toContain(secretInput);
    bridge.close();
  });

  it("keeps a legacy in-flight command alive when neither socket asserts continuity", async () => {
    const bridge = new WorkerBridge(1_000);
    const firstSocket = new TestWorkerSocket();
    bridge.attach("worker-1", firstSocket);

    const response = bridge.request("worker-1", { type: "code.probe" });
    const request = JSON.parse(String(firstSocket.sent.at(-1))) as {
      requestId: string;
    };
    firstSocket.close(1006, "transient network loss");

    const replacementSocket = new TestWorkerSocket();
    bridge.attach("worker-1", replacementSocket);
    replacementSocket.emit(
      "message",
      JSON.stringify(
        workerResponseEnvelopeSchema.parse({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { recovered: true },
        }),
      ),
      false,
    );

    await expect(response).resolves.toEqual({ recovered: true });
    bridge.close();
  });

  it("rejects in-flight commands after the reconnect grace expires", async () => {
    const bridge = new WorkerBridge(10);
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);

    const response = bridge.request("worker-1", { type: "code.probe" });
    socket.close(1006, "network loss");

    await expect(response).rejects.toThrow(/disconnected/i);
    bridge.close();
  });

  it("emits reconnecting for every flap but terminal offline only after the latest grace expires", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new WorkerBridge(15_000);
      const firstSocket = new TestWorkerSocket();
      const reconnecting = vi.fn();
      const offline = vi.fn();
      bridge.subscribeWorkerDisconnect("worker-1", reconnecting);
      bridge.subscribeWorkerOffline("worker-1", offline);
      bridge.attach("worker-1", firstSocket, "owner-1", continuityIdentity);

      const response = bridge.request("worker-1", { type: "code.probe" });
      const rejected = expect(response).rejects.toThrow(/disconnected/i);
      firstSocket.close(1006, "first flap");
      expect(reconnecting).toHaveBeenCalledOnce();
      expect(offline).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      const secondSocket = new TestWorkerSocket();
      bridge.attach("worker-1", secondSocket, "owner-1", continuityIdentity);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(offline).not.toHaveBeenCalled();

      secondSocket.close(1006, "second flap");
      expect(reconnecting).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(offline).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(offline).toHaveBeenCalledOnce();
      await rejected;
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a non-open replacement without extending the original grace", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new WorkerBridge(100);
      const firstSocket = new TestWorkerSocket();
      const offline = vi.fn();
      bridge.subscribeWorkerOffline("worker-1", offline);
      bridge.attach("worker-1", firstSocket, "owner-1", continuityIdentity);
      const pending = bridge.request("worker-1", { type: "code.probe" });
      const rejected = pending.catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/disconnected/i);
      });

      firstSocket.close(1006, "network loss");
      await vi.advanceTimersByTimeAsync(60);
      const deadSocket = new TestWorkerSocket();
      deadSocket.close(1006, "closed during authentication");

      expect(
        bridge.attach("worker-1", deadSocket, "owner-1", continuityIdentity),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(39);
      expect(offline).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(offline).toHaveBeenCalledOnce();
      await rejected;
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset grace when buffered activation loses its final race", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new WorkerBridge(100);
      const firstSocket = new TestWorkerSocket();
      const offline = vi.fn();
      bridge.subscribeWorkerOffline("worker-1", offline);
      bridge.attach("worker-1", firstSocket, "owner-1", continuityIdentity);
      firstSocket.close(1006, "network loss");
      await vi.advanceTimersByTimeAsync(60);

      expect(
        bridge.attach(
          "worker-1",
          new RejectingActivationSocket(),
          "owner-1",
          continuityIdentity,
        ),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(39);
      expect(offline).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(offline).toHaveBeenCalledOnce();
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates the old lifecycle immediately when continuity identity changes", async () => {
    const bridge = new WorkerBridge();
    const firstSocket = new TestWorkerSocket();
    const reconnecting = vi.fn();
    const offline = vi.fn();
    bridge.subscribeWorkerDisconnect("worker-1", reconnecting);
    bridge.subscribeWorkerOffline("worker-1", offline);
    bridge.attach("worker-1", firstSocket, "owner-1", continuityIdentity);
    const pending = bridge.request("worker-1", { type: "code.probe" });
    const rejected = expect(pending).rejects.toThrow(/identity changed/i);

    const replacementSocket = new TestWorkerSocket();
    bridge.attach("worker-1", replacementSocket, "owner-1", {
      ...continuityIdentity,
      workerProcessGeneration: "process-2",
    });

    expect(firstSocket.closes).toContainEqual({
      code: 1008,
      reason: "Worker continuity identity changed",
    });
    expect(reconnecting).toHaveBeenCalledOnce();
    expect(offline).toHaveBeenCalledOnce();
    await rejected;
    expect(bridge.isConnected("worker-1")).toBe(true);

    bridge.disconnect("worker-1", "credential revoked", 1008);
    expect(replacementSocket.closes).toContainEqual({
      code: 1008,
      reason: "credential revoked",
    });
    expect(reconnecting).toHaveBeenCalledTimes(2);
    expect(offline).toHaveBeenCalledTimes(2);
    bridge.close();
  });

  it("ignores messages and frames from a replaced socket", async () => {
    const bridge = new WorkerBridge();
    const firstSocket = new TestWorkerSocket();
    const surface = vi.fn();
    bridge.subscribeSurfaceFrames("worker-1", surface);
    bridge.attach("worker-1", firstSocket, "owner-1", continuityIdentity);

    const replacementSocket = new TestWorkerSocket();
    bridge.attach("worker-1", replacementSocket, "owner-1", continuityIdentity);
    const response = bridge.request("worker-1", { type: "code.probe" });
    const request = JSON.parse(String(replacementSocket.sent.at(-1))) as {
      requestId: string;
    };
    const settled = vi.fn();
    void response.then(settled);

    firstSocket.emit(
      "message",
      JSON.stringify(
        workerResponseEnvelopeSchema.parse({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { stale: true },
        }),
      ),
      false,
    );
    firstSocket.emit(
      "message",
      encodeRemoteSurfaceFrame(header, new Uint8Array([1, 2])),
      true,
    );
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(surface).not.toHaveBeenCalled();

    replacementSocket.emit(
      "message",
      encodeRemoteSurfaceFrame(header, new Uint8Array([3, 4])),
      true,
    );
    replacementSocket.emit(
      "message",
      JSON.stringify(
        workerResponseEnvelopeSchema.parse({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { recovered: true },
        }),
      ),
      false,
    );

    await expect(response).resolves.toEqual({ recovered: true });
    expect(surface).toHaveBeenCalledOnce();
    bridge.close();
  });

  it("delivers correlated events before resolving their response", async () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    const delivered: string[] = [];

    const response = bridge.request(
      "worker-1",
      { type: "code.probe" },
      {
        onEvent: async (event) => {
          await Promise.resolve();
          delivered.push(event.type);
        },
      },
    );
    const request = JSON.parse(String(socket.sent.at(-1))) as {
      requestId: string;
    };
    socket.emit(
      "message",
      JSON.stringify(
        workerEventEnvelopeSchema.parse({
          kind: "event",
          requestId: request.requestId,
          event: { type: "terminal.ready" },
        }),
      ),
      false,
    );
    socket.emit(
      "message",
      JSON.stringify(
        workerResponseEnvelopeSchema.parse({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { available: true },
        }),
      ),
      false,
    );

    await expect(response).resolves.toEqual({ available: true });
    expect(delivered).toEqual(["terminal.ready"]);
    bridge.close();
  });

  it("rejects a streaming command as soon as its event handler fails", async () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);

    const response = bridge.request(
      "worker-1",
      { type: "code.probe" },
      {
        timeoutMs: 100,
        onEvent: () => {
          throw new Error("terminal relay consumer failed");
        },
      },
    );
    const request = JSON.parse(String(socket.sent.at(-1))) as {
      requestId: string;
    };
    socket.emit(
      "message",
      JSON.stringify(
        workerEventEnvelopeSchema.parse({
          kind: "event",
          requestId: request.requestId,
          event: { type: "terminal.ready" },
        }),
      ),
      false,
    );

    await expect(response).rejects.toThrow("terminal relay consumer failed");
    expect(bridge.stats().activeRequests).toBe(0);
    bridge.close();
  });

  it("multiplexes binary frames over the authenticated worker channel", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    const listener = vi.fn();
    const disconnected = vi.fn();
    const unsubscribe = bridge.subscribeSurfaceFrames("worker-1", listener);
    bridge.subscribeWorkerDisconnect("worker-1", disconnected);

    socket.emit(
      "message",
      encodeRemoteSurfaceFrame(header, new Uint8Array([1, 2])),
      true,
    );
    expect(listener).toHaveBeenCalledWith(header, new Uint8Array([1, 2]));

    expect(
      bridge.sendSurfaceFrame(
        "worker-1",
        { ...header, sequence: 1 },
        new Uint8Array([3]),
      ),
    ).toBe(true);
    const outbound = socket.sent.at(-1);
    expect(outbound).toBeInstanceOf(Uint8Array);
    expect(decodeRemoteSurfaceFrame(outbound as Uint8Array)).toMatchObject({
      header: { sequence: 1, surfaceId: "surface-1" },
    });

    unsubscribe();
    socket.close();
    expect(disconnected).toHaveBeenCalledOnce();
    bridge.close();
  });

  it("multiplexes generic tunnel frames over the shared worker socket", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    const tunnelListener = vi.fn();
    bridge.subscribeTunnelDataPlaneFrames("worker-1", tunnelListener);
    const tunnelHeader: TunnelDataPlaneFrameHeader = {
      protocolVersion: 1,
      tunnelId: "tunnel-1",
      attachmentId: "attachment-1",
      sourceEndpointId: "desktop-1",
      destinationEndpointId: "worker-1",
      connectionId: "connection-1",
      sequence: 0,
      kind: "data",
      direction: "destination-to-source",
    };

    socket.emit(
      "message",
      encodeTunnelDataPlaneFrame(tunnelHeader, new Uint8Array([11, 12])),
      true,
    );
    expect(tunnelListener).toHaveBeenCalledWith(
      tunnelHeader,
      new Uint8Array([11, 12]),
    );

    expect(
      bridge.sendTunnelDataPlaneFrame(
        "worker-1",
        { ...tunnelHeader, sequence: 1 },
        new Uint8Array([13]),
      ),
    ).toBe(true);
    expect(
      decodeTunnelDataPlaneFrame(socket.sent.at(-1) as Uint8Array),
    ).toMatchObject({
      header: { tunnelId: "tunnel-1", sequence: 1 },
      payload: new Uint8Array([13]),
    });
    bridge.close();
  });

  it("drops disposable frames but resets a congested reliable worker channel", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    socket.bufferedAmount = 9 * 1_024 * 1_024;

    expect(
      bridge.sendSurfaceFrame(
        "worker-1",
        { ...header, channel: "frame" },
        new Uint8Array([1]),
      ),
    ).toBe(false);
    expect(socket.closes).toEqual([]);

    expect(
      bridge.sendSurfaceFrame(
        "worker-1",
        { ...header, channel: "control" },
        new Uint8Array([2]),
      ),
    ).toBe(false);
    expect(socket.closes).toContainEqual({
      code: 1013,
      reason: "Remote Surface worker channel is congested",
    });
    bridge.close();
  });

  it("delivers validated unsolicited worker notifications separately", () => {
    const bridge = new WorkerBridge();
    const socket = new TestWorkerSocket();
    bridge.attach("worker-1", socket);
    const listener = vi.fn();
    bridge.subscribeNotifications("worker-1", listener);
    const notification = workerNotificationEnvelopeSchema.parse({
      kind: "notification",
      notification: {
        type: "worktree.inventory.observed",
        sourcePath: "/repo",
        inventory: {
          sourcePath: "/repo",
          primaryPath: "/repo",
          gitCommonDir: "/repo/.git",
          managedRoot: "/worker/worktrees/fingerprint",
          repositoryFingerprint: "a".repeat(64),
          worktrees: [],
        },
      },
    });

    socket.emit("message", JSON.stringify(notification), false);
    socket.emit("message", JSON.stringify({ kind: "notification" }), false);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(notification.notification);
    bridge.close();
  });
});
