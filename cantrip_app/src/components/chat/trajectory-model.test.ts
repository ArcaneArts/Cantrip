import type { AgentActivity, AgentScope, ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  filterTrajectoryEvents,
  orderTrajectoryAgents,
  projectTrajectory,
  trajectoryEventKinds,
} from "./trajectory-model";

function message(
  id: string,
  sequence: number,
  role: ChatMessage["role"],
  createdAtMs: number,
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    worktreeId: "worktree-primary",
    executionLaneId: null,
    sequence,
    role,
    mode: "default",
    createdAt: new Date(createdAtMs).toISOString(),
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

function correlation(turnId: string, itemId: string) {
  return {
    sourceMethod: "item/completed",
    diagnosticId: "diagnostic-1",
    threadId: "thread-1",
    turnId,
    itemId,
  };
}

function activityMessage(
  id: string,
  sequence: number,
  createdAtMs: number,
  activity: AgentActivity,
): ChatMessage {
  return message(id, sequence, "assistant", createdAtMs, [
    { type: "activity", activity },
  ]);
}

describe("trajectory projection", () => {
  it("pins root, preserves spawn order, and scopes events to tracks", () => {
    const rootScope: AgentScope = {
      agentThreadId: "root-thread",
      rootThreadId: "root-thread",
      parentThreadId: null,
      rootTurnId: "root-turn",
      agentPath: ["root"],
      nickname: null,
      role: null,
      depth: 0,
      isRoot: true,
    };
    const scoutScope: AgentScope = {
      ...rootScope,
      agentThreadId: "scout-thread",
      parentThreadId: "root-thread",
      agentPath: ["root", "Scout"],
      nickname: "Scout",
      role: "explorer",
      depth: 1,
      isRoot: false,
    };
    const reviewerScope: AgentScope = {
      ...scoutScope,
      agentThreadId: "reviewer-thread",
      parentThreadId: "scout-thread",
      agentPath: ["root", "Scout", "Reviewer"],
      nickname: "Reviewer",
      role: "reviewer",
      depth: 2,
    };
    const turn = projectTrajectory({
      active: true,
      messages: [
        message("user", 1, "user", 1_000, [
          { type: "text", text: "Inspect in parallel" },
        ]),
        activityMessage("scout-spawn", 2, 1_100, {
          type: "agentCommunication",
          id: "scout-spawn",
          kind: "spawned",
          senderThreadId: "root-thread",
          receiverThreadIds: ["scout-thread"],
          message: "Inspect parsing",
          status: "completed",
          updatedAtMs: 1_100,
          agentScope: scoutScope,
        }),
        activityMessage("reviewer-spawn", 3, 1_300, {
          type: "agentCommunication",
          id: "reviewer-spawn",
          kind: "spawned",
          senderThreadId: "scout-thread",
          receiverThreadIds: ["reviewer-thread"],
          message: "Review parser findings",
          status: "completed",
          updatedAtMs: 1_300,
          agentScope: reviewerScope,
        }),
        activityMessage("reviewer-command", 4, 1_400, {
          type: "command",
          id: "reviewer-command",
          command: "pnpm test parser",
          cwd: "/workspace",
          status: "running",
          exitCode: null,
          output: null,
          updatedAtMs: 1_400,
          correlation: {
            ...correlation("reviewer-turn", "reviewer-command"),
            threadId: "reviewer-thread",
          },
          agentScope: reviewerScope,
        }),
        activityMessage("root-plan", 5, 1_500, {
          type: "plan",
          id: "root-plan",
          status: "completed",
          text: "Coordinate results",
          explanation: null,
          steps: [],
          agentScope: rootScope,
        }),
      ],
      nowMs: 1_600,
    });

    expect(turn?.key).toBe("runtime:root-turn");
    expect(turn?.agents.map((agent) => agent.label)).toEqual([
      "Root agent",
      "Scout",
      "Reviewer",
    ]);
    expect(turn?.agents.map((agent) => agent.depth)).toEqual([0, 1, 2]);
    const reviewerCommand = turn?.events.find(
      (event) => event.kind === "command",
    );
    expect(reviewerCommand).toMatchObject({
      agentDepth: 2,
      agentIsRoot: false,
      agentLabel: "Reviewer",
      focusItemKey: "root-turn:reviewer-thread:activity:reviewer-command",
    });
    expect(
      filterTrajectoryEvents(turn?.events ?? [], {
        hiddenAgents: new Set([reviewerCommand?.agentKey ?? "missing"]),
        hiddenKinds: new Set(),
        hiddenLanes: new Set(),
        hiddenStatuses: new Set(),
        hiddenTimingQualities: new Set(),
        query: "",
      }).some((event) => event.agentLabel === "Reviewer"),
    ).toBe(false);
  });

  it("pins root without reordering descendants when activity changes", () => {
    const agents = orderTrajectoryAgents([
      {
        active: false,
        depth: 1,
        key: "inactive",
        label: "Inactive",
        lastActiveAtMs: 5_000,
        parentThreadId: "root",
        path: ["root", "Inactive"],
        root: false,
        status: "completed",
        threadId: "inactive",
      },
      {
        active: false,
        depth: 0,
        key: "root",
        label: "Root agent",
        lastActiveAtMs: 1_000,
        parentThreadId: null,
        path: ["root"],
        root: true,
        status: "completed",
        threadId: "root",
      },
      {
        active: true,
        depth: 1,
        key: "active",
        label: "Active",
        lastActiveAtMs: 2_000,
        parentThreadId: "root",
        path: ["root", "Active"],
        root: false,
        status: "running",
        threadId: "active",
      },
    ]);
    expect(agents.map((agent) => agent.key)).toEqual([
      "root",
      "inactive",
      "active",
    ]);
  });

  it("treats prompts and returned results between agents as input", () => {
    const childScope: AgentScope = {
      agentThreadId: "child-thread",
      rootThreadId: "root-thread",
      parentThreadId: "root-thread",
      rootTurnId: "root-turn",
      agentPath: ["root", "Scout"],
      nickname: "Scout",
      role: "explorer",
      depth: 1,
      isRoot: false,
    };
    const turn = projectTrajectory({
      active: false,
      messages: [
        message("user", 1, "user", 1_000, [
          { type: "text", text: "Inspect this" },
        ]),
        activityMessage("spawned", 2, 1_100, {
          type: "agentCommunication",
          id: "spawned",
          kind: "spawned",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          message: "Inspect the parser",
          status: "completed",
          agentScope: childScope,
        }),
        activityMessage("returned", 3, 1_200, {
          type: "agentCommunication",
          id: "returned",
          kind: "returned",
          senderThreadId: "child-thread",
          receiverThreadIds: ["root-thread"],
          message: "The parser is safe",
          status: "completed",
          agentScope: childScope,
        }),
      ],
      nowMs: 1_300,
    });

    expect(
      turn?.events
        .filter((event) => event.kind === "agentCommunication")
        .map((event) => ({ lane: event.lane, preview: event.preview })),
    ).toEqual([
      { lane: "input", preview: "Inspect the parser" },
      { lane: "input", preview: "The parser is safe" },
    ]);
  });

  it("does not treat child final text or summaries as root completion", () => {
    const childScope: AgentScope = {
      agentThreadId: "child-thread",
      rootThreadId: "root-thread",
      parentThreadId: "root-thread",
      rootTurnId: "root-turn",
      agentPath: ["root", "Child"],
      nickname: "Child",
      role: null,
      depth: 1,
      isRoot: false,
    };
    const turn = projectTrajectory({
      active: true,
      messages: [
        message("user", 1, "user", 1_000, [
          { type: "text", text: "Keep working" },
        ]),
        message("child-final", 2, "assistant", 1_200, [
          {
            type: "text",
            text: "Child is done",
            phase: "final_answer",
            agentScope: childScope,
          },
        ]),
        activityMessage("child-summary", 3, 1_250, {
          type: "turnSummary",
          id: "child-summary",
          status: "failed",
          durationMs: 250,
          startedAt: 1,
          completedAt: 1.25,
          agentScope: childScope,
        }),
      ],
      nowMs: 1_300,
    });
    expect(turn?.completed).toBe(false);
    expect(turn?.agents[0]).toMatchObject({
      label: "Root agent",
      active: true,
      status: "running",
    });
    expect(
      turn?.events.find((event) => event.kind === "response"),
    ).toMatchObject({
      agentIsRoot: false,
      agentLabel: "Child",
    });
  });

  it("follows the newest turn and can resolve an older stable key", () => {
    const messages = [
      message("user-1", 1, "user", 1_000, [
        { type: "text", text: "First request" },
      ]),
      activityMessage("reasoning-1", 2, 1_100, {
        type: "reasoning",
        id: "reasoning-1",
        status: "completed",
        summary: ["First thought"],
        correlation: correlation("turn-1", "reasoning-1"),
      }),
      message("answer-1", 3, "assistant", 1_200, [
        { type: "text", text: "First answer", phase: "final_answer" },
      ]),
      message("user-2", 4, "user", 2_000, [
        { type: "text", text: "Second request" },
      ]),
      activityMessage("search-2", 5, 2_100, {
        type: "webSearch",
        id: "search-2",
        status: "running",
        query: "Cantrip trajectory",
        action: null,
        correlation: correlation("turn-2", "search-2"),
      }),
    ];

    const current = projectTrajectory({
      active: true,
      messages,
      nowMs: 2_500,
    });
    expect(current).toMatchObject({
      completed: false,
      key: "runtime:turn-2",
      nextTransitionAtMs: 3_000,
      ordinal: 2,
      runtimeTurnId: "turn-2",
      timelineEndMs: 2_500,
      timelineStartMs: 2_000,
      title: "Second request",
    });
    expect(current?.events.map((event) => event.kind)).toEqual([
      "input",
      "webSearch",
    ]);

    const historical = projectTrajectory({
      active: true,
      messages,
      nowMs: 2_500,
      targetTurnKey: "runtime:turn-1",
    });
    expect(historical).toMatchObject({
      completed: true,
      key: "runtime:turn-1",
      title: "First request",
    });
    expect(historical?.events.map((event) => event.kind)).toEqual([
      "input",
      "reasoning",
      "response",
    ]);
  });

  it("keeps steered input in the same runtime turn", () => {
    const turn = projectTrajectory({
      active: false,
      messages: [
        message("user-1", 1, "user", 1_000, [
          { type: "text", text: "Create the run configuration" },
        ]),
        activityMessage("reasoning-1", 2, 1_100, {
          type: "reasoning",
          id: "reasoning-1",
          status: "completed",
          summary: ["Preparing the configuration"],
          correlation: correlation("turn-1", "reasoning-1"),
        }),
        message("commentary-1", 3, "assistant", 1_200, [
          {
            type: "text",
            text: "The configuration is ready.",
            phase: "commentary",
          },
        ]),
        message("steer-1", 4, "user", 1_300, [
          { type: "text", text: "I could hear it" },
        ]),
        activityMessage("command-1", 5, 1_400, {
          type: "command",
          id: "command-1",
          status: "completed",
          command: "git status --short",
          cwd: "/workspace",
          exitCode: 0,
          output: "",
          correlation: correlation("turn-1", "command-1"),
        }),
        message("answer-1", 6, "assistant", 1_500, [
          {
            type: "text",
            text: "The run configuration works.",
            phase: "final_answer",
          },
        ]),
      ],
      nowMs: 1_500,
    });

    expect(turn).toMatchObject({
      key: "runtime:turn-1",
      laneCounts: { changes: 0, input: 2, model: 3, tools: 1 },
      ordinal: 1,
      title: "Create the run configuration",
    });
    expect(
      turn?.events.map((event) => ({
        kind: event.kind,
        label: event.label,
        preview: event.preview,
      })),
    ).toEqual([
      {
        kind: "input",
        label: "User input",
        preview: "Create the run configuration",
      },
      {
        kind: "reasoning",
        label: "Reasoned",
        preview: "Preparing the configuration",
      },
      {
        kind: "commentary",
        label: "Model commentary",
        preview: "The configuration is ready.",
      },
      { kind: "input", label: "User input", preview: "I could hear it" },
      {
        kind: "command",
        label: "git status --short",
        preview: "/workspace",
      },
      {
        kind: "response",
        label: "Assistant response",
        preview: "The run configuration works.",
      },
    ]);
  });

  it("previews the latest three non-empty reasoning lines", () => {
    const turn = projectTrajectory({
      active: true,
      messages: [
        message("user-1", 1, "user", 1_000, [
          { type: "text", text: "Inspect the project" },
        ]),
        activityMessage("reasoning-1", 2, 1_100, {
          type: "reasoning",
          id: "reasoning-1",
          status: "running",
          summary: [
            "Old line\n",
            "First current line\nSecond current line",
            "Third current line",
          ],
          correlation: correlation("turn-1", "reasoning-1"),
        }),
      ],
      nowMs: 1_200,
    });

    expect(
      turn?.events.find((event) => event.kind === "reasoning")?.preview,
    ).toBe("First current line · Second current line · Third current line");
  });

  it("merges lifecycle replacements and retains exact item timing", () => {
    const messages = [
      message("user", 1, "user", 1_000, [
        { type: "text", text: "Run the checks" },
      ]),
      activityMessage("command-running", 2, 1_100, {
        type: "command",
        id: "command-1",
        command: "pnpm test",
        cwd: "/workspace",
        status: "running",
        exitCode: null,
        output: null,
        outputTail: "starting",
        startedAtMs: 1_050,
        updatedAtMs: 1_100,
        completedAtMs: null,
        correlation: correlation("turn-1", "command-1"),
      }),
      activityMessage("command-completed", 3, 1_300, {
        type: "command",
        id: "command-1",
        command: "pnpm test",
        cwd: "/workspace",
        status: "completed",
        exitCode: 0,
        output: null,
        outputTail: "57 tests passed",
        startedAtMs: 1_050,
        updatedAtMs: 1_300,
        completedAtMs: 1_300,
        correlation: correlation("turn-1", "command-1"),
      }),
      message("answer", 4, "assistant", 1_400, [
        { type: "text", text: "Checks passed", phase: "final_answer" },
      ]),
    ];
    const turn = projectTrajectory({
      active: false,
      messages,
      nowMs: 1_400,
    });
    const commands = turn?.events.filter((event) => event.kind === "command");
    expect(commands).toHaveLength(1);
    expect(commands?.[0]).toMatchObject({
      completedAtMs: 1_300,
      itemId: "command-1",
      preview: "/workspace · 57 tests passed",
      startMs: 1_050,
      status: "completed",
      timingQuality: "exact",
      updatedAtMs: 1_300,
    });
    expect(turn?.laneCounts).toEqual({
      changes: 0,
      input: 1,
      model: 1,
      tools: 1,
    });
    expect(turn?.kindCounts).toEqual({ command: 1, input: 1, response: 1 });
    expect(turn?.nextTransitionAtMs).toBeNull();
  });

  it("labels completion-only MCP timing as derived", () => {
    const turn = projectTrajectory({
      active: false,
      messages: [
        message("user", 1, "user", 1_000, [
          { type: "text", text: "Create a worktree" },
        ]),
        activityMessage("mcp-failed", 2, 1_300, {
          type: "mcpToolCall",
          id: "mcp-1",
          status: "failed",
          server: "cantrip",
          tool: "worktree_create",
          error: "Unrecognized key: from",
          errorCode: "-32602",
          retryable: null,
          resultText: null,
          durationMs: null,
          updatedAtMs: 1_300,
          completedAtMs: 1_300,
          correlation: correlation("turn-1", "mcp-1"),
        }),
        message("answer", 3, "assistant", 1_400, [
          { type: "text", text: "The call failed.", phase: "final_answer" },
        ]),
      ],
      nowMs: 1_400,
    });
    const event = turn?.events.find(
      (candidate) => candidate.kind === "mcpToolCall",
    );
    expect(event).toMatchObject({
      preview: "Unrecognized key: from",
      status: "failed",
      timingQuality: "derived",
    });
  });

  it("settles stale running tools when the selected turn is no longer active", () => {
    const turn = projectTrajectory({
      active: false,
      messages: [
        message("user", 1, "user", 1_000, [
          { type: "text", text: "Inspect the graph" },
        ]),
        activityMessage("codegraph-running", 2, 1_100, {
          type: "mcpToolCall",
          id: "codegraph-1",
          status: "running",
          server: "codegraph",
          tool: "codegraph_explore",
          query: "project architecture",
          resultText: null,
          error: null,
          durationMs: null,
          correlation: correlation("turn-1", "codegraph-1"),
        }),
        message("answer", 3, "assistant", 1_300, [
          { type: "text", text: "Done", phase: "final_answer" },
        ]),
      ],
      nowMs: 1_400,
    });

    expect(
      turn?.events.find((event) => event.kind === "mcpToolCall"),
    ).toMatchObject({
      completedAtMs: 1_300,
      status: "completed",
    });
    expect(turn?.statusCounts.running).toBe(0);
    expect(turn?.nextTransitionAtMs).toBeNull();
  });

  it("merges file paths and labels honest timing fallbacks", () => {
    const messages = [
      message("user", 1, "user", 1_000, [
        { type: "text", text: "Change two files" },
      ]),
      activityMessage("files-running", 2, 1_100, {
        type: "fileChange",
        id: "files-1",
        status: "running",
        changes: [{ path: "src/a.ts", kind: "update" }],
        correlation: correlation("turn-1", "files-1"),
      }),
      activityMessage("files-completed", 3, 1_300, {
        type: "fileChange",
        id: "files-1",
        status: "completed",
        changes: [{ path: "src/b.ts", kind: "add" }],
        correlation: correlation("turn-1", "files-1"),
      }),
    ];
    const turn = projectTrajectory({
      active: false,
      messages,
      nowMs: 1_500,
    });
    const files = turn?.events.find((event) => event.kind === "fileChange");
    expect(files?.preview).toContain("update src/a.ts");
    expect(files?.preview).toContain("add src/b.ts");
    expect(files?.lane).toBe("changes");
    expect(files?.timingQuality).toBe("derived");
    expect(turn?.laneCounts).toEqual({
      changes: 1,
      input: 1,
      model: 0,
      tools: 0,
    });
  });

  it("filters projected events by lane, family, and local search", () => {
    const turn = projectTrajectory({
      active: false,
      messages: [
        message("user", 1, "user", 1_000, [
          { type: "text", text: "Find a needle" },
        ]),
        activityMessage("search", 2, 1_100, {
          type: "webSearch",
          id: "search-1",
          status: "completed",
          query: "needle docs",
          action: "searched",
          correlation: correlation("turn-1", "search-1"),
          raw: {
            schemaVersion: 1,
            request: null,
            response: {
              mediaType: "text/plain",
              text: "protected-only phrase",
              originalBytes: 21,
              truncated: false,
            },
            metadata: {},
          },
        }),
      ],
      nowMs: 1_200,
    });
    expect(trajectoryEventKinds(turn?.events ?? [])).toEqual([
      "input",
      "webSearch",
    ]);
    expect(
      filterTrajectoryEvents(turn?.events ?? [], {
        hiddenAgents: new Set(),
        hiddenKinds: new Set(),
        hiddenLanes: new Set(["input"]),
        hiddenStatuses: new Set(),
        hiddenTimingQualities: new Set(),
        query: "needle",
      }).map((event) => event.kind),
    ).toEqual(["webSearch"]);
    expect(
      filterTrajectoryEvents(turn?.events ?? [], {
        hiddenAgents: new Set(),
        hiddenKinds: new Set(["webSearch"]),
        hiddenLanes: new Set(),
        hiddenStatuses: new Set(),
        hiddenTimingQualities: new Set(),
        query: "",
      }).map((event) => event.kind),
    ).toEqual(["input"]);
    expect(
      filterTrajectoryEvents(turn?.events ?? [], {
        hiddenAgents: new Set(),
        hiddenKinds: new Set(),
        hiddenLanes: new Set(),
        hiddenStatuses: new Set(),
        hiddenTimingQualities: new Set(),
        query: "protected-only",
      }).map((event) => event.kind),
    ).toEqual(["webSearch"]);
    expect(
      filterTrajectoryEvents(turn?.events ?? [], {
        hiddenAgents: new Set(),
        hiddenKinds: new Set(),
        hiddenLanes: new Set(),
        hiddenStatuses: new Set(["completed"]),
        hiddenTimingQualities: new Set(),
        query: "",
      }),
    ).toEqual([]);
    expect(
      filterTrajectoryEvents(turn?.events ?? [], {
        hiddenAgents: new Set(),
        hiddenKinds: new Set(),
        hiddenLanes: new Set(),
        hiddenStatuses: new Set(),
        hiddenTimingQualities: new Set(["exact"]),
        query: "",
      }).map((event) => event.kind),
    ).toEqual(["webSearch"]);
  });
});
