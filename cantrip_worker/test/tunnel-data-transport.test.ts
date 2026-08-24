import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  decodeWorkerServerEnvelope,
  decodeTunnelDataPlaneFrame,
  encodeWorkerConnectionEnvelope,
  encodeWorkerRequestEnvelope,
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerServerEnvelope,
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
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

const chatTurnCommand = (): WorkerCommand => ({
  type: "chat.turn",
  chatId: "chat-1",
  clientMessageId: "message-1",
  executionLaneId: "lane-1",
  worktreeId: "worktree-1",
  policyProjectId: "project-1",
  policies: { policies: [] },
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
});

const workerConfig = (port: number): WorkerConfig => ({
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
});

function workerConnectionGeneration(requestUrl: string): string {
  return new URL(requestUrl, "http://worker.invalid").searchParams.get(
    "connectionGeneration",
  )!;
}

function sendConnectionState(
  socket: WebSocket,
  requestUrl: string,
  state: "pending" | "ready",
  connectionGeneration = workerConnectionGeneration(requestUrl),
): void {
  socket.send(
    encodeWorkerConnectionEnvelope({
      kind: "connection",
      state,
      protocolVersion: 1,
      connectionGeneration,
    }),
  );
}

function sendConnectionReady(socket: WebSocket, requestUrl: string): void {
  sendConnectionState(socket, requestUrl, "pending");
  sendConnectionState(socket, requestUrl, "ready");
}

function authenticatedReadyWebSocketServer(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL)
        ? WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL
        : false;
    },
  });
}

async function commandServer(
  options: {
    autoReady?: boolean;
    protocol?: "auth-ready" | "legacy" | null;
    protocolSequence?: ReadonlyArray<"auth-ready" | "legacy" | null>;
  } = {},
) {
  const server = createServer();
  let upgradeAttempt = 0;
  const selectedProtocol = () => {
    const sequenceIndex = upgradeAttempt - 1;
    const protocol =
      options.protocolSequence &&
      sequenceIndex < options.protocolSequence.length
        ? options.protocolSequence[sequenceIndex]
        : options.protocol;
    return protocol === "legacy"
      ? WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL
      : protocol === null
        ? null
        : WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL;
  };
  const webSockets = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      const selected = selectedProtocol();
      if (selected === null) return false;
      return protocols.has(selected) ? selected : false;
    },
  });
  const pendingSockets: WebSocket[] = [];
  const connected: Array<(socket: WebSocket) => void> = [];
  const requestUrls: string[] = [];
  let acceptUpgrades = true;
  const nextSocket = () => {
    const socket = pendingSockets.shift();
    return socket
      ? Promise.resolve(socket)
      : new Promise<WebSocket>((resolve) => connected.push(resolve));
  };
  webSockets.on("connection", (socket, request) => {
    const requestUrl = request.url ?? "";
    requestUrls.push(requestUrl);
    const waiter = connected.shift();
    if (waiter) waiter(socket);
    else pendingSockets.push(socket);
    if (options.autoReady !== false) sendConnectionReady(socket, requestUrl);
  });
  server.on("upgrade", (request, socket, head) => {
    upgradeAttempt += 1;
    if (!acceptUpgrades) {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      webSockets.emit("connection", client, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    for (const client of webSockets.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
  });
  return {
    port: (server.address() as AddressInfo).port,
    nextSocket,
    rejectUpgrades: () => {
      acceptUpgrades = false;
    },
    requestUrls,
    webSockets,
  };
}

describe("worker generic tunnel data transport", () => {
  it("delivers a durable chat outcome after the command channel reconnects", async () => {
    const server = createServer();
    const webSockets = authenticatedReadyWebSocketServer();
    const sockets: WebSocket[] = [];
    const connected: Array<(socket: WebSocket) => void> = [];
    const nextSocket = () =>
      new Promise<WebSocket>((resolve) => connected.push(resolve));
    webSockets.on("connection", (socket, request) => {
      sockets.push(socket);
      connected.shift()?.(socket);
      sendConnectionReady(socket, request.url ?? "");
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
    const command = chatTurnCommand();
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
    const webSockets = authenticatedReadyWebSocketServer();
    const sockets: WebSocket[] = [];
    let resolveFirst: ((socket: WebSocket) => void) | undefined;
    let resolveSecond: ((socket: WebSocket) => void) | undefined;
    const firstConnected = new Promise<WebSocket>((resolve) => {
      resolveFirst = resolve;
    });
    const secondConnected = new Promise<WebSocket>((resolve) => {
      resolveSecond = resolve;
    });
    webSockets.on("connection", (socket, request) => {
      sockets.push(socket);
      if (sockets.length === 1) resolveFirst?.(socket);
      if (sockets.length === 2) resolveSecond?.(socket);
      sendConnectionReady(socket, request.url ?? "");
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
    const webSockets = authenticatedReadyWebSocketServer();
    const connected = new Promise<WebSocket>((resolve) => {
      webSockets.once("connection", (socket, request) => {
        resolve(socket);
        sendConnectionReady(socket, request.url ?? "");
      });
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
      undefined,
      undefined,
      { transportDisconnectGraceMs: 10 },
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

  it("retains transport state and process generation through a short reconnect", async () => {
    const server = await commandServer();
    const disconnected = vi.fn();
    const firstConnected = server.nextSocket();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      disconnected,
      10,
      () => undefined,
      { reconnectDelayMs: 5, transportDisconnectGraceMs: 60 },
    );
    connection.start();
    closers.push(() => connection.close());

    const firstSocket = await firstConnected;
    const secondConnected = server.nextSocket();
    firstSocket.terminate();
    await secondConnected;
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(disconnected).not.toHaveBeenCalled();
    expect(server.requestUrls).toHaveLength(2);
    const generations = server.requestUrls.map((value) =>
      new URL(value, "http://worker.invalid").searchParams.get(
        "connectionGeneration",
      ),
    );
    expect(generations[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(generations[1]).toBe(generations[0]);
  });

  it("bounds transport retention from the initial loss across failed reconnects", async () => {
    const server = await commandServer();
    const disconnected = vi.fn();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      disconnected,
      0,
      () => undefined,
      { reconnectDelayMs: 5, transportDisconnectGraceMs: 35 },
    );
    connection.start();
    closers.push(() => connection.close());
    const socket = await server.nextSocket();

    server.rejectUpgrades();
    socket.terminate();

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce(), {
      timeout: 250,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("fences a recovered loss timer before a later disconnect", async () => {
    const server = await commandServer();
    const disconnected = vi.fn();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      disconnected,
      0,
      () => undefined,
      { reconnectDelayMs: 5, transportDisconnectGraceMs: 80 },
    );
    connection.start();
    closers.push(() => connection.close());
    const firstSocket = await server.nextSocket();
    const secondConnected = server.nextSocket();

    firstSocket.terminate();
    const secondSocket = await secondConnected;
    await new Promise((resolve) => setTimeout(resolve, 45));
    server.rejectUpgrades();
    secondSocket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 45));

    expect(disconnected).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce(), {
      timeout: 150,
    });
  });

  it("disconnects retained transport immediately when the worker closes", async () => {
    const server = await commandServer();
    const disconnected = vi.fn();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      disconnected,
      0,
      () => undefined,
      { reconnectDelayMs: 5, transportDisconnectGraceMs: 40 },
    );
    connection.start();
    const socket = await server.nextSocket();
    socket.terminate();

    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 55));

    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("disconnects immediately and does not retry after authentication rejection", async () => {
    const server = await commandServer({ autoReady: false });
    const disconnected = vi.fn();
    server.webSockets.on("connection", (socket) => {
      socket.close(1008, "Unauthorized");
    });
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      disconnected,
      0,
      () => undefined,
      { reconnectDelayMs: 5, transportDisconnectGraceMs: 100 },
    );
    connection.start();
    closers.push(() => connection.close());
    await server.nextSocket();

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce(), {
      timeout: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.requestUrls).toHaveLength(1);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("keeps queued outcomes and the original grace while reconnect authentication is pending", async () => {
    const server = await commandServer({ autoReady: false });
    const disconnected = vi.fn();
    const connected = vi.fn();
    let releaseCommand: (() => void) | undefined;
    let markCommandStarted: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => {
        markCommandStarted?.();
        await commandGate;
        return {
          threadId: "thread-1",
          turnId: "turn-1",
          text: "Authenticated result",
          status: "completed",
        };
      },
      () => undefined,
      () => undefined,
      disconnected,
      10,
      connected,
      { reconnectDelayMs: 5, transportDisconnectGraceMs: 80 },
    );
    connection.start();
    closers.push(() => connection.close());

    const firstSocket = await server.nextSocket();
    const generation = workerConnectionGeneration(server.requestUrls[0]!);
    sendConnectionReady(firstSocket, server.requestUrls[0]!);
    firstSocket.send(
      encodeWorkerRequestEnvelope({
        kind: "request",
        requestId: "chat-request-pending",
        command: chatTurnCommand(),
      }),
    );
    await commandStarted;

    const secondConnected = server.nextSocket();
    firstSocket.terminate();
    const secondSocket = await secondConnected;
    sendConnectionState(
      secondSocket,
      server.requestUrls[1]!,
      "pending",
      generation,
    );
    const received: unknown[] = [];
    const pings = vi.fn();
    secondSocket.on("message", (data) => received.push(data));
    secondSocket.on("ping", pings);
    releaseCommand?.();

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce(), {
      timeout: 250,
    });
    expect(received).toEqual([]);
    expect(pings).not.toHaveBeenCalled();
    expect(connected).toHaveBeenCalledOnce();
  });

  it("rejects a ready envelope for a different process generation", async () => {
    const server = await commandServer({ autoReady: false });
    const disconnected = vi.fn();
    const connected = vi.fn();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      disconnected,
      0,
      connected,
      { reconnectDelayMs: 5, transportDisconnectGraceMs: 70 },
    );
    connection.start();
    closers.push(() => connection.close());

    const firstSocket = await server.nextSocket();
    sendConnectionReady(firstSocket, server.requestUrls[0]!);
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());
    const secondConnected = server.nextSocket();
    firstSocket.terminate();
    const secondSocket = await secondConnected;
    sendConnectionState(
      secondSocket,
      server.requestUrls[1]!,
      "ready",
      "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
    );

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce(), {
      timeout: 200,
    });
    expect(connected).toHaveBeenCalledOnce();
  });

  it("waits for delayed pending on the authenticated-ready subprotocol", async () => {
    const server = await commandServer({
      autoReady: false,
      protocol: "auth-ready",
    });
    const disconnected = vi.fn();
    const connected = vi.fn();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      disconnected,
      0,
      connected,
      {
        reconnectDelayMs: 5,
        transportDisconnectGraceMs: 1_000,
      },
    );
    connection.start();
    closers.push(() => connection.close());
    const firstSocket = await server.nextSocket();
    sendConnectionReady(firstSocket, server.requestUrls[0]!);
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());

    const reconnect = server.nextSocket();
    firstSocket.terminate();
    const socket = await reconnect;

    expect(
      connection.sendTunnelDataPlaneFrame(frame, new Uint8Array([1])),
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(connected).toHaveBeenCalledOnce();
    expect(disconnected).not.toHaveBeenCalled();
    expect(
      connection.sendTunnelDataPlaneFrame(frame, new Uint8Array([1])),
    ).toBe(false);

    sendConnectionState(socket, server.requestUrls[1]!, "pending");
    expect(connected).toHaveBeenCalledOnce();
    sendConnectionState(socket, server.requestUrls[1]!, "ready");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2));

    const outbound = new Promise<Uint8Array>((resolve) => {
      socket.once("message", (data) =>
        resolve(Uint8Array.from(data as Buffer)),
      );
    });
    expect(
      connection.sendTunnelDataPlaneFrame(frame, new Uint8Array([1])),
    ).toBe(true);
    await expect(outbound).resolves.toEqual(
      encodeTunnelDataPlaneFrame(frame, new Uint8Array([1])),
    );
  });

  it("rejects a ready envelope that was not preceded by pending", async () => {
    const server = await commandServer({
      autoReady: false,
      protocol: "auth-ready",
    });
    const connected = vi.fn();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      0,
      connected,
      { reconnectDelayMs: 1_000, transportDisconnectGraceMs: 150 },
    );
    connection.start();
    closers.push(() => connection.close());
    const socket = await server.nextSocket();
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });

    sendConnectionState(socket, server.requestUrls[0]!, "ready");

    await expect(closed).resolves.toBe(1002);
    expect(connected).not.toHaveBeenCalled();
  });

  it("requires a new pending envelope before ready on reconnect", async () => {
    const server = await commandServer({
      autoReady: false,
      protocol: "auth-ready",
    });
    const connected = vi.fn();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      0,
      connected,
      { reconnectDelayMs: 5, transportDisconnectGraceMs: 150 },
    );
    connection.start();
    closers.push(() => connection.close());

    const firstSocket = await server.nextSocket();
    sendConnectionReady(firstSocket, server.requestUrls[0]!);
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());
    const reconnect = server.nextSocket();
    firstSocket.terminate();
    const secondSocket = await reconnect;
    const closed = new Promise<number>((resolve) => {
      secondSocket.once("close", (code) => resolve(code));
    });

    sendConnectionState(secondSocket, server.requestUrls[1]!, "ready");

    await expect(closed).resolves.toBe(1002);
    expect(connected).toHaveBeenCalledOnce();
  });

  it("offers authenticated readiness again after a no-protocol fallback", async () => {
    const server = await commandServer({
      autoReady: false,
      protocolSequence: [null, null, "auth-ready"],
    });
    const connected = vi.fn();
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async () => ({ available: true }),
      () => undefined,
      () => undefined,
      () => undefined,
      0,
      connected,
      {
        reconnectDelayMs: 5,
        transportDisconnectGraceMs: 300,
      },
    );
    connection.start();
    closers.push(() => connection.close());
    // ws rejects the first handshake when an old server omits a selected
    // protocol; the worker retries without offers and awaits a real request.
    await server.nextSocket();
    const socket = await server.nextSocket();
    const response = new Promise<WorkerServerEnvelope>((resolve) => {
      socket.once("message", (data) => {
        const decoded = decodeWorkerServerEnvelope(data.toString());
        if (decoded.success) resolve(decoded.data);
      });
    });

    socket.send(
      encodeWorkerRequestEnvelope({
        kind: "request",
        requestId: "legacy-request",
        command: { type: "code.probe" },
      }),
    );

    await expect(response).resolves.toMatchObject({
      kind: "response",
      requestId: "legacy-request",
      ok: true,
    });
    expect(connected).toHaveBeenCalledOnce();
    expect(socket.protocol).toBe("");

    const reconnect = server.nextSocket();
    socket.terminate();
    const modernSocket = await reconnect;
    expect(modernSocket.protocol).toBe(WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL);
    expect(connected).toHaveBeenCalledOnce();

    sendConnectionState(modernSocket, server.requestUrls[2]!, "pending");
    expect(connected).toHaveBeenCalledOnce();
    sendConnectionState(modernSocket, server.requestUrls[2]!, "ready");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2));
  });

  it("flushes queued outcomes on a negotiated legacy reconnect without an inbound request", async () => {
    const server = await commandServer({
      autoReady: false,
      protocol: "legacy",
    });
    const connected = vi.fn();
    let releaseCommand: (() => void) | undefined;
    let markCommandStarted: (() => void) | undefined;
    let markCommandFinished: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const commandFinished = new Promise<void>((resolve) => {
      markCommandFinished = resolve;
    });
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const connection = new WorkerConnection(
      workerConfig(server.port),
      async (command) => {
        if (command.type === "chat.turn") {
          markCommandStarted?.();
          await commandGate;
          markCommandFinished?.();
          return {
            threadId: "thread-1",
            turnId: "turn-1",
            text: "Legacy queued result",
            status: "completed",
          };
        }
        return { available: true };
      },
      () => undefined,
      () => undefined,
      () => undefined,
      0,
      connected,
      {
        reconnectDelayMs: 100,
        transportDisconnectGraceMs: 300,
      },
    );
    connection.start();
    closers.push(() => connection.close());

    const firstSocket = await server.nextSocket();
    firstSocket.send(
      encodeWorkerRequestEnvelope({
        kind: "request",
        requestId: "legacy-chat-request",
        command: chatTurnCommand(),
      }),
    );
    await commandStarted;
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());

    const reconnect = server.nextSocket();
    firstSocket.terminate();
    await vi.waitFor(() => {
      expect(
        connection.sendTunnelDataPlaneFrame(frame, new Uint8Array([1])),
      ).toBe(false);
    });
    releaseCommand?.();
    await commandFinished;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connected).toHaveBeenCalledOnce();

    const secondSocket = await reconnect;
    const received: WorkerServerEnvelope[] = [];
    secondSocket.on("message", (data) => {
      const decoded = decodeWorkerServerEnvelope(data.toString());
      if (decoded.success) received.push(decoded.data);
    });

    await vi.waitFor(() => {
      expect(
        received.some(
          (envelope) =>
            envelope.kind === "response" &&
            envelope.requestId === "legacy-chat-request",
        ),
      ).toBe(true);
    });
    expect(connected).toHaveBeenCalledTimes(2);
  });
});
