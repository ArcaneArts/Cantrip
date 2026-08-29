import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CANTRIP_MCP_TOOL_NAMES,
  agentFilePreviewLimitCharacters,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";

import {
  CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS,
  CANTRIP_DYNAMIC_TOOLS_OVERRIDE,
  NON_GIT_WORKSPACE_DEVELOPER_INSTRUCTIONS,
  STANDALONE_CHAT_DEVELOPER_INSTRUCTIONS,
  cantripChatThreadParams,
  agentInteractionRequestFromServerRequest,
  appendBoundedCommandOutput,
  boundedCommandOutput,
  changedLinesPreview,
  changedFiles,
  chatTurnRollbackBoundary,
  codexChatApprovalPolicy,
  codexChatThreadSecurityParams,
  codexResultForAgentInteraction,
  CodexAppServer,
  CodexExternalThreadChangeCoalescer,
  codexEndpointFromLine,
  codexReasoningEffortParams,
  codexStartupExitMessage,
  codexMcpConfigOverride,
  codexModelProviderName,
  codexNativeSubagentConfigOverride,
  codexThreadPermissionParams,
  codexWorkflowTurnPolicy,
  codexWorktreeTurnPolicy,
  codexWorkspaceContext,
  commandTelemetryFromCompletion,
  commandTelemetryFromDelta,
  commandTelemetryFromStart,
  completedActivityTimestamps,
  completedCodexThreadTurnFromRead,
  failClosedAgentInteractionReply,
  findActiveChatTurn,
  goalShouldContinue,
  isKnownCodexNotificationMethod,
  normalizeAgentMessage,
  normalizeCodexThreadTurn,
  normalizeCodexThreadItem,
  normalizeNoticeActivity,
  normalizeRateLimitActivity,
  normalizeStreamingAgentMessage,
  normalizeTokenUsageActivity,
  latestChangedLine,
  managedMcpToolRequirements,
  measureCodexProfileFootprint,
  parseCodexRpcMessage,
  parseCodexSkills,
  parsePermissionProfileList,
  parseWorkflowStructuredResult,
  planQuestionId,
  flushStagedAgentMessage,
  stageAgentMessage,
  workflowMeasuredUsage,
  workflowDeveloperInstructions,
  workspaceSnapshotFromPorcelainRecords,
  workspaceHasGitMetadata,
} from "../src/codex/app-server.js";

describe("external Codex thread change coalescing", () => {
  it("emits one bounded metadata-only revision for a noisy thread burst", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    try {
      const observed: Array<{
        changes: string[];
        revision: number;
        threadId: string;
      }> = [];
      const coalescer = new CodexExternalThreadChangeCoalescer(
        (change) => observed.push(change),
        50,
      );

      coalescer.observe("thread-1", "turn");
      coalescer.observe("thread-1", "turn");
      coalescer.observe("thread-1", "goal");
      vi.advanceTimersByTime(49);
      expect(observed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(observed).toEqual([
        {
          changes: ["turn", "goal"],
          revision: expect.any(Number),
          threadId: "thread-1",
        },
      ]);

      coalescer.observe("thread-1", "queue");
      vi.advanceTimersByTime(50);
      expect(observed[1]?.revision).toBeGreaterThan(observed[0]!.revision);
      expect(Object.keys(observed[0]!)).toEqual([
        "changes",
        "revision",
        "threadId",
      ]);
      coalescer.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("active chat turn selection", () => {
  it("finds a live first turn by chat ID before its thread ID is persisted", () => {
    const turns = new Map([
      [
        "turn-stale",
        {
          chatId: "chat-stale",
          executionKind: "chat" as const,
          threadId: "thread-stale",
        },
      ],
      [
        "turn-live",
        {
          chatId: "chat-live",
          executionKind: "chat" as const,
          threadId: "thread-live",
        },
      ],
    ]);

    expect(findActiveChatTurn(turns, "chat-live", null)?.[0]).toBe("turn-live");
    expect(findActiveChatTurn(turns, "chat-live", "thread-stale")?.[0]).toBe(
      "turn-live",
    );
  });
});

describe("chat turn rollback selection", () => {
  it("rewinds the matching Cantrip turn and every automatic turn after it", () => {
    expect(
      chatTurnRollbackBoundary(
        [
          {
            id: "turn-before",
            items: [
              { type: "userMessage", clientId: "cantrip:message-before" },
            ],
          },
          {
            id: "turn-edited",
            items: [
              { type: "userMessage", clientId: "cantrip:message-edited" },
            ],
          },
          { id: "turn-goal-continuation", items: [] },
        ],
        "message-edited",
      ),
    ).toEqual({ numTurns: 2, turnId: "turn-edited" });
  });

  it("does not guess when the persisted turn lacks the message identity", () => {
    expect(
      chatTurnRollbackBoundary(
        [{ id: "turn-other", items: [{ type: "userMessage" }] }],
        "message-edited",
      ),
    ).toBeNull();
  });
});

const correlation = {
  sourceMethod: "item/completed",
  diagnosticId: "runtime-session:12",
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
};

describe("Codex rich event normalization", () => {
  it("keeps streamed agent text provisional until the turn completes", () => {
    expect(
      normalizeStreamingAgentMessage({
        id: "message-streaming",
        text: "I’ll inspect one more file.",
        correlation: { ...correlation, itemId: "message-streaming" },
      }),
    ).toMatchObject({
      id: "message-streaming",
      phase: "commentary",
      streaming: true,
    });
  });

  it("recovers final messages and commands from an authoritative completed turn", () => {
    const turn = completedCodexThreadTurnFromRead(
      {
        thread: {
          id: "thread-1",
          turns: [
            {
              id: "turn-1",
              status: "completed",
              error: null,
              startedAt: 1_000,
              completedAt: 2_000,
              durationMs: 1_000,
              items: [
                {
                  type: "commandExecution",
                  id: "command-1",
                  command: "pwd",
                  cwd: "/workspace",
                  status: "completed",
                  aggregatedOutput: "/workspace\n",
                  exitCode: 0,
                  durationMs: 25,
                },
                {
                  type: "agentMessage",
                  id: "message-1",
                  text: "1",
                  phase: "final_answer",
                },
              ],
            },
          ],
        },
      },
      "/workspace",
      "turn-1",
    );

    expect(turn?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "activity",
          activity: expect.objectContaining({
            type: "command",
            id: "command-1",
            output: "/workspace\n",
          }),
        }),
        expect.objectContaining({
          type: "agentMessage",
          id: "message-1",
          text: "1",
        }),
      ]),
    );
  });

  it("retains a strict rolling 256 KiB UTF-8 command tail", () => {
    const exact = boundedCommandOutput("🙂".repeat(65_536));
    expect(Buffer.byteLength(exact.output!, "utf8")).toBe(256 * 1_024);
    expect(exact.truncated).toBe(false);

    const truncated = appendBoundedCommandOutput(exact, "tail🙂");
    expect(Buffer.byteLength(truncated.output!, "utf8")).toBeLessThanOrEqual(
      256 * 1_024,
    );
    expect(truncated.output).toMatch(/tail🙂$/u);
    expect(truncated.output).not.toContain("�");
    expect(truncated.truncated).toBe(true);

    const continued = appendBoundedCommandOutput(truncated, "\nnew output");
    expect(continued.output).toMatch(/tail🙂\nnew output$/u);
    expect(Buffer.byteLength(continued.output!, "utf8")).toBeLessThanOrEqual(
      256 * 1_024,
    );

    const sanitized = boundedCommandOutput(
      "\u001b[31mred\u001b[0m\u0000\u0007\nnext\tcolumn",
    );
    expect(sanitized).toEqual({
      output: "red\nnext\tcolumn",
      truncated: false,
    });
  });

  it("reconciles output deltas that arrive before start and completion", () => {
    const early = commandTelemetryFromDelta(null, "early", 1_100);
    const started = commandTelemetryFromStart(early, null, 1_000, 1_200);
    const running = commandTelemetryFromDelta(started, " output", 1_300);
    const completed = commandTelemetryFromCompletion(running, null, 300, 1_400);
    expect(completed).toEqual({
      output: "early output",
      truncated: false,
      startedAtMs: 1_000,
      updatedAtMs: 1_400,
    });

    expect(commandTelemetryFromCompletion(null, "done", 250, 2_000)).toEqual({
      output: "done",
      truncated: false,
      startedAtMs: 1_750,
      updatedAtMs: 2_000,
    });
  });

  it("prefers authoritative completion output after malformed delta ordering", () => {
    const pending = commandTelemetryFromDelta(null, "partial", 1_000);
    expect(
      commandTelemetryFromCompletion(pending, "complete output", 50, 1_100),
    ).toMatchObject({
      output: "complete output",
      truncated: false,
      startedAtMs: 1_000,
    });
  });

  it("keeps supported reasoning summaries and drops private reasoning content", () => {
    const activity = normalizeCodexThreadItem(
      {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["Compared the runtime capabilities."],
        content: ["unsupported private chain of thought"],
      },
      "/workspace",
      "completed",
      { ...correlation, itemId: "reasoning-1" },
    );

    expect(activity).toEqual(
      expect.objectContaining({
        type: "reasoning",
        status: "completed",
        summary: ["Compared the runtime capabilities."],
      }),
    );
    expect(activity).not.toHaveProperty("content");
  });

  it("captures redacted raw diagnostics only when protected capture is enabled", () => {
    const item = {
      type: "mcpToolCall" as const,
      id: "mcp-protected-1",
      server: "example",
      tool: "lookup",
      status: "completed" as const,
      arguments: {
        Authorization: "Bearer private-token",
        query: "safe query",
      },
      result: { content: [{ type: "text", text: "safe result" }] },
      error: null,
      durationMs: 12,
    };
    const protectedActivity = normalizeCodexThreadItem(
      item,
      "/workspace",
      "completed",
      { ...correlation, itemId: item.id },
      { captureRaw: true },
    );
    expect(protectedActivity?.raw).toMatchObject({ schemaVersion: 1 });
    expect(JSON.stringify(protectedActivity?.raw)).toContain("safe query");
    expect(JSON.stringify(protectedActivity?.raw)).toContain("safe result");
    expect(JSON.stringify(protectedActivity?.raw)).not.toContain(
      "private-token",
    );

    expect(
      normalizeCodexThreadItem(item, "/workspace", "completed", {
        ...correlation,
        itemId: item.id,
      }),
    ).not.toHaveProperty("raw");
  });

  it("extracts bounded failures from every MCP server result shape", () => {
    const validation = normalizeCodexThreadItem(
      {
        type: "mcpToolCall",
        id: "mcp-validation",
        server: "cantrip",
        tool: "worktree_create",
        status: "failed",
        arguments: { from: "main" },
        result: {
          content: [
            {
              type: "text",
              text: "MCP error -32602: Input validation error: Unrecognized key: from",
            },
          ],
          structuredContent: null,
        },
        error: { message: "MCP tool call failed." },
        durationMs: null,
      },
      "/workspace",
      "completed",
      { ...correlation, itemId: "mcp-validation" },
    );
    expect(validation).toMatchObject({
      type: "mcpToolCall",
      status: "failed",
      server: "cantrip",
      tool: "worktree_create",
      error: "MCP error -32602: Input validation error: Unrecognized key: from",
      errorCode: "-32602",
      retryable: null,
      resultText: null,
    });

    const stale = normalizeCodexThreadItem(
      {
        type: "mcpToolCall",
        id: "mcp-stale",
        server: "another-server",
        tool: "mutate",
        status: "failed",
        arguments: {},
        result: {
          content: [],
          structuredContent: {
            error: {
              code: "stale-binding",
              message: "Refresh the binding before another mutation.",
              retryable: false,
            },
          },
        },
        error: null,
        durationMs: 3,
      },
      "/workspace",
      "completed",
      { ...correlation, itemId: "mcp-stale" },
    );
    expect(stale).toMatchObject({
      error: "Refresh the binding before another mutation.",
      errorCode: "stale-binding",
      retryable: false,
    });

    const wrapped = normalizeCodexThreadItem(
      {
        type: "mcpToolCall",
        id: "mcp-wrapped",
        server: "cantrip",
        tool: "worktree_create",
        status: "failed",
        arguments: {},
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: null,
                result: {
                  content: [
                    {
                      type: "text",
                      text: "The MCP binding no longer matches the active lane.",
                    },
                  ],
                },
                status: "failed",
              }),
            },
          ],
        },
        error: null,
        durationMs: null,
      },
      "/workspace",
      "completed",
      { ...correlation, itemId: "mcp-wrapped" },
    );
    expect(wrapped).toMatchObject({
      error: "The MCP binding no longer matches the active lane.",
    });

    const bounded = normalizeCodexThreadItem(
      {
        type: "mcpToolCall",
        id: "mcp-bounded",
        server: "cantrip",
        tool: "failure",
        status: "failed",
        arguments: {},
        result: {
          content: [
            {
              type: "text",
              text: `token=private-value ${"x".repeat(8_000)}`,
            },
          ],
        },
        error: null,
        durationMs: null,
      },
      "/workspace",
      "completed",
      { ...correlation, itemId: "mcp-bounded" },
    );
    expect(bounded?.type).toBe("mcpToolCall");
    if (bounded?.type !== "mcpToolCall") throw new Error("Expected MCP call.");
    expect(bounded.error).toContain("token=[REDACTED]");
    expect(bounded.error).not.toContain("private-value");
    expect(bounded.error!.length).toBeLessThan(4_100);

    const successful = normalizeCodexThreadItem(
      {
        type: "mcpToolCall",
        id: "mcp-success",
        server: "cantrip",
        tool: "context_get",
        status: "completed",
        arguments: {},
        result: {
          content: [{ type: "text", text: "private success payload" }],
        },
        error: null,
        durationMs: 1,
      },
      "/workspace",
      "completed",
      { ...correlation, itemId: "mcp-success" },
    );
    expect(successful).toMatchObject({ error: null, resultText: null });
  });

  it("does not invent an exact item start from a completion observation", () => {
    expect(completedActivityTimestamps(null, 2_000)).toEqual({
      updatedAtMs: 2_000,
      completedAtMs: 2_000,
    });
    expect(completedActivityTimestamps(1_750, 2_000)).toEqual({
      startedAtMs: 1_750,
      updatedAtMs: 2_000,
      completedAtMs: 2_000,
    });
  });

  it("normalizes tools, subagents, web, images, review, and compaction", () => {
    const items = [
      {
        type: "mcpToolCall" as const,
        id: "mcp-1",
        server: "codegraph",
        tool: "codegraph_explore",
        status: "completed" as const,
        arguments: { query: "worker timeout" },
        result: {
          content: [{ type: "text", text: "Found two matching issues." }],
          structuredContent: null,
        },
        error: null,
        durationMs: 125,
      },
      {
        type: "dynamicToolCall" as const,
        id: "dynamic-1",
        namespace: "cantrip",
        tool: "worktree_status",
        status: "completed" as const,
        success: true,
        durationMs: 25,
      },
      {
        type: "collabAgentToolCall" as const,
        id: "collab-1",
        tool: "spawnAgent",
        status: "inProgress" as const,
        senderThreadId: "thread-1",
        receiverThreadIds: ["thread-2"],
        prompt: "Inspect the worker bridge.",
        model: "gpt-5.6-sol",
        agentsStates: {
          "thread-2": { status: "running", message: "Inspecting." },
        },
      },
      {
        type: "subAgentActivity" as const,
        id: "subagent-1",
        kind: "started" as const,
        agentThreadId: "thread-2",
        agentPath: "/root/reviewer",
      },
      {
        type: "webSearch" as const,
        id: "search-1",
        query: "Codex App Server events",
        action: { type: "search", queries: ["Codex event schema"] },
      },
      {
        type: "imageView" as const,
        id: "image-1",
        path: "/workspace/screenshots/app.png",
      },
      {
        type: "enteredReviewMode" as const,
        id: "review-1",
        review: "Review the current diff.",
      },
      { type: "contextCompaction" as const, id: "compact-1" },
    ];

    const normalized = items.map((item) =>
      normalizeCodexThreadItem(
        item,
        "/workspace",
        "completed",
        {
          ...correlation,
          itemId: item.id,
        },
        {
          startedAtMs: 1_000,
          updatedAtMs: 1_200,
          completedAtMs: 1_200,
        },
      ),
    );
    expect(normalized.map((activity) => activity?.type)).toEqual([
      "mcpToolCall",
      "dynamicToolCall",
      "collabToolCall",
      "subAgent",
      "webSearch",
      "imageView",
      "reviewMode",
      "contextCompaction",
    ]);
    for (const activity of normalized) {
      expect(activity).toMatchObject({
        startedAtMs: 1_000,
        updatedAtMs: 1_200,
        completedAtMs: 1_200,
      });
    }
    expect(
      normalizeCodexThreadItem(items[2]!, "/workspace", "completed", {
        ...correlation,
        itemId: "collab-1",
      }),
    ).toMatchObject({
      type: "collabToolCall",
      prompt: "Inspect the worker bridge.",
    });
    expect(
      normalizeCodexThreadItem(items[0]!, "/workspace", "completed", {
        ...correlation,
        itemId: "mcp-1",
      }),
    ).toMatchObject({
      type: "mcpToolCall",
      query: "worker timeout",
      resultText: "Found two matching issues.",
    });
    expect(
      normalizeCodexThreadItem(
        {
          type: "webSearch",
          id: "open-1",
          query: "",
          action: {
            type: "open_page",
            url: "https://user:secret@example.com/report?token=private#result",
          },
        },
        "/workspace",
        "completed",
        { ...correlation, itemId: "open-1" },
      ),
    ).toMatchObject({
      type: "webSearch",
      action: "Opened https://example.com/report",
    });
  });

  it("normalizes command timing and best-effort file previews", () => {
    expect(
      normalizeCodexThreadItem(
        {
          type: "commandExecution",
          id: "command-1",
          command: "pnpm test",
          cwd: "/workspace/path with spaces",
          status: "inProgress",
          exitCode: null,
          aggregatedOutput: null,
          durationMs: null,
        },
        "/workspace",
        "started",
        { ...correlation, itemId: "command-1" },
        {
          commandOutput: { output: "running", truncated: false },
          startedAtMs: 1_000,
          updatedAtMs: 1_100,
          completedAtMs: null,
        },
      ),
    ).toMatchObject({
      type: "command",
      output: null,
      outputTail: "running",
      outputTruncated: false,
      startedAtMs: 1_000,
      updatedAtMs: 1_100,
      completedAtMs: null,
    });
    expect(
      normalizeCodexThreadItem(
        {
          type: "commandExecution",
          id: "command-1",
          command: "pnpm test",
          cwd: "/workspace/path with spaces",
          status: "inProgress",
          exitCode: null,
          aggregatedOutput: "last output",
          durationMs: null,
        },
        "/workspace",
        "completed",
        { ...correlation, itemId: "command-1" },
        { completedAtMs: 1_200, status: "completed", updatedAtMs: 1_200 },
      ),
    ).toMatchObject({
      status: "completed",
      output: "last output",
      outputTail: "last output",
      completedAtMs: 1_200,
      updatedAtMs: 1_200,
    });
    expect(
      normalizeCodexThreadItem(
        {
          type: "fileChange",
          id: "files-1",
          status: "inProgress",
          changes: [
            {
              path: "/workspace/src/path with spaces.ts",
              kind: { type: "update" },
              diff: "@@ -1 +1 @@\n-old\n+new value",
            },
            {
              path: "/workspace/assets/image.png",
              kind: { type: "update" },
              diff: "Binary files differ",
            },
          ],
        },
        "/workspace",
        "started",
        { ...correlation, itemId: "files-1" },
        { startedAtMs: 2_000, updatedAtMs: 2_100, completedAtMs: null },
      ),
    ).toMatchObject({
      type: "fileChange",
      changes: [
        {
          path: "src/path with spaces.ts",
          latestLine: "new value",
          diffPreview: "-old\n+new value",
          lastActivityAtMs: 2_100,
        },
        { path: "assets/image.png" },
      ],
    });
    expect(latestChangedLine("Binary files differ")).toBeNull();
    expect(changedLinesPreview("Binary files differ")).toBeNull();
    expect(changedLinesPreview("@@ -1 +1 @@\n-old\n+new value")).toBe(
      "-old\n+new value",
    );
  });

  it("normalizes phased messages, token usage, and rate limits", () => {
    expect(
      normalizeAgentMessage(
        {
          type: "agentMessage",
          id: "message-1",
          text: "Checking the server bridge.",
          phase: "commentary",
        },
        { ...correlation, itemId: "message-1" },
      ),
    ).toMatchObject({
      phase: "commentary",
      text: "Checking the server bridge.",
    });

    const breakdown = {
      totalTokens: 1_500,
      inputTokens: 1_000,
      cachedInputTokens: 500,
      cacheWriteInputTokens: 0,
      outputTokens: 400,
      reasoningOutputTokens: 100,
    };
    expect(
      normalizeTokenUsageActivity(
        {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: breakdown,
            last: breakdown,
            modelContextWindow: 10_000,
          },
        },
        { ...correlation, itemId: null },
      ),
    ).toMatchObject({ type: "usage", contextUsedPercent: 15 });

    expect(
      normalizeRateLimitActivity(
        {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            planType: "plus",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_786_212_000,
            },
            secondary: null,
            rateLimitReachedType: null,
          },
        },
        "turn-1",
        { ...correlation, itemId: null },
      ),
    ).toMatchObject({
      type: "rateLimit",
      limitId: "codex",
      primary: { usedPercent: 42 },
    });

    expect(
      normalizeNoticeActivity({
        level: "error",
        message: "The provider rejected the request.",
        details: "Request id req-1",
        willRetry: true,
        correlation: { ...correlation, itemId: null },
      }),
    ).toMatchObject({
      type: "notice",
      status: "failed",
      willRetry: true,
      correlation: { diagnosticId: "runtime-session:12" },
    });
  });

  it("keeps model final-answer items provisional until the turn completes", () => {
    const first = normalizeAgentMessage(
      {
        type: "agentMessage",
        id: "message-1",
        text: "I’ll inspect the repository first.",
        phase: "final_answer",
      },
      { ...correlation, itemId: "message-1" },
    )!;
    const second = normalizeAgentMessage(
      {
        type: "agentMessage",
        id: "message-2",
        text: "Here is the completed answer.",
        phase: "final_answer",
      },
      { ...correlation, itemId: "message-2" },
    )!;

    const stagedFirst = stageAgentMessage(null, first);
    expect(stagedFirst).toMatchObject({ emitted: [], pending: first });

    const continued = flushStagedAgentMessage(stagedFirst.pending, false);
    expect(continued).toMatchObject({
      emitted: [{ id: "message-1", phase: "commentary" }],
      pending: null,
    });

    const stagedSecond = stageAgentMessage(continued.pending, second);
    const completed = flushStagedAgentMessage(stagedSecond.pending, true);
    expect(completed).toMatchObject({
      emitted: [{ id: "message-2", phase: "final_answer" }],
      pending: null,
    });
  });

  it("demotes an earlier provisional answer when another answer arrives", () => {
    const first = normalizeAgentMessage(
      {
        type: "agentMessage",
        id: "message-1",
        text: "First progress update.",
        phase: "final_answer",
      },
      { ...correlation, itemId: "message-1" },
    )!;
    const second = normalizeAgentMessage(
      {
        type: "agentMessage",
        id: "message-2",
        text: "Second progress update.",
        phase: "final_answer",
      },
      { ...correlation, itemId: "message-2" },
    )!;

    const stagedFirst = stageAgentMessage(null, first);
    expect(stageAgentMessage(stagedFirst.pending, second)).toMatchObject({
      emitted: [{ id: "message-1", phase: "commentary" }],
      pending: { id: "message-2", phase: "final_answer" },
    });
  });

  it("keeps only the last completed thread message as the final answer", () => {
    const completed = normalizeCodexThreadTurn(
      {
        id: "turn-1",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1_000,
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "message-1",
            text: "I’ll inspect the repository first.",
            phase: "final_answer",
          },
          {
            type: "commandExecution",
            id: "command-1",
            command: "rg --files",
            cwd: "/workspace",
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "README.md",
            durationMs: 50,
          },
          {
            type: "agentMessage",
            id: "message-2",
            text: "Here is the answer.",
            phase: "final_answer",
          },
        ],
      },
      "/workspace",
      "thread-1",
    );

    expect(completed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agentMessage",
          id: "message-1",
          phase: "commentary",
        }),
        expect.objectContaining({
          type: "agentMessage",
          id: "message-2",
          phase: "final_answer",
        }),
      ]),
    );

    const running = normalizeCodexThreadTurn(
      {
        id: "turn-2",
        status: "inProgress",
        startedAt: 1,
        completedAt: null,
        durationMs: null,
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "message-running",
            text: "I’m still looking.",
            phase: "final_answer",
          },
        ],
      },
      "/workspace",
      "thread-1",
    );
    expect(running.items[0]).toMatchObject({
      type: "agentMessage",
      id: "message-running",
      phase: "commentary",
    });
  });

  it("settles stale running tools at the authoritative turn boundary", () => {
    const codeGraphItem = {
      type: "mcpToolCall" as const,
      id: "codegraph-stale",
      server: "codegraph",
      tool: "codegraph_explore",
      status: "inProgress" as const,
      arguments: { query: "project architecture" },
      result: null,
      error: null,
      durationMs: null,
    };
    const normalizedTurn = (status: "completed" | "failed" | "inProgress") =>
      normalizeCodexThreadTurn(
        {
          id: `turn-${status}`,
          status,
          startedAt: 1,
          completedAt: status === "inProgress" ? null : 2,
          durationMs: status === "inProgress" ? null : 1_000,
          error: null,
          items: [codeGraphItem],
        },
        "/workspace",
        "thread-1",
      ).items.find(
        (item) =>
          item.type === "activity" && item.activity.type === "mcpToolCall",
      );

    expect(normalizedTurn("completed")).toMatchObject({
      type: "activity",
      activity: {
        id: "codegraph-stale",
        status: "completed",
        completedAtMs: 2_000,
      },
    });
    expect(normalizedTurn("failed")).toMatchObject({
      type: "activity",
      activity: { id: "codegraph-stale", status: "failed" },
    });
    expect(normalizedTurn("inProgress")).toMatchObject({
      type: "activity",
      activity: { id: "codegraph-stale", status: "running" },
    });
  });
});

describe("Codex agent interaction bridge", () => {
  it("normalizes all supported App Server request families", () => {
    const now = Date.parse("2026-08-08T18:00:00.000Z");
    const command = agentInteractionRequestFromServerRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-command",
        startedAtMs: now,
        approvalId: null,
        environmentId: null,
        reason: "Needs registry access",
        command: "pnpm install",
        cwd: "/workspace",
        commandActions: [{ type: "unknown", command: "pnpm install" }],
        networkApprovalContext: {
          host: "registry.npmjs.org",
          protocol: "https",
        },
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: ["accept", "decline", "cancel"],
      },
      "request-command",
      now,
    );
    expect(command).toMatchObject({
      requestKey: "request-command",
      expiresAt: "2026-08-08T18:30:00.000Z",
      payload: {
        kind: "commandExecution",
        command: "pnpm install",
        availableDecisions: ["accept", "decline", "cancel"],
      },
    });

    expect(
      agentInteractionRequestFromServerRequest(
        "item/fileChange/requestApproval",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-file",
          startedAtMs: now,
          reason: "Write a report",
          grantRoot: "/workspace",
        },
        "request-file",
        now,
      )?.payload.kind,
    ).toBe("fileChange");
    expect(
      agentInteractionRequestFromServerRequest(
        "item/permissions/requestApproval",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-permissions",
          startedAtMs: now,
          environmentId: null,
          cwd: "/workspace",
          reason: "Read fixtures",
          permissions: {
            network: null,
            fileSystem: { read: ["/fixtures"], write: null },
          },
        },
        "request-permissions",
        now,
      )?.payload.kind,
    ).toBe("permissions");
    expect(
      agentInteractionRequestFromServerRequest(
        "item/tool/requestUserInput",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-question",
          questions: [
            {
              id: "target",
              header: "Target",
              question: "Which target?",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
          autoResolutionMs: 5_000,
        },
        "request-input",
        now,
      ),
    ).toMatchObject({
      expiresAt: "2026-08-08T18:00:05.000Z",
      payload: { kind: "userInput", autoResolutionMs: 5_000 },
    });
    expect(
      agentInteractionRequestFromServerRequest(
        "mcpServer/elicitation/request",
        {
          threadId: "thread-1",
          turnId: null,
          serverName: "deployments",
          mode: "url",
          message: "Authorize deployments",
          url: "https://example.com/oauth",
          elicitationId: "elicitation-1",
          _meta: { source: "test" },
        },
        "request-mcp",
        now,
      ),
    ).toMatchObject({
      turnId: null,
      itemId: null,
      payload: { kind: "mcpElicitation", mode: "url" },
    });
  });

  it("maps responses exactly and fails closed by request family", () => {
    expect(
      codexResultForAgentInteraction({
        kind: "commandExecution",
        decision: "acceptWithExecpolicyAmendment",
        execpolicyAmendment: ["pnpm", "test"],
        networkPolicyAmendment: null,
      }),
    ).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["pnpm", "test"],
        },
      },
    });
    expect(
      codexResultForAgentInteraction({
        kind: "mcpElicitation",
        action: "accept",
        content: { environment: "staging" },
        metadata: { source: "cantrip" },
      }),
    ).toEqual({
      action: "accept",
      content: { environment: "staging" },
      _meta: { source: "cantrip" },
    });
    expect(() =>
      codexResultForAgentInteraction({
        kind: "commandExecution",
        decision: "acceptWithExecpolicyAmendment",
        execpolicyAmendment: null,
        networkPolicyAmendment: null,
      }),
    ).toThrow(/Missing execpolicy amendment/u);
    expect(
      failClosedAgentInteractionReply("commandExecution", "expired"),
    ).toEqual({ result: { decision: "cancel" } });
    expect(failClosedAgentInteractionReply("permissions", "expired")).toEqual({
      result: {
        permissions: {},
        scope: "turn",
        strictAutoReview: false,
      },
    });
    expect(failClosedAgentInteractionReply("userInput", "expired")).toEqual({
      error: { code: -32_000, message: "expired" },
    });
  });
});

describe("managed Cantrip MCP guidance", () => {
  it("registers no Cantrip dynamic tools for new or resumed threads", () => {
    expect(CANTRIP_DYNAMIC_TOOLS_OVERRIDE).toEqual({ dynamicTools: [] });
    const newThreadParams = cantripChatThreadParams();
    const resumedThreadParams = cantripChatThreadParams();
    expect(newThreadParams.dynamicTools).toEqual([]);
    expect(resumedThreadParams.dynamicTools).toEqual([]);
    expect(JSON.stringify(newThreadParams)).not.toContain("cantrip_");
    expect(JSON.stringify(resumedThreadParams)).not.toContain("cantrip_");
  });

  it("prefers managed MCP and retains the documented CLI fallback", () => {
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain(
      "managed `cantrip` MCP server",
    );
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain("`context_get`");
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain("`policy_read`");
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain(
      "`.cantrip/run-configurations`",
    );
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain(
      "`run_configuration_create`",
    );
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain(
      "`run_configuration_detect`",
    );
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain(
      "`run_configuration_secret_set`",
    );
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain(
      "`run_configuration_start`",
    );
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain(
      "stable configuration IDs and exact worktree IDs",
    );
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain("`cantrip -h`");
    expect(CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS).toContain("fallback");
  });

  it("adds non-Git guidance only when local Git metadata is absent", () => {
    expect(cantripChatThreadParams(true).developerInstructions).toBe(
      CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS,
    );
    expect(cantripChatThreadParams(false).developerInstructions).toBe(
      `${CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS}\n\n${NON_GIT_WORKSPACE_DEVELOPER_INSTRUCTIONS}`,
    );
    expect(NON_GIT_WORKSPACE_DEVELOPER_INSTRUCTIONS).toContain(
      "Do not run Git or GitHub commands",
    );
    expect(NON_GIT_WORKSPACE_DEVELOPER_INSTRUCTIONS).toContain(
      "Do not initialize Git unless the user explicitly asks",
    );
  });

  it("uses a compact standalone thread profile without IDE guidance", () => {
    const params = cantripChatThreadParams(true, "standalone-chat");
    expect(params.developerInstructions).toBe(
      STANDALONE_CHAT_DEVELOPER_INSTRUCTIONS,
    );
    expect(params.developerInstructions).toContain("managed `cantrip`");
    expect(params.developerInstructions).toContain("`web_search`");
    expect(params.developerInstructions).toContain("`web_read`");
    expect(params.developerInstructions).not.toContain("`context_get`");
    expect(params.dynamicTools).toEqual([]);
  });

  it("recognizes Git directories, worktree files, and ancestor metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-context-"));
    try {
      const plain = path.join(root, "plain", "nested");
      const repository = path.join(root, "repository");
      const repositoryChild = path.join(repository, "nested");
      const worktree = path.join(root, "worktree");
      await Promise.all([
        mkdir(plain, { recursive: true }),
        mkdir(path.join(repository, ".git"), { recursive: true }),
        mkdir(repositoryChild, { recursive: true }),
        mkdir(worktree, { recursive: true }),
      ]);
      await writeFile(
        path.join(worktree, ".git"),
        "gitdir: ../repository/.git/worktrees/example\n",
      );

      await expect(workspaceHasGitMetadata(plain)).resolves.toBe(false);
      await expect(workspaceHasGitMetadata(repository)).resolves.toBe(true);
      await expect(workspaceHasGitMetadata(repositoryChild)).resolves.toBe(
        true,
      );
      await expect(workspaceHasGitMetadata(worktree)).resolves.toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("codexWorkspaceContext", () => {
  it("binds every app-server operation to one resolved worktree root", () => {
    expect(codexWorkspaceContext("/tmp/project/../project/worktree")).toEqual({
      cwd: "/tmp/project/worktree",
      runtimeWorkspaceRoots: ["/tmp/project/worktree"],
    });
  });
});

describe("codexReasoningEffortParams", () => {
  const model = {
    id: "logical-model",
    routeId: "provider-route",
    name: "gpt-test",
    reasoningEffort: null,
  };

  it("uses the App Server effort override when an effort is selected", () => {
    expect(
      codexReasoningEffortParams({ ...model, reasoningEffort: "high" }),
    ).toEqual({ effort: "high" });
  });

  it("leaves the provider default untouched when no effort is selected", () => {
    expect(codexReasoningEffortParams(model)).toEqual({});
  });
});

describe("codexWorktreeTurnPolicy", () => {
  it("isolates standalone Chat writes to the scratch root", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/scratch/chat-one",
      executionProfile: "standalone-chat",
      rootKind: null,
      isPrimary: true,
      resultMode: { kind: "visible" },
      worktreeMode: null,
      worktreePolicy: null,
    });
    expect(policy.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/scratch/chat-one"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(policy.additionalContext["cantrip.standalone-chat"].value).toContain(
      "isolated standalone Chat scratch workspace",
    );
    expect(policy.additionalContext).not.toHaveProperty(
      "cantrip.worktree-policy",
    );
  });

  it("enforces inspection-only Primary for required-for-writes projects", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/project",
      rootKind: "git-worktree",
      isPrimary: true,
      resultMode: { kind: "visible" },
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
    });
    expect(policy).toEqual({
      additionalContext: {
        "cantrip.worktree-policy": {
          kind: "application",
          value: expect.stringContaining("Primary is inspection-only"),
        },
      },
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    const guidance = policy.additionalContext["cantrip.worktree-policy"].value;
    expect(guidance).toContain("`worktree_create`");
    expect(guidance).toContain("`worktree_switch`");
    expect(guidance).toContain("only if managed MCP is unavailable");
  });

  it("grants checkout-scoped writes outside Primary and explains pinned mode", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/project/../project/feature",
      rootKind: "git-worktree",
      isPrimary: false,
      resultMode: { kind: "visible" },
      worktreeMode: "pinned",
      worktreePolicy: "required-for-writes",
    });
    expect(policy.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace/project/feature"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(policy.additionalContext["cantrip.worktree-policy"].value).toContain(
      "pinned to the current worktree",
    );
  });

  it("omits the legacy sandbox payload when a permission profile is active", () => {
    expect(
      codexWorktreeTurnPolicy({
        cwd: "/workspace/project",
        rootKind: "git-worktree",
        isPrimary: true,
        resultMode: { kind: "visible" },
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
        permissionProfileActive: true,
      }),
    ).toEqual({
      additionalContext: {
        "cantrip.worktree-policy": {
          kind: "application",
          value: expect.stringContaining("Primary is inspection-only"),
        },
      },
    });
  });

  it("adds current policy summaries as separate application context", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/project",
      rootKind: "git-worktree",
      isPrimary: false,
      resultMode: { kind: "visible" },
      policyContext:
        "Effective Cantrip policies apply.\n\n[review] Review\nRead the policy.",
      worktreeMode: "agent-managed",
      worktreePolicy: "agent-managed",
    });
    expect(policy.additionalContext["cantrip.policies"]).toEqual({
      kind: "application",
      value:
        "Effective Cantrip policies apply.\n\n[review] Review\nRead the policy.",
    });
    expect(policy.additionalContext["cantrip.worktree-policy"]).toBeDefined();
  });

  it("forces structured Task turns read-only even with implementation access", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/project",
      rootKind: "git-worktree",
      isPrimary: false,
      resultMode: { kind: "structured", outputSchema: { type: "object" } },
      worktreeMode: "pinned",
      worktreePolicy: "direct",
      permissionProfileActive: true,
      policyContext: "Effective policy summaries",
    });
    expect(policy.sandboxPolicy).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
    expect(policy.additionalContext["cantrip.worktree-policy"].value).toContain(
      "unconditionally read-only",
    );
    expect(policy.additionalContext["cantrip.policies"]?.value).toBe(
      "Effective policy summaries",
    );
  });

  it("uses direct non-Git context for worker-managed folders", () => {
    const policy = codexWorktreeTurnPolicy({
      cwd: "/workspace/folder",
      isPrimary: true,
      resultMode: { kind: "visible" },
      rootKind: "folder-root",
      worktreeMode: "agent-managed",
      worktreePolicy: "required-for-writes",
    });

    expect(policy.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace/folder"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    const context = policy.additionalContext["cantrip.worktree-policy"].value;
    expect(context).toContain("worker-managed folder without Git protection");
    expect(context).toContain("Writes occur directly");
    expect(context).toContain("worktree commands are unavailable");
    expect(context).toContain("git init does not convert");
    expect(context).not.toContain("may use `cantrip worktree`");
  });
});

describe("Codex permission profile params", () => {
  it("disables approval escalation and implementation access for Task planning", () => {
    expect(
      codexChatThreadSecurityParams(":danger-full-access", true, true),
    ).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
  });

  it("never composes beta permission profiles with the legacy sandbox", () => {
    expect(codexThreadPermissionParams(":read-only", true)).toEqual({
      permissions: ":read-only",
    });
    expect(codexThreadPermissionParams(":read-only", false)).toEqual({
      sandbox: "workspace-write",
    });
    expect(codexThreadPermissionParams(":yolo", true)).toEqual({
      permissions: ":danger-full-access",
    });
  });

  it("only disables approvals for supported YOLO chat profiles", () => {
    expect(codexChatApprovalPolicy(":yolo", true)).toBe("never");
    expect(codexChatApprovalPolicy(":danger-full-access", true)).toBe(
      "on-request",
    );
    expect(codexChatApprovalPolicy(":yolo", false)).toBe("on-request");
  });
});

describe("Codex workflow node policy", () => {
  it("makes direct folder write semantics explicit to the agent", () => {
    expect(
      workflowDeveloperInstructions({
        developerInstructions: "Return the requested JSON.",
        rootKind: "folder-root",
      }),
    ).toContain("Writes modify the shared folder immediately");
    expect(
      workflowDeveloperInstructions({
        developerInstructions: "Return the requested JSON.",
        rootKind: "folder-root",
      }),
    ).toContain("no Git checkpoint will be created");
    expect(
      workflowDeveloperInstructions({
        developerInstructions: "Return the requested JSON.",
        rootKind: "git-worktree",
      }),
    ).toBe("Return the requested JSON.");
  });

  it("maps node mutation and network requirements into scoped sandboxes", () => {
    expect(
      codexWorkflowTurnPolicy(
        {
          cwd: "/workspace/project",
          mutationMode: "read-only",
          networkAccess: "none",
          permissionProfileId: null,
        },
        false,
      ),
    ).toEqual({
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(
      codexWorkflowTurnPolicy(
        {
          cwd: "/workspace/project/../project",
          mutationMode: "write",
          networkAccess: "unrestricted",
          permissionProfileId: null,
        },
        false,
      ),
    ).toEqual({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace/project"],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it("fails closed for restricted network without named profiles", () => {
    expect(() =>
      codexWorkflowTurnPolicy(
        {
          cwd: "/workspace/project",
          mutationMode: "read-only",
          networkAccess: "restricted",
          permissionProfileId: ":restricted",
        },
        false,
      ),
    ).toThrow(/requires a supported Codex permission profile/u);
    expect(
      codexWorkflowTurnPolicy(
        {
          cwd: "/workspace/project",
          mutationMode: "read-only",
          networkAccess: "restricted",
          permissionProfileId: ":restricted",
        },
        true,
      ),
    ).toEqual({});
  });

  it("parses bounded structured output and reports unavailable cost honestly", () => {
    expect(parseWorkflowStructuredResult("plain text", {})).toBe("plain text");
    expect(
      parseWorkflowStructuredResult('{"approved":true}', { type: "object" }),
    ).toEqual({ approved: true });
    expect(() =>
      parseWorkflowStructuredResult("not json", { type: "object" }),
    ).toThrow();
    expect(
      workflowMeasuredUsage(
        {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 0,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
        250.4,
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      totalTokens: 15,
      durationMs: 250,
      estimatedCostUsd: null,
      costAvailable: false,
    });
  });
});

describe("changedFiles", () => {
  it("summarizes added, updated, and deleted files from a turn diff", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old readme",
      "+new readme",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
    ].join("\n");

    expect(changedFiles(diff)).toEqual([
      {
        path: "README.md",
        kind: "update",
        latestLine: "new readme",
        diffPreview: "-old readme\n+new readme",
      },
      { path: "src/new.ts", kind: "add" },
      { path: "old.ts", kind: "delete" },
    ]);
    expect(
      changedLinesPreview(
        `+${"x".repeat(agentFilePreviewLimitCharacters + 1)}`,
      ),
    ).toHaveLength(agentFilePreviewLimitCharacters);
  });
});

describe("workspace snapshot metadata", () => {
  it.each([1, 100, 5_000])(
    "preserves ordered snapshot bytes for %i changed paths",
    async (count) => {
      let active = 0;
      let maxActive = 0;
      const records = Array.from({ length: count }, (_, index) => {
        const status = index % 2 === 0 ? "??" : " M";
        return `${status} file-${index.toString().padStart(4, "0")}.ts`;
      });

      const snapshot = await workspaceSnapshotFromPorcelainRecords(
        "/workspace",
        records,
        async (filePath) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setImmediate(resolve));
          active -= 1;
          const index = Number.parseInt(
            path.basename(filePath).slice("file-".length),
            10,
          );
          return { size: index + 1, mtimeMs: index + 2, mode: 0o100644 };
        },
      );

      expect(JSON.stringify([...snapshot])).toBe(
        JSON.stringify(
          records.map((record, index) => [
            record.slice(3),
            {
              fingerprint: `${index + 1}:${index + 2}:${0o100644}`,
              status: record.slice(0, 2),
            },
          ]),
        ),
      );
      expect(maxActive).toBe(Math.min(count, 16));
    },
  );

  it("bounds metadata reads while preserving input order across uneven delays", async () => {
    let active = 0;
    let maxActive = 0;
    const records = Array.from(
      { length: 64 },
      (_, index) => `?? file-${index.toString().padStart(2, "0")}.ts`,
    );

    const snapshot = await workspaceSnapshotFromPorcelainRecords(
      "/workspace",
      records,
      async (filePath) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const index = Number.parseInt(
          path.basename(filePath).slice("file-".length),
          10,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, (3 - (index % 4)) * 2),
        );
        active -= 1;
        return { size: index, mtimeMs: index * 2, mode: 0o100644 };
      },
    );

    expect(maxActive).toBe(16);
    expect([...snapshot.keys()]).toEqual(
      records.map((record) => record.slice(3)),
    );
  });

  it("skips only definite worktree deletions and retains missing-file fallback", async () => {
    const reads: string[] = [];
    const snapshot = await workspaceSnapshotFromPorcelainRecords(
      "/workspace",
      [" D deleted.ts", " M raced.ts", "?? present.ts"],
      async (filePath) => {
        reads.push(path.basename(filePath));
        if (filePath.endsWith("raced.ts")) {
          throw new Error("removed during snapshot");
        }
        return { size: 7, mtimeMs: 11, mode: 0o100644 };
      },
    );

    expect(reads).toEqual(["raced.ts", "present.ts"]);
    expect([...snapshot]).toEqual([
      ["deleted.ts", { fingerprint: "missing", status: " D" }],
      ["raced.ts", { fingerprint: "missing", status: " M" }],
      ["present.ts", { fingerprint: `7:11:${0o100644}`, status: "??" }],
    ]);
  });

  it("preserves porcelain rename record skipping", async () => {
    const reads: string[] = [];
    const snapshot = await workspaceSnapshotFromPorcelainRecords(
      "/workspace",
      ["R  renamed.ts", "original.ts", "?? loose.ts"],
      async (filePath) => {
        reads.push(path.basename(filePath));
        return { size: 1, mtimeMs: 2, mode: 0o100644 };
      },
    );

    expect(reads).toEqual(["renamed.ts", "loose.ts"]);
    expect([...snapshot.keys()]).toEqual(["renamed.ts", "loose.ts"]);
  });
});

describe("codexMcpConfigOverride", () => {
  it("maps Cantrip stdio and HTTP settings to Codex config keys", () => {
    expect(
      codexMcpConfigOverride([
        {
          name: "local_tools",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@example/mcp"],
          environment: { TOKEN: "secret" },
          enabled: true,
        },
        {
          name: "remote_tools",
          transport: "http",
          url: "https://example.com/mcp",
          bearerTokenEnvironmentVariable: "MCP_TOKEN",
          headers: { "X-Team": "Cantrip" },
          environmentHeaders: { Authorization: "MCP_AUTH_HEADER" },
          enabled: false,
        },
      ]),
    ).toEqual({
      mcp_servers: {
        local_tools: {
          command: "npx",
          args: ["-y", "@example/mcp"],
          env: { TOKEN: "secret" },
          enabled: true,
        },
      },
    });
  });

  it("omits disabled servers so Codex cannot observe their configuration", () => {
    expect(
      codexMcpConfigOverride([
        {
          name: "disabled_private_tools",
          transport: "http",
          url: "https://private.example.test/mcp",
          bearerTokenEnvironmentVariable: "PRIVATE_TOKEN",
          headers: { "X-Private": "configuration" },
          environmentHeaders: {},
          enabled: false,
        },
      ]),
    ).toEqual({ mcp_servers: {} });
  });

  it("makes managed CodeGraph a required model-facing tool", () => {
    expect(
      codexMcpConfigOverride([
        {
          name: "codegraph",
          transport: "stdio",
          command: "/worker/tools/codegraph/bin/codegraph",
          args: ["serve", "--mcp", "--path", "/workspace/project"],
          environment: { CODEGRAPH_DIR: ".codegraph-cantrip" },
          enabled: true,
        },
      ]),
    ).toEqual({
      mcp_servers: {
        codegraph: {
          command: "/worker/tools/codegraph/bin/codegraph",
          args: ["serve", "--mcp", "--path", "/workspace/project"],
          env: { CODEGRAPH_DIR: ".codegraph-cantrip" },
          enabled: true,
          required: true,
          enabled_tools: ["codegraph_explore"],
        },
      },
    });
  });

  it("makes the worker-owned Cantrip MCP required and readiness-checkable", () => {
    const server = {
      name: "CANTRIP",
      transport: "stdio" as const,
      command: "/worker/runtime/node",
      args: ["/worker/dist/mcp/stdio.js", "--connection", "/binding.json"],
      environment: {},
      enabled: true,
    };
    expect(codexMcpConfigOverride([server])).toEqual({
      mcp_servers: {
        CANTRIP: {
          command: "/worker/runtime/node",
          args: ["/worker/dist/mcp/stdio.js", "--connection", "/binding.json"],
          env: {},
          enabled: true,
          required: true,
          enabled_tools: [...CANTRIP_MCP_TOOL_NAMES],
        },
      },
    });
    expect(managedMcpToolRequirements([server])).toEqual(
      CANTRIP_MCP_TOOL_NAMES.map((tool) => ({ name: "cantrip", tool })),
    );
  });

  it("limits standalone managed Cantrip tools to the shared web catalog", () => {
    const server = {
      name: "cantrip",
      transport: "stdio" as const,
      command: "/worker/runtime/node",
      args: ["/worker/dist/mcp/stdio.js", "--connection", "/binding.json"],
      environment: { CANTRIP_MCP_PROFILE: "standalone-web" },
      enabled: true,
      managedToolNames: ["tool_help", "web_search", "web_read"],
    };
    expect(codexMcpConfigOverride([server])).toMatchObject({
      mcp_servers: {
        cantrip: {
          env: { CANTRIP_MCP_PROFILE: "standalone-web" },
          enabled_tools: ["tool_help", "web_search", "web_read"],
        },
      },
    });
    expect(managedMcpToolRequirements([server])).toEqual([
      { name: "cantrip", tool: "tool_help" },
      { name: "cantrip", tool: "web_search" },
      { name: "cantrip", tool: "web_read" },
    ]);
  });
});

describe("native Codex subagent configuration", () => {
  it("disables native collaboration for standalone Chat runtimes", () => {
    expect(codexNativeSubagentConfigOverride(null, false)).toEqual({
      features: { multi_agent: false },
      agents: { enabled: false },
    });
  });

  it("measures the worker-owned request and tool-selection footprint", () => {
    const managedIdeServers = [
      {
        name: "cantrip",
        transport: "stdio" as const,
        command: "/worker/runtime/node",
        args: ["/worker/dist/mcp/stdio.js", "--connection", "/binding.json"],
        environment: {},
        enabled: true,
      },
      {
        name: "codegraph",
        transport: "stdio" as const,
        command: "/worker/tools/codegraph/bin/codegraph",
        args: ["serve", "--mcp", "--path", "/workspace/project"],
        environment: {},
        enabled: true,
      },
    ];
    const ide = measureCodexProfileFootprint("ide", managedIdeServers);
    const standalone = measureCodexProfileFootprint("standalone-chat", []);

    expect(ide).toMatchObject({
      enabledMcpServerCount: 2,
      managedToolCount: CANTRIP_MCP_TOOL_NAMES.length + 1,
      dynamicToolSchemaBytes: 2,
    });
    expect(standalone).toMatchObject({
      enabledMcpServerCount: 0,
      managedToolCount: 0,
      dynamicToolSchemaBytes: 2,
    });
    expect(standalone.serializedWorkerOverrideBytes).toBeLessThan(
      ide.serializedWorkerOverrideBytes,
    );
  });

  it("enables native tools without inventing child defaults", () => {
    expect(codexNativeSubagentConfigOverride(null)).toEqual({
      features: { multi_agent: true },
      agents: { enabled: true },
    });
  });

  it("applies custom child defaults only when the chat selected them", () => {
    expect(
      codexNativeSubagentConfigOverride({
        model: {
          id: "child-model",
          routeId: "child-route",
          name: "gpt-5.6-terra",
          reasoningEffort: "high",
        },
        provider: {
          id: "provider-1",
          name: "ChatGPT",
          kind: "chatgpt",
          baseUrl: "https://chatgpt.com/backend-api",
          apiKey: null,
          accountId: "account-1",
          credentialHomeKey: "account-home-1",
        },
      }),
    ).toEqual({
      features: { multi_agent: true },
      agents: {
        enabled: true,
        default_subagent_model: "gpt-5.6-terra",
        default_subagent_reasoning_effort: "high",
      },
    });
  });
});

describe("codexModelProviderName", () => {
  it("uses Codex's built-in OpenAI provider for ChatGPT accounts", () => {
    expect(
      codexModelProviderName({
        id: "personal-chatgpt",
        name: "Personal ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      }),
    ).toBe("openai");
  });

  it("uses Codex's built-in Ollama provider for local models", () => {
    expect(
      codexModelProviderName({
        id: "local-ollama",
        name: "Ollama",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: null,
      }),
    ).toBe("ollama");
  });

  it("routes Grok subscription traffic through Cantrip's credential proxy", () => {
    expect(
      codexModelProviderName({
        id: "supergrok",
        name: "SuperGrok",
        kind: "grok",
        baseUrl: "http://127.0.0.1:54321/v1",
        apiKey: null,
        accountId: "grok-account",
        credentialHomeKey: "grok-account-home",
      }),
    ).toBe("cantrip_runtime");
  });

  it("keeps other compatible APIs on Cantrip's configured provider", () => {
    expect(
      codexModelProviderName({
        id: "open-router",
        name: "OpenRouter",
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
      }),
    ).toBe("cantrip_runtime");
  });
});

describe("codexEndpointFromLine", () => {
  it("recognizes both plain and colored Codex endpoint announcements", () => {
    expect(codexEndpointFromLine("  listening on: ws://127.0.0.1:54321")).toBe(
      "ws://127.0.0.1:54321",
    );
    expect(
      codexEndpointFromLine(
        "  \u001b[2mlistening on:\u001b[0m \u001b[32mws://127.0.0.1:54321\u001b[0m",
      ),
    ).toBe("ws://127.0.0.1:54321");
  });
});

describe("codexStartupExitMessage", () => {
  it("surfaces the final startup diagnostic without terminal control codes", () => {
    expect(
      codexStartupExitMessage(1, null, [
        "first warning",
        "\u001b[31mmodel catalog is missing base instructions\u001b[0m",
      ]),
    ).toBe(
      "Codex app-server exited before listening (code 1): model catalog is missing base instructions",
    );
  });
});

describe("parseCodexRpcMessage", () => {
  it("preserves raw method payloads while rejecting malformed envelopes", () => {
    expect(
      parseCodexRpcMessage(
        JSON.stringify({
          method: "future/event",
          params: { nested: { value: 42 } },
        }),
      ),
    ).toEqual({
      method: "future/event",
      params: { nested: { value: 42 } },
    });
    expect(parseCodexRpcMessage("not json")).toBeNull();
    expect(parseCodexRpcMessage(JSON.stringify({ method: 42 }))).toBeNull();
    expect(
      parseCodexRpcMessage(
        JSON.stringify({ id: 1, error: { code: "bad", message: "failed" } }),
      ),
    ).toBeNull();
  });

  it("distinguishes generated notifications from future schema drift", () => {
    expect(isKnownCodexNotificationMethod("turn/plan/updated")).toBe(true);
    expect(isKnownCodexNotificationMethod("project/changed")).toBe(true);
    expect(isKnownCodexNotificationMethod("thread/project/updated")).toBe(true);
    expect(
      isKnownCodexNotificationMethod("autoApprovalReview/strictReviewRequired"),
    ).toBe(true);
    expect(
      isKnownCodexNotificationMethod("mcpServer/event/stream/notification"),
    ).toBe(true);
    expect(isKnownCodexNotificationMethod("thread/realtime/item/started")).toBe(
      true,
    );
    expect(
      isKnownCodexNotificationMethod("thread/realtime/item/transcript/delta"),
    ).toBe(true);
    expect(
      isKnownCodexNotificationMethod("thread/realtime/item/completed"),
    ).toBe(true);
    expect(isKnownCodexNotificationMethod("future/event")).toBe(false);
  });
});

describe("parseCodexSkills", () => {
  it("returns enabled skills for the requested working directory", () => {
    expect(
      parseCodexSkills(
        {
          data: [
            {
              cwd: "/workspace",
              skills: [
                {
                  name: "skill-creator",
                  description: "Create reusable skills",
                  path: "/skills/skill-creator/SKILL.md",
                  enabled: true,
                  interface: { displayName: "Skill Creator" },
                },
                {
                  name: "disabled",
                  description: "Disabled",
                  path: "/skills/disabled/SKILL.md",
                  enabled: false,
                },
              ],
            },
          ],
        },
        "/workspace",
      ),
    ).toEqual([
      {
        name: "skill-creator",
        description: "Create reusable skills",
        displayName: "Skill Creator",
        path: "/skills/skill-creator/SKILL.md",
      },
    ]);
  });
});

describe("parsePermissionProfileList", () => {
  it("normalizes null Codex descriptions without rejecting the capability", () => {
    expect(
      parsePermissionProfileList({
        data: [
          { id: ":workspace", description: null, allowed: true },
          { id: ":read-only", description: "Read only", allowed: true },
        ],
      }),
    ).toEqual([
      { id: ":workspace", description: "", allowed: true },
      { id: ":read-only", description: "Read only", allowed: true },
    ]);
  });
});

describe("Codex goals", () => {
  const goal = {
    threadId: "thread-1",
    objective: "Complete the task",
    status: "active" as const,
    tokenBudget: null,
    tokensUsed: 100,
    timeUsedSeconds: 30,
    createdAt: 1,
    updatedAt: 2,
  };

  it("continues only active, unpaused goals", () => {
    expect(goalShouldContinue(goal)).toBe(true);
    expect(goalShouldContinue(goal, true)).toBe(false);
    expect(goalShouldContinue({ ...goal, status: "paused" })).toBe(false);
    expect(goalShouldContinue({ ...goal, status: "complete" })).toBe(false);
  });
});

describe("Codex runtime compatibility enforcement", () => {
  it("returns a clear error before starting an unavailable runtime", async () => {
    const runtime = new CodexAppServer(
      "/definitely/missing/codex",
      "/private/tmp/cantrip-runtime-test",
      "/private/tmp/cantrip-runtime-test/home",
      unprobedCodexRuntimeReport,
    );

    await expect(
      runtime.runTurn({
        chatId: "chat-1",
        clientMessageId: "message-1",
        cwd: "/private/tmp/cantrip-runtime-test",
        isPrimary: true,
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
        },
        planMode: "default",
        prompt: "Inspect the project",
        skillNames: [],
        threadId: null,
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
      }),
    ).rejects.toThrow(/Codex runtime is missing.*expected >=0\.151\.0/u);
  });

  it("uses the dedicated workflow entry point for unavailable runtimes", async () => {
    const runtime = new CodexAppServer(
      "/definitely/missing/codex",
      "/private/tmp/cantrip-workflow-runtime-test",
      "/private/tmp/cantrip-workflow-runtime-test/home",
      unprobedCodexRuntimeReport,
    );

    await expect(
      runtime.runWorkflowNode({
        workflowRunId: "run-1",
        runNodeId: "run-node-1",
        attemptId: "attempt-1",
        idempotencyKey: "execute-1",
        worktreeId: null,
        cwd: "/private/tmp/cantrip-workflow-runtime-test",
        threadId: null,
        prompt: "Inspect the project",
        developerInstructions: null,
        skillNames: [],
        outputSchema: {},
        mutationMode: "read-only",
        networkAccess: "none",
        approvalMode: "interactive",
        permissionProfileId: null,
        timeoutMs: 60_000,
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
        },
      }),
    ).rejects.toThrow(/Codex runtime is missing.*expected >=0\.151\.0/u);
  });
});

describe("Codex Plan Mode", () => {
  it("uses a stable request identity without encoding any timeout", () => {
    expect(
      planQuestionId(
        { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
        42,
      ),
    ).toBe("thread-1:turn-1:item-1:42");
  });
});
