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
  LOCAL_USER_ID,
  ServerRepository,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

import { protectedProjectFields } from "./private-label-fixture.js";

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
