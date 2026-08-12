import { afterEach, describe, expect, it, vi } from "vitest";

import {
  invokeCantripExecutionTool,
  invokeCantripWorktreeTool,
} from "../src/codex/worktree-tool-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("invokeCantripWorktreeTool", () => {
  it("routes generalized execution tools through the lane-authenticated endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: "Terminal is running.",
            target: {
              kind: "surface",
              projectId: "project-1",
              surfaceKind: "terminal",
              surfaceId: "terminal-2",
            },
            data: { status: "running", data: "ready" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invokeCantripExecutionTool({
        arguments: {
          target: {
            kind: "surface",
            projectId: "project-1",
            surfaceKind: "terminal",
            surfaceId: "terminal-2",
          },
        },
        callId: "call-target-1",
        chatId: "chat-1",
        executionLaneId: "lane-1",
        serverUrl: "http://127.0.0.1:4310",
        token: "secret",
        tool: "cantrip_terminal_read",
        workerId: "worker-1",
      }),
    ).resolves.toMatchObject({ summary: "Terminal is running." });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:4310/api/internal/agent-tools/execution",
    );
  });

  it("keeps worktree operations on their compatibility endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: "Found 1 validated worktree.",
            worktreeId: "primary-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await invokeCantripExecutionTool({
      arguments: {},
      callId: "call-worktree-generic",
      chatId: "chat-1",
      executionLaneId: "lane-1",
      serverUrl: "http://127.0.0.1:4310",
      token: "secret",
      tool: "cantrip_worktrees_list",
      workerId: "worker-1",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:4310/api/internal/agent-tools/worktree",
    );
  });

  it("authenticates and scopes an agent tool call to its active lane", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: "Found 2 validated worktrees.",
            worktreeId: "primary-1",
            continuationScheduled: false,
            data: { worktrees: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invokeCantripWorktreeTool({
        arguments: {},
        callId: "call-1",
        chatId: "chat-1",
        executionLaneId: "lane-1",
        serverUrl: "http://127.0.0.1:4310",
        token: "secret",
        tool: "cantrip_worktrees_list",
        workerId: "worker-1",
      }),
    ).resolves.toMatchObject({
      summary: "Found 2 validated worktrees.",
      worktreeId: "primary-1",
    });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://127.0.0.1:4310/api/internal/agent-tools/worktree",
    );
    expect(request?.headers).toMatchObject({
      authorization: "Bearer secret",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      callId: "call-1",
      chatId: "chat-1",
      executionLaneId: "lane-1",
      workerId: "worker-1",
      tool: "cantrip_worktrees_list",
    });
  });

  it("surfaces server safety errors to the Codex tool response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Worktree is dirty." }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      invokeCantripWorktreeTool({
        arguments: { purpose: "Done" },
        callId: "call-2",
        chatId: "chat-1",
        executionLaneId: "lane-1",
        serverUrl: "http://127.0.0.1:4310",
        token: "secret",
        tool: "cantrip_worktree_release",
        workerId: "worker-1",
      }),
    ).rejects.toThrow("Worktree is dirty.");
  });
});
