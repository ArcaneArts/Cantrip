import type { ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildChatTimeline,
  formatElapsedTime,
  formatTurnMetadata,
} from "./timeline";

function message(
  id: string,
  role: ChatMessage["role"],
  createdAt: string,
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    contextKind: "project",
    worktreeId: "worktree-primary",
    scratchRootId: null,
    executionLaneId: null,
    sequence: 1,
    role,
    mode: "default",
    createdAt,
    content,
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
  };
}

describe("chat activity timeline", () => {
  it("groups a completed turn and measures user-to-response time", () => {
    const messages = [
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Do the work" },
      ]),
      message("command", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pnpm check",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: null,
          },
        },
      ]),
      message("files", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "activity",
          activity: {
            type: "fileChange",
            id: "files-1",
            status: "completed",
            changes: [{ path: "src/App.tsx", kind: "update" }],
          },
        },
      ]),
      message("answer", "assistant", "2026-08-07T12:01:44.000Z", [
        { type: "text", text: "Finished." },
      ]),
    ];

    const timeline = buildChatTimeline(messages);
    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      kind: "turn",
      messages: [
        { content: [{ activity: { id: "command-1" } }] },
        { content: [{ activity: { id: "files-1" } }] },
      ],
      startedAt: "2026-08-07T12:00:00.000Z",
      endedAt: "2026-08-07T12:01:44.000Z",
    });
    expect(
      formatElapsedTime("2026-08-07T12:00:00.000Z", "2026-08-07T12:01:44.000Z"),
    ).toBe("1m 44s");
  });

  it("keeps an active turn expanded by leaving its end open", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Do the work" },
      ]),
      message("command", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pnpm check",
            cwd: ".",
            status: "running",
            exitCode: null,
            output: null,
          },
        },
      ]),
    ]);

    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      kind: "tool",
      endedAt: null,
    });
  });

  it("settles stale running tools after a terminal response", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Inspect the graph" },
      ]),
      message("codegraph", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "mcpToolCall",
            id: "codegraph-1",
            status: "running",
            server: "codegraph",
            tool: "codegraph_explore",
            query: "project architecture",
            resultText: null,
            error: null,
            durationMs: null,
          },
        },
      ]),
      message("answer", "assistant", "2026-08-07T12:00:02.000Z", [
        { type: "text", text: "Done", phase: "final_answer" },
      ]),
    ]);

    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      kind: "turn",
      messages: [
        {
          content: [{ activity: { id: "codegraph-1", status: "completed" } }],
        },
      ],
    });
  });

  it("uses correlated turn identities and stable legacy fallbacks", () => {
    const correlated = buildChatTimeline([
      message("user-correlated", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Inspect the turn" },
      ]),
      message("command-correlated", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-correlated",
            command: "git status",
            cwd: ".",
            status: "running",
            exitCode: null,
            output: null,
            correlation: {
              sourceMethod: "item/started",
              diagnosticId: null,
              threadId: "thread-1",
              turnId: "turn-runtime",
              itemId: "command-correlated",
            },
          },
        },
      ]),
    ]);
    expect(correlated[1]).toMatchObject({
      type: "activityGroup",
      kind: "tool",
      turnId: "turn-runtime",
      turnKey: "runtime:turn-runtime",
    });

    const legacyMessages = [
      message("user-legacy", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Inspect the legacy turn" },
      ]),
      message("command-legacy", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-legacy",
            command: "git status",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: null,
          },
        },
      ]),
    ];
    const activeLegacy = buildChatTimeline(legacyMessages);
    const completedLegacy = buildChatTimeline([
      ...legacyMessages,
      message("answer-legacy", "assistant", "2026-08-07T12:00:02.000Z", [
        { type: "text", text: "Done", phase: "final_answer" },
      ]),
    ]);
    expect(activeLegacy[1]).toMatchObject({
      type: "activityGroup",
      kind: "tool",
      turnId: null,
      turnKey: "legacy:user-legacy",
    });
    expect(completedLegacy[1]).toMatchObject({
      type: "activityGroup",
      kind: "turn",
      turnId: null,
      turnKey: "legacy:user-legacy",
    });
  });

  it("collapses recovered commentary and reasoning after a turn summary", () => {
    const timeline = buildChatTimeline([
      message("commentary", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "text",
          text: "I’m inspecting the runtime schema.",
          phase: "commentary",
        },
      ]),
      message("reasoning", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "activity",
          activity: {
            type: "reasoning",
            id: "reasoning-1",
            status: "completed",
            summary: ["Compared the event unions."],
          },
        },
      ]),
      message("summary", "assistant", "2026-08-07T12:00:03.000Z", [
        {
          type: "activity",
          activity: {
            type: "turnSummary",
            id: "turn:turn-1:summary",
            status: "completed",
            durationMs: 3_000,
            startedAt: 1_786_104_000,
            completedAt: 1_786_104_003,
          },
        },
      ]),
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      type: "activityGroup",
      kind: "turn",
      messages: [
        { id: "commentary", content: [{ phase: "commentary" }] },
        { id: "reasoning", content: [{ activity: { id: "reasoning-1" } }] },
      ],
    });
  });

  it("collapses commentary and tool groups together when work finishes", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Inspect this project" },
      ]),
      message("commentary-1", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "text",
          text: "I’ll inspect the project structure first.",
          phase: "commentary",
        },
      ]),
      message("command-1", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "ls -la",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: null,
          },
        },
      ]),
      message("commentary-2", "assistant", "2026-08-07T12:00:03.000Z", [
        {
          type: "text",
          text: "The checkout is empty, so I’ll inspect Git next.",
          phase: "commentary",
        },
      ]),
      message("command-2", "assistant", "2026-08-07T12:00:04.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-2",
            command: "git status",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: null,
          },
        },
      ]),
      message("answer", "assistant", "2026-08-07T12:00:37.000Z", [
        { type: "text", text: "The project is empty.", phase: "final_answer" },
      ]),
    ]);

    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      kind: "turn",
      messages: [
        { id: "commentary-1" },
        { id: "command-1" },
        { id: "commentary-2" },
        { id: "command-2" },
      ],
      startedAt: "2026-08-07T12:00:00.000Z",
      endedAt: "2026-08-07T12:00:37.000Z",
    });
    expect(timeline[2]).toMatchObject({
      type: "message",
      message: { id: "answer" },
    });
  });

  it("uses reasoning activity as a tool-group boundary", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Inspect this project" },
      ]),
      message("command-1", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "rg --files",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: null,
          },
        },
      ]),
      message("reasoning", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "activity",
          activity: {
            type: "reasoning",
            id: "reasoning-1",
            status: "completed",
            summary: ["The app has a dedicated chat timeline."],
          },
        },
      ]),
      message("command-2", "assistant", "2026-08-07T12:00:03.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-2",
            command: "pnpm test",
            cwd: ".",
            status: "running",
            exitCode: null,
            output: null,
          },
        },
      ]),
    ]);

    expect(timeline).toHaveLength(4);
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      kind: "tool",
      messages: [{ id: "command-1" }],
      endedAt: "2026-08-07T12:00:02.000Z",
    });
    expect(timeline[2]).toMatchObject({
      type: "message",
      message: { id: "reasoning" },
    });
    expect(timeline[3]).toMatchObject({
      type: "activityGroup",
      kind: "tool",
      messages: [{ id: "command-2" }],
      endedAt: null,
    });
  });

  it("keeps notices visible instead of burying them in a tool summary", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Inspect this project" },
      ]),
      message("command", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pnpm test",
            cwd: ".",
            status: "failed",
            exitCode: 1,
            output: "Tests failed",
          },
        },
      ]),
      message("notice", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "activity",
          activity: {
            type: "notice",
            id: "notice-1",
            status: "failed",
            level: "error",
            message: "The command failed.",
            details: "Tests failed",
            willRetry: false,
          },
        },
      ]),
    ]);

    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      kind: "tool",
      messages: [{ id: "command" }],
      endedAt: "2026-08-07T12:00:02.000Z",
    });
    expect(timeline[2]).toMatchObject({
      type: "message",
      message: { id: "notice" },
    });
  });

  it("attaches trailing turn metrics to the final answer", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Inspect the runtime" },
      ]),
      message("command", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "codex --version",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: "codex-cli 0.146.1",
          },
        },
      ]),
      message("answer", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "text",
          text: "The runtime is compatible.",
          phase: "final_answer",
        },
      ]),
      message("summary", "assistant", "2026-08-07T12:00:03.000Z", [
        {
          type: "activity",
          activity: {
            type: "turnSummary",
            id: "turn:turn-1:summary",
            status: "completed",
            durationMs: 2_000,
            startedAt: 1_786_104_000,
            completedAt: 1_786_104_002,
          },
        },
      ]),
      message("usage", "assistant", "2026-08-07T12:00:04.000Z", [
        {
          type: "activity",
          activity: {
            type: "usage",
            id: "turn:turn-1:usage",
            status: "completed",
            total: {
              totalTokens: 12_345,
              inputTokens: 10_000,
              cachedInputTokens: 2_000,
              cacheWriteInputTokens: 0,
              outputTokens: 2_345,
              reasoningOutputTokens: 1_000,
            },
            last: {
              totalTokens: 12_345,
              inputTokens: 10_000,
              cachedInputTokens: 2_000,
              cacheWriteInputTokens: 0,
              outputTokens: 2_345,
              reasoningOutputTokens: 1_000,
            },
            modelContextWindow: 100_000,
            contextUsedPercent: 12.3,
          },
        },
      ]),
    ]);

    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      kind: "turn",
      messages: [{ content: [{ activity: { type: "command" } }] }],
    });
    expect(timeline[2]).toMatchObject({
      type: "message",
      message: { id: "answer" },
      turnMetadata: { durationMs: 2_000, totalTokens: 12_345 },
    });

    const simpleTimeline = buildChatTimeline([
      message("simple-user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Say hello" },
      ]),
      message("simple-answer", "assistant", "2026-08-07T12:00:02.000Z", [
        { type: "text", text: "Hello", phase: "final_answer" },
      ]),
      message("simple-summary", "assistant", "2026-08-07T12:00:03.000Z", [
        {
          type: "activity",
          activity: {
            type: "turnSummary",
            id: "turn:simple:summary",
            status: "completed",
            durationMs: 2_000,
            startedAt: 1_786_104_000,
            completedAt: 1_786_104_002,
          },
        },
      ]),
    ]);
    expect(simpleTimeline.map((entry) => entry.type)).toEqual([
      "message",
      "message",
    ]);
    expect(simpleTimeline[1]).toMatchObject({
      type: "message",
      message: { id: "simple-answer" },
      turnMetadata: { durationMs: 2_000, totalTokens: null },
    });
  });

  it("formats compact final-answer metadata", () => {
    expect(
      formatTurnMetadata({ durationMs: 12_345, totalTokens: 12_345 }),
    ).toBe("12,345tok · 12.3s");
    expect(formatTurnMetadata({ durationMs: 62_000, totalTokens: null })).toBe(
      "1m 2s",
    );
    expect(formatTurnMetadata(null)).toBeNull();
  });

  it("does not show rate-limit telemetry in the chat timeline", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Run pwd" },
      ]),
      message("commentary", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "text",
          text: "I’ll run only pwd.",
          phase: "commentary",
        },
      ]),
      message("rate-limit", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "activity",
          activity: {
            type: "rateLimit",
            id: "turn:turn-1:rate-limit",
            status: "completed",
            limitId: "codex",
            limitName: null,
            planType: "pro",
            reachedType: null,
            primary: {
              usedPercent: 61,
              windowDurationMins: 300,
              resetsAt: null,
            },
            secondary: null,
          },
        },
      ]),
      message("answer", "assistant", "2026-08-07T12:00:03.000Z", [
        { type: "text", text: "Done.", phase: "final_answer" },
      ]),
    ]);

    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      kind: "turn",
      messages: [{ id: "commentary" }],
    });
    expect(JSON.stringify(timeline)).not.toContain("rateLimit");
  });

  it("carries metrics emitted before the final answer onto that answer", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Say hello" },
      ]),
      message("summary", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "turnSummary",
            id: "turn:early:summary",
            status: "completed",
            durationMs: 1_000,
            startedAt: 1_786_104_000,
            completedAt: 1_786_104_001,
          },
        },
      ]),
      message("answer", "assistant", "2026-08-07T12:00:02.000Z", [
        { type: "text", text: "Hello", phase: "final_answer" },
      ]),
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      type: "message",
      message: { id: "answer" },
      turnMetadata: { durationMs: 1_000, totalTokens: null },
    });
  });
});
