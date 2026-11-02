import commandRefinements from "./worker-command-refinement-fixtures.json" with { type: "json" };
import { eventPlan } from "./native-event-fixtures.mjs";
import { protectedInteraction } from "./agent-interaction-fixtures.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
export function turnOrchestrationWireFixtures(timestamp) {
  const lease = {
    cycleId: "77777777-7777-4777-8777-000000000001",
    operationId: "operation",
    leaseOwner: "instance",
    fencingToken: 1,
    leaseExpiresAt: timestamp,
  };
  const cycle = {
    id: lease.cycleId,
    chatId: "chat",
    operationId: lease.operationId,
    operationKind: "direct",
    state: "claimed",
    fifoCreatedAt: timestamp,
    requestedTaskWorkerId: null,
    selectedTaskWorkerId: null,
    taskWorkerRevision: null,
    continuityFamily: null,
    modelConfiguration: null,
    modelRouteId: null,
    providerAccountId: null,
    physicalWorkerId: null,
    worktreeId: null,
    codexThreadId: null,
    turnId: null,
    leaseOwner: lease.leaseOwner,
    leaseExpiresAt: timestamp,
    lastHeartbeatAt: null,
    fencingToken: 1,
    attemptCount: 1,
    eligibilityCode: null,
    queuedAt: timestamp,
    claimedAt: timestamp,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const relay = structuredClone(
    commandRefinements.cases.find(
      (c) => c.input?.command?.resultMode?.kind === "task-encrypted",
    ).input.command.resultMode.operation,
  );
  Object.assign(relay.classification, {
    status: "running",
    hasOutputPlan: false,
    hasOutputQuestions: false,
    hasOutputGoalPrompt: false,
    error: null,
  });
  Object.assign(relay.userMessage.classification, {
    role: "user",
    mode: relay.classification.kind === "direct" ? "default" : "plan",
  });
  const message = {
    id: "message",
    chatId: "chat",
    contextKind: "project",
    worktreeId: "root",
    scratchRootId: null,
    executionLaneId: null,
    sequence: 1,
    role: "assistant",
    mode: "default",
    content: [{ type: "text", text: "Visible legacy message fixture" }],
    reasoningEffort: null,
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: timestamp,
  };
  return {
    worktreeStatusResultSchema: [
      {
        worktree: {
          path: "/fixture",
          head: null,
          branch: "main",
          detached: false,
          isPrimary: true,
          managed: false,
          locked: false,
          lockReason: null,
          prunable: false,
          pruneReason: null,
          missing: false,
        },
        status: {
          branch: "main",
          head: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
          branches: [],
        },
      },
    ],
    generateLabelResultSchema: [
      { titleProtection: null },
      { titleProtection: null, emptyInput: true },
    ],
    agentTurnResultSchema: [
      { threadId: "thread", turnId: "turn", text: "", status: "completed" },
      {
        threadId: "thread",
        text: "Result",
        status: "completed",
        structuredResult: { opaque: true },
        measuredUsage: null,
      },
    ],
    chatMessageRelayResultSchema: [
      { message: null },
      {
        message: {
          ...retainedPrompt().pendingMessage,
          classification: {
            ...retainedPrompt().pendingMessage.classification,
            role: "assistant",
          },
        },
      },
    ],
    taskMessageRelayResultSchema: [
      {
        message: {
          ...retainedPrompt().pendingMessage,
          classification: {
            ...retainedPrompt().pendingMessage.classification,
            role: "assistant",
          },
        },
      },
    ],
    cuaApprovalRequestEventSchema: [
      {
        type: "computer-use.approval.request",
        operationId: "77777777-7777-4777-8777-000000000001",
        request: protectedInteraction("77777777-7777-4777-8777-000000000002", {
          classification: { kind: "permissions" },
          provenance: {
            owner: "computer-use",
            chatId: "chat",
            workerId: "alpha",
            threadId: "thread",
            turnId: "turn",
            itemId: null,
            executionLaneId: "lane",
          },
        }),
      },
    ],
    cuaApprovalTerminalSchema: [
      {
        type: "computer-use.approval.terminal",
        chatId: "chat",
        requestKey: "77777777-7777-4777-8777-000000000002",
        status: "interrupted",
      },
    ],
    chatTurnRollbackAcceptedSchema: [{ rolledBack: true }],
    taskDispatchWorkerLeaseSchema: [lease],
    taskDispatchCycleSummarySchema: [cycle],
    taskOperationRelayRequestSchema: [relay],
    chatMessageSchema: [
      message,
      {
        ...message,
        contextKind: "standalone",
        worktreeId: null,
        scratchRootId: "scratch",
      },
    ],
    encryptedChatPlanWireStateSchema: [
      {
        kind: "chat-encrypted",
        chatId: "chat",
        mode: "default",
        hasQuestion: false,
        state: null,
      },
      {
        kind: "chat-encrypted",
        chatId: "chat",
        mode: "plan",
        hasQuestion: eventPlan.classification.hasQuestion,
        state: eventPlan,
      },
    ],
  };
}
export function* turnOrchestrationWireCases(name, samples) {
  if (name === "chatMessageSchema")
    for (const contextKind of ["project", "standalone"])
      for (const worktreeId of [null, "root"])
        for (const scratchRootId of [null, "scratch"])
          yield { ...samples[0], contextKind, worktreeId, scratchRootId };
  if (name === "encryptedChatPlanWireStateSchema")
    for (const state of [null, eventPlan])
      for (const hasQuestion of [false, true])
        yield { ...samples[0], state, hasQuestion };
}
