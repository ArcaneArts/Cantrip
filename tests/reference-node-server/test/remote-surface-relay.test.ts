import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type RemoteSurfaceFrameHeader,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type {
  AccountUsageMeasurement,
  AccountUsageRecorder,
} from "../src/account-usage/bandwidth-meter.js";
import {
  RemoteSurfaceRelay,
  type RemoteSurfaceClientSocket,
} from "../src/remote-surfaces/relay.js";
import type {
  WorkerCommandBus,
  WorkerSurfaceFrameListener,
} from "../src/workers/bridge.js";

class TestClientSocket implements RemoteSurfaceClientSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: Uint8Array[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly #closeListeners = new Set<() => void>();
  readonly #messageListeners = new Set<
    (data: unknown, isBinary?: boolean) => void
  >();

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
    for (const listener of this.#closeListeners) listener();
  }

  on(
    event: "close" | "message",
    listener: (() => void) | ((data: unknown, isBinary?: boolean) => void),
  ): void {
    if (event === "close") this.#closeListeners.add(listener as () => void);
    else this.#messageListeners.add(listener as (data: unknown) => void);
  }

  send(data: string | Uint8Array): void {
    if (typeof data !== "string") this.sent.push(data);
  }

  receive(data: Uint8Array, isBinary = true): void {
    for (const listener of this.#messageListeners) listener(data, isBinary);
  }
}

class RecordingMeter implements AccountUsageRecorder {
  readonly measurements: AccountUsageMeasurement[] = [];
  record(measurement: AccountUsageMeasurement): boolean {
    this.measurements.push(measurement);
    return true;
  }
}

function header(sequence: number): RemoteSurfaceFrameHeader {
  return {
    protocolVersion: 1,
    surfaceId: "surface-1",
    attachmentId: "attachment-1",
    sequence,
    channel: "frame",
  };
}

describe("RemoteSurfaceRelay", () => {
  it("meters each client and worker boundary exactly once", () => {
    let workerListener: WorkerSurfaceFrameListener | null = null;
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async () => undefined,
      sendSurfaceFrame: () => true,
      subscribeWorkerDisconnect: () => () => undefined,
      subscribeSurfaceFrames(_workerId, listener) {
        workerListener = listener;
        return () => undefined;
      },
    } satisfies WorkerCommandBus;
    const socket = new TestClientSocket();
    const meter = new RecordingMeter();
    new RemoteSurfaceRelay(bridge, () => true, meter).bind(socket, {
      ownerId: "owner-1",
      workerId: "worker-1",
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
    });
    const clientFrame = encodeRemoteSurfaceFrame(
      header(1),
      new Uint8Array([1, 2, 3]),
    );
    const workerPayload = new Uint8Array([4, 5]);
    const workerFrame = encodeRemoteSurfaceFrame(header(2), workerPayload);

    socket.receive(clientFrame);
    workerListener?.(header(2), workerPayload);

    expect(meter.measurements).toEqual([
      expect.objectContaining({
        ownerId: "owner-1",
        direction: "ingress",
        channel: "remote-surface-relay",
        bytes: clientFrame.byteLength,
      }),
      expect.objectContaining({
        direction: "egress",
        channel: "remote-surface-relay",
        bytes: clientFrame.byteLength,
      }),
      expect.objectContaining({
        direction: "ingress",
        channel: "remote-surface-relay",
        bytes: workerFrame.byteLength,
      }),
      expect.objectContaining({
        direction: "egress",
        channel: "remote-surface-relay",
        bytes: workerFrame.byteLength,
      }),
    ]);
  });

  it("relays binary frames in both directions and drops stale sequences", () => {
    let workerListener: WorkerSurfaceFrameListener | null = null;
    const forwarded = vi.fn(() => true);
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async () => undefined,
      sendSurfaceFrame: forwarded,
      subscribeWorkerDisconnect: () => () => undefined,
      subscribeSurfaceFrames(_workerId, listener) {
        workerListener = listener;
        return () => {
          workerListener = null;
        };
      },
    } satisfies WorkerCommandBus;
    const socket = new TestClientSocket();
    new RemoteSurfaceRelay(bridge).bind(socket, {
      ownerId: "owner-1",
      workerId: "worker-1",
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
    });

    socket.receive(
      encodeRemoteSurfaceFrame(header(2), new Uint8Array([1, 2, 3])),
    );
    socket.receive(
      encodeRemoteSurfaceFrame(header(1), new Uint8Array([4, 5, 6])),
    );
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(forwarded).toHaveBeenCalledWith(
      "worker-1",
      header(2),
      new Uint8Array([1, 2, 3]),
    );

    workerListener?.(header(7), new Uint8Array([9]));
    workerListener?.(header(6), new Uint8Array([8]));
    expect(socket.sent).toHaveLength(1);
    expect(decodeRemoteSurfaceFrame(socket.sent[0]!).header.sequence).toBe(7);
  });

  it("closes a client that attempts to escape its authorized binding", () => {
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async () => undefined,
      sendSurfaceFrame: () => true,
      subscribeWorkerDisconnect: () => () => undefined,
      subscribeSurfaceFrames: () => () => undefined,
    } satisfies WorkerCommandBus;
    const socket = new TestClientSocket();
    new RemoteSurfaceRelay(bridge).bind(socket, {
      ownerId: "owner-1",
      workerId: "worker-1",
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
    });
    socket.receive(
      encodeRemoteSurfaceFrame(
        { ...header(0), surfaceId: "another-surface" },
        new Uint8Array(),
      ),
    );

    expect(socket.closes).toContainEqual({
      code: 1008,
      reason: "Remote Surface binding mismatch",
    });
  });

  it("closes the client promptly when its assigned worker disconnects", () => {
    let disconnect: (() => void) | null = null;
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async () => undefined,
      sendSurfaceFrame: () => true,
      subscribeWorkerDisconnect(_workerId, listener) {
        disconnect = listener;
        return () => {
          disconnect = null;
        };
      },
      subscribeSurfaceFrames: () => () => undefined,
    } satisfies WorkerCommandBus;
    const socket = new TestClientSocket();
    new RemoteSurfaceRelay(bridge).bind(socket, {
      ownerId: "owner-1",
      workerId: "worker-1",
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
    });

    disconnect?.();

    expect(socket.closes).toContainEqual({
      code: 1013,
      reason: "Remote Surface worker disconnected",
    });
  });

  it("drops disposable frames and closes reliable channels under pressure", () => {
    let workerListener: WorkerSurfaceFrameListener | null = null;
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async () => undefined,
      sendSurfaceFrame: () => true,
      subscribeWorkerDisconnect: () => () => undefined,
      subscribeSurfaceFrames(_workerId, listener) {
        workerListener = listener;
        return () => undefined;
      },
    } satisfies WorkerCommandBus;
    const socket = new TestClientSocket();
    socket.bufferedAmount = 9 * 1_024 * 1_024;
    new RemoteSurfaceRelay(bridge).bind(socket, {
      ownerId: "owner-1",
      workerId: "worker-1",
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
    });

    workerListener?.(header(0), new Uint8Array([1]));
    expect(socket.sent).toHaveLength(0);
    expect(socket.closes).toHaveLength(0);

    workerListener?.({ ...header(1), channel: "control" }, new Uint8Array([2]));
    expect(socket.closes).toContainEqual({
      code: 1013,
      reason: "Remote Surface client is too slow",
    });
  });

  it("closes the stream visibly when its relay byte quota is exhausted", () => {
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async () => undefined,
      sendSurfaceFrame: () => true,
      subscribeWorkerDisconnect: () => () => undefined,
      subscribeSurfaceFrames: () => () => undefined,
    } satisfies WorkerCommandBus;
    const socket = new TestClientSocket();
    new RemoteSurfaceRelay(bridge, () => false).bind(socket, {
      ownerId: "owner-1",
      workerId: "worker-1",
      surfaceId: "surface-1",
      attachmentId: "attachment-1",
    });

    socket.receive(
      encodeRemoteSurfaceFrame(header(0), new Uint8Array([1, 2, 3])),
    );
    expect(socket.closes).toContainEqual({
      code: 1013,
      reason: "Remote Surface relay bandwidth quota reached",
    });
  });
});
