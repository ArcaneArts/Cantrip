// Reference inputs for endpoint-owned alert, Goal, MCP and Task contracts.
import assert from "node:assert/strict";
import * as p from "../../packages/protocol/dist/index.js";

const id = "77777777-7777-4777-8777-000000000091";
const stamp = "2026-10-25T00:00:00.000Z";
const expires = "2026-10-26T00:00:00.000Z";
export function agentOperationWireFixtures(existing) {
  const valid = (name, predicate = () => true) => {
    const sample = existing[name]?.find(
      (value) => predicate(value) && p[name].safeParse(value).success,
    );
    assert.ok(sample, `An existing accepted ${name} input is required`);
    return structuredClone(sample);
  };
  const protectedDetail = {
    context: {
      domain: "alert-content",
      serverId: "server",
      workerId: "worker",
      scopeId: "chat",
      operationId: id,
      operation: "alert.raise",
      direction: "stored",
      sequence: 0,
    },
    protectedContent: {
      formatVersion: 1,
      domain: "alert-content",
      keyRevision: 1,
      envelope: valid("chatMessageOpaqueContentSchema").protectedContent
        .envelope,
    },
  };
  const projection = {
    projectId: "project",
    chatId: "chat",
    source: "interaction",
    sourceId: "request",
    episodeId: "episode",
    sourceRevision: 1,
    kind: "permission",
    status: "open",
    occurredAt: stamp,
    target: { kind: "interaction", chatId: "chat", requestId: "request" },
  };
  const projections = [
    projection,
    {
      ...projection,
      chatId: null,
      target: { ...projection.target, chatId: null },
    },
    ...["task-review", "task-blocker"].map((source) => ({
      ...projection,
      source,
      kind: "blocked",
      target: {
        kind: "task",
        chatId: "chat",
        planningRound: 0,
        section: "plan",
      },
    })),
    {
      ...projection,
      source: "goal",
      kind: "goal-stalled",
      target: { kind: "goal", chatId: "chat", threadId: "thread" },
    },
    ...["blocked", "action-required"].map((kind) => ({
      ...projection,
      source: "agent",
      kind,
      target: { kind: "chat", chatId: "chat", turnId: null },
      protectedDetail,
    })),
  ];
  const alerts = projections.map((input) => {
    const { occurredAt, ...value } =
      p.projectAlertProjectionSchema.parse(input);
    return {
      ...value,
      id: "alert_" + "a".repeat(64),
      createdAt: occurredAt,
      updatedAt: occurredAt,
      resolvedAt: null,
    };
  });
  const binding = {
    bindingId: id,
    ownerId: "owner",
    chatId: "chat",
    executionLaneId: "lane",
    workerId: "worker",
    permissionProfileId: ":workspace",
    allowedOperations: ["context.get"],
    issuedAt: stamp,
    expiresAt: expires,
    contextKind: "project",
    projectId: "project",
    worktreeId: "worktree",
    rootKind: "git-worktree",
    scratchRootId: null,
  };
  const goal = valid("chatGoalResponseSchema", (v) => v.goal !== null).goal;
  const { objective: _objective, ...goalFields } = goal;
  const snapshot = {
    kind: "chat-encrypted",
    goal: {
      ...goalFields,
      protectedObjective: valid("chatMessageOpaqueContentSchema"),
    },
  };
  const task = valid("encryptedTaskCreateSchema");
  const configuration = p.modelConfigurationSchema.parse(
    valid("modelConfigurationSchema"),
  );
  const descriptor = {
    id,
    titleProtection: task.titleProtection,
    state: "draft",
    dispatchState: null,
    eligibilityCode: null,
    configuration,
    terminal: false,
    completedAt: null,
    updatedAt: stamp,
  };
  const context = {
    summary: "Current context",
    data: {
      worker: { id: "worker", name: "Fixture worker", online: true },
      context: {
        chatId: "chat",
        executionLaneId: "lane",
        permissionProfileId: ":workspace",
        projectId: "project",
        rootKind: "git-worktree",
        terminalId: null,
        workerId: "worker",
        worktreeId: "worktree",
        worktreeMode: "agent-managed",
      },
      binding: {
        status: "ready",
        mutationReady: true,
        staleClaims: [],
        recoveryInstruction: null,
        expiresAt: expires,
      },
    },
  };
  const fixtures = {
    projectAlertProjectionSchema: [
      ...projections,
      {
        ...projection,
        target: { kind: "goal", chatId: "chat", threadId: null },
      },
      { ...projection, sourceId: "other-request" },
      { ...projections.at(-1), protectedDetail: null },
      { ...projections.at(-1), kind: "permission" },
      { ...projection, protectedDetail },
    ],
    projectAlertSchema: [
      ...alerts,
      { ...alerts[0], status: "resolved", resolvedAt: expires },
    ],
    projectAlertQuerySchema: [{}, { limit: "100", after: alerts[0].id }],
    projectAlertPageSchema: [
      { items: [], nextCursor: null },
      { items: alerts, nextCursor: alerts[0].id },
    ],
    projectAlertCountsSchema: [[], [{ projectId: "project", count: 1 }]],
    projectAlertChangeSchema: [{ ownerId: "owner", projectId: "project" }],
    projectAlertProtectedDetailSchema: [
      protectedDetail,
      {
        ...protectedDetail,
        context: { ...protectedDetail.context, direction: "request" },
      },
      {
        ...protectedDetail,
        protectedContent: {
          ...protectedDetail.protectedContent,
          domain: "run-content",
        },
      },
    ],
    agentAlertMutationWireSchema: [
      {
        key: id,
        revision: 1,
        kind: "blocked",
        status: "open",
        protectedDetail,
      },
      {
        key: id,
        revision: 2,
        kind: "action-required",
        status: "resolved",
        protectedDetail,
      },
    ],
    cantripMcpAlertRaiseInputSchema: [
      {
        key: id,
        revision: 1,
        title: " Attention ",
        message: " Needs a decision ",
        nextStep: " Review ",
      },
      {
        key: id,
        revision: 2,
        title: "Blocked",
        message: "Waiting",
        nextStep: "",
        kind: "action-required",
      },
    ],
    cantripMcpAlertResolveInputSchema: [{ key: id, revision: 2 }],
    workerCantripMcpOperationCallSchema: [
      {
        requestId: "request",
        binding,
        request: { operation: "context.get", arguments: {} },
      },
      {
        requestId: "request",
        binding: {
          ...binding,
          contextKind: "standalone",
          projectId: null,
          worktreeId: null,
          rootKind: null,
          scratchRootId: "scratch",
        },
        request: { operation: "context.get", arguments: {} },
      },
    ],
    workerCantripMcpCapabilitiesQuerySchema: [{ workerId: "worker" }],
    cantripAgentOperationResultSchema: [
      { summary: "Completed" },
      {
        summary: "Opaque result",
        data: { retained: [null, false, 0] },
        mutated: true,
        continuationScheduled: true,
      },
    ],
    projectGoalSnapshotSchema: [
      { kind: "chat-encrypted", goal: null },
      snapshot,
    ],
    projectGoalObservationSchema: [
      {
        chatId: "chat",
        workerId: "worker",
        threadId: goal.threadId,
        generation: id,
        revision: 1,
        snapshot,
      },
      {
        chatId: "chat",
        workerId: "worker",
        threadId: "different-thread",
        generation: id,
        revision: 2,
        snapshot,
      },
      {
        chatId: "chat",
        workerId: "worker",
        threadId: "thread",
        generation: id,
        revision: 3,
        snapshot: { kind: "chat-encrypted", goal: null },
      },
    ],
    projectGoalObservationResultSchema: [
      { accepted: true },
      { accepted: false, reason: "retired-thread" },
    ],
    cantripMcpContextGetResultSchema: [
      context,
      {
        ...context,
        data: {
          ...context.data,
          contextWindow: {
            threadId: "thread",
            turnId: "turn",
            usedTokens: 100,
            contextWindowTokens: 1000,
            remainingTokens: 900,
            usedPercent: 10,
            remainingPercent: 90,
            usageUpdatedAtMs: 1,
            compactionScheduled: false,
          },
        },
      },
    ],
    agentTaskCreateWireSchema: [{ operationId: id, task }],
    agentTaskStatusWireSchema: [
      { tasks: [], missingTaskIds: [id], nextCursor: null },
      { tasks: [descriptor], missingTaskIds: [], nextCursor: 1 },
    ],
    cantripMcpTaskCreateInputSchema: [
      { description: " Task brief ", operationId: id },
      { description: "Task", title: " Title ", operationId: id },
    ],
    cantripMcpTaskListInputSchema: [{}, { cursor: 100000, limit: 100 }],
    cantripMcpTaskStatusInputSchema: [{ taskIds: [id] }],
    cantripMcpTaskWaitInputSchema: [
      { taskIds: [id] },
      { taskIds: [id], mode: "any", timeoutMs: 21600000 },
    ],
  };
  const baselines = {},
    boundaries = {};
  for (const [name, cases] of Object.entries(fixtures)) {
    baselines[name] = [];
    boundaries[name] = [];
    for (const input of cases) {
      let accepted = false;
      try {
        accepted = p[name].safeParse(input).success;
      } catch {}
      (accepted ? baselines[name] : boundaries[name]).push(input);
    }
    assert.ok(
      baselines[name].length > 0,
      `${name} includes an accepted Source input`,
    );
  }
  return { baselines, boundaries };
}
