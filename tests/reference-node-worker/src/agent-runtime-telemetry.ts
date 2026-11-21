import type { AgentActivity } from "@cantrip/protocol";

const epochSecondsToMilliseconds = (value: number | null): number | null =>
  value === null ? null : value * 1_000;

/**
 * Content-free timing metadata that lets the server count encrypted root and
 * child agent intervals without seeing the protected activity payload.
 */
export function protectedAgentRuntimeTelemetry(activity: AgentActivity) {
  if (activity.type !== "turnSummary" || !activity.agentScope) return null;
  return {
    agentThreadId: activity.agentScope.agentThreadId,
    isRoot: activity.agentScope.isRoot,
    startedAtMs: epochSecondsToMilliseconds(activity.startedAt),
    completedAtMs: epochSecondsToMilliseconds(activity.completedAt),
    status:
      activity.status === "running"
        ? ("running" as const)
        : activity.status === "completed"
          ? ("completed" as const)
          : ("failed" as const),
  };
}
