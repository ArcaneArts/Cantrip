import {
  createServer,
  request as requestHttp,
  type IncomingMessage,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { CodeDirectEndpointManager } from "../src/code/direct-endpoint.js";
import type { CodeSupervisor } from "../src/code/supervisor.js";
import { subscribeWorkerLogs } from "../src/logger.js";

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("CodeDirectEndpointManager", () => {
  it("retires protected endpoints on terminal command-channel loss", async () => {
    const supervisor = {
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      proxyTarget: vi.fn(() => {
        throw new Error("The editor upstream should not be needed for health.");
      }),
    } as unknown as CodeSupervisor;
    const endpoints = new CodeDirectEndpointManager(supervisor);
    closers.push(() => endpoints.close());
    const target = await endpoints.prepareProtected(
      crypto.randomUUID(),
      "session-terminal-loss",
    );
    const healthUrl = `http://${target.host}:${target.port}/code/_cantrip/health`;

    await expect(fetch(healthUrl)).resolves.toMatchObject({ status: 200 });

    endpoints.disconnect();

    await vi.waitFor(async () => {
      await expect(fetch(healthUrl)).rejects.toThrow();
    });
  });

  it("proxies HTTP without exposing the editor credential", async () => {
    let observed: IncomingMessage | null = null;
    const editor = createServer((request, response) => {
      observed = request;
      response.writeHead(200, {
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "set-cookie": "vscode-tkn=must-not-leave-worker",
        "x-frame-options": "DENY",
      });
      response.end("editor-ready");
    });
    await new Promise<void>((resolve) =>
      editor.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      () => new Promise<void>((resolve) => editor.close(() => resolve())),
    );
    const port = (editor.address() as AddressInfo).port;
    let initialFileUri = "file:///worker/src/example.ts";
    const supervisor = {
      authorizeStartupFileUri: vi.fn(
        async (_sessionId: string, requestedFileUri: string) =>
          requestedFileUri,
      ),
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      proxyTarget: vi.fn(() => ({
        codeTabId: "code-1",
        connectionToken: "worker-local-secret",
        editorOrigin: `http://127.0.0.1:${port}`,
        initialFileUri,
        processInstanceId: "process-1",
        workspaceUri: "file:///worker/project.code-workspace",
      })),
    } as unknown as CodeSupervisor;
    const endpoints = new CodeDirectEndpointManager(supervisor);
    closers.push(() => endpoints.close());
    const tunnelId = crypto.randomUUID();
    const diagnosticTraceId = crypto.randomUUID();
    const records: Array<{ context?: unknown }> = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    closers.push(unsubscribe);
    const target = await endpoints.prepareProtected(tunnelId, "session-1", {
      attachmentId: "attachment-1",
      connectionId: "connection-1",
      diagnosticTraceId,
    });

    const health = await fetch(
      `http://${target.host}:${target.port}/code/_cantrip/health`,
    );
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBe("*");

    const initialUrl = new URL(`http://${target.host}:${target.port}/code/`);
    initialUrl.searchParams.set("workspace", "/worker/project.code-workspace");
    initialUrl.searchParams.set(
      "payload",
      JSON.stringify([
        [
          "openFile",
          `vscode-remote://${target.host}:${target.port}/worker/src/example.ts`,
        ],
      ]),
    );
    initialFileUri = "file:///worker/src/later.ts";
    const response = await fetch(initialUrl, {
      headers: {
        authorization: "Bearer must-not-reach-worker",
        cookie: "app-session=must-not-reach-worker",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-port": "666",
        "x-original-host": "attacker.example",
      },
    });
    expect(await response.text()).toBe("editor-ready");
    expect(response.redirected).toBe(false);
    expect(new URL(response.url).searchParams.get("workspace")).toBe(
      "/worker/project.code-workspace",
    );
    expect(
      JSON.parse(new URL(response.url).searchParams.get("payload")!),
    ).toEqual([
      [
        "openFile",
        `vscode-remote://${target.host}:${target.port}/worker/src/example.ts`,
      ],
    ]);
    const initialRequest = new URL(
      observed?.url ?? "",
      "http://editor.invalid",
    );
    expect(initialRequest.searchParams.get("workspace")).toBe(
      "/worker/project.code-workspace",
    );
    expect(JSON.parse(initialRequest.searchParams.get("payload")!)).toEqual([
      [
        "openFile",
        `vscode-remote://${target.host}:${target.port}/worker/src/example.ts`,
      ],
    ]);
    expect(observed?.headers.cookie).toBe("vscode-tkn=worker-local-secret");
    expect(observed?.headers.authorization).toBeUndefined();
    expect(observed?.headers.host).toBe(`127.0.0.1:${port}`);
    expect(observed?.headers["x-forwarded-host"]).toBe(
      `${target.host}:${target.port}`,
    );
    expect(observed?.headers["x-forwarded-port"]).toBeUndefined();
    expect(observed?.headers["x-original-host"]).toBeUndefined();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "tauri://localhost",
    );
    const reloaded = await fetch(initialUrl);
    expect(await reloaded.text()).toBe("editor-ready");
    expect(
      JSON.parse(
        new URL(observed?.url ?? "", "http://editor.invalid").searchParams.get(
          "payload",
        )!,
      ),
    ).toEqual([
      [
        "openFile",
        `vscode-remote://${target.host}:${target.port}/worker/src/example.ts`,
      ],
    ]);

    const hostile = await fetch(
      `http://${target.host}:${target.port}/code/?folder=${encodeURIComponent("/worker/other")}&workspace=${encodeURIComponent("/worker/hostile.code-workspace")}&payload=${encodeURIComponent(JSON.stringify([["openFile", "file:///renderer/hostile.ts"]]))}&preserved=yes`,
    );
    expect(hostile.status).toBe(400);
    expect(await hostile.text()).toBe(
      "Cantrip Code rejected invalid startup selectors.",
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "code.direct.prepared",
            attachmentId: "attachment-1",
            connectionId: "connection-1",
            diagnosticTraceId,
            sessionId: "session-1",
            tunnelId,
          }),
        }),
        expect.objectContaining({
          context: expect.objectContaining({
            event: "code.direct.health-reached",
            attachmentId: "attachment-1",
            connectionId: "connection-1",
            diagnosticTraceId,
            sessionId: "session-1",
            tunnelId,
          }),
        }),
        expect.objectContaining({
          context: expect.objectContaining({
            event: "code.direct.http-upstream-responded",
            attachmentId: "attachment-1",
            connectionId: "connection-1",
            diagnosticTraceId,
            requestId: expect.any(String),
            sessionId: "session-1",
            statusCode: 200,
            tunnelId,
          }),
        }),
      ]),
    );
  });

  it("records a safe correlated reason when OpenVSCode is unreachable", async () => {
    const unavailable = createServer();
    await new Promise<void>((resolve) =>
      unavailable.listen(0, "127.0.0.1", resolve),
    );
    const port = (unavailable.address() as AddressInfo).port;
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));

    const supervisor = {
      authorizeStartupFileUri: vi.fn(async () => {
        throw new Error("The startup file is outside the workspace.");
      }),
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      proxyTarget: vi.fn(() => ({
        codeTabId: "code-2",
        connectionToken: "must-not-be-logged",
        editorOrigin: `http://127.0.0.1:${port}`,
        processInstanceId: "process-2",
        workspaceUri: "file:///worker/project.code-workspace",
      })),
    } as unknown as CodeSupervisor;
    const endpoints = new CodeDirectEndpointManager(supervisor);
    closers.push(() => endpoints.close());
    const tunnelId = crypto.randomUUID();
    const diagnosticTraceId = crypto.randomUUID();
    const records: Array<{ context?: unknown }> = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    closers.push(unsubscribe);
    const target = await endpoints.prepareProtected(tunnelId, "session-2", {
      attachmentId: "attachment-2",
      connectionId: "connection-2",
      diagnosticTraceId,
    });

    const hostilePayload = await fetch(
      `http://${target.host}:${target.port}/code/?payload=${encodeURIComponent(
        JSON.stringify([["openFile", "file:///renderer/hostile.ts"]]),
      )}`,
    );
    expect(hostilePayload.status).toBe(400);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(`http://${target.host}:${target.port}/code/`),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([
      502, 502, 502, 502,
    ]);
    await vi.waitFor(() =>
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            context: expect.objectContaining({
              event: "code.direct.http-upstream-failed",
              reasonCode: "editor-connection-error",
              attachmentId: "attachment-2",
              connectionId: "connection-2",
              diagnosticTraceId,
              requestId: expect.any(String),
              sessionId: "session-2",
              tunnelId,
            }),
          }),
        ]),
      ),
    );
    expect(
      records.filter(
        (record) =>
          (record.context as { event?: unknown } | undefined)?.event ===
          "code.direct.http-upstream-failed",
      ),
    ).toHaveLength(1);
  });

  it("rejects canonical startup-file failures before an HTTP request reaches OpenVSCode", async () => {
    let upstreamRequests = 0;
    const editor = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200).end("unexpected");
    });
    await new Promise<void>((resolve) =>
      editor.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      () => new Promise<void>((resolve) => editor.close(() => resolve())),
    );
    const port = (editor.address() as AddressInfo).port;
    const authorizeStartupFileUri = vi.fn(async () => {
      throw new Error("The startup file escaped its workspace.");
    });
    const supervisor = {
      authorizeStartupFileUri,
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      proxyTarget: vi.fn(() => ({
        codeTabId: "code-startup-rejection",
        connectionToken: "worker-local-secret",
        editorOrigin: `http://127.0.0.1:${port}`,
        initialFileUri: null,
        processInstanceId: "process-startup-rejection",
        workspaceUri: "file:///worker/project.code-workspace",
      })),
    } as unknown as CodeSupervisor;
    const endpoints = new CodeDirectEndpointManager(supervisor);
    closers.push(() => endpoints.close());
    const target = await endpoints.prepareProtected(
      crypto.randomUUID(),
      "session-startup-rejection",
    );
    const remoteAuthority = `${target.host}:${target.port}`;
    const candidates = [
      `/worker/project/%2e%2e%2foutside.ts`,
      "/worker/project/outside-link.ts",
    ];

    for (const candidate of candidates) {
      const url = new URL(`http://${remoteAuthority}/code/`);
      url.searchParams.set(
        "payload",
        JSON.stringify([
          ["openFile", `vscode-remote://${remoteAuthority}${candidate}`],
        ]),
      );
      const response = await fetch(url);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        "Cantrip Code rejected invalid startup selectors.",
      );
    }
    expect(authorizeStartupFileUri).toHaveBeenCalledTimes(2);
    expect(upstreamRequests).toBe(0);
  });

  it("does not open an upstream after shared-route revocation during startup-file authorization", async () => {
    let upstreamHttpRequests = 0;
    const editor = createServer((_request, response) => {
      upstreamHttpRequests += 1;
      response.writeHead(200).end("unexpected");
    });
    const editorWebSockets = new WebSocketServer({ server: editor });
    let upstreamWebSockets = 0;
    editorWebSockets.on("connection", () => {
      upstreamWebSockets += 1;
    });
    await new Promise<void>((resolve) =>
      editor.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of editorWebSockets.clients) socket.terminate();
          editorWebSockets.close(() => editor.close(() => resolve()));
        }),
    );
    const port = (editor.address() as AddressInfo).port;
    const pendingAuthorizations: Array<{
      requestedFileUri: string;
      resolve(value: string): void;
    }> = [];
    const authorizeStartupFileUri = vi.fn(
      async (_sessionId: string, requestedFileUri: string) =>
        await new Promise<string>((resolve) => {
          pendingAuthorizations.push({ requestedFileUri, resolve });
        }),
    );
    const endTunnelStream = vi.fn();
    const workerProcessGeneration = randomUUID();
    const serverControlPlaneGeneration = randomUUID();
    const transportId = randomUUID();
    const security = {
      ownerId: "owner-1",
      protectedKeyRevision: 1,
      serverId: "server-1",
    };
    const lifecycle = {
      ...security,
      authSessionId: "auth-session-1",
      serverControlPlaneGeneration,
      workerProcessGeneration,
    };
    const routes = ["http", "websocket"].map((kind) => ({
      attachmentId: randomUUID(),
      grant: randomBytes(32).toString("base64url"),
      incarnationId: randomUUID(),
      sessionId: `session-deferred-${kind}`,
    }));
    const bySession = new Map(routes.map((route) => [route.sessionId, route]));
    const supervisor = {
      authorizeStartupFileUri,
      beginTunnelStream: vi.fn(),
      endTunnelStream,
      status: vi.fn((sessionId: string) => ({
        sessionIncarnationId: bySession.get(sessionId)?.incarnationId,
        status: "running",
      })),
      proxyTarget: vi.fn(() => ({
        codeTabId: "code-deferred-authorization",
        connectionToken: "worker-local-secret",
        editorOrigin: `http://127.0.0.1:${port}`,
        initialFileUri: null,
        processInstanceId: "process-deferred-authorization",
        workspaceUri: "file:///worker/project.code-workspace",
      })),
    } as unknown as CodeSupervisor;
    const endpoints = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    closers.push(() => endpoints.close());
    for (const route of routes) {
      await endpoints.authorizeSharedRoute(
        {
          type: "code.transport.route.authorize",
          ...lifecycle,
          transportId,
          attachmentId: route.attachmentId,
          sessionId: route.sessionId,
          expectedSessionIncarnationId: route.incarnationId,
          routeGrant: route.grant,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        security,
      );
    }
    const target = await endpoints.prepareSharedProtected(
      transportId,
      security,
    );
    const startupUrl = (route: (typeof routes)[number], protocol: string) => {
      const authority = `${target.host}:${target.port}`;
      const url = new URL(
        `${protocol}//${authority}/sessions/${route.grant}/code/`,
      );
      url.searchParams.set(
        "payload",
        JSON.stringify([
          ["openFile", `vscode-remote://${authority}/worker/src/start.ts`],
        ]),
      );
      return url;
    };

    const httpRoute = routes[0]!;
    const downstream = requestHttp(startupUrl(httpRoute, "http:").toString());
    const downstreamClosed = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      downstream.once("close", finish);
      downstream.once("error", finish);
    });
    downstream.end();
    await vi.waitFor(() => expect(pendingAuthorizations).toHaveLength(1));
    await endpoints.revokeSharedRoute(
      {
        type: "code.transport.route.revoke",
        ...lifecycle,
        transportId,
        attachmentId: httpRoute.attachmentId,
      },
      security,
    );
    await downstreamClosed;
    pendingAuthorizations[0]!.resolve(
      pendingAuthorizations[0]!.requestedFileUri,
    );
    await vi.waitFor(() => expect(endTunnelStream).toHaveBeenCalledTimes(1));
    expect(upstreamHttpRequests).toBe(0);

    const webSocketRoute = routes[1]!;
    const client = new WebSocket(startupUrl(webSocketRoute, "ws:").toString());
    closers.push(() => client.terminate());
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    await vi.waitFor(() => expect(pendingAuthorizations).toHaveLength(2));
    const clientClosed = new Promise<number>((resolve) =>
      client.once("close", (code) => resolve(code)),
    );
    await endpoints.revokeSharedRoute(
      {
        type: "code.transport.route.revoke",
        ...lifecycle,
        transportId,
        attachmentId: webSocketRoute.attachmentId,
      },
      security,
    );
    await expect(clientClosed).resolves.toBe(1008);
    pendingAuthorizations[1]!.resolve(
      pendingAuthorizations[1]!.requestedFileUri,
    );
    await vi.waitFor(() => expect(endTunnelStream).toHaveBeenCalledTimes(2));
    expect(upstreamWebSockets).toBe(0);
    expect(upstreamHttpRequests).toBe(0);
  });

  it("destroys the OpenVSCode request when the downstream client disconnects", async () => {
    let upstreamReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      upstreamReached = resolve;
    });
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const editor = createServer((request) => {
      upstreamReached();
      request.once("close", upstreamClosed);
    });
    await new Promise<void>((resolve) =>
      editor.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      () => new Promise<void>((resolve) => editor.close(() => resolve())),
    );
    const port = (editor.address() as AddressInfo).port;
    const supervisor = {
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      proxyTarget: vi.fn(() => ({
        codeTabId: "code-abort",
        connectionToken: "abort-token-must-stay-private",
        editorOrigin: `http://127.0.0.1:${port}`,
        processInstanceId: "process-abort",
        workspaceUri: "file:///worker/project.code-workspace",
      })),
    } as unknown as CodeSupervisor;
    const endpoints = new CodeDirectEndpointManager(supervisor);
    closers.push(() => endpoints.close());
    const target = await endpoints.prepareProtected(
      crypto.randomUUID(),
      "session-abort",
    );

    const downstream = requestHttp(
      `http://${target.host}:${target.port}/code/hang`,
    );
    downstream.on("error", () => undefined);
    downstream.end();
    await reached;
    downstream.destroy();

    await closed;
    await vi.waitFor(() =>
      expect(supervisor.endTunnelStream).toHaveBeenCalledOnce(),
    );
  });

  it("bounds WebSocket success while retaining its first connection correlation", async () => {
    const editor = createServer();
    const editorWebSockets = new WebSocketServer({ server: editor });
    await new Promise<void>((resolve) =>
      editor.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of editorWebSockets.clients) socket.terminate();
          editorWebSockets.close(() => editor.close(() => resolve()));
        }),
    );
    const port = (editor.address() as AddressInfo).port;
    const supervisor = {
      authorizeStartupFileUri: vi.fn(async () => {
        throw new Error("The startup file is outside the workspace.");
      }),
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      proxyTarget: vi.fn(() => ({
        codeTabId: "code-3",
        connectionToken: "must-not-be-logged",
        editorOrigin: `http://127.0.0.1:${port}`,
        processInstanceId: "process-3",
        workspaceUri: "file:///worker/project.code-workspace",
      })),
    } as unknown as CodeSupervisor;
    const endpoints = new CodeDirectEndpointManager(supervisor);
    closers.push(() => endpoints.close());
    const tunnelId = crypto.randomUUID();
    const diagnosticTraceId = crypto.randomUUID();
    const records: Array<{ context?: unknown }> = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    closers.push(unsubscribe);
    let target = await endpoints.prepareProtected(tunnelId, "session-3", {
      attachmentId: "attachment-3",
      connectionId: "connection-1",
      diagnosticTraceId,
    });
    for (const candidate of [
      "/worker/project/%2e%2e%2foutside.ts",
      "/worker/project/outside-link.ts",
    ]) {
      const rejected = new WebSocket(
        `ws://${target.host}:${target.port}/code/?payload=${encodeURIComponent(
          JSON.stringify([
            [
              "openFile",
              `vscode-remote://${target.host}:${target.port}${candidate}`,
            ],
          ]),
        )}`,
      );
      closers.push(() => rejected.terminate());
      await expect(
        new Promise<number>((resolve, reject) => {
          rejected.once("close", resolve);
          rejected.once("error", reject);
        }),
      ).resolves.toBe(1008);
    }
    expect(editorWebSockets.clients.size).toBe(0);
    for (let index = 1; index <= 4; index += 1) {
      if (index > 1) {
        target = await endpoints.prepareProtected(tunnelId, "session-3", {
          attachmentId: "attachment-3",
          connectionId: `connection-${index}`,
          diagnosticTraceId,
        });
      }
      const client = new WebSocket(`ws://${target.host}:${target.port}/code/`);
      closers.push(() => client.terminate());
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
    }
    await vi.waitFor(() =>
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            context: expect.objectContaining({
              event: "code.direct.websocket-opened",
              attachmentId: "attachment-3",
              connectionId: "connection-1",
              diagnosticTraceId,
              sessionId: "session-3",
              tunnelId,
            }),
          }),
        ]),
      ),
    );
    expect(
      records.filter(
        (record) =>
          (record.context as { event?: unknown } | undefined)?.event ===
          "code.direct.websocket-opened",
      ),
    ).toHaveLength(1);
  });

  it("isolates shared-route HTTP and WebSockets on one physical endpoint", async () => {
    const observed: Array<{
      cookie: string | undefined;
      url: string | undefined;
    }> = [];
    let hangingRequestReached!: () => void;
    const hangingReached = new Promise<void>((resolve) => {
      hangingRequestReached = resolve;
    });
    let hangingRequestClosed!: () => void;
    const hangingClosed = new Promise<void>((resolve) => {
      hangingRequestClosed = resolve;
    });
    const editor = createServer((request, response) => {
      observed.push({ cookie: request.headers.cookie, url: request.url });
      if (request.url === "/hang") {
        hangingRequestReached();
        request.once("close", hangingRequestClosed);
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("editor-ready");
    });
    const editorWebSockets = new WebSocketServer({ server: editor });
    await new Promise<void>((resolve) =>
      editor.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of editorWebSockets.clients) socket.terminate();
          editorWebSockets.close(() => editor.close(() => resolve()));
        }),
    );
    const port = (editor.address() as AddressInfo).port;
    const workerProcessGeneration = randomUUID();
    const serverControlPlaneGeneration = randomUUID();
    const transportId = randomUUID();
    const sessions = [
      {
        attachmentId: randomUUID(),
        grant: randomBytes(32).toString("base64url"),
        incarnationId: randomUUID(),
        initialFileUri: "file:///worker/a/src/start.ts",
        sessionId: randomUUID(),
        token: "route-a-token",
        workspace: "/worker/a.code-workspace",
      },
      {
        attachmentId: randomUUID(),
        grant: randomBytes(32).toString("base64url"),
        incarnationId: randomUUID(),
        initialFileUri: null,
        sessionId: randomUUID(),
        token: "route-b-token",
        workspace: "/worker/b.code-workspace",
      },
    ];
    const bySession = new Map(
      sessions.map((session) => [session.sessionId, session]),
    );
    const supervisor = {
      authorizeStartupFileUri: vi.fn(
        async (_sessionId: string, requestedFileUri: string) =>
          requestedFileUri,
      ),
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      status: vi.fn((sessionId: string) => ({
        initialFileUri: bySession.get(sessionId)?.initialFileUri ?? null,
        status: "running",
        sessionIncarnationId: bySession.get(sessionId)?.incarnationId,
      })),
      proxyTarget: vi.fn((sessionId: string) => {
        const session = bySession.get(sessionId)!;
        return {
          codeTabId: sessionId,
          connectionToken: session.token,
          editorOrigin: `http://127.0.0.1:${port}`,
          initialFileUri: session.initialFileUri,
          processInstanceId: "process-1",
          workspaceUri: `file://${session.workspace}`,
        };
      }),
    } as unknown as CodeSupervisor;
    const endpoints = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    closers.push(() => endpoints.close());
    const security = {
      ownerId: "owner-1",
      protectedKeyRevision: 1,
      serverId: "server-1",
    };
    const lifecycle = {
      ...security,
      authSessionId: "auth-session-1",
      serverControlPlaneGeneration,
      workerProcessGeneration,
    };
    const firstAttachmentInitialFileUri = sessions[0]!.initialFileUri;
    sessions[0]!.initialFileUri = "file:///worker/a/src/later.ts";
    for (const session of sessions) {
      await endpoints.authorizeSharedRoute(
        {
          type: "code.transport.route.authorize",
          ...lifecycle,
          transportId,
          attachmentId: session.attachmentId,
          sessionId: session.sessionId,
          expectedSessionIncarnationId: session.incarnationId,
          routeGrant: session.grant,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        security,
      );
    }
    const target = await endpoints.prepareSharedProtected(
      transportId,
      security,
    );
    const publicSessionUrl = (
      session: (typeof sessions)[number],
      initialFileUri = session.initialFileUri,
    ) => {
      const url = new URL(
        `http://${target.host}:${target.port}/sessions/${session.grant}/code/`,
      );
      url.searchParams.set("workspace", session.workspace);
      if (initialFileUri) {
        const initialFile = new URL(initialFileUri);
        url.searchParams.set(
          "payload",
          JSON.stringify([
            [
              "openFile",
              `vscode-remote://${target.host}:${target.port}${initialFile.pathname}`,
            ],
          ]),
        );
      }
      return url;
    };
    const firstAttachmentUrl = publicSessionUrl(
      sessions[0]!,
      firstAttachmentInitialFileUri,
    ).toString();
    const requestText = (url: string) =>
      new Promise<string>((resolve, reject) => {
        const request = requestHttp(url, { agent: false }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () =>
            resolve(Buffer.concat(chunks).toString("utf8")),
          );
          response.once("error", reject);
        });
        request.once("error", reject);
        request.end();
      });
    for (const [index, session] of sessions.entries()) {
      const response = await fetch(
        index === 0 ? firstAttachmentUrl : publicSessionUrl(session),
      );
      expect(await response.text()).toBe("editor-ready");
      expect(response.redirected).toBe(false);
    }
    expect(observed).toHaveLength(2);
    expect(observed[0]?.cookie).toBe("vscode-tkn=route-a-token");
    const firstSharedRequest = new URL(
      observed[0]?.url ?? "",
      "http://editor.invalid",
    );
    expect(firstSharedRequest.searchParams.get("workspace")).toBe(
      "/worker/a.code-workspace",
    );
    expect(JSON.parse(firstSharedRequest.searchParams.get("payload")!)).toEqual(
      [
        [
          "openFile",
          `vscode-remote://${target.host}:${target.port}/worker/a/src/start.ts`,
        ],
      ],
    );
    expect(observed[1]).toEqual({
      cookie: "vscode-tkn=route-b-token",
      url: "/?workspace=%2Fworker%2Fb.code-workspace",
    });
    const reloaded = await fetch(firstAttachmentUrl);
    expect(await reloaded.text()).toBe("editor-ready");
    expect(
      JSON.parse(
        new URL(
          observed[2]?.url ?? "",
          "http://editor.invalid",
        ).searchParams.get("payload")!,
      ),
    ).toEqual([
      [
        "openFile",
        `vscode-remote://${target.host}:${target.port}/worker/a/src/start.ts`,
      ],
    ]);
    expect(JSON.stringify(observed)).not.toContain(sessions[0]!.grant);

    const partialControl = requestHttp(
      `http://${target.host}:${target.port}/sessions/${sessions[0]!.grant}/code/_cantrip/open-file`,
      {
        headers: {
          "content-length": "128",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    const partialControlClosed = new Promise<void>((resolve) => {
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        resolve();
      };
      partialControl.once("close", finish);
      partialControl.once("error", finish);
    });
    partialControl.write('{"relativePath":"src/partial');
    await new Promise((resolve) => setTimeout(resolve, 25));

    const hanging = requestHttp(
      `http://${target.host}:${target.port}/sessions/${sessions[0]!.grant}/code/hang`,
    );
    const hangingDownstreamClosed = new Promise<void>((resolve) => {
      hanging.once("error", () => resolve());
    });
    hanging.end();
    await hangingReached;
    const siblingWhileHanging = await requestText(
      publicSessionUrl(sessions[1]!).toString(),
    );
    expect(siblingWhileHanging).toBe("editor-ready");

    const clients = sessions.map(
      (session) =>
        new WebSocket(
          `ws://${target.host}:${target.port}/sessions/${session.grant}/code/`,
        ),
    );
    for (const client of clients) {
      closers.push(() => client.terminate());
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
    }
    const firstClosed = new Promise<number>((resolve) =>
      clients[0]!.once("close", (code) => resolve(code)),
    );
    await endpoints.revokeSharedRoute(
      {
        type: "code.transport.route.revoke",
        ...lifecycle,
        transportId,
        attachmentId: sessions[0]!.attachmentId,
      },
      security,
    );
    await expect(firstClosed).resolves.toBe(1008);
    await partialControlClosed;
    await hangingClosed;
    await hangingDownstreamClosed;
    await vi.waitFor(() => expect(editorWebSockets.clients.size).toBe(1), {
      timeout: 2_000,
    });
    expect(clients[1]!.readyState).toBe(WebSocket.OPEN);
    const surviving = await requestText(
      publicSessionUrl(sessions[1]!).toString(),
    );
    expect(surviving).toBe("editor-ready");
    const unknown = await fetch(
      `http://${target.host}:${target.port}/sessions/${randomBytes(32).toString("base64url")}/code/`,
    );
    expect(unknown.status).toBe(404);
  });
});
