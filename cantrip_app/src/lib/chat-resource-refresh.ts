import type { ChatMessage, ChatSummary } from "@cantrip/protocol";

const ACTIVE_CHAT_REFRESH_MS = 3_000;
const DEGRADED_CHAT_REFRESH_MS = 10_000;
const LIVE_CHAT_SAFETY_REFRESH_MS = 30_000;
const RECENT_TURN_WINDOW_MS = 10 * 60_000;

function isTerminalTurnMessage(message: ChatMessage): boolean {
  if (message.role === "assistant") {
    return message.content.some(
      (content) => content.type === "text" && content.phase !== "commentary",
    );
  }
  if (message.role !== "system") return false;
  return message.content.some(
    (content) =>
      content.type === "text" &&
      (/^Agent failed:/u.test(content.text) ||
        content.text === "Turn interrupted."),
  );
}

export function chatTranscriptNeedsFastRefresh(
  messages: ChatMessage[] | undefined,
  now = Date.now(),
): boolean {
  if (!messages?.length) return false;
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return false;
  const lastUser = messages[lastUserIndex]!;
  if (now - Date.parse(lastUser.createdAt) > RECENT_TURN_WINDOW_MS)
    return false;
  return !messages.slice(lastUserIndex + 1).some(isTerminalTurnMessage);
}

export function chatResourceRefreshIntervalMs(
  status: ChatSummary["status"],
  live: boolean,
  awaitingDurableResult = false,
): number {
  if (
    awaitingDurableResult ||
    status === "running" ||
    status === "waiting-for-approval"
  ) {
    return ACTIVE_CHAT_REFRESH_MS;
  }
  return live ? LIVE_CHAT_SAFETY_REFRESH_MS : DEGRADED_CHAT_REFRESH_MS;
}
