import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  taskInferenceInputReceiptSchema,
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
