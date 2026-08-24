import { describe, expect, it, vi } from "vitest";

import { BufferedWorkerSocket } from "../src/workers/buffered-socket.js";

class TestSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly sent: Array<string | Uint8Array> = [];
  readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
}

describe("BufferedWorkerSocket", () => {
  it("replays an authenticated reconnect flush in arrival order", () => {
    const socket = new TestSocket();
    const buffered = new BufferedWorkerSocket(socket);
    const received: string[] = [];

    socket.emit("message", "first", false);
    socket.emit("message", new Uint8Array([1, 2]), true);
    buffered.on("message", (data, isBinary) => {
      received.push(isBinary ? `binary:${String((data as Uint8Array)[1])}` : String(data));
    });
    expect(received).toEqual([]);

    buffered.activate();
    socket.emit("message", "third", false);

    expect(received).toEqual(["first", "binary:2", "third"]);
  });

  it("bounds unauthenticated reconnect data before activation", () => {
    const socket = new TestSocket();
    new BufferedWorkerSocket(socket);

    socket.emit("message", new Uint8Array(8 * 1_024 * 1_024 + 1), true);

    expect(socket.closes).toEqual([
      { code: 1009, reason: "Worker authentication buffer exceeded" },
    ]);
  });

  it("replays a pre-activation close exactly once", () => {
    const socket = new TestSocket();
    const buffered = new BufferedWorkerSocket(socket);
    const closed = vi.fn();

    socket.emit("close");
    buffered.on("close", closed);
    buffered.activate();
    socket.emit("close");

    expect(closed).toHaveBeenCalledOnce();
  });
});
