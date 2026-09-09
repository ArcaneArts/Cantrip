import type { ChatMessage, NativeInitialTurnSettings } from "@cantrip/protocol";

export type NativeTurnSettingsEvidence = {
  threadId: string;
  turnId: string;
} & (
  | { status: "available"; initialSettings: NativeInitialTurnSettings }
  | { status: "conflict" | "unavailable" }
);
const key = (value: { threadId: string; turnId: string }) =>
  JSON.stringify([value.threadId, value.turnId]);

export function nativeCorrelatedTurnIdentities(
  messages: readonly ChatMessage[],
) {
  const ids = new Map<string, { threadId: string; turnId: string }>();
  for (const message of messages)
    for (const item of message.content) {
      if (item.type !== "activity" && item.type !== "text") continue;
      const { correlation, agentScope } =
        item.type === "activity" ? item.activity : item;
      if (
        !correlation?.threadId ||
        !correlation.turnId ||
        (agentScope && agentScope.agentThreadId !== correlation.threadId)
      )
        continue;
      const identity = {
        threadId: correlation.threadId,
        turnId: correlation.turnId,
      };
      ids.set(key(identity), identity);
    }
  return [...ids.values()];
}

/** Join immutable evidence across overlapping pages, archives and live summaries.
 * Missing legacy captures never erase evidence; any disagreement stays visible. */
export function mergeNativeTurnSettingsEvidence(
  groups: readonly (readonly NativeTurnSettingsEvidence[])[],
): NativeTurnSettingsEvidence[] {
  const result = new Map<string, NativeTurnSettingsEvidence>();
  for (const group of groups)
    for (const next of group) {
      const id = key(next);
      const prior = result.get(id);
      if (!prior || prior.status === "unavailable") {
        result.set(id, next);
        continue;
      }
      if (next.status === "unavailable") continue;
      if (
        prior.status === "conflict" ||
        next.status === "conflict" ||
        (prior.status === "available" &&
          next.status === "available" &&
          JSON.stringify(prior.initialSettings) !==
            JSON.stringify(next.initialSettings))
      )
        result.set(id, {
          threadId: next.threadId,
          turnId: next.turnId,
          status: "conflict",
        });
    }
  return [...result.values()];
}

/** Select only turns represented on this page/group, including child turns.
 * A child's rootTurnId is grouping information, never its settings identity. */
export function nativeTurnSettingsForMessages(
  messages: readonly ChatMessage[],
  evidence: readonly NativeTurnSettingsEvidence[],
): NativeTurnSettingsEvidence[] {
  const identities = nativeCorrelatedTurnIdentities(messages);
  const expected = new Set(identities.map(key));
  const live: NativeTurnSettingsEvidence[] = [];
  for (const message of messages)
    for (const item of message.content) {
      if (item.type !== "activity" || item.activity.type !== "turnSummary")
        continue;
      const activity = item.activity;
      const correlation = activity.correlation;
      if (
        !correlation?.threadId ||
        !correlation.turnId ||
        (activity.agentScope &&
          activity.agentScope.agentThreadId !== correlation.threadId)
      )
        continue;
      const identity = {
        threadId: correlation.threadId,
        turnId: correlation.turnId,
      };
      if (activity.initialSettingsConflict)
        live.push({ ...identity, status: "conflict" });
      else if (activity.initialSettings)
        live.push({
          ...identity,
          status: "available",
          initialSettings: activity.initialSettings,
        });
    }
  return mergeNativeTurnSettingsEvidence([evidence, live]).filter((entry) =>
    expected.has(key(entry)),
  );
}
