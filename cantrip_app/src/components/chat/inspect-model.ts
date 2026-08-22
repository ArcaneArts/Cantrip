import type { AgentActivity, ChatMessage } from "@cantrip/protocol";

export const INSPECT_COMMAND_CARD_DELAY_MS = 1_000;
export const INSPECT_COMMAND_CARD_EXIT_MS = 250;
export const INSPECT_COMPLETED_COMMAND_LIFETIME_MS = 3_000;
export const INSPECT_FILE_LIFETIME_MS = 10_000;

type CommandActivity = Extract<AgentActivity, { type: "command" }>;
type FileActivity = Extract<AgentActivity, { type: "fileChange" }>;
type ReasoningActivity = Extract<AgentActivity, { type: "reasoning" }>;

export interface AgentInspectorThought {
  id: string;
  kind: "commentary" | "reasoning";
  text: string;
  turnId: string | null;
  updatedAtMs: number;
}

export interface AgentInspectorFile {
  id: string;
  expiresAtMs: number;
  kind: FileActivity["changes"][number]["kind"];
  latestLine: string | null;
  path: string;
  turnId: string | null;
  updatedAtMs: number;
}

export type AgentInspectorCommandPresentation =
  "hidden" | "visible" | "exiting";

export interface AgentInspectorCommand {
  id: string;
  command: string;
  completedAtMs: number | null;
  cwd: string;
  elapsedMs: number;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  presentation: AgentInspectorCommandPresentation;
  startedAtMs: number;
  status: CommandActivity["status"];
  turnId: string | null;
  updatedAtMs: number;
}

export interface AgentInspectorRecentCommand {
  id: string;
  command: string;
  completedAtMs: number;
  expiresAtMs: number;
  status: CommandActivity["status"];
  turnId: string | null;
}

export interface AgentInspectorSnapshot {
  active: boolean;
  commands: AgentInspectorCommand[];
  files: AgentInspectorFile[];
  nextTransitionAtMs: number | null;
  recentCommands: AgentInspectorRecentCommand[];
  thought: AgentInspectorThought | null;
  turnId: string | null;
}

export interface AgentInspectorProjectionSource {
  readonly commands: readonly AgentInspectorCommandSource[];
  readonly files: readonly AgentInspectorFile[];
  readonly recentCommands: readonly AgentInspectorRecentCommand[];
  readonly thought: AgentInspectorThought | null;
  readonly transitionTimesMs: readonly number[];
  readonly turnId: string | null;
}

export type AgentInspectorCommandSource = Omit<
  AgentInspectorCommand,
  "elapsedMs" | "presentation"
>;

interface ActivityRecord<T extends AgentActivity = AgentActivity> {
  activity: T;
  message: ChatMessage;
  observedAtMs: number;
  turnId: string | null;
}

interface ProjectionAccumulator {
  activities: Map<string, ActivityRecord>;
  thoughts: Map<string, AgentInspectorThought>;
}

function parsedTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function activityTime(activity: AgentActivity, message: ChatMessage): number {
  return (
    activity.updatedAtMs ??
    activity.completedAtMs ??
    activity.startedAtMs ??
    parsedTime(message.createdAt)
  );
}

function terminalBoundary(message: ChatMessage): boolean {
  if (message.role === "user") return true;
  if (message.role === "system") {
    return message.content.some((content) => content.type === "text");
  }
  if (message.role !== "assistant") return false;
  return message.content.some(
    (content) => content.type === "text" && content.phase !== "commentary",
  );
}

function boundarySequence(messages: ChatMessage[]): number {
  return messages.reduce(
    (latest, message) =>
      terminalBoundary(message) ? Math.max(latest, message.sequence) : latest,
    0,
  );
}

function activityLifecycleRank(activity: AgentActivity): number {
  return activity.status === "running" ? 0 : 1;
}

function newerActivity(
  current: ActivityRecord | undefined,
  candidate: ActivityRecord,
): boolean {
  if (!current) return true;
  if (candidate.observedAtMs !== current.observedAtMs) {
    return candidate.observedAtMs > current.observedAtMs;
  }
  const lifecycleDifference =
    activityLifecycleRank(candidate.activity) -
    activityLifecycleRank(current.activity);
  if (lifecycleDifference !== 0) return lifecycleDifference > 0;
  return candidate.message.sequence > current.message.sequence;
}

function thoughtFromReasoning(
  activity: ReasoningActivity,
  message: ChatMessage,
): AgentInspectorThought | null {
  const text = activity.summary.join("\n\n").trim();
  if (!text) return null;
  return {
    id: `reasoning:${activity.id}`,
    kind: "reasoning",
    text,
    turnId: activity.correlation?.turnId ?? null,
    updatedAtMs: activityTime(activity, message),
  };
}

function commentaryThoughts(message: ChatMessage): AgentInspectorThought[] {
  if (message.role !== "assistant") return [];
  const text = message.content
    .flatMap((content) =>
      content.type === "text" && content.phase === "commentary"
        ? [content.text]
        : [],
    )
    .join("\n\n")
    .trim();
  if (!text) return [];
  const turnId = message.content.find(
    (content) => content.type === "text" && content.phase === "commentary",
  );
  return [
    {
      id: `commentary:${message.id}`,
      kind: "commentary",
      text,
      turnId:
        turnId?.type === "text" ? (turnId.correlation?.turnId ?? null) : null,
      updatedAtMs: parsedTime(message.createdAt),
    },
  ];
}

function recordThought(
  thoughts: Map<string, AgentInspectorThought>,
  candidate: AgentInspectorThought,
): void {
  const current = thoughts.get(candidate.id);
  if (
    !current ||
    candidate.updatedAtMs > current.updatedAtMs ||
    (candidate.updatedAtMs === current.updatedAtMs &&
      candidate.text.localeCompare(current.text) > 0)
  ) {
    thoughts.set(candidate.id, candidate);
  }
}

function latestTurnId(
  messages: ChatMessage[],
  afterSequence: number,
): string | null {
  let latest: { sequence: number; time: number; turnId: string } | null = null;
  for (const message of messages) {
    if (message.sequence <= afterSequence) continue;
    for (const content of message.content) {
      const turnId =
        content.type === "activity"
          ? content.activity.correlation?.turnId
          : content.type === "text"
            ? content.correlation?.turnId
            : null;
      if (!turnId) continue;
      const time =
        content.type === "activity"
          ? activityTime(content.activity, message)
          : parsedTime(message.createdAt);
      if (
        !latest ||
        time > latest.time ||
        (time === latest.time && message.sequence > latest.sequence)
      ) {
        latest = { sequence: message.sequence, time, turnId };
      }
    }
  }
  return latest?.turnId ?? null;
}

function collectProjectionRecords(
  messages: ChatMessage[],
  afterSequence: number,
  turnId: string | null,
): ProjectionAccumulator {
  const accumulator: ProjectionAccumulator = {
    activities: new Map(),
    thoughts: new Map(),
  };
  for (const message of messages) {
    if (message.sequence <= afterSequence) continue;
    for (const thought of commentaryThoughts(message)) {
      if (turnId && thought.turnId && thought.turnId !== turnId) continue;
      recordThought(accumulator.thoughts, thought);
    }
    if (message.role !== "assistant") continue;
    for (const content of message.content) {
      if (content.type !== "activity") continue;
      const activityTurnId = content.activity.correlation?.turnId ?? null;
      if (turnId && activityTurnId && activityTurnId !== turnId) continue;
      const record: ActivityRecord = {
        activity: content.activity,
        message,
        observedAtMs: activityTime(content.activity, message),
        turnId: activityTurnId,
      };
      const key = `${content.activity.type}:${content.activity.id}`;
      const accepted = newerActivity(accumulator.activities.get(key), record);
      if (accepted) {
        accumulator.activities.set(key, record);
      }
      if (accepted && content.activity.type === "reasoning") {
        const thought = thoughtFromReasoning(content.activity, message);
        if (thought) recordThought(accumulator.thoughts, thought);
      }
    }
  }
  return accumulator;
}

function latestThought(
  thoughts: AgentInspectorThought[],
): AgentInspectorThought | null {
  return (
    [...thoughts].sort(
      (left, right) =>
        right.updatedAtMs - left.updatedAtMs || right.id.localeCompare(left.id),
    )[0] ?? null
  );
}

function indexFiles(records: Iterable<ActivityRecord>): AgentInspectorFile[] {
  const files = new Map<string, AgentInspectorFile>();
  for (const record of records) {
    if (record.activity.type !== "fileChange") continue;
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
      const current = files.get(change.path);
      if (
        !current ||
        candidate.updatedAtMs > current.updatedAtMs ||
        (candidate.updatedAtMs === current.updatedAtMs &&
          candidate.id.localeCompare(current.id) > 0)
      ) {
        files.set(change.path, candidate);
      }
    }
  }
  return [...files.values()].sort(
    (left, right) =>
      right.updatedAtMs - left.updatedAtMs ||
      left.path.localeCompare(right.path),
  );
}

function completedAt(record: ActivityRecord<CommandActivity>): number | null {
  if (record.activity.status === "running") return null;
  return record.activity.completedAtMs ?? record.observedAtMs;
}

function indexCommands(records: Iterable<ActivityRecord>): {
  commands: AgentInspectorCommandSource[];
  recentCommands: AgentInspectorRecentCommand[];
} {
  const commands: AgentInspectorCommandSource[] = [];
  const recentCommands: AgentInspectorRecentCommand[] = [];
  for (const untypedRecord of records) {
    if (untypedRecord.activity.type !== "command") continue;
    const record = untypedRecord as ActivityRecord<CommandActivity>;
    const activity = record.activity;
    const startedAtMs =
      activity.startedAtMs ?? parsedTime(record.message.createdAt);
    const completedAtMs = completedAt(record);
    const completedElapsedMs =
      completedAtMs === null ? null : Math.max(0, completedAtMs - startedAtMs);
    if (
      completedElapsedMs === null ||
      completedElapsedMs >= INSPECT_COMMAND_CARD_DELAY_MS
    ) {
      commands.push({
        id: activity.id,
        command: activity.command,
        completedAtMs,
        cwd: activity.cwd,
        exitCode: activity.exitCode,
        output: activity.outputTail ?? activity.output ?? "",
        outputTruncated: activity.outputTruncated ?? false,
        startedAtMs,
        status: activity.status,
        turnId: record.turnId,
        updatedAtMs: record.observedAtMs,
      });
    }
    if (completedAtMs !== null) {
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
  commands.sort(
    (left, right) =>
      left.startedAtMs - right.startedAtMs || left.id.localeCompare(right.id),
  );
  recentCommands.sort(
    (left, right) =>
      right.completedAtMs - left.completedAtMs ||
      left.id.localeCompare(right.id),
  );
  return { commands, recentCommands };
}

function transitionTimes(
  commands: readonly AgentInspectorCommandSource[],
  files: readonly AgentInspectorFile[],
  recentCommands: readonly AgentInspectorRecentCommand[],
): number[] {
  return [
    ...files.map((file) => file.expiresAtMs),
    ...recentCommands.map((command) => command.expiresAtMs),
    ...commands.map((command) =>
      command.completedAtMs === null
        ? command.startedAtMs + INSPECT_COMMAND_CARD_DELAY_MS
        : command.completedAtMs + INSPECT_COMMAND_CARD_EXIT_MS,
    ),
  ].sort((left, right) => left - right);
}

function firstTransitionAfter(
  transitionTimesMs: readonly number[],
  nowMs: number,
): number | null {
  let lower = 0;
  let upper = transitionTimesMs.length;
  while (lower < upper) {
    const middle = lower + ((upper - lower) >> 1);
    if (transitionTimesMs[middle]! <= nowMs) lower = middle + 1;
    else upper = middle;
  }
  return transitionTimesMs[lower] ?? null;
}

function projectCommands(
  commandSources: readonly AgentInspectorCommandSource[],
  nowMs: number,
): AgentInspectorCommand[] {
  const commands: AgentInspectorCommand[] = [];
  for (const command of commandSources) {
    const elapsedMs = Math.max(
      0,
      (command.completedAtMs ?? nowMs) - command.startedAtMs,
    );
    let presentation: AgentInspectorCommandPresentation | null = null;
    if (command.completedAtMs === null) {
      presentation =
        nowMs - command.startedAtMs >= INSPECT_COMMAND_CARD_DELAY_MS
          ? "visible"
          : "hidden";
    } else if (nowMs < command.completedAtMs + INSPECT_COMMAND_CARD_EXIT_MS) {
      presentation = "exiting";
    }
    if (presentation) commands.push({ ...command, elapsedMs, presentation });
  }
  return commands;
}

export function buildAgentInspectorProjectionSource(
  messages: ChatMessage[],
): AgentInspectorProjectionSource {
  const afterSequence = boundarySequence(messages);
  const turnId = latestTurnId(messages, afterSequence);
  const records = collectProjectionRecords(messages, afterSequence, turnId);
  const files = indexFiles(records.activities.values());
  const { commands, recentCommands } = indexCommands(
    records.activities.values(),
  );
  return {
    commands,
    files,
    recentCommands,
    thought: latestThought([...records.thoughts.values()]),
    transitionTimesMs: transitionTimes(commands, files, recentCommands),
    turnId,
  };
}

export function projectAgentInspector(input: {
  active: boolean;
  nowMs: number;
  source: AgentInspectorProjectionSource;
}): AgentInspectorSnapshot {
  if (!input.active) {
    return {
      active: false,
      commands: [],
      files: [],
      nextTransitionAtMs: null,
      recentCommands: [],
      thought: null,
      turnId: null,
    };
  }
  const commands = projectCommands(input.source.commands, input.nowMs);
  const files = input.source.files.filter(
    (file) => input.nowMs < file.expiresAtMs,
  );
  const recentCommands = input.source.recentCommands.filter(
    (command) => input.nowMs < command.expiresAtMs,
  );
  return {
    active: true,
    commands,
    files,
    nextTransitionAtMs: firstTransitionAfter(
      input.source.transitionTimesMs,
      input.nowMs,
    ),
    recentCommands,
    thought: input.source.thought,
    turnId: input.source.turnId,
  };
}
