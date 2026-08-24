import { describe, expect, it, vi } from "vitest";

import {
  BufferedWorkerSocket,
  BufferedWorkerSocketByteBudget,
} from "../src/workers/buffered-socket.js";

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
  it("publishes readiness before replaying buffered worker data", () => {
    const socket = new TestSocket();
    const buffered = new BufferedWorkerSocket(socket);
    const observed: string[] = [];
    buffered.prepareReady("ready");
    socket.emit("message", "outcome", false);
    buffered.on("message", () => {
      observed.push(String(socket.sent.at(-1)));
    });

    expect(buffered.publishReady()).toBe(true);
    expect(buffered.publishReady()).toBe(true);
    expect(buffered.activate()).toBe(true);

    expect(socket.sent).toEqual(["ready"]);
    expect(observed).toEqual(["ready"]);
  });

  it("replays an authenticated reconnect flush in arrival order", () => {
    const socket = new TestSocket();
    const buffered = new BufferedWorkerSocket(socket);
    const received: string[] = [];

    socket.emit("message", "first", false);
    socket.emit("message", new Uint8Array([1, 2]), true);
    buffered.on("message", (data, isBinary) => {
      received.push(
        isBinary ? `binary:${String((data as Uint8Array)[1])}` : String(data),
      );
    });
    expect(received).toEqual([]);

    buffered.activate();
    socket.emit("message", "third", false);

    expect(received).toEqual(["first", "binary:2", "third"]);
  });

  it("bounds unauthenticated reconnect data before activation", () => {
    const socket = new TestSocket();
    const buffered = new BufferedWorkerSocket(socket);
    const closed = vi.fn();
    buffered.on("close", closed);

    socket.emit("message", new Uint8Array(8 * 1_024 * 1_024 + 1), true);
    expect(buffered.activate()).toBe(false);

    expect(socket.closes).toEqual([
      { code: 1009, reason: "Worker authentication buffer exceeded" },
    ]);
    expect(closed).not.toHaveBeenCalled();
  });

  it("discards a pre-activation close and any retained messages", () => {
    const socket = new TestSocket();
    const budget = new BufferedWorkerSocketByteBudget(16);
    const buffered = new BufferedWorkerSocket(socket, budget);
    const closed = vi.fn();
    const message = vi.fn();

    socket.emit("message", "retained", false);
    expect(budget.usedBytes).toBe(8);
    socket.emit("close");
    buffered.on("close", closed);
    buffered.on("message", message);
    expect(buffered.activate()).toBe(false);
    socket.emit("close");

    expect(budget.usedBytes).toBe(0);
    expect(message).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it("treats a pre-activation socket error as terminal", () => {
    const budget = new BufferedWorkerSocketByteBudget(16);
    const socket = new TestSocket();
    const buffered = new BufferedWorkerSocket(socket, budget);
    const error = vi.fn();

    socket.emit("message", "retained", false);
    socket.emit("error", new Error("connection reset"));
    buffered.on("error", error);

    expect(buffered.canActivate()).toBe(false);
    expect(buffered.activate()).toBe(false);
    expect(budget.usedBytes).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it("shares and releases a process-wide authentication byte budget", () => {
    const budget = new BufferedWorkerSocketByteBudget(4);
    const firstSocket = new TestSocket();
    const first = new BufferedWorkerSocket(firstSocket, budget);
    const secondSocket = new TestSocket();
    const second = new BufferedWorkerSocket(secondSocket, budget);

    firstSocket.emit("message", new Uint8Array(4), true);
    expect(budget.usedBytes).toBe(4);
    secondSocket.emit("message", new Uint8Array(1), true);
    expect(secondSocket.closes).toEqual([
      {
        code: 1013,
        reason: "Worker authentication capacity is unavailable",
      },
    ]);
    expect(budget.usedBytes).toBe(4);

    expect(first.activate()).toBe(true);
    expect(budget.usedBytes).toBe(0);
    const thirdSocket = new TestSocket();
    const third = new BufferedWorkerSocket(thirdSocket, budget);
    thirdSocket.emit("message", new Uint8Array(4), true);
    expect(budget.usedBytes).toBe(4);

    third.disposePending();
    expect(budget.usedBytes).toBe(0);
    expect(second.activate()).toBe(false);
  });

  it("makes a server-closed pending socket unattachable and releases its budget", () => {
    const budget = new BufferedWorkerSocketByteBudget(16);
    const socket = new TestSocket();
    const buffered = new BufferedWorkerSocket(socket, budget);

    socket.emit("message", "pending", false);
    expect(budget.usedBytes).toBe(7);
    buffered.close(1013, "Worker authentication timed out");

    expect(buffered.canActivate()).toBe(false);
    expect(buffered.activate()).toBe(false);
    expect(budget.usedBytes).toBe(0);
    expect(socket.closes).toEqual([
      { code: 1013, reason: "Worker authentication timed out" },
    ]);
  });
});
