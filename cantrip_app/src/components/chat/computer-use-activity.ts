import type { AgentActivity, ChatMessage } from "@cantrip/protocol";

export type ComputerUseActivity = Extract<
  AgentActivity,
  { type: "computerUse" }
>;

export function isPreviewActivity(
  activity: AgentActivity,
): activity is ComputerUseActivity {
  return activity.type === "computerUse" && activity.source === "user-preview";
}

/** Projection key only: no fabricated agent turn, prompt or persistent record. */
export function previewActivityGroupKey(activity: ComputerUseActivity): string {
  return `preview:${JSON.stringify([activity.binding.chatId, activity.binding.workerId, activity.binding.sessionId ?? activity.operationId])}`;
}

export function splitPreviewMessages(messages: readonly ChatMessage[]) {
  const agentMessages: ChatMessage[] = [];
  const previewGroups = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const remaining = message.content.filter(
      (content) =>
        content.type !== "activity" || !isPreviewActivity(content.activity),
    );
    if (remaining.length || remaining.length === message.content.length)
      agentMessages.push(
        remaining.length === message.content.length
          ? message
          : { ...message, content: remaining },
      );
    for (const content of message.content) {
      if (content.type !== "activity" || !isPreviewActivity(content.activity))
        continue;
      const key = previewActivityGroupKey(content.activity);
      const group = previewGroups.get(key) ?? [];
      group.push({ ...message, content: [content] });
      previewGroups.set(key, group);
    }
  }
  // Persisted pages can arrive out of order. Keep each preview history in the
  // same sequence order as agent turns before deriving its latest operation.
  for (const group of previewGroups.values()) {
    group.sort(
      (left, right) =>
        left.sequence - right.sequence ||
        (Date.parse(left.createdAt) || 0) -
          (Date.parse(right.createdAt) || 0) ||
        left.id.localeCompare(right.id),
    );
  }
  return { agentMessages, previewGroups };
}

const operationLabels: Record<string, string> = {
  "capabilities.get": "Capabilities",
  "targets.list": "List targets",
  "session.open": "Open session",
  "session.state": "Session state",
  "target.attach": "Attach target",
  "target.detach": "Detach target",
  "cursor.configure": "Configure cursor",
  "cursor.move": "Move cursor",
  "observation.snapshot": "Snapshot",
  "session.close": "Close session",
  "agent.sources.list": "List agent observations",
  "agent.observation.get": "Read agent observation",
  "js.evaluate": "Evaluate JavaScript",
  "js.reset": "Reset JavaScript",
  "preview.stop": "Stop computer use",
};
export function computerUseOperationLabel(operation: string): string {
  return operationLabels[operation] ?? operation;
}

export function computerUseActivitySummary(
  activity: ComputerUseActivity,
): string {
  return [
    activity.source === "user-preview" ? "Preview operator" : "Agent MCP",
    activity.operation,
    activity.outcome,
    activity.errorCode,
    activity.target
      ? `Target ${activity.target.targetId} · generation ${activity.target.targetGeneration}`
      : null,
    activity.observation
      ? `Observation #${activity.observation.revision} · ${activity.observation.image.width} × ${activity.observation.image.height}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
