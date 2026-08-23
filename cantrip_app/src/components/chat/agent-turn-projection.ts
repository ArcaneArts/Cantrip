import type { AgentActivity, AgentScope, ChatMessage } from "@cantrip/protocol";

import type { ChatTimelineEntry } from "./timeline";

type ChatMessageContentItem = ChatMessage["content"][number];

export type AgentTurnStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "idle";

export type AgentTurnStreamItem =
  | {
      key: string;
      type: "text";
      text: string;
      phase: string | null;
      messageId: string;
      sequence: number;
      createdAt: string;
    }
  | {
      key: string;
      type: "activity";
      activity: AgentActivity;
      messageId: string;
      sequence: number;
      createdAt: string;
    };

export interface AgentTurnParticipant {
  key: string;
  scope: AgentScope;
  status: AgentTurnStatus;
  active: boolean;
  firstSequence: number;
  lastSequence: number;
  lastActiveAtMs: number;
  taskSummary: string | null;
  latestActivity: AgentActivity | null;
  communications: Extract<AgentActivity, { type: "agentCommunication" }>[];
  stream: AgentTurnStreamItem[];
}

export interface AgentTurnProjection {
  agents: AgentTurnParticipant[];
  byKey: ReadonlyMap<string, AgentTurnParticipant>;
  rootMessages: ChatMessage[];
}

export type AgentTranscriptEntry =
  | { type: "timeline"; entry: ChatTimelineEntry }
  | { type: "agent"; agent: AgentTurnParticipant };

interface MutableParticipant {
  scope: AgentScope;
  firstSequence: number;
  lastSequence: number;
  lastActiveAtMs: number;
  stream: Map<string, AgentTurnStreamItem>;
}

export function agentTurnKey(
  rootTurnId: string,
  agentThreadId: string,
): string {
  return `${rootTurnId}\u001f${agentThreadId}`;
}

function contentScope(content: ChatMessageContentItem): AgentScope | null {
  if (content.type === "text") return content.agentScope ?? null;
  if (content.type === "activity") {
    return content.activity.agentScope ?? null;
  }
  return null;
}

function scopeRichness(scope: AgentScope): number {
  return (
    scope.agentPath.length * 4 +
    (scope.nickname ? 2 : 0) +
    (scope.role ? 1 : 0) +
    (scope.parentThreadId ? 1 : 0)
  );
}

function mergeScope(current: AgentScope, next: AgentScope): AgentScope {
  const preferred =
    scopeRichness(next) >= scopeRichness(current) ? next : current;
  const fallback = preferred === next ? current : next;
  return {
    ...preferred,
    agentPath:
      preferred.agentPath.length > 0 ? preferred.agentPath : fallback.agentPath,
    nickname: preferred.nickname ?? fallback.nickname,
    role: preferred.role ?? fallback.role,
    parentThreadId: preferred.parentThreadId ?? fallback.parentThreadId,
  };
}

function activityTime(activity: AgentActivity, createdAt: string): number {
  const recorded =
    activity.completedAtMs ?? activity.updatedAtMs ?? activity.startedAtMs;
  return recorded ?? (Date.parse(createdAt) || 0);
}

function streamTime(item: AgentTurnStreamItem): number {
  return item.type === "activity"
    ? activityTime(item.activity, item.createdAt)
    : Date.parse(item.createdAt) || 0;
}

function statusFromActivity(activity: AgentActivity): AgentTurnStatus | null {
  if (activity.type === "agentCommunication") {
    switch (activity.kind) {
      case "spawned":
        return activity.status === "running" ? "starting" : "running";
      case "waiting":
        return "waiting";
      case "returned":
        return "completed";
      case "interrupted":
        return "interrupted";
      case "failed":
        return "failed";
      case "messageSent":
      case "followupSent":
        return "running";
      case "statusChanged":
        break;
    }
  }
  if (activity.type === "turnSummary") {
    if (activity.status === "completed") return "completed";
    if (activity.status === "failed") return "failed";
  }
  if (activity.status === "running") return "running";
  if (activity.status === "failed") return "failed";
  return null;
}

function participantStatus(stream: AgentTurnStreamItem[]): AgentTurnStatus {
  let status: AgentTurnStatus = "idle";
  for (const item of stream) {
    if (item.type !== "activity") continue;
    status = statusFromActivity(item.activity) ?? status;
  }
  return status;
}

function taskSummary(stream: AgentTurnStreamItem[]): string | null {
  for (const item of stream) {
    if (
      item.type === "activity" &&
      item.activity.type === "agentCommunication" &&
      (item.activity.kind === "spawned" ||
        item.activity.kind === "followupSent") &&
      item.activity.message?.trim()
    ) {
      return item.activity.message.trim();
    }
  }
  return null;
}

function streamItemKey(
  message: ChatMessage,
  content: ChatMessageContentItem,
  index: number,
): string {
  if (content.type === "activity") {
    const scope = content.activity.agentScope;
    return scope
      ? `${scope.rootTurnId}:${scope.agentThreadId}:activity:${content.activity.id}`
      : `${message.id}:activity:${content.activity.id}`;
  }
  return `${message.id}:${content.type}:${index}`;
}

function isChildScope(scope: AgentScope | null): scope is AgentScope {
  return Boolean(scope && !scope.isRoot);
}

function participantReferencesActivity(
  activity: AgentActivity,
  agentThreadIds: ReadonlySet<string>,
): boolean {
  if (activity.type === "subAgent") {
    return agentThreadIds.has(activity.agentThreadId);
  }
  if (activity.type === "collabToolCall") {
    return (
      agentThreadIds.has(activity.senderThreadId) ||
      activity.receiverThreadIds.some((id) => agentThreadIds.has(id))
    );
  }
  return false;
}

function rootMessages(
  messages: readonly ChatMessage[],
  agentThreadIds: ReadonlySet<string>,
): ChatMessage[] {
  return messages.flatMap((message) => {
    const hasChildContent = message.content.some((content) =>
      isChildScope(contentScope(content)),
    );
    const hasRootContent = message.content.some((content) => {
      const scope = contentScope(content);
      if (scope?.isRoot) return true;
      if (scope) return false;
      return (
        content.type !== "attachment" &&
        !(
          content.type === "activity" &&
          (content.activity.type === "collabToolCall" ||
            content.activity.type === "subAgent")
        )
      );
    });
    const content = message.content.filter((item) => {
      if (isChildScope(contentScope(item))) return false;
      if (
        item.type === "activity" &&
        participantReferencesActivity(item.activity, agentThreadIds)
      ) {
        return false;
      }
      if (
        item.type === "attachment" &&
        message.role === "assistant" &&
        hasChildContent &&
        !hasRootContent
      ) {
        return false;
      }
      return true;
    });
    return content.length > 0 ? [{ ...message, content }] : [];
  });
}

export function buildAgentTurnProjection(
  messages: readonly ChatMessage[],
): AgentTurnProjection {
  const mutable = new Map<string, MutableParticipant>();
  const orderedMessages = [...messages].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (const message of orderedMessages) {
    message.content.forEach((content, index) => {
      const scope = contentScope(content);
      if (!isChildScope(scope) || content.type === "attachment") return;
      const key = agentTurnKey(scope.rootTurnId, scope.agentThreadId);
      const existing = mutable.get(key);
      const item: AgentTurnStreamItem =
        content.type === "text"
          ? {
              key: streamItemKey(message, content, index),
              type: "text",
              text: content.text,
              phase: content.phase ?? null,
              messageId: message.id,
              sequence: message.sequence,
              createdAt: message.createdAt,
            }
          : {
              key: streamItemKey(message, content, index),
              type: "activity",
              activity: content.activity,
              messageId: message.id,
              sequence: message.sequence,
              createdAt: message.createdAt,
            };
      const timestamp = streamTime(item);
      if (existing) {
        existing.scope = mergeScope(existing.scope, scope);
        existing.firstSequence = Math.min(
          existing.firstSequence,
          message.sequence,
        );
        existing.lastSequence = Math.max(
          existing.lastSequence,
          message.sequence,
        );
        existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, timestamp);
        existing.stream.set(item.key, item);
      } else {
        mutable.set(key, {
          scope,
          firstSequence: message.sequence,
          lastSequence: message.sequence,
          lastActiveAtMs: timestamp,
          stream: new Map([[item.key, item]]),
        });
      }
    });
  }

  const agents = [...mutable.entries()]
    .map(([key, value]): AgentTurnParticipant => {
      const stream = [...value.stream.values()].sort(
        (left, right) =>
          left.sequence - right.sequence ||
          streamTime(left) - streamTime(right) ||
          left.key.localeCompare(right.key),
      );
      const communications = stream.flatMap((item) =>
        item.type === "activity" && item.activity.type === "agentCommunication"
          ? [item.activity]
          : [],
      );
      const latestActivity = [...stream]
        .reverse()
        .find((item) => item.type === "activity");
      const status = participantStatus(stream);
      return {
        key,
        scope: value.scope,
        status,
        active:
          status === "starting" || status === "running" || status === "waiting",
        firstSequence: value.firstSequence,
        lastSequence: value.lastSequence,
        lastActiveAtMs: value.lastActiveAtMs,
        taskSummary: taskSummary(stream),
        latestActivity:
          latestActivity?.type === "activity" ? latestActivity.activity : null,
        communications,
        stream,
      };
    })
    .sort(
      (left, right) =>
        left.firstSequence - right.firstSequence ||
        left.scope.depth - right.scope.depth ||
        left.scope.agentPath
          .join("/")
          .localeCompare(right.scope.agentPath.join("/")) ||
        left.scope.agentThreadId.localeCompare(right.scope.agentThreadId),
    );
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const agentThreadIds = new Set(
    agents.map((agent) => agent.scope.agentThreadId),
  );
  return {
    agents,
    byKey,
    rootMessages: rootMessages(orderedMessages, agentThreadIds),
  };
}

function timelineSequence(entry: ChatTimelineEntry): number {
  return entry.type === "message"
    ? entry.message.sequence
    : Math.min(...entry.messages.map((message) => message.sequence));
}

export function mergeAgentCardsIntoTimeline(
  timeline: readonly ChatTimelineEntry[],
  agents: readonly AgentTurnParticipant[],
): AgentTranscriptEntry[] {
  return [
    ...timeline.map((entry): AgentTranscriptEntry => ({
      type: "timeline",
      entry,
    })),
    ...agents.map((agent): AgentTranscriptEntry => ({ type: "agent", agent })),
  ].sort((left, right) => {
    const leftSequence =
      left.type === "agent"
        ? left.agent.firstSequence
        : timelineSequence(left.entry);
    const rightSequence =
      right.type === "agent"
        ? right.agent.firstSequence
        : timelineSequence(right.entry);
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    if (left.type !== right.type) return left.type === "timeline" ? -1 : 1;
    if (left.type === "agent" && right.type === "agent") {
      return left.agent.key.localeCompare(right.agent.key);
    }
    return 0;
  });
}
