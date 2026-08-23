import type { ChatMessage } from "@cantrip/protocol";

const EPOCH_MILLISECONDS_THRESHOLD = 100_000_000_000;

function epochMilliseconds(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return value < EPOCH_MILLISECONDS_THRESHOLD ? value * 1_000 : value;
}

function timestampMilliseconds(
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveRunningAgentStartedAtMs(
  messages: readonly ChatMessage[],
  fallbackStartedAt: string,
): number | null {
  let latestTurnAnchorIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === "user" || role === "system") {
      latestTurnAnchorIndex = index;
      break;
    }
  }

  for (
    let messageIndex = messages.length - 1;
    messageIndex >= Math.max(0, latestTurnAnchorIndex);
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (
      let contentIndex = message.content.length - 1;
      contentIndex >= 0;
      contentIndex -= 1
    ) {
      const content = message.content[contentIndex];
      if (
        content?.type !== "activity" ||
        content.activity.type !== "turnSummary" ||
        content.activity.status !== "running"
      ) {
        continue;
      }
      return (
        epochMilliseconds(content.activity.startedAtMs) ??
        epochMilliseconds(content.activity.startedAt) ??
        timestampMilliseconds(message.createdAt) ??
        timestampMilliseconds(fallbackStartedAt)
      );
    }
  }

  const latestTurnAnchor = messages[latestTurnAnchorIndex];
  if (latestTurnAnchor) {
    return (
      timestampMilliseconds(latestTurnAnchor.createdAt) ??
      timestampMilliseconds(fallbackStartedAt)
    );
  }

  return timestampMilliseconds(fallbackStartedAt);
}

export function formatRunningAgentDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
