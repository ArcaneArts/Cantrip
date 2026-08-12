import { createServer, type Server } from "node:net";

import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { TunnelTcpDestinationAdapter } from "../src/tunnel-tcp-adapter.js";

const servers: Server[] = [];
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
  const server = createServer((socket) => socket.end(payload));
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

  it("pauses destination reads until the source grants more byte credit", async () => {
    const size = 320 * 1_024;
    const initialCredit = 64 * 1_024;
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
