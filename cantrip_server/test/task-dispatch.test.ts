import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  taskWorkerCreateSchema,
  type TaskDispatchCycleState,
} from "@cantrip/protocol/task-scheduling";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  TaskDispatchConflictError,
  taskDispatchSchedulerPlan,
} from "../src/db/task-dispatch.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_ROUTE_ID,
  ExecutionLaneBusyError,
  LOCAL_USER_ID,
  ServerRepository,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";
import { reconcileTaskTurnPlacement } from "../src/app/runtime/task-turn-placement.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const encryptedTaskContent = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

async function fixture() {
  const client = new PGlite();
  const queries: string[] = [];
  const database = drizzle(client, {
    schema,
    logger: {
      logQuery(query) {
        queries.push(query);
      },
    },
  });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
    }),
  );
  await repository.ensureLocalIdentity();
  await repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    "fixture-model",
    "http://127.0.0.1:11434",
  );
  const physicalWorkerId = randomUUID();
  const now = new Date();
  await database.insert(schema.workers).values({
    id: physicalWorkerId,
    ownerId: LOCAL_USER_ID,
    name: "fixture-worker",
    platform: "darwin",
    architecture: "arm64",
    startedAt: now,
    lastSeenAt: now,
  });
  return { client, database, physicalWorkerId, queries, repository };
}

function workerInput(
  name: string,
  options: { allowsPlanGoal?: boolean; maxConcurrency?: number } = {},
) {
  return taskWorkerCreateSchema.parse({
    name,
    modelConfiguration: { modelId: DEFAULT_MODEL_ID },
    continuityFamilyOverride: "fixture-family",
    ...options,
  });
}

async function addTask(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  input: {
    createdAt: Date;
    planGoalEnabled?: boolean;
    priority?: number;
    requestedTaskWorkerId?: string | null;
  },
) {
  const { database, physicalWorkerId } = fixtureValue;
  const project = protectedProjectFields();
  const sourceId = randomUUID();
  const worktreeId = randomUUID();
  const chatId = randomUUID();
  await database.insert(schema.projects).values({
    id: project.id,
    ownerId: LOCAL_USER_ID,
    protectedLabel: project.nameProtection,
    githubRepositoryBlindIndex: randomUUID(),
  });
  await database.insert(schema.projectSources).values({
    id: sourceId,
    projectId: project.id,
    workerId: physicalWorkerId,
    absolutePath: `/fixture/${project.id}`,
    displayPath: `/fixture/${project.id}`,
  });
  await database.insert(schema.projectWorktrees).values({
    id: worktreeId,
    projectSourceId: sourceId,
    workerId: physicalWorkerId,
    name: "main",
    absolutePath: `/fixture/${project.id}`,
    displayPath: `/fixture/${project.id}`,
    isPrimary: true,
    isDefault: true,
    origin: "cantrip",
    lifecycleState: "ready",
  });
  await database.insert(schema.chats).values({
    id: chatId,
    ownerId: LOCAL_USER_ID,
    projectId: project.id,
    protectedLabel: project.nameProtection,
    experience: "task",
    activeWorktreeId: worktreeId,
    createdAt: input.createdAt,
  });
  await database.insert(schema.tasks).values({
    chatId,
    planGoalEnabled: input.planGoalEnabled ?? false,
    priority: input.priority ?? 0,
    requestedTaskWorkerId: input.requestedTaskWorkerId ?? null,
    protectedContent: encryptedTaskContent,
    createdAt: input.createdAt,
  });
  return { chatId, projectId: project.id, worktreeId };
}

const eligible = async () => ({
  eligible: true as const,
  modelRouteId: DEFAULT_MODEL_ROUTE_ID,
  providerAccountId: null,
});

describe("Task dispatch scheduling", () => {
  it("admits a follow-up after a blocked Task's secondary checkout was cleaned up", async () => {
    const f = await fixture();
    try {
      const task = await addTask(f, {
        createdAt: new Date(),
        planGoalEnabled: true,
      });
      await f.database
        .update(schema.chats)
        .set({
          protectedLabel: protectedChatFields(task.chatId).titleProtection,
        })
        .where(eq(schema.chats.id, task.chatId));
      const primary = (
        await f.repository.listProjectWorktrees(LOCAL_USER_ID, task.projectId)
      )[0]!;
      const secondaryId = randomUUID();
      await f.database.insert(schema.projectWorktrees).values({
        id: secondaryId,
        projectSourceId: primary.projectSourceId,
        workerId: primary.workerId,
        name: "Completed work",
        absolutePath: "/completed-work",
        displayPath: "/completed-work",
        origin: "agent",
        lifecycleState: "ready",
      });
      await f.repository.updateChatWorktree(LOCAL_USER_ID, task.chatId, {
        worktreeId: secondaryId,
        mode: "agent-managed",
      });
      await f.repository.updateChatRuntime(
        task.chatId,
        primary.workerId,
        secondaryId,
        "historical-thread",
        DEFAULT_MODEL_ROUTE_ID,
        "ready",
      );
      await f.database
        .update(schema.tasks)
        .set({ state: "blocked" })
        .where(eq(schema.tasks.chatId, task.chatId));
      await f.database
        .update(schema.projectWorktrees)
        .set({ lifecycleState: "missing" })
        .where(eq(schema.projectWorktrees.id, secondaryId));
      const before = (await f.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        task.chatId,
      ))!;
      await expect(
        f.repository.startChatExecutionLane(
          LOCAL_USER_ID,
          task.chatId,
          "user",
          "Follow-up",
        ),
      ).rejects.toThrow("not ready");
      // A user pin arriving after the recovery snapshot must win even when
      // the worktree ID itself did not change.
      await f.database
        .update(schema.chats)
        .set({ worktreeMode: "pinned" })
        .where(eq(schema.chats.id, task.chatId));
      await expect(
        f.repository.updateChatWorktree(
          LOCAL_USER_ID,
          task.chatId,
          {
            worktreeId: primary.id,
            mode: "agent-managed",
          },
          secondaryId,
        ),
      ).rejects.toThrow("placement changed");
      expect(
        (await f.repository.getChatExecutionContext(LOCAL_USER_ID, task.chatId))
          ?.worktreeId,
      ).toBe(secondaryId);
      await f.database
        .update(schema.chats)
        .set({ worktreeMode: "agent-managed" })
        .where(eq(schema.chats.id, task.chatId));
      const prepared = await reconcileTaskTurnPlacement(
        f.repository,
        {
          isConnected: () => true,
          request: async () => ({
            sourcePath: primary.path,
            primaryPath: primary.path,
            gitCommonDir: `${primary.path}/.git`,
            managedRoot: "/managed",
            repositoryFingerprint: "a".repeat(64),
            worktrees: [
              {
                path: primary.path,
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
            ],
          }),
        } as never,
        LOCAL_USER_ID,
        before,
      );
      expect(prepared).toMatchObject({
        chatId: task.chatId,
        workerId: primary.workerId,
        worktreeId: primary.id,
      });
      expect(
        (await f.repository.tasks.get(LOCAL_USER_ID, task.chatId))?.state,
      ).toBe("blocked");
      const historical = await f.database
        .select()
        .from(schema.chatRuntimeSessions)
        .where(eq(schema.chatRuntimeSessions.worktreeId, secondaryId));
      expect(historical[0]?.codexThreadId).toBe("historical-thread");
      const execution = await f.repository.startChatExecutionLane(
        LOCAL_USER_ID,
        task.chatId,
        "user",
        "Follow-up",
      );
      expect(execution?.executionLaneId).toBeTruthy();
      expect(execution?.worktreeId).toBe(primary.id);
    } finally {
      await f.client.close();
    }
  });
  it("reopens a settled handoff only with real worker capacity and records its new session affinity", async () => {
    const f = await fixture();
    try {
      const worker = await f.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("One slot", { allowsPlanGoal: true }),
      );
      const task = await addTask(f, {
        createdAt: new Date(),
        planGoalEnabled: true,
      });
      await f.database
        .update(schema.tasks)
        .set({
          state: "blocked",
          implementationStartedAt: new Date(),
          hasFinalPlan: true,
          hasGoalPrompt: true,
        })
        .where(eq(schema.tasks.chatId, task.chatId));
      const id = randomUUID();
      await f.database.insert(schema.taskDispatchCycles).values({
        id,
        ownerId: LOCAL_USER_ID,
        chatId: task.chatId,
        operationId: randomUUID(),
        operationKind: "finalize",
        state: "succeeded",
        fifoCreatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
        fencingToken: 2,
        codexThreadId: "source-thread",
        worktreeId: task.worktreeId,
        physicalWorkerId: f.physicalWorkerId,
        selectedTaskWorkerId: worker.id,
      });
      const cycle = (await f.repository.taskDispatch.get(LOCAL_USER_ID, id))!;
      const recover = () =>
        f.repository.taskDispatch.recoverStartedGoal(
          LOCAL_USER_ID,
          cycle,
          "recovery",
          new Date(),
          { allowSettled: true },
        );
      await expect(
        f.repository.taskDispatch.recoverStartedGoal(
          LOCAL_USER_ID,
          cycle,
          "passive",
        ),
      ).rejects.toMatchObject({ code: "stale-lease" });
      await f.database
        .update(schema.taskWorkers)
        .set({ enabled: false })
        .where(eq(schema.taskWorkers.id, worker.id));
      await expect(recover()).rejects.toMatchObject({
        code: "active-operation",
      });
      await f.database
        .update(schema.taskWorkers)
        .set({ enabled: true })
        .where(eq(schema.taskWorkers.id, worker.id));
      await f.database
        .update(schema.taskWorkers)
        .set({ allowsPlanGoal: false })
        .where(eq(schema.taskWorkers.id, worker.id));
      await expect(recover()).rejects.toThrow("no longer allows Plan + Goal");
      await f.database
        .update(schema.taskWorkers)
        .set({ allowsPlanGoal: true })
        .where(eq(schema.taskWorkers.id, worker.id));
      const other = await addTask(f, { createdAt: new Date() });
      const occupied = randomUUID();
      await f.database.insert(schema.taskDispatchCycles).values({
        id: occupied,
        ownerId: LOCAL_USER_ID,
        chatId: other.chatId,
        operationId: randomUUID(),
        operationKind: "direct",
        state: "claimed",
        fifoCreatedAt: new Date(),
        selectedTaskWorkerId: worker.id,
      });
      await expect(recover()).rejects.toMatchObject({
        code: "active-operation",
      });
      await f.database
        .update(schema.taskDispatchCycles)
        .set({ state: "succeeded" })
        .where(eq(schema.taskDispatchCycles.id, occupied));
      await f.database
        .update(schema.tasks)
        .set({ state: "complete" })
        .where(eq(schema.tasks.chatId, task.chatId));
      await expect(recover()).rejects.toMatchObject({ code: "stale-lease" });
      await f.database
        .update(schema.tasks)
        .set({ state: "blocked" })
        .where(eq(schema.tasks.chatId, task.chatId));
      const lease = await recover();
      expect(lease.fencingToken).toBe(3);
      await f.repository.taskDispatch.markRunning(lease, {
        turnId: "destination-turn",
        affinity: {
          worktreeId: other.worktreeId,
          threadId: "destination-thread",
          modelRouteId: DEFAULT_MODEL_ROUTE_ID,
          providerAccountId: null,
        },
      });
      expect(
        await f.repository.taskDispatch.get(LOCAL_USER_ID, id),
      ).toMatchObject({
        state: "running",
        codexThreadId: "destination-thread",
        worktreeId: other.worktreeId,
        turnId: "destination-turn",
        fencingToken: 3,
      });
      await expect(recover()).rejects.toMatchObject({ code: "stale-lease" });
    } finally {
      await f.client.close();
    }
  });
  it("recovers an expired retained Goal with a new fence without replaying its finalized operation", async () => {
    const f = await fixture();
    try {
      const task = await addTask(f, {
        createdAt: new Date(),
        planGoalEnabled: true,
      });
      await f.database
        .update(schema.tasks)
        .set({
          state: "failed",
          implementationStartedAt: new Date(),
          hasFinalPlan: true,
          hasGoalPrompt: true,
        })
        .where(eq(schema.tasks.chatId, task.chatId));
      const id = randomUUID();
      await f.database.insert(schema.taskDispatchCycles).values({
        id,
        ownerId: LOCAL_USER_ID,
        chatId: task.chatId,
        operationId: randomUUID(),
        operationKind: "finalize",
        state: "expired",
        fifoCreatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
        fencingToken: 2,
        codexThreadId: "retained-thread",
        worktreeId: task.worktreeId,
        physicalWorkerId: f.physicalWorkerId,
        eligibilityCode: "reconciliation-required",
      });
      const expired = (await f.repository.taskDispatch.get(LOCAL_USER_ID, id))!;
      await expect(
        f.repository.taskDispatch.recoverStartedGoal(
          "other-owner",
          expired,
          "new-server",
        ),
      ).rejects.toMatchObject({ code: "stale-lease" });
      const recovered = await f.repository.taskDispatch.recoverStartedGoal(
        LOCAL_USER_ID,
        expired,
        "new-server",
      );
      expect(recovered.fencingToken).toBe(3);
      expect(recovered.leaseOwner).toBe("new-server");
      expect(
        await f.repository.taskDispatch.get(LOCAL_USER_ID, id),
      ).toMatchObject({
        state: "running",
        codexThreadId: "retained-thread",
        attemptCount: 0,
        eligibilityCode: null,
        completedAt: null,
      });
      await expect(
        f.repository.taskDispatch.recoverStartedGoal(
          LOCAL_USER_ID,
          expired,
          "stale-server",
        ),
      ).rejects.toMatchObject({ code: "stale-lease" });
      await f.repository.taskDispatch.heartbeat(recovered);
      const live = (await f.repository.taskDispatch.get(LOCAL_USER_ID, id))!;
      expect(
        await f.repository.taskDispatch.recoverStartedGoal(
          LOCAL_USER_ID,
          live,
          "another-server",
        ),
      ).toMatchObject({ fencingToken: 3, leaseOwner: "new-server" });
      await f.repository.taskDispatch.settle(recovered, "succeeded");
      const complete = (await f.repository.taskDispatch.get(
        LOCAL_USER_ID,
        id,
      ))!;
      await expect(
        f.repository.taskDispatch.recoverStartedGoal(
          LOCAL_USER_ID,
          complete,
          "new-server",
        ),
      ).rejects.toMatchObject({ code: "stale-lease" });
      await f.database
        .update(schema.taskDispatchCycles)
        .set({ state: "expired" })
        .where(eq(schema.taskDispatchCycles.id, id));
      const superseded = (await f.repository.taskDispatch.get(
        LOCAL_USER_ID,
        id,
      ))!;
      await f.database.insert(schema.taskDispatchCycles).values({
        id: randomUUID(),
        ownerId: LOCAL_USER_ID,
        chatId: task.chatId,
        operationId: randomUUID(),
        operationKind: "finalize",
        state: "queued",
        fifoCreatedAt: new Date(),
        createdAt: new Date(Date.now() + 1000),
      });
      await expect(
        f.repository.taskDispatch.recoverStartedGoal(
          LOCAL_USER_ID,
          superseded,
          "new-server",
        ),
      ).rejects.toMatchObject({ code: "stale-lease" });
    } finally {
      await f.client.close();
    }
  });
  it("keeps a negative-priority Task queued behind the actual branch lease, then runs it", async () => {
    const value = await fixture();
    try {
      await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Two slots", { maxConcurrency: 2 }),
      );
      const first = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00Z"),
      });
      const second = await addTask(value, {
        createdAt: new Date("2026-08-24T10:01:00Z"),
        priority: -1,
      });
      await value.database
        .update(schema.projectWorktrees)
        .set({ branch: "main" })
        .where(eq(schema.projectWorktrees.id, first.worktreeId));
      await value.database
        .update(schema.chats)
        .set({ projectId: first.projectId, activeWorktreeId: first.worktreeId })
        .where(eq(schema.chats.id, second.chatId));
      await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        first.chatId,
        "first",
        "direct",
        1,
      );
      const running = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler",
        eligible,
      );
      await value.repository.taskDispatch.markRunning(running!.lease);
      const execution = await value.repository.startChatExecutionLane(
        LOCAL_USER_ID,
        first.chatId,
        "user",
        "First Task",
      );
      await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        second.chatId,
        "second",
        "direct",
        1,
      );
      expect(
        await value.repository.taskDispatch.claimNext(
          LOCAL_USER_ID,
          "scheduler",
          eligible,
        ),
      ).toBeNull();
      expect(
        (await value.repository.tasks.get(LOCAL_USER_ID, second.chatId))
          ?.dispatch,
      ).toMatchObject({
        state: "queued",
        eligibilityCode: "capacity-unavailable",
      });
      await expect(
        value.repository.startChatExecutionLane(
          LOCAL_USER_ID,
          second.chatId,
          "user",
          "Competing Task",
        ),
      ).rejects.toBeInstanceOf(ExecutionLaneBusyError);
      await value.repository.finishChatExecutionLane(
        first.chatId,
        execution!.executionLaneId!,
        "idle",
      );
      await value.repository.taskDispatch.settle(running!.lease, "succeeded");
      const next = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler",
        eligible,
      );
      expect(next?.cycle).toMatchObject({
        chatId: second.chatId,
        state: "claimed",
        operationId: "second",
      });
    } finally {
      await value.client.close();
    }
  });

  it("defers a competing launch without losing its operation or FIFO age and fences the old claimant", async () => {
    const value = await fixture();
    try {
      await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("One slot"),
      );
      const task = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00Z"),
      });
      const queued = await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        task.chatId,
        "race",
        "direct",
        1,
      );
      const claim = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler",
        eligible,
      );
      await value.repository.taskDispatch.markRunning(claim!.lease);
      const deferred = await value.repository.taskDispatch.deferForCapacity(
        claim!.lease,
      );
      expect(deferred).toMatchObject({
        state: "queued",
        operationId: "race",
        fifoCreatedAt: queued.fifoCreatedAt,
        selectedTaskWorkerId: null,
        fencingToken: claim!.lease.fencingToken + 1,
      });
      await expect(
        value.repository.taskDispatch.settle(claim!.lease, "failed"),
      ).rejects.toMatchObject({ code: "stale-lease" });
      const retried = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler",
        eligible,
      );
      expect(retried?.cycle.operationId).toBe("race");
    } finally {
      await value.client.close();
    }
  });
  it("summarizes active owner states into scheduler stage gates", async () => {
    const value = await fixture();
    try {
      const task = await addTask(value, {
        createdAt: new Date("2026-08-24T09:00:00.000Z"),
      });
      await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        task.chatId,
        "scheduler-state-operation",
        "direct",
        1,
      );

      const activeStates = [
        "queued",
        "claimed",
        "running",
        "paused",
      ] as const satisfies readonly TaskDispatchCycleState[];
      for (const state of activeStates) {
        await value.database
          .update(schema.taskDispatchCycles)
          .set({ state })
          .where(eq(schema.taskDispatchCycles.chatId, task.chatId));
        const owners =
          await value.repository.taskDispatch.listSchedulerOwners();
        expect(owners).toEqual([
          {
            ownerId: LOCAL_USER_ID,
            hasQueued: state === "queued",
            hasClaimed: state === "claimed",
            hasRunning: state === "running",
            hasPaused: state === "paused",
          },
        ]);
        expect(taskDispatchSchedulerPlan(owners[0]!)).toEqual({
          reconcileUnstartedClaims: state === "claimed",
          reconcileStartedLeases: state === "claimed" || state === "running",
          resumePaused: state === "paused",
          claimQueued: state === "queued",
        });
      }

      for (const state of [
        "succeeded",
        "failed",
        "cancelled",
        "expired",
      ] as const satisfies readonly TaskDispatchCycleState[]) {
        await value.database
          .update(schema.taskDispatchCycles)
          .set({ state })
          .where(eq(schema.taskDispatchCycles.chatId, task.chatId));
        expect(
          await value.repository.taskDispatch.listSchedulerOwners(),
        ).toEqual([]);
      }

      const remainingStates = ["claimed", "running", "paused"] as const;
      await value.database
        .update(schema.taskDispatchCycles)
        .set({ state: "queued" })
        .where(eq(schema.taskDispatchCycles.chatId, task.chatId));
      for (const [index, state] of remainingStates.entries()) {
        const extra = await addTask(value, {
          createdAt: new Date(`2026-08-24T0${index + 6}:00:00.000Z`),
        });
        await value.repository.taskDispatch.enqueue(
          LOCAL_USER_ID,
          extra.chatId,
          `scheduler-state-${state}`,
          "direct",
          1,
        );
        await value.database
          .update(schema.taskDispatchCycles)
          .set({ state })
          .where(eq(schema.taskDispatchCycles.chatId, extra.chatId));
      }
      value.queries.length = 0;
      const mixed = await value.repository.taskDispatch.listSchedulerOwners();
      expect(value.queries).toHaveLength(1);
      expect(mixed).toEqual([
        {
          ownerId: LOCAL_USER_ID,
          hasQueued: true,
          hasClaimed: true,
          hasRunning: true,
          hasPaused: true,
        },
      ]);
      expect(taskDispatchSchedulerPlan(mixed[0]!)).toEqual({
        reconcileUnstartedClaims: true,
        reconcileStartedLeases: true,
        resumePaused: true,
        claimQueued: true,
      });
    } finally {
      await value.client.close();
    }
  });

  it("enforces account-global capacity and FIFO independently of priority", async () => {
    const value = await fixture();
    try {
      const taskWorker = await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Two global slots", { maxConcurrency: 2 }),
      );
      const oldest = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
        priority: -100,
      });
      const middle = await addTask(value, {
        createdAt: new Date("2026-08-24T11:00:00.000Z"),
        priority: 100,
      });
      const newest = await addTask(value, {
        createdAt: new Date("2026-08-24T12:00:00.000Z"),
      });
      for (const task of [newest, middle, oldest]) {
        await value.repository.taskDispatch.enqueue(
          LOCAL_USER_ID,
          task.chatId,
          `operation-${task.chatId}`,
          "direct",
          1,
        );
      }

      const [first, second] = await Promise.all([
        value.repository.taskDispatch.claimNext(
          LOCAL_USER_ID,
          "scheduler-a",
          eligible,
        ),
        value.repository.taskDispatch.claimNext(
          LOCAL_USER_ID,
          "scheduler-b",
          eligible,
        ),
      ]);
      expect([first?.cycle.chatId, second?.cycle.chatId]).toEqual([
        oldest.chatId,
        middle.chatId,
      ]);
      expect(first?.taskWorker.id).toBe(taskWorker.id);
      expect(
        await value.repository.taskDispatch.claimNext(
          LOCAL_USER_ID,
          "scheduler-c",
          eligible,
        ),
      ).toBeNull();

      await value.repository.taskDispatch.settle(first!.lease, "succeeded");
      expect(
        (
          await value.repository.taskDispatch.claimNext(
            LOCAL_USER_ID,
            "scheduler-c",
            eligible,
          )
        )?.cycle.chatId,
      ).toBe(newest.chatId);
    } finally {
      await value.client.close();
    }
  });

  it("uses eligibility before FIFO and configured worker order for Auto", async () => {
    const value = await fixture();
    try {
      const direct = await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Direct first"),
      );
      const plan = await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Planning second", { allowsPlanGoal: true }),
      );
      const olderPlan = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
        planGoalEnabled: true,
      });
      const newerDirect = await addTask(value, {
        createdAt: new Date("2026-08-24T11:00:00.000Z"),
      });
      await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        olderPlan.chatId,
        "older-plan",
        "initial-plan",
        1,
      );
      await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        newerDirect.chatId,
        "newer-direct",
        "direct",
        1,
      );

      const first = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-a",
        eligible,
      );
      const second = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-b",
        eligible,
      );
      expect(first?.cycle.chatId).toBe(newerDirect.chatId);
      expect(first?.taskWorker.id).toBe(direct.id);
      expect(second?.cycle.chatId).toBe(olderPlan.chatId);
      expect(second?.taskWorker.id).toBe(plan.id);
    } finally {
      await value.client.close();
    }
  });

  it("requeues unstarted claims but expires and fences started work", async () => {
    const value = await fixture();
    try {
      await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Lease worker"),
      );
      const task = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
      });
      const queued = await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        task.chatId,
        "lease-operation",
        "direct",
        1,
      );
      const claimed = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-a",
        eligible,
        {
          now: new Date("2026-08-24T10:01:00.000Z"),
          leaseMs: 1_000,
        },
      );
      expect(claimed?.cycle.fifoCreatedAt).toBe(queued.fifoCreatedAt);
      const reconciled =
        await value.repository.taskDispatch.requeueExpiredLeases(
          LOCAL_USER_ID,
          new Date("2026-08-24T10:01:02.000Z"),
        );
      expect(reconciled).toHaveLength(1);
      expect(reconciled[0]).toMatchObject({
        state: "queued",
        fifoCreatedAt: queued.fifoCreatedAt,
        eligibilityCode: "reconciliation-required",
        fencingToken: claimed!.lease.fencingToken + 1,
      });
      const reclaimed = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-b",
        eligible,
        {
          now: new Date("2026-08-24T10:01:02.250Z"),
          leaseMs: 1_000,
        },
      );
      expect(reclaimed?.cycle.fifoCreatedAt).toBe(queued.fifoCreatedAt);
      await value.repository.taskDispatch.markRunning(reclaimed!.lease, {
        now: new Date("2026-08-24T10:01:02.500Z"),
        turnId: "turn-1",
      });
      expect(
        await value.repository.taskDispatch.requeueExpiredLeases(
          LOCAL_USER_ID,
          new Date("2026-08-24T10:01:04.000Z"),
        ),
      ).toHaveLength(0);
      const expired = await value.repository.taskDispatch.expireStartedLeases(
        LOCAL_USER_ID,
        new Date("2026-08-24T10:01:04.000Z"),
      );
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({
        state: "expired",
        fifoCreatedAt: queued.fifoCreatedAt,
        eligibilityCode: "reconciliation-required",
        fencingToken: reclaimed!.lease.fencingToken + 1,
      });
      await expect(
        value.repository.taskDispatch.settle(reclaimed!.lease, "succeeded", {
          now: new Date("2026-08-24T10:01:04.500Z"),
        }),
      ).rejects.toMatchObject<Partial<TaskDispatchConflictError>>({
        code: "stale-lease",
      });
    } finally {
      await value.client.close();
    }
  });

  it("requeues a terminal cycle without changing its FIFO age", async () => {
    const value = await fixture();
    try {
      await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Retry worker"),
      );
      const task = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
      });
      const queued = await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        task.chatId,
        "retry-operation",
        "direct",
        1,
      );
      const claimed = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-a",
        eligible,
      );
      await value.repository.taskDispatch.settle(claimed!.lease, "failed");

      const retried = await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        task.chatId,
        "retry-operation",
        "direct",
        1,
      );
      expect(retried).toMatchObject({
        id: queued.id,
        state: "queued",
        fifoCreatedAt: queued.fifoCreatedAt,
        queuedAt: queued.queuedAt,
        fencingToken: claimed!.lease.fencingToken + 1,
      });
    } finally {
      await value.client.close();
    }
  });

  it("releases paused capacity and reacquires the exact resident affinity", async () => {
    const value = await fixture();
    try {
      const taskWorker = await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("One resumable slot", { maxConcurrency: 1 }),
      );
      const firstTask = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
      });
      const secondTask = await addTask(value, {
        createdAt: new Date("2026-08-24T11:00:00.000Z"),
      });
      await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        firstTask.chatId,
        "resident-operation",
        "direct",
        1,
      );
      await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        secondTask.chatId,
        "other-operation",
        "direct",
        1,
      );
      const resident = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-a",
        eligible,
      );
      await value.repository.taskDispatch.markRunning(resident!.lease);
      const paused = await value.repository.taskDispatch.pause(
        resident!.lease,
        { threadId: "thread-resident", turnId: "turn-resident" },
      );
      expect(paused).toMatchObject({
        state: "paused",
        selectedTaskWorkerId: taskWorker.id,
        codexThreadId: "thread-resident",
        turnId: "turn-resident",
      });
      expect(paused.leaseExpiresAt).not.toBeNull();

      const other = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-b",
        eligible,
      );
      expect(other?.cycle.chatId).toBe(secondTask.chatId);
      expect(
        await value.repository.taskDispatch.resumeNextPaused(
          LOCAL_USER_ID,
          "scheduler-c",
          async () => ({ eligible: true }),
        ),
      ).toBeNull();

      await value.repository.taskDispatch.settle(other!.lease, "succeeded");
      const resumed = await value.repository.taskDispatch.resumeNextPaused(
        LOCAL_USER_ID,
        "scheduler-c",
        async () => ({ eligible: true }),
      );
      expect(resumed?.cycle).toMatchObject({
        id: paused.id,
        state: "running",
        selectedTaskWorkerId: taskWorker.id,
        physicalWorkerId: resident!.cycle.physicalWorkerId,
        modelRouteId: resident!.cycle.modelRouteId,
        providerAccountId: resident!.cycle.providerAccountId,
        codexThreadId: "thread-resident",
        turnId: "turn-resident",
      });
      expect(resumed?.lease.leaseOwner).toBe(resident!.lease.leaseOwner);
      expect(resumed?.lease.fencingToken).toBe(resident!.lease.fencingToken);
    } finally {
      await value.client.close();
    }
  });

  it("fences a delayed unstarted launch when pausing its claim", async () => {
    const value = await fixture();
    try {
      await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Preflight pause worker"),
      );
      const task = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
      });
      await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        task.chatId,
        "preflight-pause-operation",
        "direct",
        1,
      );
      const claimed = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-a",
        eligible,
      );
      const paused = await value.repository.taskDispatch.pauseUnstarted(
        claimed!.lease,
        { threadId: null, turnId: null },
      );
      expect(paused).toMatchObject({
        state: "paused",
        fencingToken: claimed!.lease.fencingToken + 1,
      });
      await expect(
        value.repository.taskDispatch.markRunning(claimed!.lease),
      ).rejects.toMatchObject<Partial<TaskDispatchConflictError>>({
        code: "stale-lease",
      });

      const resumed = await value.repository.taskDispatch.resumeNextPaused(
        LOCAL_USER_ID,
        "scheduler-b",
        async () => ({ eligible: true }),
      );
      expect(resumed?.lease.fencingToken).toBe(paused.fencingToken);
      await value.repository.taskDispatch.markRunning(resumed!.lease);
    } finally {
      await value.client.close();
    }
  });

  it("keeps queued Tasks editable until an atomic claim", async () => {
    const value = await fixture();
    try {
      const taskWorker = await value.repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Editable queue"),
      );
      const task = await addTask(value, {
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
      });
      const queued = await value.repository.taskDispatch.enqueue(
        LOCAL_USER_ID,
        task.chatId,
        "editable-operation",
        "direct",
        1,
      );
      const current = await value.repository.tasks.get(
        LOCAL_USER_ID,
        task.chatId,
      );
      const updated = await value.repository.tasks.updateDraft(
        LOCAL_USER_ID,
        task.chatId,
        {
          rowVersion: current.rowVersion,
          task: {
            classification: {
              state: current.state,
              stableStateBeforeFailure: current.stableStateBeforeFailure,
              activeOperationKind: current.activeOperationKind,
              planAuthorship: current.planAuthorship,
              planningRound: current.planningRound,
              hasPlan: current.hasPlan,
              hasQuestions: current.hasQuestions,
              hasFinalPlan: current.hasFinalPlan,
              hasGoalPrompt: current.hasGoalPrompt,
              lastError: current.lastError,
            },
            protectedContent: current.protectedContent,
          },
          priority: 50,
          requestedTaskWorkerId: taskWorker.id,
        },
      );
      expect(updated).toMatchObject({
        priority: 50,
        requestedTaskWorkerId: taskWorker.id,
        dispatch: {
          state: "queued",
          fifoCreatedAt: queued.fifoCreatedAt,
          requestedTaskWorkerId: taskWorker.id,
        },
      });

      const claimed = await value.repository.taskDispatch.claimNext(
        LOCAL_USER_ID,
        "scheduler-a",
        eligible,
      );
      expect(claimed?.cycle.chatId).toBe(task.chatId);
      await expect(
        value.repository.tasks.updateDraft(LOCAL_USER_ID, task.chatId, {
          rowVersion: updated!.rowVersion,
          task: {
            classification: {
              state: updated!.state,
              stableStateBeforeFailure: updated!.stableStateBeforeFailure,
              activeOperationKind: updated!.activeOperationKind,
              planAuthorship: updated!.planAuthorship,
              planningRound: updated!.planningRound,
              hasPlan: updated!.hasPlan,
              hasQuestions: updated!.hasQuestions,
              hasFinalPlan: updated!.hasFinalPlan,
              hasGoalPrompt: updated!.hasGoalPrompt,
              lastError: updated!.lastError,
            },
            protectedContent: updated!.protectedContent,
          },
          priority: 51,
        }),
      ).rejects.toThrow("already started");
    } finally {
      await value.client.close();
    }
  });
});
