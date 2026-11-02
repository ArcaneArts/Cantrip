import { placementWireFixtures } from "./placement-wire-fixtures.mjs";
import { deferredAttachment } from "./native-settlement-fixtures.mjs";

export const taskTimestamp = "2026-10-25T00:00:00.000Z";
export const taskOperationId = "77777777-7777-4777-8777-000000000081";
export const taskEnvelope = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
export function taskContent(state = "draft", ordinal = 0, extra = {}) {
  return {
    classification: {
      state,
      stableStateBeforeFailure: null,
      activeOperationKind: null,
      planAuthorship: "agent",
      planningRound: ordinal,
      hasPlan: false,
      hasQuestions: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError: null,
      ...extra,
    },
    protectedContent: structuredClone(taskEnvelope),
  };
}
export function taskMessage(
  role,
  kind,
  id = "77777777-7777-4777-8777-000000000082",
) {
  return {
    id,
    classification: {
      role,
      mode: kind === "direct" ? "default" : kind === "goal" ? "goal" : "plan",
      attachmentIds: [],
    },
    protectedContent: structuredClone(taskEnvelope),
    reasoningEffort: null,
    idempotencyKey: `task:${id}`,
  };
}
export function taskStart(
  kind = "initial-plan",
  chatId = "task-chat",
  ordinal = 1,
  rowVersion = 1,
  operationId = taskOperationId,
) {
  const stableStateBeforeFailure = ["direct", "initial-plan"].includes(kind)
    ? "draft"
    : "review";
  const error = {
    code: "task-operation-failed",
    operationKind: kind,
    occurredAt: taskTimestamp,
  };
  const classification = {
    ordinal,
    kind,
    status: "running",
    hasOutputPlan: false,
    hasOutputQuestions: false,
    hasOutputGoalPrompt: false,
    error: null,
  };
  return {
    rowVersion,
    operation: {
      chatId,
      operationId,
      fingerprint: "A".repeat(43),
      classification,
      protectedInput: structuredClone(taskEnvelope),
      task: taskContent(
        kind === "direct"
          ? "implementing"
          : kind === "finalize"
            ? "finalizing"
            : "planning",
        ordinal,
        { stableStateBeforeFailure, activeOperationKind: kind },
      ),
      userMessage: taskMessage("user", kind),
    },
    failure: {
      task: taskContent("failed", ordinal, {
        stableStateBeforeFailure,
        lastError: error,
      }),
      round: {
        classification: { ...classification, status: "failed", error },
        protectedContent: structuredClone(taskEnvelope),
      },
    },
  };
}
export function taskResult(start) {
  const request = start.operation;
  const { kind, ordinal } = request.classification;
  const direct = kind === "direct",
    finalizing = kind === "finalize";
  const task = taskContent(
    direct ? "complete" : finalizing ? "implementing" : "review",
    ordinal,
    {
      hasPlan: !direct,
      hasFinalPlan: finalizing,
      hasGoalPrompt: finalizing,
    },
  );
  return {
    chatId: request.chatId,
    operationId: request.operationId,
    fingerprint: request.fingerprint,
    classification: {
      ...request.classification,
      status: "completed",
      hasOutputPlan: !direct,
      hasOutputGoalPrompt: finalizing,
    },
    protectedResult: structuredClone(taskEnvelope),
    task,
    assistantMessage: taskMessage("assistant", kind),
    goal: finalizing
      ? {
          classification: {
            chatId: request.chatId,
            threadId: "task-thread",
            status: "active",
          },
          protectedObjective: structuredClone(taskEnvelope),
          startMessage: taskMessage("user", "goal"),
          failureTask: taskContent("failed", ordinal, {
            hasPlan: true,
            hasFinalPlan: true,
            hasGoalPrompt: true,
            stableStateBeforeFailure: "review",
            lastError: {
              code: "task-goal-start-failed",
              operationKind: "finalize",
              occurredAt: taskTimestamp,
            },
          }),
        }
      : null,
  };
}
export function taskWireFixtures(timestamp) {
  const starts = ["direct", "initial-plan", "continue-plan", "finalize"].map(
    (k) => taskStart(k),
  );
  const results = starts.map(taskResult);
  const summary = {
    ...taskContent().classification,
    automaticRetry: null,
    chatId: "task-chat",
    planGoalEnabled: false,
    modelConfiguration: {
      modelId: null,
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
    },
    priority: 0,
    requestedTaskWorkerId: null,
    continuityFamily: null,
    lastTaskWorkerId: null,
    dispatch: null,
    activeOperationId: null,
    draftAttachmentIds: ["attachment"],
    protectedContent: taskEnvelope,
    implementationStartedAt: null,
    completedAt: null,
    schedulerRevision: 1,
    rowVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const legacy = structuredClone(results[3]);
  delete legacy.goal.failureTask;
  const titleProtection = {
    classification: { recordKind: "chat" },
    protectedLabel: structuredClone(taskEnvelope),
  };
  const create = {
    chatId: taskOperationId,
    titleProtection,
    task: taskContent(),
  };
  const chat = {
    ...placementWireFixtures(titleProtection).chatWireSummarySchema[0],
    id: taskOperationId,
    experience: "task",
  };
  return {
    encryptedTaskCreateSchema: [
      create,
      {
        ...create,
        planGoalEnabled: true,
        priority: 3,
        modelConfiguration: summary.modelConfiguration,
        target: {
          kind: "worktree",
          projectId: chat.projectId,
          worktreeId: chat.activeWorktreeId,
        },
        paneId: "pane",
        autoTitle: true,
        worktreeMode: "pinned",
      },
    ],
    taskWireCreateResultSchema: [
      { chat, task: { ...summary, chatId: chat.id } },
    ],
    chatAttachmentOpaqueListSchema: [[], [deferredAttachment()]],
    chatModelConfigurationUpdateSchema: [
      { modelId: "task-model" },
      {
        modelId: "task-model",
        reasoningEffort: " high ",
        customSubagentModel: true,
        subagentModelId: " child ",
        subagentReasoningEffort: " low ",
      },
    ],
    chatInterruptAcceptedSchema: [
      { interrupted: true },
      { interrupted: false, ignored: true },
    ],
    taskWorkerSummarySchema: [
      {
        id: "77777777-7777-4777-8777-000000000101",
        name: "Task worker",
        enabled: true,
        modelConfiguration: {
          modelId: "task-model",
          reasoningEffort: null,
          customSubagentModel: false,
          subagentModelId: null,
          subagentReasoningEffort: null,
        },
        maxConcurrency: 1,
        allowsPlanGoal: true,
        continuityFamily: "fixture",
        continuityFamilyOverride: null,
        position: 0,
        activeTaskCount: 0,
        rowVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    taskDispatchCycleListSchema: [[]],
    taskGoalWorkerResultSchema: [
      { goal: null, task: taskContent(), message: null },
      {
        goal: {
          chatId: "task-chat",
          threadId: "task-thread",
          status: "active",
          protectedObjective: taskEnvelope,
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 0,
          updatedAt: 0,
        },
        task: results[3].task,
        message: taskMessage("user", "goal"),
        execution: { threadId: "task-thread", status: "idle" },
      },
    ],
    chatGoalResponseSchema: [
      { goal: null },
      {
        goal: {
          threadId: "chat-thread",
          objective: "An ordinary Chat objective",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 0,
          updatedAt: 0,
          ignored: true,
        },
        ignored: true,
      },
    ],
    taskEncryptedOperationStartSchema: starts,
    taskOperationStartSchema: [{ operationId: taskOperationId, rowVersion: 1 }],
    taskRecoveryStartSchema: [{}],
    taskOpaqueContentSchema: [taskContent(), results[3].task],
    taskOpaqueMutationSchema: [
      { rowVersion: 1, task: taskContent() },
      {
        rowVersion: 2,
        task: taskContent(),
        draftAttachmentIds: ["a"],
        priority: 1,
        modelConfiguration: {
          modelId: "task-model",
          reasoningEffort: null,
          customSubagentModel: false,
          subagentModelId: null,
          subagentReasoningEffort: null,
        },
        planGoalEnabled: true,
      },
    ],
    taskOpaqueSummarySchema: [summary],
    taskOperationRelayResultSchema: [...results, legacy],
    taskPlanningRoundOpaqueSummarySchema: [
      {
        ...starts[0].operation.classification,
        id: taskOperationId,
        chatId: "task-chat",
        protectedContent: taskEnvelope,
        userMessageId: null,
        assistantMessageId: null,
        executionLaneId: null,
        turnId: null,
        startedAt: timestamp,
        completedAt: null,
      },
    ],
    taskPlanningRoundOpaqueContentSchema: [starts[0].failure.round],
  };
}
export function* taskWireCases(name, samples) {
  if (name === "encryptedTaskCreateSchema") {
    const base = samples[0];
    const changes = [
      { worktreeId: "tree", target: { kind: "project", projectId: "project" } },
      { paneId: "pane", tabGroupId: "legacy" },
      { paneId: "pane", targetRegion: "left" },
      { tabGroupId: "legacy", targetRegion: "right" },
      {
        paneId: "pane",
        tabGroupId: "legacy",
        targetRegion: "bottom",
        worktreeId: "tree",
        target: { kind: "project", projectId: "project" },
      },
    ];
    for (const change of changes) {
      yield { ...structuredClone(base), ...change };
      const all = { ...structuredClone(base), ...change };
      all.task.classification.hasPlan = true;
      all.titleProtection.classification.recordKind = "project";
      yield all;
    }
    for (const [field, values] of Object.entries({
      state: [
        "draft",
        "review",
        "planning",
        "implementing",
        "failed",
        "complete",
      ],
      stableStateBeforeFailure: [null, "draft", "review"],
      activeOperationKind: [null, "direct", "initial-plan", "finalize"],
      planAuthorship: ["agent", "user"],
      planningRound: [0, 1, 2],
      hasPlan: [false, true],
      hasQuestions: [false, true],
      hasFinalPlan: [false, true],
      hasGoalPrompt: [false, true],
      lastError: [
        null,
        { code: "failure", operationKind: "direct", occurredAt: taskTimestamp },
      ],
    }))
      for (const value of values) {
        const input = structuredClone(base);
        input.task.classification[field] = value;
        yield input;
      }
    return;
  }
  if (name === "taskWorkerOrderUpdateSchema") {
    yield { ids: [samples[0].ids[0], samples[0].ids[0]] };
    yield { ids: [samples[0].ids[0], samples[0].ids[0].toUpperCase()] };
    return;
  }
  if (name === "taskGoalWorkerResultSchema") {
    for (const role of ["user", "assistant", "system"])
      for (const mode of ["default", "plan", "goal"])
        for (const goal of [null, samples[1].goal]) {
          const value = structuredClone(samples[1]);
          value.goal = goal;
          value.message.classification.role = role;
          value.message.classification.mode = mode;
          yield value;
        }
    return;
  }
  if (
    ![
      "taskEncryptedOperationStartSchema",
      "taskOperationRelayResultSchema",
    ].includes(name)
  )
    return;
  for (const sample of samples) {
    const value = structuredClone(sample);
    if (name === "taskEncryptedOperationStartSchema") {
      value.operation.task.classification.state = "draft";
      value.failure.task.classification.state = "draft";
      value.failure.round.classification.status = "completed";
    } else {
      value.classification.status = "running";
      value.task.classification.state = "draft";
      if (value.goal) {
        value.goal.classification.chatId = "another-chat";
        if (value.goal.failureTask)
          value.goal.failureTask.classification.hasPlan = false;
      }
    }
    yield value;
  }
}
export function taskSchedulingWireFixtures(timestamp) {
  const worker = taskWireFixtures(timestamp).taskWorkerSummarySchema[0];
  return {
    taskWorkerContinuityFamilySchema: [
      "model:task-model",
      "codex/gpt-5.4",
      " foo.bar ",
      "a-b_c:d/e",
    ],
    taskWorkerCreateSchema: [
      { name: " Task Worker ", modelConfiguration: { modelId: "task-model" } },
      {
        name: "Configured",
        enabled: false,
        maxConcurrency: 64,
        allowsPlanGoal: true,
        continuityFamilyOverride: "family-a",
        modelConfiguration: {
          modelId: "root",
          customSubagentModel: true,
          subagentModelId: "subagent",
        },
      },
    ],
    taskWorkerUpdateSchema: [
      { rowVersion: 1, name: " renamed " },
      { rowVersion: 1, enabled: false },
      { rowVersion: 1, continuityFamilyOverride: null },
      { rowVersion: 1, modelConfiguration: { modelId: "task-model" } },
    ],
    taskWorkerDeleteSchema: [{ rowVersion: 1 }],
    taskWorkerOrderUpdateSchema: [{ ids: [worker.id] }],
    taskWorkerListSchema: [[], [worker]],
    projectTaskPauseStateSchema: [
      { projectId: "project", paused: false, pausedAt: null, rowVersion: 1 },
      {
        projectId: "project",
        paused: true,
        pausedAt: timestamp,
        rowVersion: 2,
      },
    ],
    projectTaskPauseUpdateSchema: [
      { paused: true, rowVersion: 1 },
      { paused: false, rowVersion: 2 },
    ],
  };
}
