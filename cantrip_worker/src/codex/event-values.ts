import type {
  AgentActivity,
  CodexEventCorrelation,
  NormalizedAgentMessage,
} from "@cantrip/protocol";
import { agentActivitySchema } from "@cantrip/protocol";
import { createHash } from "node:crypto";
import path from "node:path";

export function boundedMapSet<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number,
) {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function settleRunningActivityAtTurnBoundary(
  activity: AgentActivity,
  status: Exclude<AgentActivity["status"], "running">,
  completedAtMs: number | null,
  correlation: CodexEventCorrelation,
): AgentActivity {
  if (activity.status !== "running") return activity;
  return agentActivitySchema.parse({
    ...activity,
    status,
    ...(completedAtMs === null
      ? {}
      : {
          updatedAtMs: Math.max(activity.updatedAtMs ?? 0, completedAtMs),
          completedAtMs,
        }),
    correlation,
  });
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function optionalDepth(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 32)
    : null;
}

export function boundedText(value: string | null | undefined, limit = 20_000) {
  if (value === null || value === undefined) return null;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…truncated…`;
}

export function completedActivityTimestamps(
  startedAtMs: number | null | undefined,
  completedAtMs: number,
) {
  return {
    ...(startedAtMs === null || startedAtMs === undefined
      ? {}
      : { startedAtMs }),
    updatedAtMs: completedAtMs,
    completedAtMs,
  };
}

export function stableActivityId(
  prefix: string,
  ...parts: Array<string | null>
) {
  const digest = createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\0"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}:${digest}`;
}

export function eventCorrelation(
  sourceMethod: string,
  diagnosticId: string | null,
  threadId: string | null,
  turnId: string | null,
  itemId: string | null,
): CodexEventCorrelation {
  return {
    sourceMethod,
    diagnosticId,
    threadId,
    turnId,
    itemId,
  };
}

export function displayPath(cwd: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath;
  }
  if (path.resolve(filePath) === path.resolve(cwd)) {
    return ".";
  }
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

export function asCommentary(
  message: NormalizedAgentMessage,
): NormalizedAgentMessage {
  return message.phase === "commentary"
    ? message
    : { ...message, phase: "commentary" };
}

export function agentMessageFingerprint(
  message: NormalizedAgentMessage,
): string {
  return JSON.stringify([
    message.phase === "commentary" ? "commentary" : "final",
    message.text,
  ]);
}

export function codexErrorReasonCode(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const record = objectRecord(value);
  if (!record) return null;
  const keys = Object.keys(record);
  return keys.length === 1 ? keys[0]! : null;
}
