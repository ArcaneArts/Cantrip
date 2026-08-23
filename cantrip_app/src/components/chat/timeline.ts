import type { AgentActivity, ChatMessage } from "@cantrip/protocol";

export interface ChatTurnMetadata {
  durationMs: number | null;
  totalTokens: number | null;
}

export interface ChatTurnIdentity {
  turnId: string | null;
  turnKey: string;
}

export type ChatTimelineEntry =
  | {
      type: "message";
      message: ChatMessage;
      turnMetadata: ChatTurnMetadata | null;
    }
  | {
      type: "activityGroup";
      key: string;
      messages: ChatMessage[];
      startedAt: string;
      endedAt: string | null;
      turnId: string | null;
      turnKey: string;
    };

function activities(message: ChatMessage): AgentActivity[] | null {
  if (
    message.role !== "assistant" ||
    message.content.length === 0 ||
    message.content.some((item) => item.type !== "activity")
  ) {
    return null;
  }
  return message.content.map((item) => {
    if (item.type !== "activity") {
      throw new Error("Expected activity content.");
    }
    return item.activity;
  });
}

function precedingTurnStart(messages: ChatMessage[], index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message?.role === "user") return message.createdAt;
  }
  return messages[index]?.createdAt ?? new Date(0).toISOString();
}

function messageTurnId(message: ChatMessage | null | undefined): string | null {
  if (!message) return null;
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

function precedingTurnAnchor(
  messages: readonly ChatMessage[],
  index: number,
): ChatMessage | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message?.role === "user") return message;
  }
  return null;
}

export function resolveChatTurnIdentity(input: {
  messages: readonly ChatMessage[];
  startIndex: number;
  terminalMessage?: ChatMessage;
  turnMessages: readonly ChatMessage[];
}): ChatTurnIdentity {
  const openingMessage = precedingTurnAnchor(input.messages, input.startIndex);
  const turnId =
    input.turnMessages.map(messageTurnId).find(Boolean) ??
    messageTurnId(input.terminalMessage) ??
    messageTurnId(openingMessage);
  if (turnId) return { turnId, turnKey: `runtime:${turnId}` };

  const anchorId =
    openingMessage?.id ??
    input.turnMessages[0]?.id ??
    input.terminalMessage?.id ??
    "empty";
  return { turnId: null, turnKey: `legacy:${anchorId}` };
}

function terminalMessage(message: ChatMessage | undefined): boolean {
  if (!message) return false;
  if (message.role === "system") return true;
  if (message.role !== "assistant") return false;
  return message.content.some(
    (item) => item.type === "text" && item.phase !== "commentary",
  );
}

function workMessage(message: ChatMessage | undefined): boolean {
  return Boolean(
    message && message.role === "assistant" && !terminalMessage(message),
  );
}

function messageActivities(message: ChatMessage): AgentActivity[] {
  return message.content.flatMap((item) =>
    item.type === "activity" ? [item.activity] : [],
  );
}

function trailingTurnMetadata(activities: AgentActivity[]): boolean {
  return activities.every(
    (activity) =>
      activity.type === "usage" ||
      activity.type === "rateLimit" ||
      activity.type === "turnSummary",
  );
}

function activityTurnMetadata(
  activities: AgentActivity[],
): ChatTurnMetadata | null {
  const usage = [...activities]
    .reverse()
    .find((activity) => activity.type === "usage");
  const summary = [...activities]
    .reverse()
    .find(
      (activity) =>
        activity.type === "turnSummary" && activity.status !== "running",
    );
  const metadata = {
    durationMs: summary?.type === "turnSummary" ? summary.durationMs : null,
    totalTokens: usage?.type === "usage" ? usage.last.totalTokens : null,
  };
  return metadata.durationMs !== null || metadata.totalTokens !== null
    ? metadata
    : null;
}

function mergeTurnMetadata(
  current: ChatTurnMetadata | null,
  next: ChatTurnMetadata | null,
): ChatTurnMetadata | null {
  if (!next) return current;
  return {
    durationMs: next.durationMs ?? current?.durationMs ?? null,
    totalTokens: next.totalTokens ?? current?.totalTokens ?? null,
  };
}

export function settleRunningActivity(
  activity: AgentActivity,
  status: "completed" | "failed",
  completedAtMs: number | null = null,
): AgentActivity {
  return activity.status === "running"
    ? ({
        ...activity,
        status,
        ...(completedAtMs === null
          ? {}
          : {
              updatedAtMs: Math.max(activity.updatedAtMs ?? 0, completedAtMs),
              completedAtMs,
            }),
      } as AgentActivity)
    : activity;
}

function terminalActivityStatus(
  followingMessage: ChatMessage | undefined,
  turnSummary: AgentActivity | undefined,
): "completed" | "failed" | null {
  if (turnSummary?.type === "turnSummary") {
    return turnSummary.status === "completed" ? "completed" : "failed";
  }
  if (followingMessage?.role === "system") return "failed";
  return terminalMessage(followingMessage) ? "completed" : null;
}

function visibleWorkMessage(
  message: ChatMessage,
  terminalStatus: "completed" | "failed" | null,
): ChatMessage | null {
  const content = message.content
    .filter(
      (item) =>
        item.type !== "activity" ||
        (item.activity.type !== "usage" &&
          item.activity.type !== "rateLimit" &&
          item.activity.type !== "instructionContext" &&
          item.activity.type !== "turnSummary"),
    )
    .map((item) =>
      item.type === "activity" && terminalStatus
        ? {
            ...item,
            activity: settleRunningActivity(item.activity, terminalStatus),
          }
        : item,
    );
  return content.length > 0 ? { ...message, content } : null;
}

export function buildChatTimeline(
  messages: ChatMessage[],
): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [];
  const pendingTurnMetadata = new Map<string, ChatTurnMetadata>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (!workMessage(message)) {
      entries.push({
        type: "message",
        message,
        turnMetadata: pendingTurnMetadata.get(message.id) ?? null,
      });
      pendingTurnMetadata.delete(message.id);
      continue;
    }

    const groupedMessages = [message];
    let endIndex = index;
    while (workMessage(messages[endIndex + 1])) {
      groupedMessages.push(messages[endIndex + 1]!);
      endIndex += 1;
    }
    const grouped = groupedMessages.flatMap(messageActivities);
    const followingMessage = messages[endIndex + 1];
    const metadata = activityTurnMetadata(grouped);
    const turnSummary = [...grouped]
      .reverse()
      .find(
        (activity) =>
          activity.type === "turnSummary" && activity.status !== "running",
      );
    const terminalStatus = terminalActivityStatus(
      followingMessage,
      turnSummary,
    );
    const displayedMessages = groupedMessages.flatMap((groupedMessage) => {
      const visible = visibleWorkMessage(groupedMessage, terminalStatus);
      return visible ? [visible] : [];
    });
    const endedAt = terminalMessage(followingMessage)
      ? followingMessage!.createdAt
      : turnSummary?.type === "turnSummary" && turnSummary.completedAt !== null
        ? new Date(turnSummary.completedAt * 1_000).toISOString()
        : null;
    const identity = resolveChatTurnIdentity({
      messages,
      startIndex: index,
      terminalMessage: followingMessage,
      turnMessages: groupedMessages,
    });

    const previousMessageEntry = entries.at(-1);
    const previousActivityEntry = entries.at(-2);
    if (
      groupedMessages.every((groupedMessage) => {
        const groupedActivities = activities(groupedMessage);
        return (
          groupedActivities !== null && trailingTurnMetadata(groupedActivities)
        );
      }) &&
      previousMessageEntry?.type === "message" &&
      terminalMessage(previousMessageEntry.message)
    ) {
      previousMessageEntry.turnMetadata = mergeTurnMetadata(
        previousMessageEntry.turnMetadata,
        metadata,
      );
      if (previousActivityEntry?.type === "activityGroup") {
        const trailingIdentity = resolveChatTurnIdentity({
          messages,
          startIndex: index,
          terminalMessage: previousMessageEntry.message,
          turnMessages: [...previousActivityEntry.messages, ...groupedMessages],
        });
        previousActivityEntry.turnId = trailingIdentity.turnId;
        previousActivityEntry.turnKey = trailingIdentity.turnKey;
      }
      if (
        displayedMessages.length > 0 &&
        previousActivityEntry?.type === "activityGroup"
      ) {
        previousActivityEntry.messages.push(...displayedMessages);
      } else if (displayedMessages.length > 0) {
        entries.splice(entries.length - 1, 0, {
          type: "activityGroup",
          key: `activities:${message.id}`,
          messages: displayedMessages,
          startedAt: precedingTurnStart(messages, index),
          endedAt: previousMessageEntry.message.createdAt,
          turnId: identity.turnId,
          turnKey: identity.turnKey,
        });
      }
      index = endIndex;
      continue;
    }

    if (followingMessage && terminalMessage(followingMessage) && metadata) {
      pendingTurnMetadata.set(
        followingMessage.id,
        mergeTurnMetadata(
          pendingTurnMetadata.get(followingMessage.id) ?? null,
          metadata,
        )!,
      );
    }
    if (displayedMessages.length > 0) {
      entries.push({
        type: "activityGroup",
        key: `activities:${message.id}`,
        messages: displayedMessages,
        startedAt: precedingTurnStart(messages, index),
        endedAt,
        turnId: identity.turnId,
        turnKey: identity.turnKey,
      });
    }
    index = endIndex;
  }
  return entries;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 100) / 10}s`;
  }
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

export function formatTurnMetadata(
  metadata: ChatTurnMetadata | null,
): string | null {
  if (!metadata) return null;
  const parts = [
    metadata.totalTokens === null
      ? null
      : `${metadata.totalTokens.toLocaleString()}tok`,
    metadata.durationMs === null ? null : formatDuration(metadata.durationMs),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function formatElapsedTime(startedAt: string, endedAt: string): string {
  const seconds = Math.max(
    1,
    Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1_000),
  );
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}
