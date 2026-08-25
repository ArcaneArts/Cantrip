import type { AgentActivity, ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  INSPECT_COMMAND_CARD_DELAY_MS,
  INSPECT_COMMAND_CARD_EXIT_MS,
  INSPECT_COMPLETED_COMMAND_LIFETIME_MS,
  INSPECT_FILE_LIFETIME_MS,
  buildAgentInspectorProjectionSource,
  projectAgentInspector as projectAgentInspectorSource,
  type AgentInspectorCommand,
  type AgentInspectorFile,
  type AgentInspectorProjectionSource,
  type AgentInspectorRecentCommand,
  type AgentInspectorSnapshot,
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
    contextKind: "project",
    worktreeId: "worktree-primary",
    scratchRootId: null,
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

interface LegacyActivityRecord {
  activity: AgentActivity;
  message: ChatMessage;
  observedAtMs: number;
  turnId: string | null;
}

function legacyRecords(messages: ChatMessage[]): LegacyActivityRecord[] {
  return messages.flatMap((entry) =>
    entry.role === "assistant"
      ? entry.content.flatMap((content) =>
          content.type === "activity"
            ? [
                {
                  activity: content.activity,
                  message: entry,
                  observedAtMs:
                    content.activity.updatedAtMs ??
                    content.activity.completedAtMs ??
                    content.activity.startedAtMs ??
                    Date.parse(entry.createdAt),
                  turnId: content.activity.correlation?.turnId ?? null,
                },
              ]
            : [],
        )
      : [],
  );
}

function legacyProjectAgentInspector(input: {
  nowMs: number;
  records: readonly LegacyActivityRecord[];
  source: AgentInspectorProjectionSource;
}): AgentInspectorSnapshot {
  const fileMap = new Map<string, AgentInspectorFile>();
  const commands: AgentInspectorCommand[] = [];
  const recentCommands: AgentInspectorRecentCommand[] = [];

  for (const record of input.records) {
    if (record.activity.type === "fileChange") {
      for (const change of record.activity.changes) {
        const updatedAtMs = change.lastActivityAtMs ?? record.observedAtMs;
        const candidate: AgentInspectorFile = {
          id: `${record.activity.id}:${change.path}`,
          expiresAtMs: updatedAtMs + INSPECT_FILE_LIFETIME_MS,
          kind: change.kind,
          latestLine: change.latestLine ?? null,
          path: change.path,
          turnId: record.turnId,
          updatedAtMs,
        };
        const current = fileMap.get(change.path);
        if (
          !current ||
          candidate.updatedAtMs > current.updatedAtMs ||
          (candidate.updatedAtMs === current.updatedAtMs &&
            candidate.id.localeCompare(current.id) > 0)
        ) {
          fileMap.set(change.path, candidate);
        }
      }
      continue;
    }
    if (record.activity.type !== "command") continue;

    const activity = record.activity;
    const startedAtMs =
      activity.startedAtMs ?? Date.parse(record.message.createdAt);
    const completedAtMs =
      activity.status === "running"
        ? null
        : (activity.completedAtMs ?? record.observedAtMs);
    const elapsedMs = Math.max(0, (completedAtMs ?? input.nowMs) - startedAtMs);
    const presentation =
      completedAtMs === null
        ? input.nowMs - startedAtMs >= INSPECT_COMMAND_CARD_DELAY_MS
          ? "visible"
          : "hidden"
        : elapsedMs >= INSPECT_COMMAND_CARD_DELAY_MS &&
            input.nowMs < completedAtMs + INSPECT_COMMAND_CARD_EXIT_MS
          ? "exiting"
          : null;
    if (presentation) {
      commands.push({
        id: activity.id,
        command: activity.command,
        completedAtMs,
        cwd: activity.cwd,
        elapsedMs,
        exitCode: activity.exitCode,
        output: activity.outputTail ?? activity.output ?? "",
        outputTruncated: activity.outputTruncated ?? false,
        presentation,
        startedAtMs,
        status: activity.status,
        turnId: record.turnId,
        updatedAtMs: record.observedAtMs,
      });
    }
    if (
      completedAtMs !== null &&
      input.nowMs < completedAtMs + INSPECT_COMPLETED_COMMAND_LIFETIME_MS
    ) {
      recentCommands.push({
        id: activity.id,
        command: activity.command,
        completedAtMs,
        expiresAtMs: completedAtMs + INSPECT_COMPLETED_COMMAND_LIFETIME_MS,
        status: activity.status,
        turnId: record.turnId,
      });
    }
  }

  const files = [...fileMap.values()]
    .filter((file) => input.nowMs < file.expiresAtMs)
    .sort(
      (left, right) =>
        right.updatedAtMs - left.updatedAtMs ||
        left.path.localeCompare(right.path),
    );
  commands.sort(
    (left, right) =>
      left.startedAtMs - right.startedAtMs || left.id.localeCompare(right.id),
  );
  recentCommands.sort(
    (left, right) =>
      right.completedAtMs - left.completedAtMs ||
      left.id.localeCompare(right.id),
  );
  const transitions = [
    ...files.map((file) => file.expiresAtMs),
    ...recentCommands.map((command) => command.expiresAtMs),
    ...commands.flatMap((command) => {
      if (command.presentation === "hidden") {
        return [command.startedAtMs + INSPECT_COMMAND_CARD_DELAY_MS];
      }
      if (
        command.presentation === "exiting" &&
        command.completedAtMs !== null
      ) {
        return [command.completedAtMs + INSPECT_COMMAND_CARD_EXIT_MS];
      }
      return [];
    }),
  ].filter((transition) => transition > input.nowMs);

  return {
    active: true,
    commands,
    files,
    nextTransitionAtMs:
      transitions.length > 0 ? Math.min(...transitions) : null,
    recentCommands,
    thought: input.source.thought,
    turnId: input.source.turnId,
  };
}

function syntheticInspectorMessages(
  recordCount: number,
  sessionStartMs: number,
): ChatMessage[] {
  const messages = [user(1, sessionStartMs - 20_000)];
  for (let index = 0; index < recordCount; index += 1) {
    const sequence = index + 2;
    const id = `activity-${index}`;
    const variant = index % 6;
    if (variant === 0) {
      const updatedAtMs = sessionStartMs - (index % 200);
      messages.push(
        activityMessage(
          commandActivity({
            id,
            output: `running output ${index}`,
            startedAtMs: sessionStartMs - 5_000 - (index % 5_000),
            updatedAtMs,
          }),
          sequence,
          updatedAtMs,
        ),
      );
      continue;
    }
    if (variant === 2 || variant === 5) {
      const completedAtMs = sessionStartMs - (index % 2_500);
      messages.push(
        activityMessage(
          commandActivity({
            completedAtMs,
            id,
            output: `completed output ${index}`,
            startedAtMs: completedAtMs - (variant === 2 ? 2_000 : 750),
            status: "completed",
            updatedAtMs: completedAtMs,
          }),
          sequence,
          completedAtMs,
        ),
      );
      continue;
    }
    if (variant === 1 || variant === 4) {
      const updatedAtMs = sessionStartMs - (index % 9_000);
      messages.push(
        activityMessage(
          {
            type: "fileChange",
            id,
            status: "running",
            updatedAtMs,
            correlation: correlation("turn-1", id),
            changes: [
              {
                path: `src/generated/file-${index}.ts`,
                kind: index % 2 === 0 ? "update" : "add",
                latestLine: `const value${index} = ${index};`,
                lastActivityAtMs: updatedAtMs,
              },
            ],
          },
          sequence,
          updatedAtMs,
        ),
      );
      continue;
    }
    const updatedAtMs = sessionStartMs - (index % 1_000);
    messages.push(
      activityMessage(
        {
          type: "reasoning",
          id,
          status: "running",
          summary: [`Inspecting activity ${index}`],
          updatedAtMs,
          correlation: correlation("turn-1", id),
        },
        sequence,
        updatedAtMs,
      ),
    );
  }
  return messages;
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function measureInspectorSession(
  times: readonly number[],
  project: (nowMs: number) => AgentInspectorSnapshot,
): { checksum: number; elapsedMs: number } {
  let checksum = 0;
  const startedAt = performance.now();
  for (const nowMs of times) {
    const snapshot = project(nowMs);
    checksum +=
      snapshot.commands.length * 3 +
      snapshot.files.length * 5 +
      snapshot.recentCommands.length * 7 +
      (snapshot.nextTransitionAtMs ?? 0);
  }
  return { checksum, elapsedMs: performance.now() - startedAt };
}

const INSPECT_BENCHMARK_TICK_MS = 250;

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

  it("preindexes stable activity state while preserving every timed projection", () => {
    const sessionStartMs = 100_000;
    const messages = syntheticInspectorMessages(180, sessionStartMs);
    const source = buildAgentInspectorProjectionSource(messages);
    const records = legacyRecords(messages);

    expect(source.transitionTimesMs).toEqual(
      [...source.transitionTimesMs].sort((left, right) => left - right),
    );
    for (let tick = 0; tick < 240; tick += 1) {
      const nowMs = sessionStartMs + tick * INSPECT_BENCHMARK_TICK_MS;
      expect(
        projectAgentInspectorSource({ active: true, nowMs, source }),
      ).toEqual(legacyProjectAgentInspector({ nowMs, records, source }));
    }
  });
});

const benchmarkInspectorProjection =
  (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.CANTRIP_BENCHMARK_AGENT_INSPECT === "1"
    ? it
    : it.skip;

benchmarkInspectorProjection(
  "benchmarks a 60-second open inspector session",
  () => {
    const results: Array<Record<string, number>> = [];
    for (const recordCount of [10, 100, 1_000]) {
      const sessionStartMs = 1_000_000;
      const messages = syntheticInspectorMessages(recordCount, sessionStartMs);
      const source = buildAgentInspectorProjectionSource(messages);
      const records = legacyRecords(messages);
      const times = Array.from(
        { length: 240 },
        (_, tick) => sessionStartMs + tick * INSPECT_BENCHMARK_TICK_MS,
      );
      const baseline = (nowMs: number) =>
        legacyProjectAgentInspector({ nowMs, records, source });
      const candidate = (nowMs: number) =>
        projectAgentInspectorSource({ active: true, nowMs, source });

      for (const nowMs of times) {
        expect(candidate(nowMs)).toEqual(baseline(nowMs));
      }
      for (let warmup = 0; warmup < 5; warmup += 1) {
        measureInspectorSession(times, baseline);
        measureInspectorSession(times, candidate);
      }

      const baselineSamples: number[] = [];
      const candidateSamples: number[] = [];
      for (let iteration = 0; iteration < 25; iteration += 1) {
        const first =
          iteration % 2 === 0
            ? measureInspectorSession(times, baseline)
            : measureInspectorSession(times, candidate);
        const second =
          iteration % 2 === 0
            ? measureInspectorSession(times, candidate)
            : measureInspectorSession(times, baseline);
        const baselineResult = iteration % 2 === 0 ? first : second;
        const candidateResult = iteration % 2 === 0 ? second : first;
        expect(candidateResult.checksum).toBe(baselineResult.checksum);
        baselineSamples.push(baselineResult.elapsedMs);
        candidateSamples.push(candidateResult.elapsedMs);
      }

      const baselineP50Ms = percentile(baselineSamples, 0.5);
      const candidateP50Ms = percentile(candidateSamples, 0.5);
      results.push({
        recordCount,
        ticks: times.length,
        baselineP50Ms,
        baselineP95Ms: percentile(baselineSamples, 0.95),
        candidateP50Ms,
        candidateP95Ms: percentile(candidateSamples, 0.95),
        speedup: baselineP50Ms / candidateP50Ms,
      });
      expect(candidateP50Ms).toBeLessThan(baselineP50Ms * 0.95);
    }
    console.info("agent-inspector-projection-benchmark", results);
  },
  120_000,
);
