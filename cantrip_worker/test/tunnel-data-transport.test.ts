import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  decodeWorkerServerEnvelope,
  decodeTunnelDataPlaneFrame,
  encodeWorkerRequestEnvelope,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerServerEnvelope,
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
  it("delivers a durable chat outcome after the command channel reconnects", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    const sockets: WebSocket[] = [];
    const connected: Array<(socket: WebSocket) => void> = [];
    const nextSocket = () =>
      new Promise<WebSocket>((resolve) => connected.push(resolve));
    webSockets.on("connection", (socket) => {
      sockets.push(socket);
      connected.shift()?.(socket);
    });
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
    let commandStarted: (() => void) | undefined;
    let releaseCommand: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const firstConnected = nextSocket();
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
      async () => {
        commandStarted?.();
        await gate;
        return {
          threadId: "thread-1",
          turnId: "turn-1",
          text: "Recovered result",
          status: "completed",
        };
      },
      () => undefined,
      () => undefined,
      () => undefined,
      10,
    );
    connection.start();
    closers.push(() => connection.close());

    const firstSocket = await firstConnected;
    const command: WorkerCommand = {
      type: "chat.turn",
      chatId: "chat-1",
      clientMessageId: "message-1",
      executionLaneId: "lane-1",
      worktreeId: "worktree-1",
      cwd: "/workspace",
      isPrimary: true,
      worktreeMode: "pinned",
      worktreePolicy: "direct",
      threadId: null,
      prompt: "Hello",
      attachments: [],
      skillNames: [],
      model: {
        id: "model-1",
        routeId: "route-1",
        name: "gpt-5.6-sol",
        reasoningEffort: null,
      },
      provider: {
        id: "provider-1",
        name: "ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
        accountId: "account-1",
        credentialHomeKey: "account-home-1",
      },
      permissionProfileId: ":workspace",
      planMode: "default",
      mcpServers: [],
      automationPaused: false,
    };
    firstSocket.send(
      encodeWorkerRequestEnvelope({
        kind: "request",
        requestId: "chat-request-1",
        command,
      }),
    );
    await started;

    const secondConnected = nextSocket();
    firstSocket.terminate();
    const secondSocket = await secondConnected;
    const envelopes: WorkerServerEnvelope[] = [];
    secondSocket.on("message", (data) => {
      const decoded = decodeWorkerServerEnvelope(data.toString());
      if (decoded.success) envelopes.push(decoded.data);
    });
    releaseCommand?.();

    await vi.waitFor(() => expect(envelopes).toHaveLength(2));
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        kind: "response",
        requestId: "chat-request-1",
        ok: true,
      }),
    );
    expect(envelopes).toContainEqual({
      kind: "notification",
      notification: {
        type: "chat.turn.outcome",
        chatId: "chat-1",
        clientMessageId: "message-1",
        executionLaneId: "lane-1",
        worktreeId: "worktree-1",
        outcome: {
          ok: true,
          result: {
            threadId: "thread-1",
            turnId: "turn-1",
            text: "Recovered result",
            status: "completed",
          },
        },
      },
    });
  });

  it("keeps the channel active and returns a command after reconnecting", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    const sockets: WebSocket[] = [];
    let resolveFirst: ((socket: WebSocket) => void) | undefined;
    let resolveSecond: ((socket: WebSocket) => void) | undefined;
    const firstConnected = new Promise<WebSocket>((resolve) => {
      resolveFirst = resolve;
    });
    const secondConnected = new Promise<WebSocket>((resolve) => {
      resolveSecond = resolve;
    });
    webSockets.on("connection", (socket) => {
      sockets.push(socket);
      if (sockets.length === 1) resolveFirst?.(socket);
      if (sockets.length === 2) resolveSecond?.(socket);
    });
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
    let releaseCommand: (() => void) | undefined;
    let markCommandStarted: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
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
      async () => {
        markCommandStarted?.();
        await commandGate;
        return { recovered: true };
      },
      () => undefined,
      () => undefined,
      () => undefined,
      10,
    );
    connection.start();
    closers.push(() => connection.close());

    const firstSocket = await firstConnected;
    await new Promise<void>((resolve) => firstSocket.once("ping", resolve));
    firstSocket.send(
      JSON.stringify({
        kind: "request",
        requestId: "request-1",
        command: { type: "code.probe" },
      }),
    );
    await commandStarted;
    firstSocket.terminate();

    const secondSocket = await secondConnected;
    const response = new Promise<unknown>((resolve) =>
      secondSocket.once("message", (data) =>
        resolve(JSON.parse(data.toString())),
      ),
    );
    releaseCommand?.();
    await expect(response).resolves.toMatchObject({
      kind: "response",
      requestId: "request-1",
      ok: true,
      result: { recovered: true },
    });
  });

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
