import { afterEach, describe, expect, it, vi } from "vitest";

import { invokeCantripWorktreeTool } from "../src/codex/worktree-tool-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("invokeCantripWorktreeTool", () => {
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
