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

describe("worker project share transport", () => {
  it("carries protected project-share traffic on the generic tunnel channel", async () => {
    const tunnelId = "11111111-1111-4111-8111-111111111111";
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
      header: TunnelDataPlaneFrameHeader;
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
      (header, payload) => {
        received.push({ header, payload: Uint8Array.from(payload) });
      },
    );
    connection.start();
    closers.push(() => connection.close());
    const workerSocket = await connected;
    expect(authorization).toBe("Bearer worker-secret");

    const inbound: TunnelDataPlaneFrameHeader = {
      protocolVersion: 1,
      tunnelId,
      attachmentId: "share-1",
      sourceEndpointId: "server:project-share:share-1",
      destinationEndpointId: "worker:share-1",
      connectionId: "stream-1",
      sequence: 0,
      kind: "connect",
      target: {
        kind: "protected-tunnel",
        targetKind: "project-share",
        recordId: tunnelId,
        protectedRecord: {
          operationId: tunnelId,
          revision: 1,
          protectedContent: {
            formatVersion: 1,
            domain: "tunnel-content",
            keyRevision: 1,
            envelope: {
              version: 1,
              algorithm: "AES-256-GCM",
              keyRevision: 1,
              nonce: "AAAAAAAAAAAAAAAA",
              ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
            },
          },
        },
      },
      initialCreditBytes: 1024,
    };
    workerSocket.send(encodeTunnelDataPlaneFrame(inbound, new Uint8Array()), {
      binary: true,
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ header: inbound, payload: new Uint8Array() });

    const outbound = new Promise<Uint8Array>((resolve) =>
      workerSocket.once("message", (data) =>
        resolve(Uint8Array.from(data as Buffer)),
      ),
    );
    const reply: TunnelDataPlaneFrameHeader = {
      protocolVersion: 1,
      tunnelId: inbound.tunnelId,
      attachmentId: inbound.attachmentId,
      sourceEndpointId: inbound.sourceEndpointId,
      destinationEndpointId: inbound.destinationEndpointId,
      connectionId: inbound.connectionId,
      sequence: 0,
      kind: "accepted",
      initialCreditBytes: 2048,
    };
    expect(connection.sendTunnelDataPlaneFrame(reply, new Uint8Array())).toBe(
      true,
    );
    expect(decodeTunnelDataPlaneFrame(await outbound).header).toEqual(reply);
  });
});
