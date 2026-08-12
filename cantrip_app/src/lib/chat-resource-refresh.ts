import type { ChatSummary } from "@cantrip/protocol";

const ACTIVE_CHAT_REFRESH_MS = 3_000;
const DEGRADED_CHAT_REFRESH_MS = 10_000;
const LIVE_CHAT_SAFETY_REFRESH_MS = 30_000;

export function chatResourceRefreshIntervalMs(
  status: ChatSummary["status"],
  live: boolean,
): number {
  if (status === "running" || status === "waiting-for-approval") {
    return ACTIVE_CHAT_REFRESH_MS;
  }
  return live ? LIVE_CHAT_SAFETY_REFRESH_MS : DEGRADED_CHAT_REFRESH_MS;
}
