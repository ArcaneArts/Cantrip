import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  nativeSettingsReadScopeSchema,
  taskGoalCycleSourceRecordSchema,
  taskGoalCycleRecoverySchema,
  type InferenceJournalRecord,
  type NativeRuntimeHandoffQueuedSource,
  type NativeSettingsBinding,
  type NativeSettingsReadScope,
  type NativeRuntimeHandoffPrepared,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { nativeCommandContext } from "./native-command-context.js";
import { NativeCommandError } from "./native-command-errors.js";

const fail = (): never => {
  throw new NativeCommandError(
    "handoff-task-goal-source-replaced",
    "The queued Goal cycle changed or has already started. Refresh the queued cycle and try again.",
  );
};

/** Caller owns the existing project/chat lock. These are the Task's actual
 * current controls and dispatch, not a generated input or a managed session. */
export async function readTaskGoalHandoff(
  tx: RepositoryTransaction,
  ownerId: string,
  chatId: string,
  allowInactive = false,
) {
  const context = await nativeCommandContext(tx, ownerId, chatId);
  if (context?.experience !== "task") return null;
  const [task] = await tx
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.chatId, chatId))
    .for("update")
    .limit(1);
  const [cycle] = await tx
    .select()
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.ownerId, ownerId),
        eq(schema.taskDispatchCycles.chatId, chatId),
      ),
    )
    .orderBy(
      desc(schema.taskDispatchCycles.createdAt),
      desc(schema.taskDispatchCycles.id),
    )
    .for("update")
    .limit(1);
  const [chat] = await tx
    .select()
    .from(schema.chats)
    .where(and(eq(schema.chats.ownerId, ownerId), eq(schema.chats.id, chatId)))
    .limit(1);
  const [project] = context.projectId
    ? await tx
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, context.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1)
    : [];
  const [route] = cycle?.modelRouteId
    ? await tx
        .select()
        .from(schema.modelRoutes)
        .where(eq(schema.modelRoutes.id, cycle.modelRouteId))
        .limit(1)
    : [];
  const input = cycle?.goalInput;
  if (
    !task ||
    !cycle ||
    !chat ||
    !project ||
    !route ||
    context.contextKind !== "project" ||
    !context.threadId ||
    !context.worktreeId ||
    !task.planGoalEnabled ||
    !task.hasFinalPlan ||
    !task.hasGoalPrompt ||
    !task.implementationStartedAt ||
    (!allowInactive &&
      (task.activeOperationId !== null ||
        ["complete", "failed", "paused"].includes(task.state) ||
        chat.archivedAt ||
        chat.automationPaused ||
        chat.managedAutonomyStopped ||
        project.taskSchedulingPaused)) ||
    cycle.operationKind !== "finalize" ||
    !cycle.startedAt ||
    (!allowInactive && ["paused", "cancelled"].includes(cycle.state)) ||
    cycle.physicalWorkerId !== context.workerId ||
    cycle.codexThreadId !== context.threadId ||
    cycle.worktreeId !== context.worktreeId ||
    cycle.modelRouteId !== context.modelRouteId ||
    cycle.providerAccountId !== context.providerAccountId ||
    (!allowInactive &&
      input &&
      !input.deferred &&
      !input.failedBeforeDispatch &&
      input.firstDispatchedOperationId === null)
  )
    fail();
  const scope = nativeSettingsReadScopeSchema.parse({
    chatId,
    workerId: context.workerId,
    threadId: context.threadId,
    contextKind: "project",
    projectId: context.projectId,
    placementId: context.worktreeId,
    modelRouteId: context.modelRouteId,
    providerAccountId: context.providerAccountId,
  });
  return { context, task: task!, cycle: cycle!, route: route!, scope };
}

type Current = NonNullable<Awaited<ReturnType<typeof readTaskGoalHandoff>>>;

export function assertTaskGoalRecord(
  row: Current,
  scope: NativeSettingsReadScope,
  value: InferenceJournalRecord,
  original?: InferenceJournalRecord,
) {
  const record = taskGoalCycleSourceRecordSchema.parse(value);
  const cycle = record.identity.recovery!.taskGoalCycle!;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        record.workerGeneration,
        record.identity.runtimeGeneration,
        record.identity.operationId,
      ]),
    )
    .digest("hex");
  const expectedOrder =
    cycle.orderEpoch +
    (original && row.route.providerId !== original.identity.providerId ? 1 : 0);
  if (
    key !== record.key ||
    !isDeepStrictEqual(row.scope, scope) ||
    record.identity.chatId !== scope.chatId ||
    record.identity.projectId !== scope.projectId ||
    record.identity.recovery!.threadId !== scope.threadId ||
    cycle.cycleId !== row.cycle.id ||
    row.cycle.goalOrderEpoch !== expectedOrder ||
    (!original &&
      (record.identity.providerId !== row.route.providerId ||
        cycle.modelRouteId !== scope.modelRouteId ||
        cycle.providerAccountId !== scope.providerAccountId))
  )
    fail();
  return record;
}

export function reserveTaskGoalHandoff(
  row: Current,
  scope: NativeSettingsReadScope,
  record: InferenceJournalRecord,
): NativeRuntimeHandoffQueuedSource {
  assertTaskGoalRecord(row, scope, record);
  if (!["waiting", "granted"].includes(record.state) || record.outcome !== null)
    fail();
  return {
    operationId: record.identity.operationId,
    operationGeneration: record.identity.runtimeGeneration,
    withdrawn: false,
    taskGoal: record,
    taskGoalControl: {
      taskConfiguration: row.task.modelConfiguration,
      cycleConfiguration: row.cycle.modelConfiguration,
    },
  };
}

/** Verify current routing and stable control fields while preserving the actual
 * physical Source. Task progress/lease heartbeat row versions are irrelevant. */
export async function assertTaskGoalHandoff(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeSettingsBinding,
  queued: NativeRuntimeHandoffQueuedSource,
  allowInactive = false,
) {
  if (
    !queued.taskGoal ||
    !queued.taskGoalControl ||
    queued.autonomousAttempt ||
    queued.goalRecovery ||
    queued.goalClaim ||
    queued.goalWithdrawal ||
    queued.retargetedPrompt
  )
    fail();
  const row = await readTaskGoalHandoff(
    tx,
    ownerId,
    binding.chatId,
    allowInactive,
  );
  if (!row) fail();
  const {
    bindingId: _id,
    runtimeGeneration: _runtime,
    nativeEpoch: _epoch,
    ...scope
  } = binding;
  assertTaskGoalRecord(row!, scope, queued.taskGoal!, queued.taskGoal!);
  if (
    queued.operationId !== queued.taskGoal!.identity.operationId ||
    queued.operationGeneration !==
      queued.taskGoal!.identity.runtimeGeneration ||
    !isDeepStrictEqual(
      row!.task.modelConfiguration,
      queued.taskGoalControl!.taskConfiguration,
    ) ||
    !isDeepStrictEqual(
      row!.cycle.modelConfiguration,
      queued.taskGoalControl!.cycleConfiguration,
    )
  )
    fail();
  return row!;
}

export async function confirmTaskGoalHandoff(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeSettingsBinding,
  queued: NativeRuntimeHandoffQueuedSource,
  proof: InferenceJournalRecord | null,
) {
  const row = await assertTaskGoalHandoff(tx, ownerId, binding, queued);
  const source = queued.taskGoal!;
  const cycle = source.identity.recovery!.taskGoalCycle!;
  if (
    !proof ||
    proof.key !== source.key ||
    proof.workerGeneration !== source.workerGeneration ||
    !isDeepStrictEqual(proof.identity, source.identity) ||
    proof.order !== source.order ||
    proof.state !== "released" ||
    proof.outcome !== "never-started" ||
    (proof.nativeExecution &&
      (proof.nativeExecution.threadId !== binding.threadId ||
        proof.nativeExecution.turnId !== source.identity.recovery!.turnId ||
        proof.nativeExecution.scopeId !== cycle.scopeId))
  )
    fail();
  const previous = row.cycle.goalCycleRecovery;
  const same =
    previous &&
    previous.cycle.cycleId === cycle.cycleId &&
    previous.cycle.goalEpoch === cycle.goalEpoch &&
    previous.cycle.orderEpoch === cycle.orderEpoch &&
    previous.providerId === source.identity.providerId &&
    previous.threadId === binding.threadId &&
    (!previous.settled ||
      (previous.settled.reason === "dispatched" &&
        previous.settled.operationId === source.identity.operationId));
  const retained = same ? { ...previous! } : null;
  if (retained) delete retained.settled;
  const marker = taskGoalCycleRecoverySchema.parse(
    same
      ? { ...retained, admission: null }
      : {
          sourceKey: source.key,
          operationId: source.identity.operationId,
          runtimeGeneration: source.identity.runtimeGeneration,
          workerGeneration: source.workerGeneration,
          workerId: binding.workerId,
          providerId: source.identity.providerId,
          threadId: binding.threadId,
          turnId: source.identity.recovery!.turnId,
          cycle,
        },
  );
  await tx
    .update(schema.taskDispatchCycles)
    .set({ goalCycleRecovery: marker })
    .where(eq(schema.taskDispatchCycles.id, row.cycle.id));
}

export async function commitTaskGoalHandoff(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeSettingsBinding,
  queued: NativeRuntimeHandoffQueuedSource | null | undefined,
  target: {
    modelId: string;
    providerId: string;
    routeId: string;
    accountId: string | null;
  },
  prepared: NativeRuntimeHandoffPrepared,
): Promise<NativeRuntimeHandoffQueuedSource | undefined> {
  if (!queued?.taskGoal) return undefined;
  const row = await assertTaskGoalHandoff(tx, ownerId, binding, queued);
  const changedProvider = row.route.providerId !== target.providerId;
  const epoch = row.cycle.goalOrderEpoch + (changedProvider ? 1 : 0);
  if (!Number.isSafeInteger(epoch)) fail();
  const updateModel = (configuration: typeof row.task.modelConfiguration) => ({
    ...configuration,
    modelId: target.modelId,
    ...(prepared.reasoningEffort !== undefined
      ? { reasoningEffort: prepared.reasoningEffort }
      : {}),
  });
  const taskConfiguration = updateModel(row.task.modelConfiguration);
  const cycleConfiguration = updateModel(
    row.cycle.modelConfiguration ?? row.task.modelConfiguration,
  );
  const marker = row.cycle.goalCycleRecovery;
  if (
    !marker ||
    marker.settled ||
    marker.cycle.goalEpoch !==
      queued.taskGoal.identity.recovery!.taskGoalCycle!.goalEpoch
  )
    fail();
  const next = changedProvider
    ? {
        ...marker!,
        admission: null,
        settled: {
          reason: "transferred" as const,
          turnId: queued.taskGoal.identity.recovery!.turnId!,
          operationId: null,
        },
      }
    : {
        ...marker!,
        admission: null,
        binding: {
          modelRouteId: target.routeId,
          providerAccountId: target.accountId,
          orderEpoch: epoch,
        },
      };
  await tx
    .update(schema.tasks)
    .set({
      modelConfiguration: taskConfiguration,
      rowVersion: sql`${schema.tasks.rowVersion}+1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.chatId, binding.chatId));
  await tx
    .update(schema.taskDispatchCycles)
    .set({
      modelConfiguration: cycleConfiguration,
      modelRouteId: target.routeId,
      providerAccountId: target.accountId,
      goalOrderEpoch: epoch,
      goalCycleRecovery: taskGoalCycleRecoverySchema.parse(next),
      updatedAt: new Date(),
    })
    .where(eq(schema.taskDispatchCycles.id, row.cycle.id));
  return {
    ...queued,
    taskGoalControl: { taskConfiguration, cycleConfiguration },
  };
}
