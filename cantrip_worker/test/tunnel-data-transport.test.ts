import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import type { WorkerConfig } from "../src/config.js";
import { WorkerConnection } from "../src/transport.js";

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const frame: TunnelDataPlaneFrameHeader = {
  protocolVersion: 1,
  tunnelId: "tunnel-1",
  attachmentId: "attachment-1",
  sourceEndpointId: "desktop-1",
  destinationEndpointId: "worker-1",
  connectionId: "connection-1",
  sequence: 0,
  kind: "data",
  direction: "source-to-destination",
};

describe("worker generic tunnel data transport", () => {
  it("multiplexes generic frames and reports transport disconnect", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    const connected = new Promise<WebSocket>((resolve) =>
      webSockets.once("connection", resolve),
    );
    server.on("upgrade", (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit("connection", client, request);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    closers.push(async () => {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    });
    const { port } = server.address() as AddressInfo;
    const received: Array<{
      header: TunnelDataPlaneFrameHeader;
      payload: Uint8Array;
    }> = [];
    const disconnected = vi.fn();
    const connection = new WorkerConnection(
      {
        codeIdleTimeoutMs: 1_000,
        codexBinary: "/tmp/codex",
        codexInstallation: {
          binary: "/tmp/codex",
          manifestPath: null,
          source: "override",
        },
        dataDirectory: "/tmp/cantrip-worker",
        name: "Test Worker",
        serverUrl: `http://127.0.0.1:${port}`,
        token: "worker-secret",
        workerId: "worker-1",
      } satisfies WorkerConfig,
      async () => undefined,
      () => undefined,
      (header, payload) => {
        received.push({ header, payload: Uint8Array.from(payload) });
      },
      disconnected,
    );
    connection.start();
    closers.push(() => connection.close());
    const workerSocket = await connected;

    workerSocket.send(
      encodeTunnelDataPlaneFrame(frame, new Uint8Array([1, 2, 3])),
      { binary: true },
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      header: frame,
      payload: new Uint8Array([1, 2, 3]),
    });

    const outbound = new Promise<Uint8Array>((resolve) =>
      workerSocket.once("message", (data) =>
        resolve(Uint8Array.from(data as Buffer)),
      ),
    );
    expect(
      connection.sendTunnelDataPlaneFrame(
        {
          ...frame,
          sequence: 1,
          direction: "destination-to-source",
        },
        new Uint8Array([4, 5]),
      ),
    ).toBe(true);
    expect(decodeTunnelDataPlaneFrame(await outbound)).toMatchObject({
      header: { sequence: 1, direction: "destination-to-source" },
      payload: new Uint8Array([4, 5]),
    });

    workerSocket.close();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
  });
});
