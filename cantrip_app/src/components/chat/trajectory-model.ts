import type {
  AgentActivity,
  AgentScope,
  ChatMessage,
  CodexEventCorrelation,
  InferenceProgressSnapshot,
} from "@cantrip/protocol";

import type { InferenceProgressTrace } from "@/lib/inference-progress-history";

import { activityLabel } from "./activity";
import {
  agentTurnKey,
  buildAgentTurnProjection,
  type AgentTurnProjection,
  type AgentTurnParticipant,
  type AgentTurnStatus,
} from "./agent-turn-projection";
import {
  resolveTrajectoryTiming,
  type TrajectoryTimingQuality,
} from "./trajectory-timing";
import { settleRunningActivity } from "./timeline";

export type TrajectoryLane = "input" | "model" | "tools" | "changes";

export interface TrajectoryAgent {
  active: boolean;
  depth: number;
  key: string;
  label: string;
  lastActiveAtMs: number;
  parentThreadId: string | null;
  path: string[];
  root: boolean;
  status: AgentTurnStatus;
  threadId: string | null;
}

export interface TrajectoryEvent {
  activity: AgentActivity | null;
  agentDepth: number;
  agentIsRoot: boolean;
  agentKey: string;
  agentLabel: string;
  completedAtMs: number | null;
  contentIndex: number;
  diagnosticId: string | null;
  id: string;
  focusItemKey: string | null;
  itemId: string | null;
  kind: string;
  label: string;
  lane: TrajectoryLane;
  metrics?: Array<{ label: string; value: string }>;
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
  agents: TrajectoryAgent[];
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
  hiddenAgents: ReadonlySet<string>;
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
  agentScope: AgentScope | null;
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
    const scope =
      content.type === "activity"
        ? content.activity.agentScope
        : content.type === "text"
          ? content.agentScope
          : null;
    if (scope?.isRoot) return scope.rootTurnId;
  }
  for (const content of message.content) {
    const scope =
      content.type === "activity"
        ? content.activity.agentScope
        : content.type === "text"
          ? content.agentScope
          : null;
    if (scope) return scope.rootTurnId;
  }
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
  if (activity.type === "agentCommunication") {
    if (
      activity.kind === "spawned" ||
      activity.kind === "messageSent" ||
      activity.kind === "followupSent" ||
      activity.kind === "returned"
    ) {
      return "input";
    }
  }
  // Codex patch activity and Cantrip's worktree-diff fallback both arrive as
  // fileChange events, so this lane only represents confirmed filesystem writes.
  if (activity.type === "fileChange" && activity.changes.length > 0) {
    return "changes";
  }
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

function latestReasoningLines(summary: string[], limit = 3): string {
  return summary
    .flatMap((part) => part.split(/\r?\n/gu))
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .join(" · ");
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
      preview = latestReasoningLines(activity.summary);
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
    case "agentCommunication":
      preview = activity.message ?? activity.kind;
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
      (content) =>
        content.type === "text" &&
        content.phase !== "commentary" &&
        (content.agentScope?.isRoot ?? true),
    )
  );
}

function lifecycleKey(activity: AgentActivity): string {
  const owner = activity.agentScope
    ? `${activity.agentScope.rootTurnId}:${activity.agentScope.agentThreadId}`
    : (activity.correlation?.threadId ?? "root");
  const itemId = activity.correlation?.itemId;
  return itemId
    ? `${owner}:item:${activity.correlation?.turnId ?? "turn"}:${itemId}`
    : `${owner}:activity:${activity.type}:${activity.id}`;
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
        agentScope: content.activity.agentScope ?? null,
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
  agent: TrajectoryAgent,
  source: CodexEventCorrelation | null,
  focusItemKey: string | null,
): TrajectoryEvent {
  const eventAtMs = timestamp(message.createdAt);
  return {
    activity: null,
    agentDepth: agent.depth,
    agentIsRoot: agent.root,
    agentKey: agent.key,
    agentLabel: agent.label,
    completedAtMs: eventAtMs,
    contentIndex,
    diagnosticId: source?.diagnosticId ?? null,
    id: `${agent.key}:${kind}:${message.id}:${contentIndex}`,
    focusItemKey,
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

function scopeFromContent(
  content: ChatMessage["content"][number],
): AgentScope | null {
  if (content.type === "text") return content.agentScope ?? null;
  if (content.type === "activity") {
    return content.activity.agentScope ?? null;
  }
  return null;
}

function rootScope(messages: readonly ChatMessage[]): AgentScope | null {
  for (const message of messages) {
    for (const content of message.content) {
      const scope = scopeFromContent(content);
      if (scope?.isRoot) return scope;
    }
  }
  return null;
}

function participantLabel(participant: AgentTurnParticipant): string {
  return (
    participant.scope.nickname ??
    participant.scope.agentPath.at(-1) ??
    `Agent ${participant.scope.agentThreadId.slice(0, 8)}`
  );
}

export function orderTrajectoryAgents(
  agents: readonly TrajectoryAgent[],
): TrajectoryAgent[] {
  return [
    ...agents.filter((agent) => agent.root),
    ...agents.filter((agent) => !agent.root),
  ];
}

function trajectoryAgents(input: {
  agentProjection?: AgentTurnProjection;
  completed: boolean;
  failed: boolean;
  messages: readonly ChatMessage[];
  selectedKey: string;
}): TrajectoryAgent[] {
  const projection =
    input.agentProjection ?? buildAgentTurnProjection(input.messages);
  const scope = rootScope(input.messages);
  const inferredRootTurnId =
    scope?.rootTurnId ?? projection.agents[0]?.scope.rootTurnId ?? null;
  const childAgents = projection.agents
    .filter(
      (participant) =>
        !inferredRootTurnId ||
        participant.scope.rootTurnId === inferredRootTurnId,
    )
    .map((participant): TrajectoryAgent => {
      const active = !input.completed && participant.active;
      return {
        active,
        depth: participant.scope.depth,
        key: participant.key,
        label: participantLabel(participant),
        lastActiveAtMs: participant.lastActiveAtMs,
        parentThreadId: participant.scope.parentThreadId,
        path: participant.scope.agentPath,
        root: false,
        status:
          input.completed && participant.active
            ? "completed"
            : participant.status,
        threadId: participant.scope.agentThreadId,
      };
    });
  const rootThreadId =
    scope?.agentThreadId ??
    input.messages
      .flatMap((message) => message.content)
      .flatMap((content) => {
        if (content.type === "attachment") return [];
        const contentScope = scopeFromContent(content);
        const correlation =
          content.type === "text"
            ? content.correlation
            : content.activity.correlation;
        return !contentScope || contentScope.isRoot
          ? [correlation?.threadId ?? null]
          : [];
      })
      .find((threadId): threadId is string => Boolean(threadId)) ??
    null;
  const rootKey = scope
    ? agentTurnKey(scope.rootTurnId, scope.agentThreadId)
    : `root:${input.selectedKey}`;
  const lastActiveAtMs = Math.max(
    ...input.messages.map((message) => timestamp(message.createdAt)),
    0,
  );
  return orderTrajectoryAgents([
    {
      active: !input.completed,
      depth: 0,
      key: rootKey,
      label: "Root agent",
      lastActiveAtMs,
      parentThreadId: null,
      path: ["Root agent"],
      root: true,
      status: input.completed
        ? input.failed
          ? "failed"
          : "completed"
        : "running",
      threadId: rootThreadId,
    },
    ...childAgents,
  ]);
}

function eventAgent(
  scope: AgentScope | null,
  correlationThreadId: string | null | undefined,
  agents: readonly TrajectoryAgent[],
): TrajectoryAgent {
  const root = agents.find((agent) => agent.root)!;
  if (scope?.isRoot) return root;
  if (scope) {
    return (
      agents.find(
        (agent) =>
          agent.key === agentTurnKey(scope.rootTurnId, scope.agentThreadId),
      ) ?? root
    );
  }
  return (
    agents.find(
      (agent) => !agent.root && agent.threadId === correlationThreadId,
    ) ?? root
  );
}

function activityFocusItemKey(activity: AgentActivity): string | null {
  const scope = activity.agentScope;
  return scope && !scope.isRoot
    ? `${scope.rootTurnId}:${scope.agentThreadId}:activity:${activity.id}`
    : null;
}

function compactTokenCount(tokens: number): string {
  return tokens < 1_000 ? `${tokens}` : `${Math.round(tokens / 1_000)}k`;
}

function progressPercent(progress: InferenceProgressSnapshot): number | null {
  if (
    progress.precision === "indeterminate" ||
    progress.fractionComplete === null
  ) {
    return null;
  }
  return Math.min(100, Math.floor(progress.fractionComplete * 100));
}

function progressDurationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function inferenceProgressEvents(input: {
  agents: readonly TrajectoryAgent[];
  current: InferenceProgressSnapshot | null | undefined;
  history: readonly InferenceProgressTrace[] | undefined;
  messages: readonly ChatMessage[];
  nowMs: number;
}): TrajectoryEvent[] {
  const requestMessages = new Map(
    input.messages
      .filter((message) => message.role === "user")
      .map((message) => [message.id, message] as const),
  );
  const traces = new Map<string, InferenceProgressTrace>();
  for (const trace of input.history ?? []) {
    const { progress } = trace;
    if (
      progress.phase !== "prefill" ||
      !requestMessages.has(progress.requestId)
    ) {
      continue;
    }
    traces.set(`${progress.requestId}:${progress.cycle}`, trace);
  }
  if (
    input.current?.phase === "prefill" &&
    requestMessages.has(input.current.requestId)
  ) {
    traces.set(`${input.current.requestId}:${input.current.cycle}`, {
      completedAt: null,
      progress: input.current,
    });
  }
  const root = input.agents.find((agent) => agent.root);
  if (!root) return [];

  return [...traces.values()].map((trace) => {
    const { progress } = trace;
    const current =
      input.current?.requestId === progress.requestId &&
      input.current.cycle === progress.cycle;
    const startMs = Date.parse(progress.startedAt);
    const observedAtMs = Date.parse(progress.observedAt);
    const completedAtMs = trace.completedAt
      ? Date.parse(trace.completedAt)
      : observedAtMs;
    const running = Boolean(current);
    const endMs = Math.max(startMs, running ? input.nowMs : completedAtMs);
    const observedDurationMs = Math.max(0, observedAtMs - startMs);
    const durationMs = Math.max(0, endMs - startMs);
    const percent = progressPercent(progress);
    const observedTokensPerSecond =
      progress.completedTokens !== null && observedDurationMs >= 1_000
        ? Math.round(progress.completedTokens / (observedDurationMs / 1_000))
        : null;
    const tokenSummary =
      progress.completedTokens === null
        ? "Prompt token counts unavailable"
        : progress.totalTokens === null
          ? `${compactTokenCount(progress.completedTokens)} prompt tokens prefetched`
          : `${compactTokenCount(progress.completedTokens)} of ${compactTokenCount(progress.totalTokens)} prompt tokens`;
    const label = running
      ? percent === null
        ? "Prefilling prompt"
        : `Prefilling prompt ${percent}%`
      : "Prompt prefill completed";
    const preview = [
      tokenSummary,
      progressDurationLabel(durationMs),
      observedTokensPerSecond === null
        ? null
        : `${observedTokensPerSecond.toLocaleString()} tok/s observed`,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    const request = requestMessages.get(progress.requestId)!;
    const metrics = [
      ...(percent === null
        ? []
        : [{ label: "Progress", value: `${percent}%` }]),
      ...(progress.completedTokens === null
        ? []
        : [
            {
              label: "Prefilled tokens",
              value: progress.completedTokens.toLocaleString(),
            },
          ]),
      ...(progress.totalTokens === null
        ? []
        : [
            {
              label: "Prompt tokens",
              value: progress.totalTokens.toLocaleString(),
            },
          ]),
      { label: "Duration", value: progressDurationLabel(durationMs) },
      ...(observedTokensPerSecond === null
        ? []
        : [
            {
              label: "Observed rate",
              value: `${observedTokensPerSecond.toLocaleString()} tokens/s`,
            },
          ]),
      { label: "Precision", value: progress.precision },
      { label: "Source", value: progress.source },
    ];
    return {
      activity: null,
      agentDepth: root.depth,
      agentIsRoot: true,
      agentKey: root.key,
      agentLabel: root.label,
      completedAtMs: running ? null : endMs,
      contentIndex: -1,
      diagnosticId: null,
      focusItemKey: null,
      id: `inference-progress:${progress.requestId}:${progress.cycle}`,
      itemId: null,
      kind: "inferenceProgress",
      label,
      lane: "model",
      messageId: progress.requestId,
      metrics,
      preview,
      searchableText:
        `${label} ${preview} ${metrics.map((metric) => `${metric.label} ${metric.value}`).join(" ")}`.toLocaleLowerCase(),
      sequence: request.sequence,
      startMs,
      status: running ? "running" : "completed",
      threadId: root.threadId,
      timingQuality: "exact",
      turnId: null,
      updatedAtMs: endMs,
    };
  });
}

export function projectTrajectory(input: {
  active: boolean;
  agentProjection?: AgentTurnProjection;
  inferenceProgress?: InferenceProgressSnapshot | null;
  inferenceProgressHistory?: readonly InferenceProgressTrace[];
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
      content.type === "activity" &&
      content.activity.type === "turnSummary" &&
      (content.activity.agentScope?.isRoot ?? true)
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
  const terminalSummary = [...summaryActivities]
    .reverse()
    .find((activity) => activity.status !== "running");
  const terminalActivityStatus = completed
    ? terminalSummary?.status === "failed" ||
      terminalSummary?.status === "declined" ||
      terminal?.role === "system"
      ? "failed"
      : "completed"
    : null;
  const startedAtMs = summaryStartedAtMs ?? timestamp(opening.createdAt);
  const completedAtMs = completed
    ? (summaryCompletedAtMs ??
      (terminal ? timestamp(terminal.createdAt) : null) ??
      timestamp(selected.messages.at(-1)!.createdAt))
    : null;
  const agents = trajectoryAgents({
    agentProjection: input.agentProjection,
    completed,
    failed: terminalActivityStatus === "failed",
    messages: selected.messages,
    selectedKey: selected.key,
  });
  const progressEvents = inferenceProgressEvents({
    agents,
    current: input.inferenceProgress,
    history: input.inferenceProgressHistory,
    messages: selected.messages,
    nowMs: input.nowMs,
  });
  const livePrefill = progressEvents.some(
    (event) => event.status === "running",
  );

  const events: TrajectoryEvent[] = [];
  for (const message of selected.messages) {
    if (message.role === "user") {
      const firstTextIndex = message.content.findIndex(
        (content) => content.type === "text",
      );
      const firstText = message.content[firstTextIndex];
      const scope =
        firstText?.type === "text" ? (firstText.agentScope ?? null) : null;
      const source =
        firstText?.type === "text" ? (firstText.correlation ?? null) : null;
      const agent = eventAgent(scope, source?.threadId, agents);
      events.push(
        messageEvent(
          message,
          Math.max(0, firstTextIndex),
          "input",
          "User input",
          messageText(message),
          "input",
          agent,
          source,
          scope && !scope.isRoot
            ? `${message.id}:text:${Math.max(0, firstTextIndex)}`
            : null,
        ),
      );
      continue;
    }
    for (const [contentIndex, content] of message.content.entries()) {
      if (content.type !== "text") continue;
      const commentary = content.phase === "commentary";
      const scope = content.agentScope ?? null;
      const agent = eventAgent(scope, content.correlation?.threadId, agents);
      events.push(
        messageEvent(
          message,
          contentIndex,
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
          content.text,
          "model",
          agent,
          content.correlation ?? null,
          scope && !scope.isRoot ? `${message.id}:text:${contentIndex}` : null,
        ),
      );
    }
  }

  for (const [id, record] of collectActivityRecords(selected.messages)) {
    if (
      livePrefill &&
      record.activity.type === "turnSummary" &&
      record.activity.status === "running"
    ) {
      continue;
    }
    const activity = terminalActivityStatus
      ? settleRunningActivity(
          record.activity,
          terminalActivityStatus,
          completedAtMs,
        )
      : record.activity;
    const timing = resolveTrajectoryTiming({
      completedAtMs: activity.completedAtMs ?? record.completedAtMs,
      durationMs: activityDuration(activity),
      firstObservedAtMs: record.firstObservedAtMs,
      lastObservedAtMs: record.lastObservedAtMs,
      nowMs: input.nowMs,
      running: activity.status === "running",
      startedAtMs: record.startedAtMs,
      turnCompletedAtMs: completedAtMs,
      turnStartedAtMs: startedAtMs,
      updatedAtMs: activity.updatedAtMs ?? record.updatedAtMs,
    });
    const {
      label,
      preview,
      rawSearchText: protectedSearchText,
    } = activityPresentation(activity);
    const correlation = activity.correlation;
    const agent = eventAgent(record.agentScope, correlation?.threadId, agents);
    events.push({
      activity,
      agentDepth: agent.depth,
      agentIsRoot: agent.root,
      agentKey: agent.key,
      agentLabel: agent.label,
      completedAtMs: activity.status === "running" ? null : timing.endMs,
      contentIndex: record.contentIndex,
      diagnosticId: correlation?.diagnosticId ?? null,
      focusItemKey: activityFocusItemKey(activity),
      id,
      itemId: correlation?.itemId ?? null,
      kind: activity.type,
      label,
      lane: activityLane(activity),
      messageId: record.messageId,
      preview,
      searchableText:
        `${agent.label} ${agent.path.join(" ")} ${label} ${preview ?? ""} ${protectedSearchText}`.toLocaleLowerCase(),
      sequence: record.sequence,
      startMs: timing.startMs,
      status: activity.status,
      threadId: correlation?.threadId ?? null,
      timingQuality: timing.quality,
      turnId: correlation?.turnId ?? null,
      updatedAtMs: timing.endMs,
    });
  }
  events.push(...progressEvents);

  events.sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.sequence - right.sequence ||
      left.contentIndex - right.contentIndex ||
      left.id.localeCompare(right.id),
  );
  const endMs = completedAtMs ?? input.nowMs;
  const laneCounts = { input: 0, model: 0, tools: 0, changes: 0 };
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
    agents,
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
      !filters.hiddenAgents.has(event.agentKey) &&
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

export function trajectoryLaneLabel(lane: TrajectoryLane): string {
  if (lane === "changes") return "Made changes";
  return lane.replace(/^./u, (character) => character.toLocaleUpperCase());
}
