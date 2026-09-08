import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import type {
  McpServerConfiguration,
  McpServerOpaqueRuntime,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServer } from "../src/codex/app-server.js";
import { ManagedSessionCoordinator } from "../src/codex/managed-session.js";
import { withManagedSessionMcpServers } from "../src/codex/managed-session-mcp.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-managed-mcp-"),
  );
  directories.push(directory);
  const runtime = new CodexAppServer(
    "/unused/codex",
    directory,
    directory,
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    ensureStarted(): Promise<void>;
    methodAvailable(method: string): boolean;
    request(method: string, params: unknown): Promise<unknown>;
  };
  native.ensureStarted = vi.fn().mockResolvedValue(undefined);
  native.methodAvailable = () => true;
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: "native-thread" } };
    if (method === "thread/managedConfig/update")
      return { threadId: "native-thread", applied: true };
    if (method === "collaborationMode/list")
      return { data: [{ mode: "default" }] };
    return {};
  });
  native.request = request;
  const resolve = vi.fn(
    async (
      _configured: McpServerOpaqueRuntime[],
    ): Promise<McpServerConfiguration[]> => [],
  );
  const prepare = async (
    threadId: string | null,
    mcpServers?: McpServerOpaqueRuntime[],
  ) => {
    const result = await new ManagedSessionCoordinator(
      path.join(directory, "sessions"),
    ).prepare({
      identity: {
        serverId: "server",
        ownerId: "owner",
        workerId: "worker",
        chatId: "chat",
        placementId: "worktree",
        projectId: "project",
        contextKind: "project",
      },
      runtime: withManagedSessionMcpServers(runtime, mcpServers, resolve),
      configuration: {
        cwd: directory,
        threadId,
        intent: "preserve",
        executionProfile: "ide",
        model: {
          id: "model",
          routeId: "route",
          name: "gpt-5.6-sol",
          reasoningEffort: null,
        },
        provider: {
          id: "provider",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: null,
        },
        permissionProfileId: ":workspace",
        planMode: "default",
        subagentDefaults: null,
        mcpServers: undefined,
      },
    });
    return result;
  };
  return { request, resolve, prepare, runtime };
}

describe("managed attachment MCP omission", () => {
  it("preserves omitted MCP configuration on a prepared thread recovered from the journal", async () => {
    const { request, resolve, prepare, runtime } = await fixture();
    await prepare(null);
    runtime.close();
    request.mockClear();
    resolve.mockClear();
    // Each call constructs a fresh coordinator, so this identity comes from disk.
    const result = await prepare(null);
    expect(result.threadId).toBe("native-thread");
    expect(resolve).not.toHaveBeenCalled();
    expect(request.mock.calls).toEqual([
      ["thread/resume", { threadId: "native-thread" }],
    ]);
  });

  it("preserves an existing thread without resolving or replacing omitted MCP configuration", async () => {
    const { request, resolve, prepare } = await fixture();
    const result = await prepare("native-thread");
    expect(result.threadId).toBe("native-thread");
    expect(resolve).not.toHaveBeenCalled();
    expect(request.mock.calls).toEqual([
      ["thread/resume", { threadId: "native-thread" }],
    ]);
  });

  it("applies an explicit empty list as an exact replacement", async () => {
    const { request, resolve, prepare } = await fixture();
    await prepare("native-thread", []);
    expect(resolve).toHaveBeenCalledExactlyOnceWith([]);
    expect(request).toHaveBeenCalledWith(
      "thread/managedConfig/update",
      expect.objectContaining({ threadId: "native-thread", mcpServers: {} }),
    );
    expect(request).not.toHaveBeenCalledWith(
      "thread/settings/update",
      expect.anything(),
    );
  });

  it("fully configures a new unbound session when its first view omits MCP configuration", async () => {
    const { request, resolve, prepare } = await fixture();
    const result = await prepare(null);
    expect(result.threadId).toBe("native-thread");
    expect(resolve).toHaveBeenCalledExactlyOnceWith([]);
    expect(request).toHaveBeenCalledWith("thread/start", expect.anything());
    expect(request).toHaveBeenCalledWith(
      "thread/managedConfig/update",
      expect.objectContaining({ mcpServers: {} }),
    );
    expect(request).toHaveBeenCalledWith(
      "thread/settings/update",
      expect.anything(),
    );
  });
});
