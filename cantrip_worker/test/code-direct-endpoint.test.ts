import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeDirectEndpointManager } from "../src/code/direct-endpoint.js";
import type { CodeSupervisor } from "../src/code/supervisor.js";

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
    const target = await endpoints.prepare(crypto.randomUUID(), "session-1");

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
  });
});
