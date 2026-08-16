import type { AgentActivity, ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  INSPECT_COMMAND_CARD_DELAY_MS,
  INSPECT_COMMAND_CARD_EXIT_MS,
  INSPECT_COMPLETED_COMMAND_LIFETIME_MS,
  INSPECT_FILE_LIFETIME_MS,
  buildAgentInspectorProjectionSource,
  projectAgentInspector as projectAgentInspectorSource,
} from "./inspect-model";

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
    diagnosticId: null,
    threadId: "thread-1",
    turnId,
    itemId,
  };
}

function user(sequence = 1, createdAtMs = 100): ChatMessage {
  return message("user", sequence, "user", createdAtMs, [
    { type: "text", text: "Do the work" },
  ]);
}

function activityMessage(
  activity: AgentActivity,
  sequence: number,
  createdAtMs: number,
  id = `${activity.type}-${activity.id}-${sequence}`,
): ChatMessage {
  return message(id, sequence, "assistant", createdAtMs, [
    { type: "activity", activity },
  ]);
}

function commandActivity(input: {
  completedAtMs?: number | null;
  id?: string;
  output?: string;
  startedAtMs: number;
  status?: "running" | "completed" | "failed";
  turnId?: string;
  updatedAtMs: number;
}): Extract<AgentActivity, { type: "command" }> {
  const id = input.id ?? "command-1";
  const status = input.status ?? "running";
  return {
    type: "command",
    id,
    command: `run ${id}`,
    cwd: ".",
    status,
    exitCode: status === "running" ? null : status === "completed" ? 0 : 1,
    output: null,
    outputTail: input.output ?? "",
    outputTruncated: false,
    startedAtMs: input.startedAtMs,
    updatedAtMs: input.updatedAtMs,
    completedAtMs:
      input.completedAtMs === undefined
        ? status === "running"
          ? null
          : input.updatedAtMs
        : input.completedAtMs,
    correlation: correlation(input.turnId ?? "turn-1", id),
  };
}

function projectAgentInspector(input: {
  active: boolean;
  messages: ChatMessage[];
  nowMs: number;
}) {
  return projectAgentInspectorSource({
    active: input.active,
    nowMs: input.nowMs,
    source: buildAgentInspectorProjectionSource(input.messages),
  });
}

describe("agent inspector projection", () => {
  it("applies exact command entry, exit, and completion boundaries", () => {
    const running = activityMessage(
      commandActivity({ startedAtMs: 1_000, updatedAtMs: 1_100 }),
      2,
      1_100,
    );
    const beforeEntry = projectAgentInspector({
      active: true,
      messages: [user(), running],
      nowMs: 1_000 + INSPECT_COMMAND_CARD_DELAY_MS - 1,
    });
    expect(beforeEntry.commands).toMatchObject([
      { id: "command-1", presentation: "hidden" },
    ]);
    expect(beforeEntry.nextTransitionAtMs).toBe(
      1_000 + INSPECT_COMMAND_CARD_DELAY_MS,
    );

    expect(
      projectAgentInspector({
        active: true,
        messages: [user(), running],
        nowMs: 1_000 + INSPECT_COMMAND_CARD_DELAY_MS,
      }).commands,
    ).toMatchObject([{ id: "command-1", presentation: "visible" }]);

    const completedAtMs = 2_500;
    const completed = activityMessage(
      commandActivity({
        completedAtMs,
        startedAtMs: 1_000,
        status: "completed",
        updatedAtMs: completedAtMs,
      }),
      2,
      completedAtMs,
    );
    expect(
      projectAgentInspector({
        active: true,
        messages: [user(), completed],
        nowMs: completedAtMs,
      }).commands,
    ).toMatchObject([{ id: "command-1", presentation: "exiting" }]);
    expect(
      projectAgentInspector({
        active: true,
        messages: [user(), completed],
        nowMs: completedAtMs + INSPECT_COMMAND_CARD_EXIT_MS,
      }).commands,
    ).toEqual([]);

    const recentBeforeExpiry = projectAgentInspector({
      active: true,
      messages: [user(), completed],
      nowMs: completedAtMs + INSPECT_COMPLETED_COMMAND_LIFETIME_MS - 1,
    });
    expect(recentBeforeExpiry.recentCommands).toHaveLength(1);
    expect(
      projectAgentInspector({
        active: true,
        messages: [user(), completed],
        nowMs: completedAtMs + INSPECT_COMPLETED_COMMAND_LIFETIME_MS,
      }).recentCommands,
    ).toEqual([]);
  });

  it("never projects a terminal card for a sub-second command", () => {
    const completedAtMs = 1_999;
    const snapshot = projectAgentInspector({
      active: true,
      messages: [
        user(),
        activityMessage(
          commandActivity({
            completedAtMs,
            startedAtMs: 1_000,
            status: "completed",
            updatedAtMs: completedAtMs,
          }),
          2,
          completedAtMs,
        ),
      ],
      nowMs: completedAtMs,
    });
    expect(snapshot.commands).toEqual([]);
    expect(snapshot.recentCommands).toMatchObject([{ id: "command-1" }]);
  });

  it("expires active files at ten seconds and keeps the newest path update", () => {
    const fileActivity = activityMessage(
      {
        type: "fileChange",
        id: "files-1",
        status: "running",
        updatedAtMs: 2_000,
        correlation: correlation("turn-1", "files-1"),
        changes: [
          {
            path: "src/path with spaces.ts",
            kind: "update",
            latestLine: "const oldValue = true;",
            lastActivityAtMs: 1_900,
          },
          {
            path: "assets/image.png",
            kind: "update",
            lastActivityAtMs: 2_000,
          },
        ],
      },
      2,
      2_000,
    );
    const newerFileActivity = activityMessage(
      {
        type: "fileChange",
        id: "files-2",
        status: "running",
        updatedAtMs: 2_100,
        correlation: correlation("turn-1", "files-2"),
        changes: [
          {
            path: "src/path with spaces.ts",
            kind: "update",
            latestLine: "const newValue = true;",
            lastActivityAtMs: 2_100,
          },
        ],
      },
      3,
      2_100,
    );
    const beforeExpiry = projectAgentInspector({
      active: true,
      messages: [user(), newerFileActivity, fileActivity],
      nowMs: 2_100 + INSPECT_FILE_LIFETIME_MS - 1,
    });
    expect(beforeExpiry.files).toMatchObject([
      {
        path: "src/path with spaces.ts",
        latestLine: "const newValue = true;",
      },
    ]);
    expect(
      projectAgentInspector({
        active: true,
        messages: [user(), newerFileActivity, fileActivity],
        nowMs: 2_100 + INSPECT_FILE_LIFETIME_MS,
      }).files,
    ).toEqual([]);
  });

  it("retains the latest visible thought while commands and files update", () => {
    const commentary = message("commentary", 2, "assistant", 1_000, [
      {
        type: "text",
        text: "I am checking the runtime behavior.",
        phase: "commentary",
        correlation: correlation("turn-1", "message-1"),
      },
    ]);
    const reasoning = activityMessage(
      {
        type: "reasoning",
        id: "reasoning-1",
        status: "running",
        summary: ["The reconnect path needs a stable projection."],
        updatedAtMs: 1_500,
        correlation: correlation("turn-1", "reasoning-1"),
      },
      3,
      1_500,
    );
    const command = activityMessage(
      commandActivity({ startedAtMs: 1_600, updatedAtMs: 4_000 }),
      4,
      1_600,
    );
    const snapshot = projectAgentInspector({
      active: true,
      messages: [command, user(), commentary, reasoning],
      nowMs: 4_000,
    });
    expect(snapshot.thought).toMatchObject({
      kind: "reasoning",
      text: "The reconnect path needs a stable projection.",
    });
    expect(snapshot.commands).toHaveLength(1);
  });

  it("does not treat a mid-turn system activity notice as a turn boundary", () => {
    const reasoning = activityMessage(
      {
        type: "reasoning",
        id: "reasoning-before-notice",
        status: "running",
        summary: ["The provider route is still active."],
        updatedAtMs: 1_500,
        correlation: correlation("turn-1", "reasoning-before-notice"),
      },
      2,
      1_500,
    );
    const notice = message("system-notice", 3, "system", 1_700, [
      {
        type: "activity",
        activity: {
          type: "notice",
          id: "reasoning-adjustment",
          status: "completed",
          level: "warning",
          message: "Using the provider default reasoning effort.",
          details: null,
          willRetry: null,
        },
      },
    ]);
    const running = activityMessage(
      commandActivity({ startedAtMs: 1_800, updatedAtMs: 3_000 }),
      4,
      1_800,
    );
    const snapshot = projectAgentInspector({
      active: true,
      messages: [user(), reasoning, notice, running],
      nowMs: 3_000,
    });
    expect(snapshot.thought?.text).toBe("The provider route is still active.");
    expect(snapshot.commands).toHaveLength(1);
  });

  it("prefers terminal lifecycle updates across reordered duplicates", () => {
    const stale = activityMessage(
      commandActivity({
        id: "same-command",
        output: "partial",
        startedAtMs: 1_000,
        updatedAtMs: 1_500,
      }),
      4,
      1_500,
      "stale-command-copy",
    );
    const completed = activityMessage(
      commandActivity({
        completedAtMs: 2_000,
        id: "same-command",
        output: "complete",
        startedAtMs: 1_000,
        status: "completed",
        updatedAtMs: 2_000,
      }),
      2,
      2_000,
      "completed-command-copy",
    );
    const duplicate = activityMessage(
      completed.content[0]!.type === "activity"
        ? completed.content[0]!.activity
        : commandActivity({ startedAtMs: 1_000, updatedAtMs: 2_000 }),
      3,
      2_000,
      "duplicate-command-copy",
    );
    const snapshot = projectAgentInspector({
      active: true,
      messages: [stale, duplicate, user(), completed],
      nowMs: 2_000,
    });
    expect(snapshot.commands).toMatchObject([
      { id: "same-command", output: "complete", presentation: "exiting" },
    ]);
    expect(snapshot.recentCommands).toHaveLength(1);
  });

  it("hydrates identical running snapshots in reconnecting windows and sorts longest-running first", () => {
    const messages = [
      user(),
      activityMessage(
        commandActivity({
          id: "newest",
          output: "new output",
          startedAtMs: 3_000,
          updatedAtMs: 4_000,
        }),
        4,
        3_000,
      ),
      activityMessage(
        commandActivity({
          id: "oldest",
          output: "old output",
          startedAtMs: 1_000,
          updatedAtMs: 4_000,
        }),
        2,
        1_000,
      ),
      activityMessage(
        commandActivity({
          id: "middle",
          output: "middle output",
          startedAtMs: 2_000,
          updatedAtMs: 4_000,
        }),
        3,
        2_000,
      ),
    ];
    const snapshot = projectAgentInspector({
      active: true,
      messages,
      nowMs: 5_000,
    });
    const secondWindowSnapshot = projectAgentInspector({
      active: true,
      messages: structuredClone(messages),
      nowMs: 5_000,
    });
    expect(snapshot.commands.map((command) => command.id)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    expect(
      snapshot.commands.every(({ presentation }) => presentation === "visible"),
    ).toBe(true);
    expect(secondWindowSnapshot).toEqual(snapshot);
  });

  it("clears stale state on turn completion or a new terminal boundary", () => {
    const running = activityMessage(
      commandActivity({ startedAtMs: 1_000, updatedAtMs: 2_000 }),
      2,
      1_000,
    );
    expect(
      projectAgentInspector({
        active: false,
        messages: [user(), running],
        nowMs: 3_000,
      }),
    ).toEqual({
      active: false,
      commands: [],
      files: [],
      nextTransitionAtMs: null,
      recentCommands: [],
      thought: null,
      turnId: null,
    });

    const checkpoint = message("checkpoint", 3, "assistant", 2_500, [
      { type: "text", text: "Completed the first goal cycle." },
    ]);
    const betweenTurns = projectAgentInspector({
      active: true,
      messages: [user(), running, checkpoint],
      nowMs: 3_000,
    });
    expect(betweenTurns.commands).toEqual([]);
    expect(betweenTurns.thought).toBeNull();
  });

  it("isolates the newest correlated turn after reconnect", () => {
    const oldCommand = activityMessage(
      commandActivity({
        id: "old-turn-command",
        startedAtMs: 1_000,
        turnId: "turn-old",
        updatedAtMs: 5_000,
      }),
      2,
      1_000,
    );
    const newCommand = activityMessage(
      commandActivity({
        id: "new-turn-command",
        startedAtMs: 4_000,
        turnId: "turn-new",
        updatedAtMs: 6_000,
      }),
      3,
      4_000,
    );
    const snapshot = projectAgentInspector({
      active: true,
      messages: [newCommand, oldCommand, user()],
      nowMs: 6_000,
    });
    expect(snapshot.turnId).toBe("turn-new");
    expect(snapshot.commands.map(({ id }) => id)).toEqual(["new-turn-command"]);
  });
});
