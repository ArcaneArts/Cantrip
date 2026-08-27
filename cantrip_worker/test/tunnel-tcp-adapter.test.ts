import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";

import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { subscribeWorkerLogs } from "../src/logger.js";
import { TunnelTcpDestinationAdapter } from "../src/tunnel-tcp-adapter.js";

const servers: Server[] = [];
const subscriptions: Array<() => void> = [];
const EMPTY_PAYLOAD = new Uint8Array();

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for tunnel adapter event."));
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

async function listenEcho(): Promise<number> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", (data) => socket.write(data));
    socket.on("end", () => {
      socket.write("after-half-close");
      socket.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Echo server did not bind a TCP port.");
  }
  return address.port;
}

async function listenBurst(size: number): Promise<number> {
  const payload = Buffer.alloc(size, 7);
  return listenPayload(payload);
}

async function listenPayload(payload: Buffer): Promise<number> {
  const server = createServer((socket) => {
    socket.on("error", () => {
      // Tests that exercise local congestion intentionally reset the producer.
    });
    socket.end(payload);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Burst server did not bind a TCP port.");
  }
  return address.port;
}

async function listenSynchronizedPayload(
  payload: Buffer,
  connectionCount: number,
): Promise<number> {
  const sockets: import("node:net").Socket[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    sockets.push(socket);
    if (sockets.length === connectionCount) {
      for (const connected of sockets) connected.end(payload);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synchronized server did not bind a TCP port.");
  }
  return address.port;
}

function connectHeader(
  connectionId: string,
  port: number,
): Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }> {
  return {
    protocolVersion: 1,
    tunnelId: "tunnel-1",
    attachmentId: "attachment-1",
    sourceEndpointId: "desktop-1",
    destinationEndpointId: "worker-1",
    connectionId,
    sequence: 0,
    kind: "connect",
    target: { kind: "tcp", host: "127.0.0.1", port },
    initialCreditBytes: 256 * 1_024,
  };
}

function nextHeader(
  connectionId: string,
  sequence: number,
  input:
    | { kind: "data"; direction: "source-to-destination" }
    | { kind: "half-close"; direction: "source-to-destination" }
    | {
        kind: "credit";
        direction: "destination-to-source";
        bytes: number;
      },
): TunnelDataPlaneFrameHeader {
  return {
    protocolVersion: 1,
    tunnelId: "tunnel-1",
    attachmentId: "attachment-1",
    sourceEndpointId: "desktop-1",
    destinationEndpointId: "worker-1",
    connectionId,
    sequence,
    ...input,
  };
}

afterEach(async () => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("worker TCP tunnel destination", () => {
  it("relays binary echo and preserves TCP half-close", async () => {
    const port = await listenEcho();
    const adapter = new TunnelTcpDestinationAdapter();
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    adapter.setFrameEmitter((header, payload) => {
      output.push({ header, payload: payload.slice() });
      return true;
    });

    adapter.handleFrame(connectHeader("connection-1", port), EMPTY_PAYLOAD);
    await waitFor(() =>
      output.some(({ header }) => header.kind === "accepted"),
    );
    adapter.handleFrame(
      nextHeader("connection-1", 1, {
        kind: "data",
        direction: "source-to-destination",
      }),
      new TextEncoder().encode("hello"),
    );
    await waitFor(() =>
      output.some(
        ({ header, payload }) =>
          header.kind === "data" &&
          new TextDecoder().decode(payload) === "hello",
      ),
    );
    adapter.handleFrame(
      nextHeader("connection-1", 2, {
        kind: "half-close",
        direction: "source-to-destination",
      }),
      EMPTY_PAYLOAD,
    );
    await waitFor(() =>
      output.some(
        ({ header, payload }) =>
          header.kind === "data" &&
          new TextDecoder().decode(payload) === "after-half-close",
      ),
    );
    await waitFor(() =>
      output.some(({ header }) => header.kind === "half-close"),
    );
    adapter.close();
  });

  it("retains and retries nested credit when the outer carrier is congested", async () => {
    const port = await listenEcho();
    const adapter = new TunnelTcpDestinationAdapter();
    const attempts: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    let rejectFirstCredit = true;
    let releaseCapacity!: (available: boolean) => void;
    const capacity = new Promise<boolean>((resolve) => {
      releaseCapacity = resolve;
    });
    adapter.setFrameEmitter(
      (header, payload) => {
        attempts.push({ header, payload: payload.slice() });
        if (header.kind === "credit" && rejectFirstCredit) {
          rejectFirstCredit = false;
          return false;
        }
        output.push({ header, payload: payload.slice() });
        return true;
      },
      () => capacity,
    );

    adapter.handleFrame(connectHeader("credit-retry", port), EMPTY_PAYLOAD);
    await waitFor(() =>
      output.some(({ header }) => header.kind === "accepted"),
    );
    adapter.handleFrame(
      nextHeader("credit-retry", 1, {
        kind: "data",
        direction: "source-to-destination",
      }),
      new Uint8Array([2, 7, 1, 8]),
    );
    await waitFor(
      () =>
        attempts.filter(({ header }) => header.kind === "credit").length > 0,
    );
    expect(output.some(({ header }) => header.kind === "credit")).toBe(false);

    releaseCapacity(true);
    await waitFor(() => output.some(({ header }) => header.kind === "credit"));
    const creditAttempts = attempts.filter(
      ({ header }) => header.kind === "credit",
    );
    expect(creditAttempts).toHaveLength(2);
    expect(creditAttempts[1]).toEqual(creditAttempts[0]);
    await waitFor(() => output.some(({ header }) => header.kind === "data"));
    adapter.close();
  });

  it("supports multiple simultaneous target connections", async () => {
    const port = await listenEcho();
    const adapter = new TunnelTcpDestinationAdapter();
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    adapter.setFrameEmitter((header, payload) => {
      output.push({ header, payload: payload.slice() });
      return true;
    });
    for (const connectionId of ["connection-a", "connection-b"]) {
      adapter.handleFrame(connectHeader(connectionId, port), EMPTY_PAYLOAD);
    }
    await waitFor(
      () =>
        output.filter(({ header }) => header.kind === "accepted").length === 2,
    );
    for (const [index, connectionId] of [
      "connection-a",
      "connection-b",
    ].entries()) {
      adapter.handleFrame(
        nextHeader(connectionId, 1, {
          kind: "data",
          direction: "source-to-destination",
        }),
        new TextEncoder().encode(`payload-${index}`),
      );
    }
    await waitFor(
      () => output.filter(({ header }) => header.kind === "data").length === 2,
    );
    expect(
      output
        .filter(({ header }) => header.kind === "data")
        .map(({ payload }) => new TextDecoder().decode(payload))
        .sort(),
    ).toEqual(["payload-0", "payload-1"]);
    adapter.close();
  });

  it("does not let one backpressured stream block a sibling stream", async () => {
    const port = await listenPayload(Buffer.from("ready"));
    const adapter = new TunnelTcpDestinationAdapter();
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    let capacityWaits = 0;
    let releaseFirstCapacity!: (available: boolean) => void;
    const firstCapacity = new Promise<boolean>((resolve) => {
      releaseFirstCapacity = resolve;
    });
    let rejectFirstStream = true;
    adapter.setFrameEmitter(
      (header, payload) => {
        if (
          header.kind === "data" &&
          header.connectionId === "connection-a" &&
          rejectFirstStream
        ) {
          rejectFirstStream = false;
          return false;
        }
        output.push({ header, payload: payload.slice() });
        return true;
      },
      async () => {
        capacityWaits += 1;
        return capacityWaits === 1 ? firstCapacity : true;
      },
    );

    adapter.handleFrame(connectHeader("connection-a", port), EMPTY_PAYLOAD);
    await waitFor(() => capacityWaits === 1);
    adapter.handleFrame(connectHeader("connection-b", port), EMPTY_PAYLOAD);
    await waitFor(() =>
      output.some(
        ({ header, payload }) =>
          header.kind === "data" &&
          header.connectionId === "connection-b" &&
          new TextDecoder().decode(payload) === "ready",
      ),
    );
    expect(capacityWaits).toBe(1);
    releaseFirstCapacity(true);
    adapter.close();
  });

  it("interleaves sustained sibling streams within the shared byte window", async () => {
    const expected = Buffer.allocUnsafe(1 * 1_024 * 1_024);
    for (let index = 0; index < expected.byteLength; index += 1) {
      expected[index] = (index * 13 + 7) & 0xff;
    }
    const port = await listenSynchronizedPayload(expected, 2);
    const adapter = new TunnelTcpDestinationAdapter();
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    const inputSequences = new Map([
      ["connection-a", 1],
      ["connection-b", 1],
    ]);
    adapter.setFrameEmitter((header, payload) => {
      output.push({ header, payload: payload.slice() });
      if (header.kind === "data") {
        const sequence = inputSequences.get(header.connectionId)!;
        inputSequences.set(header.connectionId, sequence + 1);
        adapter.handleFrame(
          nextHeader(header.connectionId, sequence, {
            kind: "credit",
            direction: "destination-to-source",
            bytes: payload.byteLength,
          }),
          EMPTY_PAYLOAD,
        );
      }
      return true;
    });

    adapter.handleFrame(connectHeader("connection-a", port), EMPTY_PAYLOAD);
    adapter.handleFrame(connectHeader("connection-b", port), EMPTY_PAYLOAD);
    await waitFor(
      () =>
        output.filter(({ header }) => header.kind === "half-close").length ===
        2,
      10_000,
    );

    const data = output.filter(({ header }) => header.kind === "data");
    adapter.close();
    expect(
      new Set(data.slice(0, 4).map(({ header }) => header.connectionId)),
    ).toEqual(new Set(["connection-a", "connection-b"]));
    for (const connectionId of ["connection-a", "connection-b"]) {
      const actual = Buffer.concat(
        data
          .filter(({ header }) => header.connectionId === connectionId)
          .map(({ payload }) => Buffer.from(payload)),
      );
      expect(actual.equals(expected)).toBe(true);
    }
  });

  it("allows exactly the pending-output cap and closes at one byte over", async () => {
    class FakeSocket extends EventEmitter {
      localPort = 43_210;
      writableLength = 0;

      destroy(): this {
        return this;
      }

      end(): this {
        return this;
      }

      pause(): this {
        return this;
      }

      resume(): this {
        return this;
      }

      setNoDelay(): this {
        return this;
      }

      setTimeout(): this {
        return this;
      }

      write(_payload: Uint8Array, callback?: () => void): boolean {
        callback?.();
        return true;
      }
    }

    const socket = new FakeSocket();
    const adapter = new TunnelTcpDestinationAdapter(
      () => socket as unknown as Socket,
    );
    const output: TunnelDataPlaneFrameHeader[] = [];
    adapter.setFrameEmitter(
      (header) => {
        output.push(header);
        return header.kind !== "data";
      },
      () => new Promise<boolean>(() => undefined),
    );
    adapter.handleFrame(connectHeader("queue-boundary", 43_210), EMPTY_PAYLOAD);
    socket.emit("connect");

    socket.emit("data", Buffer.alloc(1 * 1_024 * 1_024));
    await waitFor(() => output.some((header) => header.kind === "data"));
    expect(output.some((header) => header.kind === "close")).toBe(false);

    socket.emit("data", Buffer.from([1]));
    await waitFor(() =>
      output.some(
        (header) => header.kind === "close" && header.code === "congested",
      ),
    );
    adapter.close();
  });

  it("keeps destination reads paused while queued output has no byte credit", async () => {
    class FakeSocket extends EventEmitter {
      localPort = 43_210;
      pauseCalls = 0;
      resumeCalls = 0;
      writableLength = 0;

      destroy(): this {
        return this;
      }

      end(): this {
        return this;
      }

      pause(): this {
        this.pauseCalls += 1;
        return this;
      }

      resume(): this {
        this.resumeCalls += 1;
        return this;
      }

      setNoDelay(): this {
        return this;
      }

      setTimeout(): this {
        return this;
      }

      write(_payload: Uint8Array, callback?: () => void): boolean {
        callback?.();
        return true;
      }
    }

    const socket = new FakeSocket();
    const adapter = new TunnelTcpDestinationAdapter(
      () => socket as unknown as Socket,
    );
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    adapter.setFrameEmitter((header, payload) => {
      output.push({ header, payload: payload.slice() });
      return true;
    });
    adapter.handleFrame(
      {
        ...connectHeader("zero-credit-pause", 43_210),
        initialCreditBytes: 64 * 1_024,
      },
      EMPTY_PAYLOAD,
    );
    socket.emit("connect");

    socket.emit("data", Buffer.alloc(128 * 1_024, 19));
    await waitFor(
      () =>
        output
          .filter(({ header }) => header.kind === "data")
          .reduce((total, { payload }) => total + payload.byteLength, 0) ===
        64 * 1_024,
    );
    expect(socket.pauseCalls).toBe(1);
    expect(socket.resumeCalls).toBe(0);

    adapter.handleFrame(
      nextHeader("zero-credit-pause", 1, {
        kind: "credit",
        direction: "destination-to-source",
        bytes: 64 * 1_024,
      }),
      EMPTY_PAYLOAD,
    );
    await waitFor(
      () =>
        output
          .filter(({ header }) => header.kind === "data")
          .reduce((total, { payload }) => total + payload.byteLength, 0) ===
        128 * 1_024,
    );
    await waitFor(() => socket.resumeCalls === 1);
    adapter.close();
  });

  it("pauses destination reads until the source grants more byte credit", async () => {
    const size = 320 * 1_024;
    // Deliberately does not align with Node's TCP read size. The adapter must
    // split a queued read at the exact credit boundary instead of deadlocking.
    const initialCredit = 48 * 1_024 + 13;
    const port = await listenBurst(size);
    const adapter = new TunnelTcpDestinationAdapter();
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    adapter.setFrameEmitter((header, payload) => {
      output.push({ header, payload: payload.slice() });
      return true;
    });
    adapter.handleFrame(
      {
        ...connectHeader("flow-controlled", port),
        initialCreditBytes: initialCredit,
      },
      EMPTY_PAYLOAD,
    );
    await waitFor(
      () =>
        output
          .filter(({ header }) => header.kind === "data")
          .reduce((total, { payload }) => total + payload.byteLength, 0) ===
        initialCredit,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(
      output
        .filter(({ header }) => header.kind === "data")
        .reduce((total, { payload }) => total + payload.byteLength, 0),
    ).toBe(initialCredit);

    adapter.handleFrame(
      nextHeader("flow-controlled", 1, {
        kind: "credit",
        direction: "destination-to-source",
        bytes: size - initialCredit,
      }),
      EMPTY_PAYLOAD,
    );
    await waitFor(
      () =>
        output
          .filter(({ header }) => header.kind === "data")
          .reduce((total, { payload }) => total + payload.byteLength, 0) ===
        size,
    );
    adapter.close();
  });

  it("drains the initial byte window without a carrier round trip per frame", async () => {
    const expected = Buffer.allocUnsafe(256 * 1_024);
    for (let index = 0; index < expected.byteLength; index += 1) {
      expected[index] = (index * 17 + 29) & 0xff;
    }
    const port = await listenPayload(expected);
    const adapter = new TunnelTcpDestinationAdapter();
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    let capacityWaits = 0;
    adapter.setFrameEmitter(
      (header, payload) => {
        output.push({ header, payload: payload.slice() });
        return true;
      },
      () => {
        capacityWaits += 1;
        return new Promise<boolean>(() => undefined);
      },
    );

    adapter.handleFrame(connectHeader("window-drain", port), EMPTY_PAYLOAD);
    await waitFor(
      () => output.some(({ header }) => header.kind === "half-close"),
      15_000,
    );

    const dataFrames = output.filter(({ header }) => header.kind === "data");
    expect(dataFrames.length).toBeGreaterThanOrEqual(4);
    expect(capacityWaits).toBe(0);
    expect(
      Buffer.concat(
        dataFrames.map(({ payload }) => Buffer.from(payload)),
      ).equals(expected),
    ).toBe(true);
    expect(
      output.findIndex(({ header }) => header.kind === "half-close"),
    ).toBeGreaterThan(
      output.findLastIndex(({ header }) => header.kind === "data"),
    );
    adapter.close();
  });

  it("relays a fast 16 MiB response in order while WebSocket capacity is delayed", async () => {
    const expected = Buffer.allocUnsafe(16 * 1_024 * 1_024);
    for (let index = 0; index < expected.byteLength; index += 1) {
      expected[index] = (index * 31 + 17) & 0xff;
    }
    const port = await listenPayload(expected);
    const adapter = new TunnelTcpDestinationAdapter();
    const connectionId = "backpressured-response";
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    let inputSequence = 1;
    let capacityWaits = 0;
    let releaseInitialCapacity!: (available: boolean) => void;
    const initialCapacity = new Promise<boolean>((resolve) => {
      releaseInitialCapacity = resolve;
    });
    let rejectFirstData = true;
    adapter.setFrameEmitter(
      (header, payload) => {
        if (header.kind === "data" && rejectFirstData) {
          rejectFirstData = false;
          return false;
        }
        output.push({ header, payload: payload.slice() });
        if (header.kind === "data") {
          adapter.handleFrame(
            nextHeader(connectionId, inputSequence++, {
              kind: "credit",
              direction: "destination-to-source",
              bytes: payload.byteLength,
            }),
            EMPTY_PAYLOAD,
          );
        }
        return true;
      },
      async () => {
        capacityWaits += 1;
        return capacityWaits === 1 ? initialCapacity : true;
      },
    );

    adapter.handleFrame(connectHeader(connectionId, port), EMPTY_PAYLOAD);
    await waitFor(() => capacityWaits === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(output.some(({ header }) => header.kind === "close")).toBe(false);

    releaseInitialCapacity(true);
    await waitFor(
      () => output.some(({ header }) => header.kind === "half-close"),
      15_000,
    );

    const dataFrames = output.filter(
      (
        item,
      ): item is {
        header: Extract<TunnelDataPlaneFrameHeader, { kind: "data" }>;
        payload: Uint8Array;
      } => item.header.kind === "data",
    );
    const actual = Buffer.concat(
      dataFrames.map(({ payload }) => Buffer.from(payload)),
    );
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(actual.equals(expected)).toBe(true);
    expect(
      output.findIndex(({ header }) => header.kind === "half-close"),
    ).toBeGreaterThan(
      output.findLastIndex(({ header }) => header.kind === "data"),
    );
    expect(
      output.some(
        ({ header }) => header.kind === "close" && header.code === "congested",
      ),
    ).toBe(false);
    adapter.close();
  });

  it("retains and retries an output frame rejected by shared channel congestion", async () => {
    const port = await listenPayload(Buffer.from("ready"));
    const adapter = new TunnelTcpDestinationAdapter();
    const connectionId = "shared-channel-congestion";
    const attempts: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    const output: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    let rejectFirstData = true;
    let capacityWaits = 0;
    let releaseCongestion!: (available: boolean) => void;
    const congestion = new Promise<boolean>((resolve) => {
      releaseCongestion = resolve;
    });
    adapter.setFrameEmitter(
      (header, payload) => {
        attempts.push({ header, payload: payload.slice() });
        if (header.kind === "data" && rejectFirstData) {
          rejectFirstData = false;
          return false;
        }
        output.push({ header, payload: payload.slice() });
        return true;
      },
      async () => {
        capacityWaits += 1;
        return capacityWaits === 1 ? congestion : true;
      },
    );

    adapter.handleFrame(connectHeader(connectionId, port), EMPTY_PAYLOAD);
    await waitFor(
      () =>
        attempts.filter(({ header }) => header.kind === "data").length === 1,
    );
    expect(capacityWaits).toBe(1);
    expect(
      attempts.some(
        ({ header }) => header.kind === "close" && header.code === "congested",
      ),
    ).toBe(false);

    releaseCongestion(true);
    await waitFor(() =>
      output.some(({ header }) => header.kind === "half-close"),
    );
    const dataAttempts = attempts.filter(
      ({ header }) => header.kind === "data",
    );
    expect(dataAttempts).toHaveLength(2);
    expect(dataAttempts[1]).toEqual(dataAttempts[0]);
    expect(
      new TextDecoder().decode(
        output.find(({ header }) => header.kind === "data")!.payload,
      ),
    ).toBe("ready");
    expect(
      output.some(
        ({ header }) => header.kind === "close" && header.code === "congested",
      ),
    ).toBe(false);
    adapter.close();
  });

  it("records a safe diagnostic when output capacity closes a stream", async () => {
    const port = await listenBurst(64 * 1_024);
    const adapter = new TunnelTcpDestinationAdapter();
    const connectionId = "capacity-unavailable";
    const output: TunnelDataPlaneFrameHeader[] = [];
    const records: Array<{ context?: Record<string, unknown> }> = [];
    const unsubscribe = subscribeWorkerLogs((record) =>
      records.push(record as { context?: Record<string, unknown> }),
    );
    subscriptions.push(unsubscribe);
    adapter.setFrameEmitter(
      (header) => {
        output.push(header);
        return header.kind !== "data";
      },
      async () => false,
    );

    adapter.handleFrame(connectHeader(connectionId, port), EMPTY_PAYLOAD);
    await waitFor(() =>
      output.some(
        (header) => header.kind === "close" && header.code === "congested",
      ),
    );

    const context = records.find(
      (record) =>
        record.context?.event === "tunnel.destination.closed-locally" &&
        record.context.connectionId === connectionId,
    )?.context;
    expect(context).toMatchObject({
      connectionScope: "logical-stream",
      event: "tunnel.destination.closed-locally",
      reasonCode: "capacity-unavailable",
      status: "failed",
      connectionId,
    });
    expect(context).not.toHaveProperty("host");
    expect(context).not.toHaveProperty("port");
    expect(context).not.toHaveProperty("target");
    expect(context).not.toHaveProperty("payload");
    const rejectedData = output.find((header) => header.kind === "data");
    const terminal = output.find(
      (header) => header.kind === "close" && header.code === "congested",
    );
    expect(terminal?.sequence).toBe(rejectedData?.sequence);
    adapter.close();
  });

  it("reports an unavailable destination without exposing credentials", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("No port.");
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const adapter = new TunnelTcpDestinationAdapter();
    const output: TunnelDataPlaneFrameHeader[] = [];
    adapter.setFrameEmitter((header) => {
      output.push(header);
      return true;
    });
    adapter.handleFrame(
      connectHeader("connection-failed", port),
      EMPTY_PAYLOAD,
    );
    await waitFor(() => output.some(({ kind }) => kind === "error"));
    expect(output.at(-1)).toMatchObject({
      kind: "error",
      code: "connection-failed",
    });
    adapter.close();
  });
});
