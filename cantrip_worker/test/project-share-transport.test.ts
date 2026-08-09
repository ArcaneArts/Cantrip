import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  decodeProjectShareTunnelFrame,
  encodeProjectShareTunnelFrame,
  type ProjectShareTunnelFrameHeader,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import type { WorkerConfig } from "../src/config.js";
import { WorkerConnection } from "../src/transport.js";

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("worker project share transport", () => {
  it("multiplexes project share frames on the authenticated outbound socket", async () => {
    let authorization: string | undefined;
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    const connected = new Promise<WebSocket>((resolve) =>
      webSockets.once("connection", resolve),
    );
    server.on("upgrade", (request, socket, head) => {
      authorization = request.headers.authorization;
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
      header: ProjectShareTunnelFrameHeader;
      payload: Uint8Array;
    }> = [];
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
      () => undefined,
      (header, payload) => {
        received.push({ header, payload: Uint8Array.from(payload) });
      },
    );
    connection.start();
    closers.push(() => connection.close());
    const workerSocket = await connected;
    expect(authorization).toBe("Bearer worker-secret");

    const inbound: ProjectShareTunnelFrameHeader = {
      protocolVersion: 1,
      shareId: "share-1",
      streamId: "stream-1",
      kind: "http-request-data",
    };
    workerSocket.send(
      encodeProjectShareTunnelFrame(inbound, new Uint8Array([1, 2, 3])),
      { binary: true },
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      header: inbound,
      payload: new Uint8Array([1, 2, 3]),
    });

    const outbound = new Promise<Uint8Array>((resolve) =>
      workerSocket.once("message", (data) =>
        resolve(Uint8Array.from(data as Buffer)),
      ),
    );
    expect(
      connection.sendProjectShareTunnelFrame(
        { ...inbound, kind: "http-response-data" },
        new Uint8Array([4, 5]),
      ),
    ).toBe(true);
    expect(decodeProjectShareTunnelFrame(await outbound)).toMatchObject({
      header: { kind: "http-response-data", shareId: "share-1" },
      payload: new Uint8Array([4, 5]),
    });
  });
});
