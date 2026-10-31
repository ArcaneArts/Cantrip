import { workerIngressFixtures } from "./worker-wire-fixtures.mjs";
import {
  eventMessage,
  taskEventMessage,
  eventPlan,
} from "./native-event-fixtures.mjs";
import { protectedInteraction } from "./agent-interaction-fixtures.mjs";
export function nativeEventWireFixtures() {
  const create = protectedInteraction("11111111-1111-4111-8111-111111111111");
  const { requestKey, classification, protectedPayload } = create;
  const request = {
    requestKey,
    classification,
    protectedPayload,
    threadId: "thread",
    turnId: null,
    itemId: null,
    expiresAt: "2099-01-01T00:00:00Z",
  };
  const computer = {
    ...create,
    classification: { kind: "permissions" },
    provenance: { ...create.provenance, owner: "computer-use", turnId: "turn" },
  };
  return {
    cuaPreviewAuthoritySchema: [
      {
        ownerId: "owner",
        serverId: "server",
        workerId: "worker",
        chatId: "chat",
        projectId: "project",
        contextKind: "project",
        placementId: "worktree",
        generation: 1,
        profile: {
          selectedId: ":workspace",
          effectiveId: ":workspace",
          forcedByWorktreePolicy: false,
          usesDefault: true,
        },
      },
    ],
    nativeCommandEventSchema: [
      {
        type: "agent.protected-message",
        message: eventMessage,
        telemetry: { kind: "checkpoint", turnId: "turn" },
      },
      {
        type: "agent.protected-task-message",
        message: taskEventMessage,
        telemetry: { kind: "checkpoint", turnId: "turn" },
      },
      { type: "agent.plan.protected", turnId: null, state: eventPlan },
      { type: "agent.interaction.requested.protected", request },
      { type: "agent.interaction.cleared", requestKey },
      { type: "agent.interaction.expired", requestKey },
      {
        type: "computer-use.approval.request",
        operationId: requestKey,
        request: computer,
      },
      {
        type: "computer-use.approval.terminal",
        chatId: "chat",
        requestKey,
        status: "expired",
      },
    ].map((event) => ({
      workerId: "worker",
      operationId: "operation",
      operationGeneration: "generation",
      event,
    })),
  };
}
export function nativeEventWireCases(schema) {
  return schema !== "nativeCommandEventSchema"
    ? []
    : workerIngressFixtures
        .filter((v) => v.kind === "event")
        .map((v) => ({
          workerId: "worker",
          operationId: "operation",
          operationGeneration: "generation",
          event: v.event,
        }));
}
