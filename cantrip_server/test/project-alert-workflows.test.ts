import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  projectGoalObservationSchema,
  agentAlertMutationWireSchema,
  type ProjectGoalObservation,
} from "@cantrip/protocol";
import { createAgentAlertOperations } from "../src/agent-tools/alert-operations.js";
import * as schema from "../src/db/schema.js";
import { projectAlertFixture } from "./project-alert-fixture.js";
import { protectedDisplayLabelFields } from "./private-label-fixture.js";
import { scheduleTaskRetry } from "../src/tasks/automatic-retry.js";

const cipher = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(22),
  },
};
let f: Awaited<ReturnType<typeof projectAlertFixture>>, chat: string;
const page = async () =>
  (await f.db.repository.alerts.list(f.owner, f.project))!.items;
const count = async () => (await page()).length;
beforeAll(async () => {
  f = await projectAlertFixture();
}, 30_000);
beforeEach(async () => {
  chat = (await f.db.repository.createChat(f.owner, f.project, {
    ...protectedDisplayLabelFields("chat"),
    modelId: null,
  }))!.id;
});
afterEach(async () => {
  await f.db.database.delete(schema.chats).where(eq(schema.chats.id, chat));
});
afterAll(async () => {
  await f?.close();
});
const taskUpdate = async (values: Partial<typeof schema.tasks.$inferInsert>) =>
  f.db.database
    .update(schema.tasks)
    .set({
      ...values,
      rowVersion: sql`${schema.tasks.rowVersion}+1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.chatId, chat));

it("keeps one review occurrence, retires accepted dispatch, and presents a new review after cancellation", async () => {
  await f.db.database
    .update(schema.chats)
    .set({ experience: "task" })
    .where(eq(schema.chats.id, chat));
  await f.db.database.insert(schema.tasks).values({
    chatId: chat,
    state: "review",
    hasPlan: true,
    hasQuestions: true,
    planningRound: 1,
    protectedContent: cipher,
  });
  const first = (await page())[0];
  expect(first.kind).toBe("task-questions");
  await taskUpdate({ protectedContent: cipher });
  expect((await page())[0].id).toBe(first.id);
  expect((await page())[0].createdAt).toBe(first.createdAt);
  const cycle = randomUUID();
  await f.db.database.insert(schema.taskDispatchCycles).values({
    id: cycle,
    ownerId: f.owner,
    chatId: chat,
    operationId: randomUUID(),
    operationKind: "finalize",
    state: "queued",
    fifoCreatedAt: new Date(),
  });
  expect(await count()).toBe(0);
  await f.db.database
    .update(schema.taskDispatchCycles)
    .set({ state: "cancelled" })
    .where(eq(schema.taskDispatchCycles.id, cycle));
  expect(await count()).toBe(1);
  expect((await page())[0].id).not.toBe(first.id);
  await taskUpdate({ planningRound: 2, hasQuestions: false });
  expect((await page())[0]).toMatchObject({
    kind: "plan-ready",
    target: { kind: "task", chatId: chat, planningRound: 2, section: "plan" },
  });
  await taskUpdate({ state: "implementing" });
  expect(await count()).toBe(0);
});

it("keeps explicit blockers visible on paused leases, avoids automatic-retry noise, and retires completion", async () => {
  await f.db.database
    .update(schema.chats)
    .set({ experience: "task" })
    .where(eq(schema.chats.id, chat));
  await f.db.database.insert(schema.tasks).values({
    chatId: chat,
    state: "blocked",
    lastError: {
      code: "goal-blocked",
      operationKind: "implementation",
      occurredAt: new Date().toISOString(),
    },
    protectedContent: cipher,
  });
  const blocked = (await page())[0];
  expect(blocked.kind).toBe("blocked");
  const cycle = randomUUID();
  await f.db.database.insert(schema.taskDispatchCycles).values({
    id: cycle,
    ownerId: f.owner,
    chatId: chat,
    operationId: randomUUID(),
    operationKind: "goal-continuation",
    state: "paused",
    fifoCreatedAt: new Date(),
  });
  expect((await page())[0].id).toBe(blocked.id);
  await taskUpdate({ state: "implementing", lastError: null });
  expect(await count()).toBe(0);
  await taskUpdate({ state: "paused" });
  expect(await count()).toBe(0);
  const retry = scheduleTaskRetry(null, "failure", "runtime", Date.now());
  await taskUpdate({
    state: "failed",
    lastError: {
      code: "runtime-failed",
      operationKind: "implementation",
      occurredAt: new Date().toISOString(),
    },
    automaticRetry: retry,
  });
  expect(await count()).toBe(0);
  await taskUpdate({
    automaticRetry: { ...retry, status: "manual", dueAt: null },
  });
  expect(await count()).toBe(1);
  await taskUpdate({ state: "complete", lastError: null });
  expect(await count()).toBe(0);
});

async function goalBinding() {
  const c = (
    await f.db.database
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, chat))
  )[0];
  await f.db.database
    .insert(schema.chatRuntimeSessions)
    .values({
      id: randomUUID(),
      chatId: chat,
      workerId: "alert-worker",
      worktreeId: c.activeWorktreeId,
      codexThreadId: "goal-thread",
    })
    .onConflictDoNothing();
  await f.db.database
    .update(schema.chatRuntimeSessions)
    .set({ codexThreadId: "goal-thread" })
    .where(eq(schema.chatRuntimeSessions.chatId, chat));
  const generation = randomUUID();
  await f.db.repository.alerts.registerGoalWorker(
    f.owner,
    "alert-worker",
    generation,
  );
  return generation;
}
function observation(
  generation: string,
  revision: number,
  status:
    | "active"
    | "paused"
    | "blocked"
    | "usageLimited"
    | "budgetLimited"
    | "complete"
    | null,
): ProjectGoalObservation {
  return projectGoalObservationSchema.parse({
    chatId: chat,
    workerId: "alert-worker",
    threadId: "goal-thread",
    generation,
    revision,
    snapshot: {
      kind: "chat-encrypted",
      goal: status
        ? {
            threadId: "goal-thread",
            status,
            tokenBudget: 1000,
            tokensUsed: 10,
            timeUsedSeconds: 1,
            createdAt: 1,
            updatedAt: 2,
            protectedObjective: {
              id: randomUUID(),
              classification: { role: "user", mode: "goal", attachmentIds: [] },
              protectedContent: cipher,
              idempotencyKey: "goal",
            },
          }
        : null,
    },
  });
}
it("projects explicit native Goal limits, rejects delayed observations, and recovers after a worker restart", async () => {
  const generation = await goalBinding();
  const apply = (revision: number, status: Parameters<typeof observation>[2]) =>
    f.db.repository.alerts.observeGoal(
      f.owner,
      observation(generation, revision, status),
    );
  await apply(1, "active");
  await apply(2, "paused");
  expect(await count()).toBe(0);
  const event = observation(generation, 3, "blocked");
  await f.db.repository.alerts.observeGoal(f.owner, event);
  await f.db.repository.alerts.observeGoal(f.owner, event);
  expect(await count()).toBe(1);
  const first = (await page())[0];
  expect(first.source).toBe("goal");
  expect(
    await f.db.repository.alerts.goalChats(f.owner, "alert-worker"),
  ).toContain(chat);
  expect(
    await f.db.repository.alerts.goalChats("foreign", "alert-worker"),
  ).toEqual([]);
  await apply(4, "active");
  expect(await count()).toBe(0);
  await f.db.repository.alerts.observeGoal(f.owner, event);
  expect(await count()).toBe(0);
  await apply(5, "budgetLimited");
  expect(await count()).toBe(1);
  expect((await page())[0].id).not.toBe(first.id);
  await f.db.database
    .update(schema.chats)
    .set({ archivedAt: new Date() })
    .where(eq(schema.chats.id, chat));
  expect(await count()).toBe(0);
  await apply(6, "budgetLimited");
  await f.db.database
    .update(schema.chats)
    .set({ archivedAt: null })
    .where(eq(schema.chats.id, chat));
  await apply(7, "budgetLimited");
  expect(await count()).toBe(0);
  await apply(8, "active");
  await apply(9, "usageLimited");
  expect(await count()).toBe(1);
  const restarted = randomUUID();
  await f.db.repository.alerts.registerGoalWorker(
    f.owner,
    "alert-worker",
    restarted,
  );
  expect(await apply(10, null)).toEqual({
    accepted: false,
    reason: "retired-worker",
  });
  expect(await count()).toBe(1);
  await f.db.repository.alerts.observeGoal(
    f.owner,
    observation(restarted, 1, null),
  );
  expect(await count()).toBe(0);
});

it("reconciles existing Goal intent without reading a transcript or inventing missing-status attention", async () => {
  const generation = await goalBinding();
  await f.db.database.insert(schema.chatMessages).values({
    id: randomUUID(),
    chatId: chat,
    role: "user",
    mode: "goal",
    worktreeId: (
      await f.db.database
        .select()
        .from(schema.chats)
        .where(eq(schema.chats.id, chat))
    )[0].activeWorktreeId,
    protectedContent: cipher,
  });
  expect(
    await f.db.repository.alerts.goalChats(f.owner, "alert-worker"),
  ).toContain(chat);
  expect(await count()).toBe(0);
  await f.db.repository.alerts.observeGoal(
    f.owner,
    observation(generation, 1, null),
  );
  expect(
    await f.db.repository.alerts.goalChats(f.owner, "alert-worker"),
  ).not.toContain(chat);
  expect(await count()).toBe(0);
});

it("rejects unprotected or mismatched Goal snapshots and avoids a second alert for a Task Goal", async () => {
  const generation = await goalBinding();
  const event = observation(generation, 1, "blocked");
  expect(
    projectGoalObservationSchema.safeParse({
      ...event,
      snapshot: {
        goal: { objective: "PRIVATE SENTINEL" },
        kind: "chat-encrypted",
      },
    }).success,
  ).toBe(false);
  expect(
    projectGoalObservationSchema.safeParse({ ...event, threadId: "another" })
      .success,
  ).toBe(false);
  await f.db.database
    .update(schema.chats)
    .set({ experience: "task" })
    .where(eq(schema.chats.id, chat));
  expect(await f.db.repository.alerts.observeGoal(f.owner, event)).toEqual({
    accepted: false,
    reason: "not-project-agent",
  });
  expect(await count()).toBe(0);
});

function mutation(
  key: string,
  revision: number,
  status: "open" | "resolved",
  scope = chat,
) {
  return agentAlertMutationWireSchema.parse({
    key,
    revision,
    status,
    kind: "blocked",
    protectedDetail: {
      context: {
        domain: "alert-content",
        serverId: "server",
        workerId: "alert-worker",
        scopeId: scope,
        operationId: key,
        operation: "agent-alert",
        direction: "stored",
        sequence: revision,
      },
      protectedContent: { ...cipher, domain: "alert-content" },
    },
  });
}
it("scopes agent tools to their live Chat, keeps tombstones, and retires on actual execution advancement", async () => {
  const context = await f.db.repository.startChatExecutionLane(
    f.owner,
    chat,
    "agent",
    "Alert tool qualification",
  );
  expect(context).not.toBeNull();
  const execute = createAgentAlertOperations({
    applicationOwnerId: () => f.owner,
    serverId: "server",
    repository: f.db.repository,
  });
  const call = (
    key: string,
    revision: number,
    status: "open" | "resolved",
    scope = chat,
  ) =>
    execute(context!, {
      operation: status === "open" ? "alert.raise" : "alert.resolve",
      arguments: mutation(key, revision, status, scope),
    });
  const key = randomUUID();
  const first = await call(key, 1, "open");
  expect(await count()).toBe(1);
  expect((await call(key, 1, "open")).data).toEqual(first.data);
  await expect(call(key, 2, "open", "foreign-chat")).rejects.toThrow(
    "authenticated Chat context",
  );
  expect(await count()).toBe(1);
  await call(key, 3, "resolved");
  expect(await count()).toBe(0);
  expect((await call(key, 4, "open")).data).toMatchObject({
    status: "resolved",
  });
  expect(await count()).toBe(0);
  const early = randomUUID();
  await call(early, 5, "resolved");
  await call(early, 1, "open");
  expect(await count()).toBe(0);
  await call(randomUUID(), 1, "open");
  await f.db.repository.finishChatExecutionLane(
    chat,
    context!.executionLaneId!,
    "idle",
  );
  expect(await count()).toBe(1);
  await f.db.repository.startChatExecutionLane(
    f.owner,
    chat,
    "agent",
    "Next accepted execution",
  );
  expect(await count()).toBe(0);
});
