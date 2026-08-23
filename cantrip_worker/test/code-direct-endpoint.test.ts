import { createServer, type IncomingMessage } from "node:http";
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
});
