import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  taskInferenceInputReceiptSchema,
  taskGoalCycleSuspensionSourceSchema,
  taskGoalOutcomeDeliverySchema,
  workerChatTurnOutcomeNotificationSchema,
  type InferenceFailureEvidence,
} from "@cantrip/protocol";
import { ServerRepository } from "../src/db/repository.js";
import { SecretVault } from "../src/security/secret-vault.js";
import { recoverGoalInputHistory } from "../src/db/task-goal-input-history.js";
import { persistHistoricalRoundOutcome } from "../src/db/task-round-input-history.js";
import type { TaskInferenceInputState } from "../src/db/task-inference-inputs.js";
import * as schema from "../src/db/schema.js";
import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";
import {
  taskEnvelope,
  taskMessage,
  taskResult,
  taskStart,
} from "../../scripts/server-rust/task-wire-fixtures.mjs";
import { captureTaskRuntimeState } from "../../scripts/server-rust/task-runtime-snapshot.mjs";

const client = new PGlite();
const database = drizzle(client, { schema });
const repository = new ServerRepository(
  database,
  new SecretVault({
    activeKeyId: "fixture",
    keys: [{ id: "fixture", key: Buffer.alloc(32) }],
  }),
);
const tasks = repository.tasks;
const contexts = repository;
const owner = randomUUID(),
  worker = randomUUID(),
  project = randomUUID();
const source = randomUUID(),
  tree = randomUUID();

beforeAll(async () => {
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await database
    .insert(schema.users)
    .values({ id: owner, kind: "anonymous", displayName: "Input authority" });
  await database.insert(schema.workers).values({
    id: worker,
    ownerId: owner,
    name: "Fixture",
    platform: "linux",
    architecture: "x64",
    startedAt: new Date(),
    lastSeenAt: new Date(),
  });
  await database.insert(schema.projects).values({
    id: project,
    ownerId: owner,
    protectedLabel: protectedProjectFields(project).nameProtection,
    githubRepositoryBlindIndex: randomUUID(),
  });
  await database.insert(schema.projectSources).values({
    id: source,
    projectId: project,
    workerId: worker,
    absolutePath: "/fixture",
    displayPath: "/fixture",
  });
  await database.insert(schema.projectWorktrees).values({
    id: tree,
    projectSourceId: source,
    workerId: worker,
    name: "Primary",
    isPrimary: true,
    isDefault: true,
    origin: "cantrip",
    lifecycleState: "ready",
    absolutePath: "/fixture",
    displayPath: "/fixture",
  });
}, 60000);
afterAll(() => client.close());

async function input(kind: "round" | "goal") {
  const chat = randomUUID(),
    message = randomUUID();
  await database.insert(schema.chats).values({
    id: chat,
    ownerId: owner,
    projectId: project,
    experience: "task",
    activeWorkerId: worker,
    activeWorktreeId: tree,
    protectedLabel: protectedChatFields(chat).titleProtection,
  });
  await database
    .insert(schema.tasks)
    .values({ chatId: chat, protectedContent: taskEnvelope });
  const receipt = taskInferenceInputReceiptSchema.parse({
    operationId: randomUUID(),
    ...(kind === "goal" ? { kind } : {}),
    chatId: chat,
    clientMessageId: message,
    workerId: worker,
    worktreeId: tree,
    executionLaneId: randomUUID(),
    executionLaneActivatedAt: new Date().toISOString(),
    providerId: "provider",
    modelRouteId: "route",
    providerAccountId: null,
    dispatch: {
      cycleId: randomUUID(),
      operationId: randomUUID(),
      leaseOwner: "server",
      fencingToken: 1,
    },
  });
  let state: TaskInferenceInputState = {
    receipt,
    deferred: true,
    accepted: true,
    dispatched: false,
    allAttemptsEnforced: true,
    firstDispatchedOperationId: null,
    multipleDispatched: false,
    attemptCountBefore: 0,
  };
  await database.insert(schema.chatMessages).values({
    id: message,
    chatId: chat,
    role: "user",
    mode: kind === "goal" ? "goal" : "plan",
    worktreeId: tree,
    taskProtectedContent: taskEnvelope,
    ...(kind === "goal" ? { taskGoalInput: state } : {}),
  });
  let roundStart: ReturnType<typeof taskStart> | undefined;
  if (kind === "round") {
    const start = taskStart(
      "initial-plan",
      chat,
      1,
      1,
      receipt.dispatch.operationId,
    );
    start.operation.userMessage.id = message;
    roundStart = start;
    await database.insert(schema.taskPlanningRounds).values({
      id: receipt.dispatch.operationId,
      chatId: chat,
      ordinal: 1,
      kind: "initial-plan",
      protectedContent: taskEnvelope,
      relayRequest: start.operation,
      failureTask: start.failure.task,
      failureRound: start.failure.round,
      userMessageId: message,
      inferenceInput: state,
    });
  }
  async function write(change: Partial<TaskInferenceInputState>) {
    state = { ...state, ...change };
    if (kind === "goal")
      await database
        .update(schema.chatMessages)
        .set({ taskGoalInput: state })
        .where(eq(schema.chatMessages.id, message));
    else
      await database
        .update(schema.taskPlanningRounds)
        .set({ inferenceInput: state })
        .where(eq(schema.taskPlanningRounds.id, receipt.dispatch.operationId));
  }
  function outcome(
    disposition: InferenceFailureEvidence["disposition"],
    changes: Record<string, string> = {},
  ) {
    const inference = {
      operationId: receipt.operationId,
      chatId: chat,
      messageId: message,
      providerId: receipt.providerId,
      disposition,
      runtimeGeneration: randomUUID(),
      threadId: "thread",
      turnId: "turn",
      nativeScopeId:
        disposition === "input-not-dispatched" ? null : randomUUID(),
      ...changes,
    };
    return workerChatTurnOutcomeNotificationSchema.parse({
      type: "chat.turn.outcome",
      chatId: chat,
      clientMessageId: message,
      executionLaneId: receipt.executionLaneId,
      worktreeId: tree,
      taskInferenceInputOperationId: receipt.operationId,
      taskDispatchFence: receipt.dispatch,
      outcome: { ok: false, error: "Controlled failure", inference },
    });
  }
  async function retire(
    disposition: InferenceFailureEvidence["disposition"],
    changes: Record<string, string> = {},
    reportingWorker = worker,
  ) {
    const notification = outcome(disposition, changes);
    return kind === "goal"
      ? tasks.inferenceInputs.goals.outcomeRetirementReason(
          owner,
          notification,
          reportingWorker,
        )
      : tasks.roundOutcomeRetirement(owner, reportingWorker, notification);
  }
  async function history(
    notification: ReturnType<typeof outcome>,
    reportingOwner = owner,
  ) {
    return kind === "goal"
      ? database.transaction((tx) =>
          recoverGoalInputHistory(
            tx,
            reportingOwner,
            worker,
            notification,
            repository.messageWrites,
          ),
        )
      : persistHistoricalRoundOutcome(
          database,
          repository.messageWrites,
          reportingOwner,
          worker,
          notification,
        );
  }
  function success() {
    const response = taskMessage(
      "assistant",
      kind === "goal" ? "goal" : "initial-plan",
      randomUUID(),
    );
    response.idempotencyKey = `assistant:${message}`;
    const structuredResult =
      kind === "goal"
        ? { message: response }
        : { ...taskResult(roundStart!), assistantMessage: response };
    return workerChatTurnOutcomeNotificationSchema.parse({
      ...outcome("model-failed-before-output"),
      outcome: {
        ok: true,
        result: {
          threadId: "thread",
          turnId: "turn",
          text: "",
          status: "completed",
          structuredResult,
        },
      },
    });
  }
  return { chat, receipt, write, retire, outcome, history, success };
}

describe.each(["round", "goal"] as const)(
  "durable %s outcome retirement",
  (kind) => {
    it("requires input-not-dispatched evidence rather than a model failure before output", async () => {
      const f = await input(kind);
      expect(await f.retire("model-failed-before-output")).toBeNull();
      expect(await f.retire("input-not-dispatched")).toBe(
        "canonical-input-deferred",
      );
    });
    it.each(["operationId", "providerId", "chatId", "messageId"])(
      "rejects a different evidence %s",
      async (field) => {
        const f = await input(kind);
        expect(
          await f.retire("input-not-dispatched", { [field]: randomUUID() }),
        ).toBeNull();
      },
    );
    it("rejects another physical worker", async () => {
      const f = await input(kind);
      expect(
        await f.retire("input-not-dispatched", {}, randomUUID()),
      ).toBeNull();
    });
    it.each([
      { accepted: false },
      { allAttemptsEnforced: false },
      { firstDispatchedOperationId: "prior-physical-attempt" },
      { deferred: false },
    ])(
      "retains input authority when a required guard changes: %j",
      async (change) => {
        const f = await input(kind);
        await f.write(change);
        expect(await f.retire("input-not-dispatched")).toBeNull();
      },
    );
  },
);

it("captures live Task evidence in one read-only snapshot scoped to its owner and project", async () => {
  const f = await input("round");
  const unsupportedSuspension = {
    version: 99,
    phase: "future-suspension",
    opaque: { retained: true },
  };
  const goalRecovery = {
    source: {
      operationId: "original-operation",
      operationGeneration: "original-generation",
      threadId: "original-thread",
      goalEpoch: "original-goal",
    },
    admission: null,
  };
  await database
    .insert(schema.managedQueueStates)
    .values({
      chatId: f.chat,
      goalRecovery,
      notifiedRevision: 0,
      notificationDueAt: new Date("2099-01-01T00:00:00Z"),
    })
    .onConflictDoUpdate({
      target: schema.managedQueueStates.chatId,
      set: { goalRecovery },
    });
  await database
    .update(schema.chats)
    .set({
      automationPaused: true,
      nativeSuspensionState: unsupportedSuspension,
    })
    .where(eq(schema.chats.id, f.chat));
  const query = (statements: string[], queries: string[]) =>
    client.transaction(async (tx) => {
      for (const statement of statements) await tx.exec(statement);
      const values = [];
      for (const statement of queries) {
        const result = await tx.query<{ result: string }>(statement);
        values.push(JSON.parse(result.rows[0]!.result));
      }
      return values;
    });
  const snapshot = await captureTaskRuntimeState({
    ownerId: owner,
    projectId: project,
    query,
  });
  expect(snapshot.rows.tasks).toEqual(
    expect.arrayContaining([expect.objectContaining({ chat_id: f.chat })]),
  );
  expect(snapshot.rows.chat_messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: f.receipt.clientMessageId,
        protected_content: expect.any(Object),
      }),
    ]),
  );
  expect(Object.keys(snapshot.rows)).toHaveLength(10);
  expect(snapshot.rows.managed_queue_states).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ chat_id: f.chat, goal_recovery: goalRecovery }),
    ]),
  );
  expect(snapshot.rows.chats).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: f.chat,
        automation_paused: true,
        native_suspension_state: unsupportedSuspension,
      }),
    ]),
  );
  for (const scope of [
    { ownerId: randomUUID(), projectId: project },
    { ownerId: owner, projectId: randomUUID() },
  ]) {
    const other = await captureTaskRuntimeState({ ...scope, query });
    expect(
      Object.values(other.rows).every(
        (rows) => Array.isArray(rows) && rows.length === 0,
      ),
    ).toBe(true);
  }
  expect(await tasks.get(owner, f.chat)).not.toBeNull();
});

describe("durable Goal observation placement", () => {
  async function observed() {
    const f = await input("goal");
    await database.insert(schema.chatRuntimeSessions).values({
      id: randomUUID(),
      chatId: f.chat,
      workerId: worker,
      worktreeId: tree,
      codexThreadId: "thread",
    });
    const context = await contexts.getChatExecutionContext(owner, f.chat);
    const task = await tasks.get(owner, f.chat);
    if (!context || !task) throw new Error("Missing owned observation fixture");
    return { ...f, context, task };
  }
  it("captures and revalidates the owned source path and rejects a changed Chat", async () => {
    const f = await observed();
    const fence = await tasks.goalObservations.capture(
      owner,
      f.context,
      f.task,
    );
    expect(JSON.parse(fence.fingerprint).chat.activeWorktreePath).toBe(
      "/fixture",
    );
    await tasks.goalObservations.validate(owner, f.chat, fence);
    await database
      .update(schema.chats)
      .set({ automationPaused: true })
      .where(eq(schema.chats.id, f.chat));
    await expect(
      tasks.goalObservations.validate(owner, f.chat, fence),
    ).rejects.toMatchObject({ code: "stale-version" });
  });
  it("rejects an execution root from a different project owned by the same user", async () => {
    const f = await observed();
    const foreignProject = randomUUID(),
      foreignSource = randomUUID(),
      foreignTree = randomUUID();
    await database.insert(schema.projects).values({
      id: foreignProject,
      ownerId: owner,
      protectedLabel: protectedProjectFields(foreignProject).nameProtection,
      githubRepositoryBlindIndex: randomUUID(),
    });
    await database.insert(schema.projectSources).values({
      id: foreignSource,
      projectId: foreignProject,
      workerId: worker,
      absolutePath: "/foreign",
      displayPath: "/foreign",
    });
    await database.insert(schema.projectWorktrees).values({
      id: foreignTree,
      projectSourceId: foreignSource,
      workerId: worker,
      name: "Primary",
      isPrimary: true,
      isDefault: true,
      origin: "cantrip",
      lifecycleState: "ready",
      absolutePath: "/foreign",
      displayPath: "/foreign",
    });
    await database.insert(schema.chatRuntimeSessions).values({
      id: randomUUID(),
      chatId: f.chat,
      workerId: worker,
      worktreeId: foreignTree,
      codexThreadId: "thread",
    });
    await database
      .update(schema.chats)
      .set({ activeWorktreeId: foreignTree })
      .where(eq(schema.chats.id, f.chat));
    const context = await contexts.getChatExecutionContext(owner, f.chat);
    if (!context) throw new Error("Missing foreign-placement fixture");
    await expect(
      tasks.goalObservations.capture(owner, context, f.task),
    ).rejects.toMatchObject({ code: "stale-version" });
  });
});

describe.each(["round", "goal"] as const)(
  "historical %s input ownership",
  (kind) => {
    it("stores a terminal physical failure through the owned source without changing Task controls", async () => {
      const f = await input(kind);
      await f.write({ deferred: false });
      const before = await tasks.get(owner, f.chat);
      const result = await f.history(f.outcome("model-failed-before-output"));
      expect(result).toMatchObject(
        kind === "goal"
          ? { historyOnly: true, terminal: { ok: false }, message: null }
          : {
              state: "owned",
              terminal: { historyOnly: true, ok: false },
              message: null,
            },
      );
      expect(await tasks.get(owner, f.chat)).toEqual(before);
      expect(
        await database
          .select()
          .from(schema.chatExecutionLanes)
          .where(eq(schema.chatExecutionLanes.chatId, f.chat)),
      ).toEqual([]);
      expect(
        await database
          .select()
          .from(schema.taskDispatchCycles)
          .where(eq(schema.taskDispatchCycles.chatId, f.chat)),
      ).toEqual([]);
    });
    it("retains the exact original dispatch fence", async () => {
      const f = await input(kind);
      await f.write({ deferred: false });
      const notification = f.outcome("model-failed-before-output");
      notification.taskDispatchFence!.fencingToken += 1;
      await expect(f.history(notification)).rejects.toMatchObject({
        code: "stale-lease",
      });
    });
    it("does not write historical metadata for another owner", async () => {
      const f = await input(kind);
      await f.write({ deferred: false });
      expect(
        await f.history(f.outcome("model-failed-before-output"), randomUUID()),
      ).toBeNull();
      expect(
        await f.history(f.outcome("model-failed-before-output")),
      ).toMatchObject({ terminal: { ok: false } });
    });
    it("attributes protected historical output to the original owned physical root", async () => {
      const f = await input(kind);
      await f.write({
        deferred: false,
        dispatched: true,
        firstDispatchedOperationId: f.receipt.operationId,
      });
      const replacement = randomUUID();
      await database.insert(schema.projectWorktrees).values({
        id: replacement,
        projectSourceId: source,
        workerId: worker,
        name: "replacement",
        origin: "cantrip",
        lifecycleState: "ready",
        absolutePath: `/replacement/${replacement}`,
        displayPath: `/replacement/${replacement}`,
      });
      await database
        .update(schema.chatMessages)
        .set({ worktreeId: replacement })
        .where(eq(schema.chatMessages.id, f.receipt.clientMessageId));
      const before = await tasks.get(owner, f.chat);
      const result = await f.history(f.success());
      expect(result).toMatchObject({
        terminal: { ok: true },
        message: {
          worktreeId: tree,
          executionLaneId: null,
          protectedContent: taskEnvelope,
        },
      });
      expect(await tasks.get(owner, f.chat)).toEqual(before);
    });
  },
);

describe("canonical Task native execution binding", () => {
  const lanes: string[] = [];
  afterEach(async () => {
    for (const id of lanes.splice(0))
      await database
        .update(schema.chatExecutionLanes)
        .set({ state: "released", releasedAt: new Date() })
        .where(eq(schema.chatExecutionLanes.id, id));
  });
  async function active(
    kind: "round" | "goal" = "round",
    finalizerStatus: "running" | "completed" = "completed",
  ) {
    const f = await input(kind);
    await f.write({ deferred: false, accepted: false });
    let goalInput: TaskInferenceInputState | undefined;
    if (kind === "goal") {
      const start = taskStart(
        "finalize",
        f.chat,
        2,
        1,
        f.receipt.dispatch.operationId,
      );
      const finalizerMessage = randomUUID();
      start.operation.userMessage.id = finalizerMessage;
      const result = taskResult(start);
      await database.insert(schema.chatMessages).values({
        id: finalizerMessage,
        chatId: f.chat,
        worktreeId: tree,
        role: "user",
        mode: "plan",
        taskProtectedContent: taskEnvelope,
      });
      await database.insert(schema.taskPlanningRounds).values({
        id: f.receipt.dispatch.operationId,
        chatId: f.chat,
        ordinal: 2,
        kind: "finalize",
        status: finalizerStatus,
        protectedContent: taskEnvelope,
        relayRequest: start.operation,
        relayResult: result,
        failureTask: start.failure.task,
        failureRound: start.failure.round,
        userMessageId: finalizerMessage,
      });
      const [message] = await database
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, f.receipt.clientMessageId));
      goalInput = {
        ...message!.taskGoalInput!,
        publication: {
          id: randomUUID(),
          idempotencyKey: `assistant:${f.receipt.clientMessageId}`,
        },
      };
    }
    await database
      .update(schema.tasks)
      .set({
        ...(kind === "goal"
          ? {
              state: "implementing" as const,
              activeOperationId: null,
              activeOperationKind: null,
              implementationStartedAt: new Date(),
              planGoalEnabled: true,
              planningRound: 2,
              hasPlan: true,
              hasFinalPlan: true,
              hasGoalPrompt: true,
            }
          : {
              activeOperationId: f.receipt.dispatch.operationId,
              activeOperationKind: "initial-plan" as const,
            }),
      })
      .where(eq(schema.tasks.chatId, f.chat));
    await database.insert(schema.chatExecutionLanes).values({
      id: f.receipt.executionLaneId,
      chatId: f.chat,
      workerId: worker,
      worktreeId: tree,
      acquiringActor: "fixture",
      state: "active",
      activatedAt: new Date(f.receipt.executionLaneActivatedAt),
    });
    lanes.push(f.receipt.executionLaneId);
    await database.insert(schema.taskDispatchCycles).values({
      id: f.receipt.dispatch.cycleId,
      chatId: f.chat,
      ownerId: owner,
      operationId: f.receipt.dispatch.operationId,
      operationKind: kind === "goal" ? "finalize" : "initial-plan",
      ...(goalInput ? { goalInput } : {}),
      state: "running",
      fifoCreatedAt: new Date(),
      fencingToken: f.receipt.dispatch.fencingToken,
      leaseOwner: f.receipt.dispatch.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 600_000),
      physicalWorkerId: worker,
      worktreeId: tree,
    });
    const metadata = {
      workerGeneration: randomUUID(),
      nativeRuntimeGeneration: randomUUID(),
      nativeExecution: {
        threadId: randomUUID(),
        turnId: randomUUID(),
        scopeId: randomUUID(),
      },
    };
    const dispatch = (
      phase: "claim" | "dispatch" | "native",
      value = metadata,
    ) => tasks.inferenceInputs.dispatch(owner, worker, f.receipt, phase, value);
    async function snapshot() {
      const [round] = await database
        .select()
        .from(schema.taskPlanningRounds)
        .where(
          eq(schema.taskPlanningRounds.id, f.receipt.dispatch.operationId),
        );
      const [cycle] = await database
        .select()
        .from(schema.taskDispatchCycles)
        .where(eq(schema.taskDispatchCycles.id, f.receipt.dispatch.cycleId));
      const [lane] = await database
        .select()
        .from(schema.chatExecutionLanes)
        .where(eq(schema.chatExecutionLanes.id, f.receipt.executionLaneId));
      return { round, cycle, lane };
    }
    return { ...f, metadata, dispatch, snapshot };
  }

  it.each([
    "restored",
    "live",
    "live-failed",
    "stopped",
    "restored-stopped",
  ] as const)(
    "preserves the completed parent while settling a %s autonomous Goal cycle",
    async (mode) => {
      const f = await active("goal");
      await f.dispatch("claim");
      await f.dispatch("dispatch");
      await f.dispatch("native");
      const before = await f.snapshot();
      const native = {
        threadId: f.metadata.nativeExecution.threadId,
        turnId: randomUUID(),
      };
      const cycle = {
        cycleId: f.receipt.dispatch.cycleId,
        goalEpoch: "actual-goal-epoch",
        scopeId: randomUUID(),
        gateAttemptId: randomUUID(),
        runnerGeneration: "native-runner",
        modelRouteId: f.receipt.modelRouteId,
        providerAccountId: f.receipt.providerAccountId,
        orderEpoch: 0,
      };
      const operationId = `native-inference:${native.threadId}:${native.turnId}:${cycle.scopeId}:${cycle.gateAttemptId}`;
      const sourceKey = createHash("sha256")
        .update(
          JSON.stringify([
            f.metadata.workerGeneration,
            f.metadata.nativeRuntimeGeneration,
            operationId,
          ]),
        )
        .digest("hex");
      const source = taskGoalCycleSuspensionSourceSchema.parse({
        kind: "goal-cycle",
        sourceKey,
        operationId,
        ...native,
        cycle,
        parent: f.receipt,
        workerGeneration: f.metadata.workerGeneration,
        runtimeGeneration: f.metadata.nativeRuntimeGeneration,
        publication: {
          id: randomUUID(),
          idempotencyKey: `assistant:goal-cycle:${sourceKey}`,
        },
      });
      await database
        .update(schema.chatMessages)
        .set({
          idempotencyKey: `goal-cycle-parent:${f.receipt.clientMessageId}`,
          taskAttachmentIds: [],
        })
        .where(eq(schema.chatMessages.id, f.receipt.clientMessageId));
      const parent = {
        ...before.cycle!.goalInput!,
        terminal: {
          ok: true,
          failureKind: null,
          observedAt: new Date().toISOString(),
          projectedAt: null,
          threadId: f.metadata.nativeExecution.threadId,
          turnId: f.metadata.nativeExecution.turnId,
        },
      };
      await database
        .insert(schema.modelProviders)
        .values({
          id: "provider",
          ownerId: owner,
          name: "Goal scope fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid",
        })
        .onConflictDoNothing();
      await database
        .insert(schema.modelProfiles)
        .values({ id: "model", ownerId: owner, name: "Goal scope fixture" })
        .onConflictDoNothing();
      await database
        .insert(schema.modelRoutes)
        .values({
          id: "route",
          modelId: "model",
          providerId: "provider",
          modelName: "fixture",
        })
        .onConflictDoNothing();
      await database
        .update(schema.taskDispatchCycles)
        .set({
          goalInput: parent,
          modelRouteId: f.receipt.modelRouteId,
          goalCycleRecovery: {
            sourceKey,
            operationId,
            ...native,
            cycle,
            workerId: worker,
            providerId: f.receipt.providerId,
            workerGeneration: source.workerGeneration,
            runtimeGeneration: source.runtimeGeneration,
            settled: {
              reason: "dispatched",
              operationId,
              turnId: native.turnId,
            },
            suspension: { source },
          },
        })
        .where(eq(schema.taskDispatchCycles.id, cycle.cycleId));
      await database
        .update(schema.chatExecutionLanes)
        .set({ state: "idle" })
        .where(eq(schema.chatExecutionLanes.id, f.receipt.executionLaneId));
      expect(
        (await repository.getChatExecutionContext(owner, f.chat))!
          .executionLaneId,
      ).toBeNull();
      const intent = (await repository.taskAutomationPause.request(
        owner,
        f.chat,
        true,
      ))!;
      expect(intent.scope.taskRound).toBeUndefined();
      expect(intent.scope.taskGoalCycle).toEqual({
        cycleId: cycle.cycleId,
        sourceKey,
        operationId,
        goalEpoch: cycle.goalEpoch,
        scopeId: cycle.scopeId,
      });
      const requested = (
        await repository.nativeSuspensions.request(
          owner,
          f.chat,
          "pause",
          native,
        )
      ).state;
      const actor = {
        workerGeneration: source.workerGeneration,
        runtimeGeneration: source.runtimeGeneration,
        operationId,
        operationGeneration: operationId,
      };
      await expect(
        repository.nativeSuspensions.claim(
          owner,
          f.chat,
          requested.controlId,
          null,
          { ...actor, runtimeGeneration: randomUUID() },
          native,
        ),
      ).rejects.toThrow("suspension-authority-changed");
      await repository.nativeSuspensions.claim(
        owner,
        f.chat,
        requested.controlId,
        null,
        actor,
        native,
      );
      // A later native cycle has no pending parent command whose teardown could
      // record this hold. The durable acknowledgement must commit it directly.
      expect((await f.snapshot()).cycle!.state).toBe("running");
      await repository.nativeSuspensions.paused(
        owner,
        f.chat,
        requested.controlId,
        actor,
        {
          storageId: randomUUID(),
          runtimeVersion: "0.166.0",
          runtimeFingerprint: null,
          suspension: { ...native, checkpointId: randomUUID(), revision: 1 },
        },
      );
      expect((await f.snapshot()).cycle!.state).toBe("paused");
      expect(
        await repository.taskDispatch.resumeNextPaused(
          owner,
          "ordinary-scheduler",
          async () => ({ eligible: true }),
        ),
      ).toBeNull();
      const stopCycle = async () => {
        await repository.nativeSuspensions.prepareTaskStop(owner, f.chat);
        const intent = (await repository.taskAutomationPause.request(
          owner,
          f.chat,
          true,
        ))!;
        const scope = (await repository.taskAutomationPause.fenceInterrupt(
          owner,
          f.chat,
          intent.scope.revision,
        ))!;
        expect(scope.scope.taskGoalCycle?.sourceKey).toBe(source.sourceKey);
        const stopped = (await repository.nativeSuspensions.prepareTaskStop(
          owner,
          f.chat,
        ))!;
        expect(stopped.stop!.active).toEqual(native);
        await repository.nativeSuspensions.acknowledgeTaskStop(
          owner,
          f.chat,
          stopped.stop!,
          scope.scope,
          {
            controlId: stopped.stop!.controlId,
            interrupted: true,
            active: native,
            outcome: "stopped",
            actor: {
              operationId: stopped.stop!.controlId,
              operationGeneration: stopped.stop!.controlId,
              workerGeneration: randomUUID(),
              runtimeGeneration: randomUUID(),
            },
          },
          repository.chatExecutionLanes,
        );
        expect(
          (await repository.nativeSuspensions.read(owner, f.chat))!.phase,
        ).toBe("stopped");
        expect(
          (await repository.nativeSuspensions.prepareTaskStop(owner, f.chat))!
            .stop,
        ).toBeNull();
        await expect(
          repository.nativeSuspensions.request(owner, f.chat, "resume"),
        ).rejects.toThrow("suspension-not-resumable");
        expect((await f.snapshot()).cycle!.goalInput).toEqual(parent);
        expect((await f.snapshot()).round).toEqual(before.round);
      };
      if (mode === "stopped") {
        await stopCycle();
        return;
      }
      const resumeIntent = (await repository.taskAutomationPause.request(
        owner,
        f.chat,
        false,
      ))!;
      expect(resumeIntent.paused).toBe(false);
      expect(
        (await repository.getChatExecutionContext(owner, f.chat))!
          .automationPaused,
      ).toBe(true);
      const saved = (await repository.nativeSuspensions.read(owner, f.chat))!;
      expect(saved.phase).toBe("resuming");
      if (mode === "live" || mode === "live-failed") {
        await repository.nativeSuspensions.claim(
          owner,
          f.chat,
          saved.controlId,
          actor,
          actor,
          native,
        );
        await repository.nativeSuspensions.running(
          owner,
          f.chat,
          saved.controlId,
          actor,
        );
        const response = taskMessage(
          "assistant",
          "goal",
          source.publication.id,
        );
        response.idempotencyKey = source.publication.idempotencyKey;
        const delivery = taskGoalOutcomeDeliverySchema.parse({
          version: 1,
          inputKind: "goal-cycle",
          deliveryId: randomUUID(),
          serverId: randomUUID(),
          ownerId: owner,
          workerId: worker,
          goalCycleSource: source,
          notification: {
            ...f.success(),
            taskInferenceInputOperationId: undefined,
            taskDispatchFence: undefined,
            outcome:
              mode === "live-failed"
                ? { ok: false, error: "The autonomous Task Goal turn failed." }
                : {
                    ok: true,
                    result: {
                      ...native,
                      text: "",
                      status: "completed",
                      structuredResult: { message: response },
                    },
                  },
          },
        });
        expect(
          await repository.tasks.inferenceInputs.goalCycles.commitOutcome(
            owner,
            worker,
            delivery,
          ),
        ).toMatchObject({
          committed: true,
          message:
            mode === "live-failed" ? null : { id: source.publication.id },
        });
        expect(
          await repository.tasks.inferenceInputs.goalCycles.commitOutcome(
            owner,
            worker,
            delivery,
          ),
        ).toMatchObject({ committed: true });
        const wrongPublisher = structuredClone(delivery);
        if (wrongPublisher.notification.outcome.ok) {
          (
            wrongPublisher.notification.outcome.result.structuredResult as {
              message: { id: string };
            }
          ).message.id = randomUUID();
          await expect(
            repository.tasks.inferenceInputs.goalCycles.commitOutcome(
              owner,
              worker,
              wrongPublisher,
            ),
          ).rejects.toThrow("canonical publisher");
        }
        expect(
          (await repository.nativeSuspensions.read(owner, f.chat))!.phase,
        ).toBe(mode === "live-failed" ? "failed" : "completed");
        expect(
          await database
            .select()
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.id, source.publication.id)),
        ).toHaveLength(mode === "live-failed" ? 0 : 1);
        expect((await f.snapshot()).cycle!.goalInput).toEqual(parent);
        expect((await f.snapshot()).round).toEqual(before.round);
        return;
      }
      const restore = await repository.nativeSuspensions.taskResumption(
        owner,
        f.chat,
        saved.controlId,
      );
      expect(restore.goalCycle).toEqual(source);
      expect(restore.source).toEqual(parent.receipt);
      const resumed = await repository.taskDispatch.resumeNextPaused(
        owner,
        "fresh-resume-owner",
        async () => ({ eligible: true }),
        {
          nativeSuspension: { chatId: f.chat, controlId: saved.controlId },
        },
      );
      expect(resumed?.lease.leaseOwner).toBe("fresh-resume-owner");
      expect(resumed!.lease.fencingToken).toBeGreaterThan(
        f.receipt.dispatch.fencingToken,
      );
      const restoredSource =
        await repository.tasks.inferenceInputs.goals.restorationSource(owner, {
          resumption: restore,
          lease: resumed!.lease,
        });
      expect(restoredSource.publication).toEqual(source.publication);
      expect(restoredSource.message.id).toBe(parent.receipt.clientMessageId);
      const admitted = await repository.nativeSuspensions.restoredTaskContext(
        owner,
        f.chat,
        restore,
        resumed!.lease,
      );
      expect(admitted.executionLaneId).toBe(parent.receipt.executionLaneId);
      expect(admitted.executionLaneActivatedAt).toBe(
        parent.receipt.executionLaneActivatedAt,
      );
      const physical = await repository.tasks.inferenceInputs.prepareResumption(
        owner,
        {
          resumption: restore,
          lease: resumed!.lease,
        },
      );
      expect(physical.kind).toBe("goal");
      expect(physical.operationId).not.toBe(parent.receipt.operationId);
      expect(physical.dispatch).toEqual({
        ...resumed!.lease,
        leaseExpiresAt: undefined,
      });
      expect(
        await repository.tasks.inferenceInputs.prepareResumption(owner, {
          resumption: restore,
          lease: resumed!.lease,
        }),
      ).toEqual(physical);
      const freshOwner = {
        workerGeneration: randomUUID(),
        nativeRuntimeGeneration: randomUUID(),
        nativeExecution: { ...native, scopeId: source.cycle.scopeId },
      };
      for (const phase of ["claim", "dispatch", "native"] as const)
        await repository.tasks.inferenceInputs.dispatch(
          owner,
          worker,
          physical,
          phase,
          freshOwner,
        );
      expect(
        (await repository.nativeSuspensions.read(owner, f.chat))!,
      ).toMatchObject({
        phase: "running",
        active: native,
        actor: {
          operationId: physical.operationId,
          workerGeneration: freshOwner.workerGeneration,
          runtimeGeneration: freshOwner.nativeRuntimeGeneration,
        },
      });
      if (mode === "restored-stopped") {
        await stopCycle();
        const stoppedFailure = workerChatTurnOutcomeNotificationSchema.parse({
          ...f.outcome("model-failed-before-output", {
            operationId: physical.operationId,
            turnId: native.turnId,
          }),
          taskInferenceInputOperationId: physical.operationId,
          taskDispatchFence: physical.dispatch,
        });
        expect(
          await repository.tasks.inferenceInputs.goals.applyOutcome(
            owner,
            worker,
            stoppedFailure,
          ),
        ).toMatchObject({
          retained: true,
          terminal: null,
          historyOnly: true,
        });
        expect((await f.snapshot()).cycle!.goalInput).toEqual(parent);
        expect(
          (await f.snapshot()).cycle!.goalCycleRecovery!.suspension!.terminal,
        ).toBeUndefined();
        return;
      }
      const response = taskMessage("assistant", "goal", source.publication.id);
      response.idempotencyKey = source.publication.idempotencyKey;
      const completed =
        await repository.tasks.inferenceInputs.goals.applyOutcome(
          owner,
          worker,
          workerChatTurnOutcomeNotificationSchema.parse({
            ...f.success(),
            taskInferenceInputOperationId: physical.operationId,
            taskDispatchFence: physical.dispatch,
            outcome: {
              ok: true,
              result: {
                ...native,
                text: "",
                status: "completed",
                structuredResult: { message: response },
              },
            },
          }),
        );
      expect(completed!.terminal).toMatchObject({
        ok: true,
        turnId: native.turnId,
      });
      expect(completed!.message!.id).toBe(source.publication.id);
      expect(
        (await repository.nativeSuspensions.read(owner, f.chat))!.phase,
      ).toBe("completed");
      expect((await f.snapshot()).cycle!.goalInput).toEqual(parent);
      expect((await f.snapshot()).round).toEqual(before.round);
    },
  );

  it.each(["running", "completed"] as const)(
    "binds a Goal input without rewriting its %s finalizer",
    async (status) => {
      const f = await active("goal", status);
      const before = await f.snapshot();
      await expect(f.dispatch("native")).rejects.toMatchObject({
        code: "stale-lease",
      });
      await f.dispatch("claim");
      await f.dispatch("dispatch");
      await f.dispatch("native");
      await f.dispatch("native");
      const bound = await f.snapshot();
      expect(bound.round).toEqual(before.round);
      expect(bound.cycle!.goalInput).toMatchObject({
        receipt: f.receipt,
        nativeExecution: f.metadata.nativeExecution,
        nativeOwner: {
          workerGeneration: f.metadata.workerGeneration,
          runtimeGeneration: f.metadata.nativeRuntimeGeneration,
        },
      });
      expect(bound.cycle!.turnId).toBe(f.metadata.nativeExecution.turnId);
      await expect(
        f.dispatch("native", {
          ...f.metadata,
          nativeRuntimeGeneration: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "stale-lease" });
      expect(await f.snapshot()).toEqual(bound);
      const intent = await repository.taskAutomationPause.request(
        owner,
        f.chat,
        true,
      );
      expect(intent?.scope.taskRound).toEqual({
        operationId: f.receipt.dispatch.operationId,
        inputOperationId: f.receipt.operationId,
        cycleId: f.receipt.dispatch.cycleId,
      });
    },
  );

  it.each(["round", "goal"] as const)(
    "fences stopped Task %s callbacks and requires the current cancellation proof",
    async (kind) => {
      const f = await active(kind);
      await f.dispatch("claim");
      await f.dispatch("dispatch");
      await f.dispatch("native");
      const pending = (await repository.nativeSuspensions.prepareTaskStop(
        owner,
        f.chat,
      ))!;
      expect(pending.stop).not.toBeNull();
      const intent = (await repository.taskAutomationPause.request(
        owner,
        f.chat,
        true,
      ))!;
      const current = (await repository.taskAutomationPause.fenceInterrupt(
        owner,
        f.chat,
        intent.scope.revision,
      ))!;
      const stopped = (await repository.nativeSuspensions.prepareTaskStop(
        owner,
        f.chat,
      ))!;
      expect(stopped.state.controlId).toBe(pending.state.controlId);
      expect(
        await repository.nativeSuspensions.taskExecutionStopped(
          owner,
          worker,
          f.receipt,
        ),
      ).toMatchObject({ phase: "stopping" });
      expect(
        await repository.nativeSuspensions.taskExecutionStopped(
          owner,
          "another-worker",
          f.receipt,
        ),
      ).toBeNull();
      expect(
        await repository.nativeSuspensions.taskExecutionStopped(owner, worker, {
          ...f.receipt,
          operationId: randomUUID(),
        }),
      ).toBeNull();
      let attempted = false;
      expect(
        await repository.taskDispatch.resumeNextPaused(
          owner,
          "ordinary-scheduler",
          async () => {
            attempted = true;
            return { eligible: true };
          },
        ),
      ).toBeNull();
      expect(attempted).toBe(false);
      const proof = {
        controlId: stopped.state.controlId,
        interrupted: true as const,
        active: stopped.stop!.active,
        outcome: "stopped" as const,
        actor: {
          operationId: stopped.state.controlId,
          operationGeneration: stopped.state.controlId,
          workerGeneration: randomUUID(),
          runtimeGeneration: randomUUID(),
        },
      };
      const before = await f.snapshot();
      await expect(
        repository.nativeSuspensions.acknowledgeTaskStop(
          owner,
          f.chat,
          stopped.stop!,
          current.scope,
          { ...proof, active: { ...proof.active, turnId: randomUUID() } },
          repository.chatExecutionLanes,
        ),
      ).rejects.toThrow("suspension-turn-mismatch");
      await expect(
        repository.nativeSuspensions.acknowledgeTaskStop(
          owner,
          f.chat,
          stopped.stop!,
          current.scope,
          { ...proof, actor: { ...proof.actor, operationId: randomUUID() } },
          repository.chatExecutionLanes,
        ),
      ).rejects.toThrow("suspension-actor-stale");
      expect(await f.snapshot()).toEqual(before);
      await repository.nativeSuspensions.acknowledgeTaskStop(
        owner,
        f.chat,
        stopped.stop!,
        current.scope,
        proof,
        repository.chatExecutionLanes,
      );
      expect(
        await repository.nativeSuspensions.taskExecutionStopped(
          owner,
          worker,
          f.receipt,
        ),
      ).toMatchObject({ phase: "stopped", checkpoint: null });
      expect((await f.snapshot()).round).toEqual(before.round);
      if (kind === "goal") {
        const retained = await tasks.inferenceInputs.goals.applyOutcome(
          owner,
          worker,
          f.outcome("model-failed-before-output"),
        );
        expect(retained).toMatchObject({
          retained: true,
          terminal: null,
          finished: false,
          historyOnly: true,
        });
        expect((await f.snapshot()).cycle!.goalInput!.terminal).toBeUndefined();
      }
      expect((await f.snapshot()).cycle).toMatchObject({
        state: "paused",
        attemptCount: before.cycle!.attemptCount,
      });
      expect(
        (await repository.nativeSuspensions.prepareTaskStop(owner, f.chat))!
          .stop,
      ).toBeNull();
    },
  );

  it.each(["completed", "failed"] as const)(
    "retires actual native %s while Stop awaits its cancellation receipt",
    async (outcome) => {
      const f = await active();
      await f.dispatch("claim");
      await f.dispatch("dispatch");
      await f.dispatch("native");
      const pending = (await repository.nativeSuspensions.prepareTaskStop(
        owner,
        f.chat,
      ))!;
      const activeTurn = {
        threadId: f.metadata.nativeExecution.threadId,
        turnId: f.metadata.nativeExecution.turnId,
      };
      const nativeOwner = {
        workerGeneration: f.metadata.workerGeneration,
        runtimeGeneration: f.metadata.nativeRuntimeGeneration,
      };
      await repository.nativeSuspensions.retireTaskExecution(
        owner,
        f.receipt,
        f.receipt,
        { ...nativeOwner, runtimeGeneration: randomUUID() },
        activeTurn,
        outcome,
      );
      expect(await repository.nativeSuspensions.read(owner, f.chat)).toEqual(
        pending.state,
      );
      await repository.nativeSuspensions.retireTaskExecution(
        owner,
        f.receipt,
        f.receipt,
        nativeOwner,
        activeTurn,
        outcome,
      );
      expect(
        await repository.nativeSuspensions.read(owner, f.chat),
      ).toMatchObject({
        phase: outcome,
        action: "stop",
        checkpoint: null,
        active: activeTurn,
      });
      expect(
        (await repository.nativeSuspensions.prepareTaskStop(owner, f.chat))!
          .stop,
      ).toBeNull();
    },
  );

  it.each(["round", "goal"] as const)(
    "admits a fresh physical %s Resume while keeping the original canonical input immutable",
    async (kind) => {
      const f = await active(kind);
      await f.dispatch("claim");
      await f.dispatch("dispatch");
      await f.dispatch("native");
      const activeTurn = {
        threadId: f.metadata.nativeExecution.threadId,
        turnId: f.metadata.nativeExecution.turnId,
      };
      const actor = {
        workerGeneration: f.metadata.workerGeneration,
        runtimeGeneration: f.metadata.nativeRuntimeGeneration,
        operationId: f.receipt.operationId,
        operationGeneration: f.receipt.operationId,
      };
      const requested = (
        await repository.nativeSuspensions.request(
          owner,
          f.chat,
          "pause",
          activeTurn,
        )
      ).state;
      await repository.nativeSuspensions.claim(
        owner,
        f.chat,
        requested.controlId,
        null,
        actor,
        activeTurn,
      );
      const checkpoint = {
        storageId: randomUUID(),
        runtimeVersion: "0.166.0",
        runtimeFingerprint: null,
        suspension: { ...activeTurn, checkpointId: randomUUID(), revision: 1 },
      };
      await repository.nativeSuspensions.paused(
        owner,
        f.chat,
        requested.controlId,
        actor,
        checkpoint,
      );
      await repository.nativeSuspensions.retainTaskExecution(
        owner,
        worker,
        f.receipt,
      );
      const intent = (await repository.taskAutomationPause.request(
        owner,
        f.chat,
        false,
      ))!;
      const saved = (await repository.nativeSuspensions.read(owner, f.chat))!;
      const original = await f.snapshot();
      const claim = await repository.taskDispatch.resumeNextPaused(
        owner,
        "fresh-resume-owner",
        async () => ({ eligible: true }),
        { nativeSuspension: { chatId: f.chat, controlId: saved.controlId } },
      );
      expect(claim).not.toBeNull();
      expect(claim!.lease.fencingToken).toBe(
        f.receipt.dispatch.fencingToken + 1,
      );
      expect(claim!.cycle.attemptCount).toBe(original.cycle!.attemptCount);
      const input = {
        resumption: {
          controlId: saved.controlId,
          checkpoint,
          source: f.receipt,
        },
        lease: claim!.lease,
        expectedInputRevision: intent.scope.revision,
      };
      await expect(
        tasks.inferenceInputs.prepareResumption(owner, {
          ...input,
          expectedInputRevision: intent.scope.revision + 1,
        }),
      ).rejects.toMatchObject({ code: "stale-lease" });
      const receipt = await tasks.inferenceInputs.prepareResumption(
        owner,
        input,
      );
      expect(
        await tasks.inferenceInputs.prepareResumption(owner, input),
      ).toEqual(receipt);
      expect(receipt.operationId).not.toBe(f.receipt.operationId);
      expect(receipt.executionLaneId).toBe(f.receipt.executionLaneId);
      if (kind === "goal") {
        const note = f.outcome("model-failed-before-output", {
          operationId: receipt.operationId,
        });
        note.taskInferenceInputOperationId = receipt.operationId;
        note.taskDispatchFence = receipt.dispatch;
        expect(
          await tasks.inferenceInputs.goals.outcomeRetirementReason(
            owner,
            note,
            worker,
          ),
        ).toBeNull();
      }
      const fresh = {
        workerGeneration: randomUUID(),
        nativeRuntimeGeneration: randomUUID(),
        nativeExecution: {
          ...f.metadata.nativeExecution,
          scopeId: randomUUID(),
        },
      };
      const dispatch = (
        phase: "claim" | "dispatch" | "native",
        metadata = fresh,
      ) =>
        tasks.inferenceInputs.dispatch(owner, worker, receipt, phase, metadata);
      await expect(f.dispatch("native")).rejects.toMatchObject({
        code: "stale-lease",
      });
      await expect(dispatch("native")).rejects.toMatchObject({
        code: "stale-lease",
      });
      await dispatch("claim");
      await expect(dispatch("claim")).rejects.toMatchObject({
        code: "stale-lease",
      });
      await dispatch("dispatch");
      await expect(
        dispatch("native", {
          ...fresh,
          nativeExecution: { ...fresh.nativeExecution, turnId: randomUUID() },
        }),
      ).rejects.toMatchObject({ code: "stale-lease" });
      await dispatch("native");
      const snapshot = await f.snapshot();
      if (kind === "goal") expect(snapshot.round).toEqual(original.round);
      expect(
        kind === "goal"
          ? snapshot.cycle!.goalInput
          : snapshot.round!.inferenceInput,
      ).toMatchObject({
        receipt: f.receipt,
        nativeExecution: f.metadata.nativeExecution,
        nativeOwner: {
          workerGeneration: f.metadata.workerGeneration,
          runtimeGeneration: f.metadata.nativeRuntimeGeneration,
        },
        firstDispatchedOperationId: f.receipt.operationId,
        multipleDispatched: false,
        resumption: {
          receipt,
          nativeExecution: fresh.nativeExecution,
          nativeOwner: {
            workerGeneration: fresh.workerGeneration,
            runtimeGeneration: fresh.nativeRuntimeGeneration,
          },
        },
      });
      const running = (await repository.nativeSuspensions.read(owner, f.chat))!;
      expect(running).toMatchObject({
        phase: "running",
        active: activeTurn,
        target: { originalOperationId: f.receipt.operationId },
        actor: {
          operationId: receipt.operationId,
          workerGeneration: fresh.workerGeneration,
          runtimeGeneration: fresh.nativeRuntimeGeneration,
        },
      });
      expect(
        (await repository.getChatExecutionContext(owner, f.chat))!
          .automationPaused,
      ).toBe(false);
    },
  );

  it("binds exact native identity atomically while preserving final-result and runtime authority", async () => {
    const f = await active();
    await f.dispatch("claim");
    await f.dispatch("dispatch");
    const result = await f.dispatch("native");
    expect(result).toEqual({
      receipt: f.receipt,
      nativeExecution: f.metadata.nativeExecution,
      nativeRuntimeGeneration: f.metadata.nativeRuntimeGeneration,
    });
    const { round, lane, cycle } = await f.snapshot();
    expect(round!.inferenceInput).toMatchObject({
      nativeExecution: f.metadata.nativeExecution,
      nativeOwner: {
        workerGeneration: f.metadata.workerGeneration,
        runtimeGeneration: f.metadata.nativeRuntimeGeneration,
      },
      dispatched: true,
      firstDispatchedOperationId: f.receipt.operationId,
    });
    expect(round!.turnId).toBeNull();
    expect(round!.relayResult).toBeNull();
    expect(lane!.codexThreadId).toBe(f.metadata.nativeExecution.threadId);
    expect(cycle!.codexThreadId).toBe(f.metadata.nativeExecution.threadId);
    expect(cycle!.turnId).toBe(f.metadata.nativeExecution.turnId);
    expect(
      await database
        .select()
        .from(schema.chatRuntimeSessions)
        .where(eq(schema.chatRuntimeSessions.chatId, f.chat)),
    ).toEqual([]);
    await database
      .update(schema.chats)
      .set({ automationPaused: true })
      .where(eq(schema.chats.id, f.chat));
    expect(await f.dispatch("native")).toEqual(result);
  });

  it("binds suspension metadata to the canonical Task input and its actual native actor", async () => {
    const f = await active();
    await f.dispatch("claim");
    await f.dispatch("dispatch");
    await f.dispatch("native");
    const execution = f.metadata.nativeExecution;
    const nativeTurn = {
      threadId: execution.threadId,
      turnId: execution.turnId,
    };
    const requested = await repository.nativeSuspensions.request(
      owner,
      f.chat,
      "pause",
      nativeTurn,
    );
    expect(requested.state.target).toMatchObject({
      threadId: execution.threadId,
      originalOperationId: f.receipt.operationId,
      taskRound: {
        operationId: f.receipt.dispatch.operationId,
        inputOperationId: f.receipt.operationId,
        cycleId: f.receipt.dispatch.cycleId,
      },
    });
    const actor = {
      workerGeneration: f.metadata.workerGeneration,
      runtimeGeneration: f.metadata.nativeRuntimeGeneration,
      operationId: f.receipt.operationId,
      operationGeneration: f.receipt.operationId,
    };
    await expect(
      repository.nativeSuspensions.claim(
        owner,
        f.chat,
        requested.state.controlId,
        null,
        { ...actor, operationId: randomUUID() },
        nativeTurn,
      ),
    ).rejects.toThrow("suspension-authority-changed");
    await repository.nativeSuspensions.claim(
      owner,
      f.chat,
      requested.state.controlId,
      null,
      actor,
      nativeTurn,
    );
    const evidence = {
      storageId: randomUUID(),
      runtimeVersion: "0.166.0",
      runtimeFingerprint: null,
      suspension: {
        threadId: execution.threadId,
        turnId: execution.turnId,
        checkpointId: randomUUID(),
        revision: 1,
      },
    };
    const paused = await repository.nativeSuspensions.paused(
      owner,
      f.chat,
      requested.state.controlId,
      actor,
      evidence,
    );
    expect(paused.state.phase).toBe("paused");
    expect(paused.state.checkpoint).toEqual(evidence);
    expect(
      await repository.nativeSuspensions.retainTaskExecution(owner, worker, {
        ...f.receipt,
        operationId: randomUUID(),
      }),
    ).toBeNull();
    expect(
      await repository.nativeSuspensions.retainTaskExecution(
        owner,
        worker,
        f.receipt,
      ),
    ).toEqual(paused.state);
    const [retained] = await database
      .select()
      .from(schema.taskDispatchCycles)
      .where(eq(schema.taskDispatchCycles.id, f.receipt.dispatch.cycleId));
    expect(retained).toMatchObject({
      state: "paused",
      codexThreadId: nativeTurn.threadId,
      turnId: nativeTurn.turnId,
    });
    const [round] = await database
      .select()
      .from(schema.taskPlanningRounds)
      .where(eq(schema.taskPlanningRounds.id, f.receipt.dispatch.operationId));
    expect(round).toMatchObject({
      status: "running",
      relayResult: null,
      turnId: null,
    });
    let admissionAttempted = false;
    expect(
      await repository.taskDispatch.resumeNextPaused(
        owner,
        "scheduler",
        async () => {
          admissionAttempted = true;
          throw new Error("A saved Task needs explicit restoration authority.");
        },
      ),
    ).toBeNull();
    expect(admissionAttempted).toBe(false);
    expect(
      await database
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, f.chat)),
    ).toEqual([]);
    expect(
      await database
        .select()
        .from(schema.chatRuntimeSessions)
        .where(eq(schema.chatRuntimeSessions.chatId, f.chat)),
    ).toEqual([]);
  });

  it("requires actual dispatch and the original physical worker generation", async () => {
    const f = await active();
    await expect(f.dispatch("native")).rejects.toMatchObject({
      code: "stale-lease",
    });
    await f.dispatch("claim");
    await expect(
      f.dispatch("dispatch", { ...f.metadata, workerGeneration: randomUUID() }),
    ).rejects.toMatchObject({ code: "stale-lease" });
    await expect(f.dispatch("native")).rejects.toMatchObject({
      code: "stale-lease",
    });
    await f.dispatch("dispatch");
    const before = await f.snapshot();
    await expect(
      f.dispatch("native", { ...f.metadata, workerGeneration: randomUUID() }),
    ).rejects.toMatchObject({ code: "stale-lease" });
    expect(await f.snapshot()).toEqual(before);
    await f.dispatch("native");
    const bound = await f.snapshot();
    for (const nativeExecution of [
      { ...f.metadata.nativeExecution, threadId: randomUUID() },
      { ...f.metadata.nativeExecution, turnId: randomUUID() },
      { ...f.metadata.nativeExecution, scopeId: randomUUID() },
    ])
      await expect(
        f.dispatch("native", { ...f.metadata, nativeExecution }),
      ).rejects.toMatchObject({ code: "stale-lease" });
    await expect(
      f.dispatch("native", {
        ...f.metadata,
        nativeRuntimeGeneration: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "stale-lease" });
    expect(await f.snapshot()).toEqual(bound);
  });

  it("rolls back lane and cycle changes when the actual round write fails", async () => {
    const f = await active();
    await f.dispatch("claim");
    await f.dispatch("dispatch");
    const before = await f.snapshot();
    await client.exec(`CREATE FUNCTION fail_native_task_bind() RETURNS trigger AS $$ BEGIN IF NEW.id = '${f.receipt.dispatch.operationId}' THEN RAISE EXCEPTION 'controlled native binding write failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_native_task_bind BEFORE UPDATE ON task_planning_rounds FOR EACH ROW EXECUTE FUNCTION fail_native_task_bind();`);
    try {
      await expect(f.dispatch("native")).rejects.toThrow();
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await client.exec(
        "DROP TRIGGER fail_native_task_bind ON task_planning_rounds; DROP FUNCTION fail_native_task_bind();",
      );
    }
    await f.dispatch("native");
  });

  it("rejects a retired canonical source without modifying its native identity", async () => {
    const f = await active();
    await f.dispatch("claim");
    await f.dispatch("dispatch");
    await database
      .update(schema.taskDispatchCycles)
      .set({ fencingToken: f.receipt.dispatch.fencingToken + 1 })
      .where(eq(schema.taskDispatchCycles.id, f.receipt.dispatch.cycleId));
    const before = await f.snapshot();
    await expect(f.dispatch("native")).rejects.toMatchObject({
      code: "stale-lease",
    });
    expect(await f.snapshot()).toEqual(before);
  });
});
