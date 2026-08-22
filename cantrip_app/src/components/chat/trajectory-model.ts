import type { AgentActivity, ChatMessage } from "@cantrip/protocol";

import { activityLabel } from "./activity";
import {
  resolveTrajectoryTiming,
  type TrajectoryTimingQuality,
} from "./trajectory-timing";

export type TrajectoryLane = "input" | "model" | "tools";

export interface TrajectoryEvent {
  activity: AgentActivity | null;
  completedAtMs: number | null;
  contentIndex: number;
  diagnosticId: string | null;
  id: string;
  itemId: string | null;
  kind: string;
  label: string;
  lane: TrajectoryLane;
  messageId: string;
  preview: string | null;
  searchableText: string;
  sequence: number;
  startMs: number;
  status: AgentActivity["status"];
  threadId: string | null;
  timingQuality: TrajectoryTimingQuality;
  turnId: string | null;
  updatedAtMs: number;
}

export interface TrajectoryTurn {
  completed: boolean;
  completedAtMs: number | null;
  elapsedMs: number;
  events: TrajectoryEvent[];
  exactTimingComplete: boolean;
  key: string;
  kindCounts: Record<string, number>;
  laneCounts: Record<TrajectoryLane, number>;
  nextTransitionAtMs: number | null;
  ordinal: number;
  runtimeTurnId: string | null;
  startedAtMs: number;
  statusCounts: Record<AgentActivity["status"], number>;
  timelineEndMs: number;
  timelineStartMs: number;
  title: string;
}

export interface TrajectoryFilters {
  hiddenKinds: ReadonlySet<string>;
  hiddenLanes: ReadonlySet<TrajectoryLane>;
  hiddenStatuses: ReadonlySet<AgentActivity["status"]>;
  hiddenTimingQualities: ReadonlySet<TrajectoryTimingQuality>;
  query: string;
}

interface TurnSlice {
  key: string;
  messages: ChatMessage[];
  runtimeTurnId: string | null;
}

interface ActivityRecord {
  activity: AgentActivity;
  contentIndex: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  messageId: string;
  sequence: number;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  completedAtMs: number | null;
}

const messageActivityRecords = new WeakMap<ChatMessage, ActivityRecord[]>();
const activityPresentations = new WeakMap<
  AgentActivity,
  { label: string; preview: string | null; rawSearchText: string }
>();
const activityRichness = new WeakMap<AgentActivity, number>();

const terminalStatuses = new Set<AgentActivity["status"]>([
  "completed",
  "failed",
  "declined",
]);

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function correlationTurnId(message: ChatMessage): string | null {
  for (const content of message.content) {
    const turnId =
      content.type === "activity"
        ? content.activity.correlation?.turnId
        : content.type === "text"
          ? content.correlation?.turnId
          : null;
    if (turnId) return turnId;
  }
  return null;
}

function turnSlices(messages: readonly ChatMessage[]): TurnSlice[] {
  const ordered = [...messages].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      timestamp(left.createdAt) - timestamp(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  const slices: ChatMessage[][] = [];
  for (const message of ordered) {
    if (message.role === "user" || slices.length === 0) slices.push([]);
    slices.at(-1)!.push(message);
  }
  const projected = slices.map((turnMessages) => {
    const runtimeTurnId =
      turnMessages.map(correlationTurnId).find(Boolean) ?? null;
    const opening =
      turnMessages.find((message) => message.role === "user") ??
      turnMessages[0]!;
    return {
      key: runtimeTurnId ? `runtime:${runtimeTurnId}` : `legacy:${opening.id}`,
      messages: turnMessages,
      runtimeTurnId,
    };
  });
  const merged: TurnSlice[] = [];
  for (const slice of projected) {
    const previous = merged.at(-1);
    if (
      slice.runtimeTurnId &&
      previous?.runtimeTurnId === slice.runtimeTurnId
    ) {
      previous.messages.push(...slice.messages);
      continue;
    }
    merged.push(slice);
  }
  return merged;
}

function activityLane(activity: AgentActivity): TrajectoryLane {
  if (activity.type === "instructionContext") return "input";
  switch (activity.type) {
    case "reasoning":
    case "plan":
    case "contextCompaction":
    case "usage":
    case "rateLimit":
    case "turnSummary":
    case "notice":
      return "model";
    default:
      return "tools";
  }
}

function activityDuration(activity: AgentActivity): number | null {
  return "durationMs" in activity ? (activity.durationMs ?? null) : null;
}

function compactText(value: string | null | undefined, limit = 360): string {
  if (!value) return "";
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > limit
    ? `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
    : compact;
}

function activityPreview(activity: AgentActivity): string | null {
  let preview = "";
  switch (activity.type) {
    case "instructionContext":
      preview = activity.text ?? activity.sources.join(" · ");
      break;
    case "command":
      preview = [activity.cwd, activity.outputTail ?? activity.output]
        .map((part) => compactText(part))
        .filter(Boolean)
        .join(" · ");
      break;
    case "fileChange":
      preview = activity.changes
        .map((change) => `${change.kind} ${change.path}`)
        .join(" · ");
      break;
    case "worktree":
      preview = `${activity.operation} · ${activity.summary}`;
      break;
    case "plan":
      preview =
        activity.explanation ??
        activity.text ??
        activity.steps.map((step) => step.step).join(" · ");
      break;
    case "reasoning":
      preview = activity.summary.join(" · ");
      break;
    case "mcpToolCall":
      preview = activity.error ?? activity.query ?? activity.resultText ?? "";
      break;
    case "dynamicToolCall":
      preview =
        activity.success === null
          ? ""
          : activity.success
            ? "Succeeded"
            : "Failed";
      break;
    case "collabToolCall":
      preview = activity.prompt ?? activity.receiverThreadIds.join(", ");
      break;
    case "subAgent":
      preview = `${activity.kind} · ${activity.agentPath}`;
      break;
    case "webSearch":
      preview = activity.action ?? activity.query;
      break;
    case "imageView":
      preview = activity.path;
      break;
    case "reviewMode":
      preview = activity.review;
      break;
    case "notice":
      preview = activity.details ?? activity.message;
      break;
    case "usage":
      preview = `${activity.last.totalTokens.toLocaleString()} tokens`;
      break;
    case "rateLimit":
      preview = activity.limitName ?? activity.reachedType ?? "";
      break;
    case "turnSummary":
      preview = activity.durationMs === null ? "" : `${activity.durationMs} ms`;
      break;
    case "contextCompaction":
      preview = "Conversation context compacted";
      break;
  }
  const compact = compactText(preview);
  return compact || null;
}

function rawSearchText(activity: AgentActivity): string {
  return [activity.raw?.request?.text, activity.raw?.response?.text]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function terminalMessage(message: ChatMessage): boolean {
  if (message.role === "system") return true;
  return (
    message.role === "assistant" &&
    message.content.some(
      (content) => content.type === "text" && content.phase !== "commentary",
    )
  );
}

function lifecycleKey(activity: AgentActivity): string {
  const itemId = activity.correlation?.itemId;
  return itemId
    ? `item:${activity.correlation?.turnId ?? "turn"}:${itemId}`
    : `activity:${activity.type}:${activity.id}`;
}

function laterRecord(
  current: ActivityRecord,
  candidate: ActivityRecord,
): ActivityRecord {
  const currentTerminal = terminalStatuses.has(current.activity.status);
  const candidateTerminal = terminalStatuses.has(candidate.activity.status);
  if (candidateTerminal !== currentTerminal) {
    return candidateTerminal ? candidate : current;
  }
  const currentRichness =
    activityRichness.get(current.activity) ??
    JSON.stringify(current.activity).length;
  const candidateRichness =
    activityRichness.get(candidate.activity) ??
    JSON.stringify(candidate.activity).length;
  activityRichness.set(current.activity, currentRichness);
  activityRichness.set(candidate.activity, candidateRichness);
  if (candidateRichness !== currentRichness) {
    return candidateRichness > currentRichness ? candidate : current;
  }
  if (candidate.sequence !== current.sequence) {
    return candidate.sequence > current.sequence ? candidate : current;
  }
  return candidate.contentIndex >= current.contentIndex ? candidate : current;
}

function recordsForMessage(message: ChatMessage): ActivityRecord[] {
  const cached = messageActivityRecords.get(message);
  if (cached) return cached;
  const observedAtMs = timestamp(message.createdAt);
  const records = message.content.flatMap((content, contentIndex) => {
    if (content.type !== "activity") return [];
    return [
      {
        activity: content.activity,
        completedAtMs: content.activity.completedAtMs ?? null,
        contentIndex,
        firstObservedAtMs: observedAtMs,
        lastObservedAtMs: observedAtMs,
        messageId: message.id,
        sequence: message.sequence,
        startedAtMs: content.activity.startedAtMs ?? null,
        updatedAtMs: content.activity.updatedAtMs ?? null,
      },
    ];
  });
  messageActivityRecords.set(message, records);
  return records;
}

function mergeFileChanges(
  current: AgentActivity,
  candidate: AgentActivity,
  selected: AgentActivity,
): AgentActivity {
  if (current.type !== "fileChange" || candidate.type !== "fileChange") {
    return selected;
  }
  if (selected.type !== "fileChange") return selected;
  const changes = new Map(
    current.changes.map((change) => [change.path, change] as const),
  );
  for (const change of candidate.changes) changes.set(change.path, change);
  return { ...selected, changes: [...changes.values()] };
}

function collectActivityRecords(messages: readonly ChatMessage[]) {
  const records = new Map<string, ActivityRecord>();
  for (const message of messages) {
    for (const candidate of recordsForMessage(message)) {
      const key = lifecycleKey(candidate.activity);
      const current = records.get(key);
      if (!current) {
        records.set(key, candidate);
        continue;
      }
      const selected = laterRecord(current, candidate);
      records.set(key, {
        ...selected,
        activity: mergeFileChanges(
          current.activity,
          candidate.activity,
          selected.activity,
        ),
        completedAtMs:
          Math.max(current.completedAtMs ?? 0, candidate.completedAtMs ?? 0) ||
          null,
        firstObservedAtMs: Math.min(
          current.firstObservedAtMs,
          candidate.firstObservedAtMs,
        ),
        lastObservedAtMs: Math.max(
          current.lastObservedAtMs,
          candidate.lastObservedAtMs,
        ),
        startedAtMs:
          Math.min(
            current.startedAtMs ?? Infinity,
            candidate.startedAtMs ?? Infinity,
          ) === Infinity
            ? null
            : Math.min(
                current.startedAtMs ?? Infinity,
                candidate.startedAtMs ?? Infinity,
              ),
        updatedAtMs:
          Math.max(current.updatedAtMs ?? 0, candidate.updatedAtMs ?? 0) ||
          null,
      });
    }
  }
  return records;
}

function activityPresentation(activity: AgentActivity) {
  const cached = activityPresentations.get(activity);
  if (cached) return cached;
  const presentation = {
    label: activityLabel(activity),
    preview: activityPreview(activity),
    rawSearchText: rawSearchText(activity),
  };
  activityPresentations.set(activity, presentation);
  return presentation;
}

function messageText(message: ChatMessage): string {
  return message.content
    .flatMap((content) =>
      content.type === "text"
        ? [content.text]
        : content.type === "attachment"
          ? [content.attachment.fileName]
          : [],
    )
    .join("\n\n");
}

function messageEvent(
  message: ChatMessage,
  contentIndex: number,
  kind: string,
  label: string,
  preview: string,
  lane: TrajectoryLane,
): TrajectoryEvent {
  const eventAtMs = timestamp(message.createdAt);
  const correlation = message.content.find(
    (content) => content.type === "text" && content.correlation,
  );
  const source =
    correlation?.type === "text" ? correlation.correlation : undefined;
  return {
    activity: null,
    completedAtMs: eventAtMs,
    contentIndex,
    diagnosticId: source?.diagnosticId ?? null,
    id: `${kind}:${message.id}`,
    itemId: source?.itemId ?? null,
    kind,
    label,
    lane,
    messageId: message.id,
    preview: compactText(preview, 500) || null,
    searchableText: `${label} ${preview}`.toLocaleLowerCase(),
    sequence: message.sequence,
    startMs: eventAtMs,
    status: "completed",
    threadId: source?.threadId ?? null,
    timingQuality: "exact",
    turnId: source?.turnId ?? null,
    updatedAtMs: eventAtMs,
  };
}

function formatTurnTitle(opening: ChatMessage): string {
  const text = compactText(messageText(opening), 72);
  return text || "Agent turn";
}

export function projectTrajectory(input: {
  active: boolean;
  messages: readonly ChatMessage[];
  nowMs: number;
  targetTurnKey?: string | null;
}): TrajectoryTurn | null {
  const slices = turnSlices(input.messages);
  const selected = input.targetTurnKey
    ? slices.find((slice) => slice.key === input.targetTurnKey)
    : slices.at(-1);
  if (!selected || selected.messages.length === 0) return null;

  const opening =
    selected.messages.find((message) => message.role === "user") ??
    selected.messages[0]!;
  const summaryActivities = selected.messages.flatMap((message) =>
    message.content.flatMap((content) =>
      content.type === "activity" && content.activity.type === "turnSummary"
        ? [content.activity]
        : [],
    ),
  );
  const summaryStartedAtMs = summaryActivities
    .map((activity) =>
      activity.startedAt === null ? null : activity.startedAt * 1_000,
    )
    .find((value): value is number => value !== null);
  const summaryCompletedAtMs = [...summaryActivities]
    .reverse()
    .map((activity) =>
      activity.completedAt === null ? null : activity.completedAt * 1_000,
    )
    .find((value): value is number => value !== null);
  const terminal = [...selected.messages].reverse().find(terminalMessage);
  const followingCurrent = !input.targetTurnKey && selected === slices.at(-1);
  const completed = !followingCurrent || !input.active;
  const startedAtMs = summaryStartedAtMs ?? timestamp(opening.createdAt);
  const completedAtMs = completed
    ? (summaryCompletedAtMs ??
      (terminal ? timestamp(terminal.createdAt) : null) ??
      timestamp(selected.messages.at(-1)!.createdAt))
    : null;

  const events: TrajectoryEvent[] = [];
  for (const message of selected.messages) {
    if (message.role === "user") {
      events.push(
        messageEvent(
          message,
          0,
          "input",
          "User input",
          messageText(message),
          "input",
        ),
      );
      continue;
    }
    const texts = message.content.flatMap((content, contentIndex) =>
      content.type === "text" ? [{ content, contentIndex }] : [],
    );
    if (texts.length === 0) continue;
    const preview = texts.map(({ content }) => content.text).join("\n\n");
    const commentary = texts.every(
      ({ content }) => content.phase === "commentary",
    );
    events.push(
      messageEvent(
        message,
        texts[0]!.contentIndex,
        message.role === "system"
          ? "system"
          : commentary
            ? "commentary"
            : "response",
        message.role === "system"
          ? "System message"
          : commentary
            ? "Model commentary"
            : "Assistant response",
        preview,
        "model",
      ),
    );
  }

  for (const [id, record] of collectActivityRecords(selected.messages)) {
    const activity = record.activity;
    const timing = resolveTrajectoryTiming({
      completedAtMs: record.completedAtMs,
      durationMs: activityDuration(activity),
      firstObservedAtMs: record.firstObservedAtMs,
      lastObservedAtMs: record.lastObservedAtMs,
      nowMs: input.nowMs,
      running: activity.status === "running" && !completed,
      startedAtMs: record.startedAtMs,
      turnCompletedAtMs: completedAtMs,
      turnStartedAtMs: startedAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    const {
      label,
      preview,
      rawSearchText: protectedSearchText,
    } = activityPresentation(activity);
    const correlation = activity.correlation;
    events.push({
      activity,
      completedAtMs: activity.status === "running" ? null : timing.endMs,
      contentIndex: record.contentIndex,
      diagnosticId: correlation?.diagnosticId ?? null,
      id,
      itemId: correlation?.itemId ?? null,
      kind: activity.type,
      label,
      lane: activityLane(activity),
      messageId: record.messageId,
      preview,
      searchableText:
        `${label} ${preview ?? ""} ${protectedSearchText}`.toLocaleLowerCase(),
      sequence: record.sequence,
      startMs: timing.startMs,
      status: activity.status,
      threadId: correlation?.threadId ?? null,
      timingQuality: timing.quality,
      turnId: correlation?.turnId ?? null,
      updatedAtMs: timing.endMs,
    });
  }

  events.sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.sequence - right.sequence ||
      left.contentIndex - right.contentIndex ||
      left.id.localeCompare(right.id),
  );
  const endMs = completedAtMs ?? input.nowMs;
  const laneCounts = { input: 0, model: 0, tools: 0 };
  const statusCounts = { running: 0, completed: 0, failed: 0, declined: 0 };
  const kindCounts: Record<string, number> = {};
  for (const event of events) {
    laneCounts[event.lane] += 1;
    statusCounts[event.status] += 1;
    kindCounts[event.kind] = (kindCounts[event.kind] ?? 0) + 1;
  }
  const timelineStartMs = Math.min(
    startedAtMs,
    ...events.map((event) => event.startMs),
  );
  const timelineEndMs = Math.max(
    endMs,
    ...events.map((event) => event.updatedAtMs),
  );
  return {
    completed,
    completedAtMs,
    elapsedMs: Math.max(0, endMs - startedAtMs),
    events,
    exactTimingComplete: events.every(
      (event) => event.timingQuality === "exact",
    ),
    key: selected.key,
    kindCounts,
    laneCounts,
    nextTransitionAtMs: events.some((event) => event.status === "running")
      ? input.nowMs + 500
      : null,
    ordinal: slices.indexOf(selected) + 1,
    runtimeTurnId: selected.runtimeTurnId,
    startedAtMs,
    statusCounts,
    timelineEndMs,
    timelineStartMs,
    title: formatTurnTitle(opening),
  };
}

export function filterTrajectoryEvents(
  events: readonly TrajectoryEvent[],
  filters: TrajectoryFilters,
): TrajectoryEvent[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return events.filter(
    (event) =>
      !filters.hiddenLanes.has(event.lane) &&
      !filters.hiddenKinds.has(event.kind) &&
      !filters.hiddenStatuses.has(event.status) &&
      !filters.hiddenTimingQualities.has(event.timingQuality) &&
      (!query || event.searchableText.includes(query)),
  );
}

export function trajectoryEventKinds(
  events: readonly TrajectoryEvent[],
): string[] {
  return [...new Set(events.map((event) => event.kind))].sort((left, right) =>
    trajectoryKindLabel(left).localeCompare(trajectoryKindLabel(right)),
  );
}

export function trajectoryKindLabel(kind: string): string {
  return kind
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/^./u, (character) => character.toLocaleUpperCase());
}
