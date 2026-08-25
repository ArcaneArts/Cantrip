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
    const supervisor = {
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      proxyTarget: vi.fn(() => ({
        codeTabId: "code-1",
        connectionToken: "worker-local-secret",
        editorOrigin: `http://127.0.0.1:${port}`,
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

    const response = await fetch(`http://${target.host}:${target.port}/code/`, {
      headers: {
        authorization: "Bearer must-not-reach-worker",
        cookie: "app-session=must-not-reach-worker",
      },
    });
    expect(await response.text()).toBe("editor-ready");
    expect(observed?.url).toBe(
      "/?workspace=%2Fworker%2Fproject.code-workspace",
    );
    expect(observed?.headers.cookie).toBe("vscode-tkn=worker-local-secret");
    expect(observed?.headers.authorization).toBeUndefined();
    expect(observed?.headers.host).toBe(`127.0.0.1:${port}`);
    expect(observed?.headers["x-forwarded-host"]).toBe(
      `${target.host}:${target.port}`,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "tauri://localhost",
    );

    const hostile = await fetch(
      `http://${target.host}:${target.port}/code/?folder=${encodeURIComponent("/worker/other")}&workspace=${encodeURIComponent("/worker/hostile.code-workspace")}&preserved=yes`,
    );
    expect(await hostile.text()).toBe("editor-ready");
    expect(observed?.url).toBe(
      "/?preserved=yes&workspace=%2Fworker%2Fproject.code-workspace",
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
        sessionId: randomUUID(),
        token: "route-a-token",
        workspace: "/worker/a.code-workspace",
      },
      {
        attachmentId: randomUUID(),
        grant: randomBytes(32).toString("base64url"),
        incarnationId: randomUUID(),
        sessionId: randomUUID(),
        token: "route-b-token",
        workspace: "/worker/b.code-workspace",
      },
    ];
    const bySession = new Map(
      sessions.map((session) => [session.sessionId, session]),
    );
    const supervisor = {
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      status: vi.fn((sessionId: string) => ({
        status: "running",
        sessionIncarnationId: bySession.get(sessionId)?.incarnationId,
      })),
      proxyTarget: vi.fn((sessionId: string) => {
        const session = bySession.get(sessionId)!;
        return {
          codeTabId: sessionId,
          connectionToken: session.token,
          editorOrigin: `http://127.0.0.1:${port}`,
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
    for (const session of sessions) {
      const response = await fetch(
        `http://${target.host}:${target.port}/sessions/${session.grant}/code/`,
      );
      expect(await response.text()).toBe("editor-ready");
    }
    expect(observed).toEqual([
      {
        cookie: "vscode-tkn=route-a-token",
        url: "/?workspace=%2Fworker%2Fa.code-workspace",
      },
      {
        cookie: "vscode-tkn=route-b-token",
        url: "/?workspace=%2Fworker%2Fb.code-workspace",
      },
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
      `http://${target.host}:${target.port}/sessions/${sessions[1]!.grant}/code/`,
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
      `http://${target.host}:${target.port}/sessions/${sessions[1]!.grant}/code/`,
    );
    expect(surviving).toBe("editor-ready");
    const unknown = await fetch(
      `http://${target.host}:${target.port}/sessions/${randomBytes(32).toString("base64url")}/code/`,
    );
    expect(unknown.status).toBe(404);
  });
});
