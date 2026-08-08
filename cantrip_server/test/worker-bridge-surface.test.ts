import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  type RemoteSurfaceFrameHeader,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { WorkerBridge } from "../src/workers/bridge.js";

class TestWorkerSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly sent: Array<string | Uint8Array> = [];
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

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }
}

const header: RemoteSurfaceFrameHeader = {
  protocolVersion: 1,
  surfaceId: "surface-1",
  attachmentId: "attachment-1",
  sequence: 0,
  channel: "control",
};

describe("WorkerBridge Remote Surface transport", () => {
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
});
