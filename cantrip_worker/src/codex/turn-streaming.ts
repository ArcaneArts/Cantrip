import type {
  AgentActivity,
  CodexEventCorrelation,
  NormalizedAgentMessage,
} from "@cantrip/protocol";
import {
  agentActivitySchema,
  normalizedAgentMessageSchema,
} from "@cantrip/protocol";
import type {
  ActiveCommandTelemetry,
  ActiveTurn,
  AgentEventState,
} from "./runtime-types.js";
import {
  AGENT_MESSAGE_DELTA_COALESCE_MS,
  COMMAND_OUTPUT_COALESCE_MS,
  MAX_COMPLETED_COMMAND_IDS,
  MAX_OBSERVED_ACTIVITY_FINGERPRINTS,
  MAX_TURN_COMMAND_TELEMETRY,
  MAX_TURN_ITEM_TIMESTAMPS,
} from "./runtime-limits.js";
import {
  agentMessageFingerprint,
  asCommentary,
  boundedMapSet,
  settleRunningActivityAtTurnBoundary,
} from "./event-values.js";
import { normalizeCodexThreadItem } from "./event-normalization.js";
import type { StagedAgentMessageResult } from "./event-types.js";

export function scopedAgentActivity(
  state: AgentEventState,
  activity: AgentActivity,
): AgentActivity {
  return state.agentScope
    ? agentActivitySchema.parse({ ...activity, agentScope: state.agentScope })
    : activity;
}

export function agentActivityDeliveryFingerprint(
  activity: AgentActivity,
): string {
  return JSON.stringify([
    activity.agentScope?.agentThreadId ??
      activity.correlation?.threadId ??
      null,
    activity.correlation?.turnId ?? null,
    activity.correlation?.itemId ?? activity.id,
    activity.type,
    activity.status,
  ]);
}

function rememberObservedActivity(
  state: AgentEventState,
  activity: AgentActivity,
): void {
  if (
    state.observedActivityFingerprints.size >=
    MAX_OBSERVED_ACTIVITY_FINGERPRINTS
  ) {
    const oldest = state.observedActivityFingerprints.values().next().value;
    if (oldest !== undefined) state.observedActivityFingerprints.delete(oldest);
  }
  state.observedActivityFingerprints.add(
    agentActivityDeliveryFingerprint(activity),
  );
}

export function emitTurnActivity(
  state: AgentEventState,
  activity: AgentActivity,
): void {
  const capture = state.nativeModelAttribution;
  const scoped = scopedAgentActivity(
    state,
    capture &&
      (activity.type === "usage" || activity.type === "turnSummary") &&
      capture.threadId === activity.correlation?.threadId &&
      capture.turnId === activity.correlation?.turnId
      ? { ...activity, nativeModelAttribution: capture }
      : activity,
  );
  rememberObservedActivity(state, scoped);
  const itemId = scoped.correlation?.itemId;
  if (itemId) {
    if (scoped.status === "running") {
      boundedMapSet(
        state.pendingActivities,
        itemId,
        scoped,
        MAX_TURN_ITEM_TIMESTAMPS,
      );
    } else {
      state.pendingActivities.delete(itemId);
    }
  }
  state.onActivity?.(scoped);
}

export function settlePendingTurnActivities(
  active: AgentEventState,
  status: "completed" | "failed",
  completedAtMs: number,
  correlation: CodexEventCorrelation,
): void {
  for (const activity of [...active.pendingActivities.values()]) {
    emitTurnActivity(
      active,
      settleRunningActivityAtTurnBoundary(activity, status, completedAtMs, {
        ...correlation,
        itemId: activity.correlation?.itemId ?? null,
      }),
    );
  }
}

export function rememberCompletedCommand(
  active: AgentEventState,
  itemId: string,
): void {
  if (active.completedCommandIds.size >= MAX_COMPLETED_COMMAND_IDS) {
    const oldest = active.completedCommandIds.values().next().value;
    if (oldest !== undefined) active.completedCommandIds.delete(oldest);
  }
  active.completedCommandIds.add(itemId);
}

export function boundedCommandTelemetrySet(
  active: AgentEventState,
  itemId: string,
  telemetry: ActiveCommandTelemetry,
): void {
  if (
    !active.commandTelemetry.has(itemId) &&
    active.commandTelemetry.size >= MAX_TURN_COMMAND_TELEMETRY
  ) {
    const oldestId = active.commandTelemetry.keys().next().value;
    if (oldestId !== undefined) {
      const oldest = active.commandTelemetry.get(oldestId);
      if (oldest) clearCommandFlush(oldest);
      active.commandTelemetry.delete(oldestId);
    }
  }
  active.commandTelemetry.set(itemId, telemetry);
}

export function emitCommandTelemetry(
  active: AgentEventState,
  telemetry: ActiveCommandTelemetry,
  completedAtMs?: number | null,
  status?: AgentActivity["status"],
): void {
  if (!telemetry.item) return;
  const activity = normalizeCodexThreadItem(
    telemetry.item,
    active.cwd,
    completedAtMs === undefined ? "started" : "completed",
    telemetry.correlation,
    {
      captureRaw: active.captureProtectedDiagnostics,
      commandOutput: {
        output: telemetry.output,
        truncated: telemetry.truncated,
      },
      startedAtMs: telemetry.startedAtMs,
      updatedAtMs: telemetry.updatedAtMs,
      ...(completedAtMs === undefined ? {} : { completedAtMs }),
      ...(status === undefined ? {} : { status }),
    },
  );
  if (activity) emitTurnActivity(active, activity);
}

export function clearCommandFlush(telemetry: ActiveCommandTelemetry): void {
  if (!telemetry.flushTimer) return;
  clearTimeout(telemetry.flushTimer);
  telemetry.flushTimer = null;
}

export function scheduleCommandTelemetry(
  active: AgentEventState,
  telemetry: ActiveCommandTelemetry,
): void {
  if (!telemetry.item || telemetry.flushTimer) return;
  telemetry.flushTimer = setTimeout(() => {
    telemetry.flushTimer = null;
    if (active.commandTelemetry.get(telemetry.item!.id) !== telemetry) return;
    emitCommandTelemetry(active, telemetry);
  }, COMMAND_OUTPUT_COALESCE_MS);
  telemetry.flushTimer.unref();
}

export function clearStreamingAgentMessage(active: AgentEventState): void {
  const streaming = active.streamingAgentMessage;
  if (streaming?.flushTimer) clearTimeout(streaming.flushTimer);
  active.streamingAgentMessage = null;
}

export function normalizeStreamingAgentMessage(
  message: Omit<NormalizedAgentMessage, "phase" | "streaming">,
): NormalizedAgentMessage {
  return normalizedAgentMessageSchema.parse({
    ...message,
    // An agent message item can be followed by more tools or messages. Keep
    // streamed text provisional until the authoritative turn boundary decides
    // whether it was commentary or the final answer.
    phase: "commentary",
    streaming: true,
  });
}

export function emitStreamingAgentMessage(active: AgentEventState): void {
  const streaming = active.streamingAgentMessage;
  if (!streaming) return;
  if (streaming.flushTimer) {
    clearTimeout(streaming.flushTimer);
    streaming.flushTimer = null;
  }
  const text = streaming.text.trim();
  if (
    !text ||
    text === streaming.lastEmittedText ||
    streaming.phase === "commentary" ||
    active.structuredChat
  ) {
    return;
  }
  streaming.lastEmittedText = text;
  active.onMessage?.(
    normalizeStreamingAgentMessage({
      id: streaming.id,
      text,
      correlation: streaming.correlation,
      ...(active.agentScope ? { agentScope: active.agentScope } : {}),
    }),
  );
}

function scheduleStreamingAgentMessage(active: AgentEventState): void {
  const streaming = active.streamingAgentMessage;
  if (!streaming || streaming.flushTimer) return;
  streaming.flushTimer = setTimeout(() => {
    if (active.streamingAgentMessage !== streaming) return;
    streaming.flushTimer = null;
    emitStreamingAgentMessage(active);
  }, AGENT_MESSAGE_DELTA_COALESCE_MS);
  streaming.flushTimer.unref();
}

export function settleStreamingAgentMessage(
  active: AgentEventState,
  completed: boolean,
): void {
  const streaming = active.streamingAgentMessage;
  if (!streaming) return;
  emitStreamingAgentMessage(active);
  const text = streaming.text.trim();
  clearStreamingAgentMessage(active);
  if (!text || active.structuredChat) return;
  active.onMessage?.(
    normalizedAgentMessageSchema.parse({
      id: streaming.id,
      text,
      phase:
        streaming.phase === "commentary" || !completed
          ? "commentary"
          : "final_answer",
      correlation: streaming.correlation,
      ...(active.agentScope ? { agentScope: active.agentScope } : {}),
    }),
  );
}

export function appendStreamingAgentMessageDelta(
  active: AgentEventState,
  itemId: string,
  delta: string,
  correlation: CodexEventCorrelation,
): void {
  if (active.streamingAgentMessage?.id !== itemId) {
    settleStreamingAgentMessage(active, false);
    active.streamingAgentMessage = {
      correlation,
      flushTimer: null,
      id: itemId,
      lastEmittedText: "",
      phase: null,
      text: "",
    };
  }
  active.streamingAgentMessage.text += delta;
  active.streamingAgentMessage.correlation = correlation;
  scheduleStreamingAgentMessage(active);
}

export function clearTurnInspectionTelemetry(active: AgentEventState): void {
  clearStreamingAgentMessage(active);
  for (const telemetry of active.commandTelemetry.values()) {
    clearCommandFlush(telemetry);
  }
  active.commandTelemetry.clear();
  active.completedCommandIds.clear();
  active.fileStartedAtMs.clear();
  active.itemStartedAtMs.clear();
  active.pendingActivities.clear();
}

/** Reset segment-local output only; the surrounding legacy goal stays alive. */
export function resetGoalSegment(active: ActiveTurn): void {
  clearTurnInspectionTelemetry(active);
  active.delta = "";
  active.diffChanges = [];
  active.finalText = null;
  active.durationMs = null;
  active.latestUsage = null;
  active.pendingAgentMessage = null;
  active.interruptionRequestedAtMs = null;
  active.liveAgentMessageFingerprints.clear();
  active.reasoningSummaries.clear();
  active.startedAtMs = Date.now();
}

export function publishGoalCheckpoint(
  active: ActiveTurn,
  turnId: string,
): void {
  const completed = active.goalCompletion;
  if (
    !completed ||
    completed.turnId !== turnId ||
    completed.checkpointPublished
  )
    return;
  completed.checkpointPublished = true;
  active.onCheckpoint?.({ text: completed.text, turnId });
}

export function emitFileActivity(
  active: AgentEventState,
  turnId: string,
  status: AgentActivity["status"],
  correlation: CodexEventCorrelation,
): void {
  if (active.diffChanges.length === 0) {
    return;
  }
  emitTurnActivity(
    active,
    agentActivitySchema.parse({
      type: "fileChange",
      id: `turn:${turnId}:files`,
      status,
      changes: active.diffChanges,
      startedAtMs:
        active.diffChanges
          .map((change) => change.lastActivityAtMs)
          .filter((value): value is number => value !== undefined)
          .sort((left, right) => left - right)[0] ?? active.startedAtMs,
      updatedAtMs: Math.max(
        ...active.diffChanges.map(
          (change) => change.lastActivityAtMs ?? active.startedAtMs,
        ),
      ),
      completedAtMs: status === "running" ? null : Date.now(),
      correlation,
    }),
  );
}

export function stageAgentMessage(
  pending: NormalizedAgentMessage | null,
  message: NormalizedAgentMessage,
): StagedAgentMessageResult {
  if (message.phase === "commentary") {
    return {
      emitted: pending ? [asCommentary(pending), message] : [message],
      pending: null,
    };
  }
  return {
    emitted: pending ? [asCommentary(pending)] : [],
    pending: message,
  };
}

export function flushStagedAgentMessage(
  pending: NormalizedAgentMessage | null,
  completed: boolean,
): StagedAgentMessageResult {
  return {
    emitted: pending ? [completed ? pending : asCommentary(pending)] : [],
    pending: null,
  };
}

export function publishStagedAgentMessages(
  active: AgentEventState,
  staged: StagedAgentMessageResult,
): void {
  active.pendingAgentMessage = staged.pending;
  for (const message of staged.emitted) {
    if (!active.structuredChat || message.phase === "commentary") {
      const scoped = normalizedAgentMessageSchema.parse({
        ...message,
        ...(active.agentScope ? { agentScope: active.agentScope } : {}),
      });
      active.liveAgentMessageFingerprints.add(agentMessageFingerprint(scoped));
      active.onMessage?.(scoped);
    }
  }
}

export function flushActiveAgentMessage(
  active: AgentEventState,
  completed: boolean,
): void {
  settleStreamingAgentMessage(active, completed);
  publishStagedAgentMessages(
    active,
    flushStagedAgentMessage(active.pendingAgentMessage, completed),
  );
}
