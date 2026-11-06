import { queueStateChanged } from "./native-command-queue.js";
import { assertNativeRuntimeWritable } from "./native-runtime-handoff-guard.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nativeRuntimeHandoffInventory } from "./native-runtime-handoff-inventory.js";
import {
  nativeRuntimeHandoffRequestSchema,
  nativeRuntimeHandoffPreparedSchema,
  nativeRuntimeHandoffStateSchema,
  nativeRuntimeHandoffTaskContextSchema,
  taskGoalCycleCaptureSchema,
  type NativeRuntimeHandoffRequest,
  type NativeRuntimeHandoffPrepared,
  type NativeSettingsBinding,
  type InferenceJournalRecord,
  type NativeGoalRecoveryWithdrawal,
  type NativeSettingsReadScope,
  type TaskGoalCycleCapture,
  type NativeRuntimeHandoffQueuedSource,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { NativeCommandError } from "./native-command-errors.js";
import { ChatRuntimeContextRepository } from "./chat-runtime-context.js";
import {
  NativeSettingsStateRepository,
  changeNativeSettingsState,
} from "./native-settings-persistence.js";
import { bindNativeSettingsRead } from "./native-settings-state.js";
import type {
  ChatExecutionContext,
  ChatExecutionLaneRepository,
} from "./chat-execution-lanes.js";
import {
  reserveHandoffQueuedSource,
  confirmHandoffQueuedSource,
  retargetStandaloneHandoffInput,
} from "./native-handoff-queued-source.js";
import {
  assertGoalClaimPrompt,
  retainedGoalClaimMatches,
} from "./native-handoff-goal-claim.js";
import type { GoalHandoffClaim } from "./native-goal-handoff-affinity.js";
import {
  confirmGoalRecoveryHandoff,
  commitGoalRecoveryProvider,
} from "./native-handoff-goal-recovery.js";
import {
  readTaskGoalHandoff,
  assertTaskGoalRecord,
  reserveTaskGoalHandoff,
  assertTaskGoalHandoff,
  confirmTaskGoalHandoff,
  commitTaskGoalHandoff,
} from "./native-handoff-task-goal.js";
import { scopedNativeModelAttribution } from "./native-model-attribution.js";

export type TaskGoalCaptureReader = (
  scope: NativeSettingsReadScope,
  cycleId: string,
) => Promise<TaskGoalCycleCapture>;

type Row = typeof schema.nativeRuntimeHandoffs.$inferSelect;
const activePhases = ["preparing", "prepared", "committed"];
const fail = (code: string): never => {
  throw new NativeCommandError(code);
};
const wire = ({ ownerId: _owner, ...row }: Row) =>
  nativeRuntimeHandoffStateSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

function epochRetired(
  row: Row,
  runtimeGeneration: string,
  nativeEpoch: string,
) {
  return row.retiredNativeEpochs.some(
    (entry) =>
      entry.runtimeGeneration === runtimeGeneration &&
      entry.nativeEpoch === nativeEpoch,
  );
}
function retireEpoch(row: Row, runtimeGeneration: string, nativeEpoch: string) {
  return epochRetired(row, runtimeGeneration, nativeEpoch)
    ? row.retiredNativeEpochs
    : [...row.retiredNativeEpochs, { runtimeGeneration, nativeEpoch }];
}

function sameSnapshot(
  a: NativeRuntimeHandoffPrepared["snapshot"],
  b: NativeRuntimeHandoffPrepared["snapshot"],
) {
  // A retried worker read may encrypt the same version with a new nonce.
  return (
    a.contentFingerprint === b.contentFingerprint &&
    a.protectedContent.keyRevision === b.protectedContent.keyRevision &&
    isDeepStrictEqual(a.context, b.context) &&
    isDeepStrictEqual(a.modelAttribution, b.modelAttribution)
  );
}

/** Owns durable routing only. Files, credentials, native operations and CLI
 * replacement are performed by the authenticated worker outside transactions. */
export class NativeRuntimeHandoffRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly lanes: ChatExecutionLaneRepository,
  ) {}
  async inventory(ownerId: string, chatId: string) {
    const [latest] = await this.database
      .select({ operationId: schema.nativeRuntimeHandoffs.operationId })
      .from(schema.nativeRuntimeHandoffs)
      .where(
        and(
          eq(schema.nativeRuntimeHandoffs.ownerId, ownerId),
          eq(schema.nativeRuntimeHandoffs.chatId, chatId),
        ),
      )
      .orderBy(
        desc(schema.nativeRuntimeHandoffs.createdAt),
        desc(schema.nativeRuntimeHandoffs.operationId),
      )
      .limit(1);
    return nativeRuntimeHandoffInventory(
      this.database,
      ownerId,
      chatId,
      latest ? await this.get(ownerId, chatId, latest.operationId) : null,
    );
  }
  /** Configured routing affinity for an exact transferred queue revision. This
   * never grants capacity and cannot change later per-message choices. */
  async queuedStandaloneTransfer(
    ownerId: string,
    context: ChatExecutionContext,
    claimId: string | undefined,
    modelId: string,
  ): Promise<{ reasoningEffort?: string | null } | null> {
    if (
      context.contextKind !== "standalone" ||
      !claimId ||
      !context.modelRouteId
    )
      return null;
    const [handoff] = await this.database
      .select({
        reasoningKnown: sql<boolean>`${schema.nativeRuntimeHandoffs.prepared} ? 'reasoningEffort'`,
        reasoningEffort: sql<
          string | null
        >`${schema.nativeRuntimeHandoffs.prepared}->>'reasoningEffort'`,
      })
      .from(schema.nativeRuntimeHandoffs)
      .innerJoin(
        schema.modelRoutes,
        eq(
          schema.modelRoutes.id,
          schema.nativeRuntimeHandoffs.targetModelRouteId,
        ),
      )
      .innerJoin(
        schema.managedQueueClaims,
        and(
          eq(
            schema.managedQueueClaims.chatId,
            schema.nativeRuntimeHandoffs.chatId,
          ),
          sql`${schema.managedQueueClaims.promptId} = ${schema.nativeRuntimeHandoffs.queuedSource}->'retargetedPrompt'->>'id'`,
          sql`${schema.managedQueueClaims.promptRevision}::text = ${schema.nativeRuntimeHandoffs.queuedSource}->'retargetedPrompt'->>'revision'`,
        ),
      )
      .innerJoin(
        schema.nativeSettingsStates,
        and(
          eq(
            schema.nativeSettingsStates.chatId,
            schema.nativeRuntimeHandoffs.chatId,
          ),
          sql`${schema.nativeSettingsStates.state}->'binding'->>'bindingId' = ${schema.nativeRuntimeHandoffs.binding}->>'bindingId'`,
        ),
      )
      .where(
        and(
          eq(schema.nativeRuntimeHandoffs.ownerId, ownerId),
          eq(schema.nativeRuntimeHandoffs.chatId, context.chatId),
          eq(schema.nativeRuntimeHandoffs.workerId, context.workerId),
          eq(schema.nativeRuntimeHandoffs.phase, "completed"),
          eq(
            schema.nativeRuntimeHandoffs.targetModelRouteId,
            context.modelRouteId,
          ),
          context.providerAccountId === null
            ? isNull(schema.nativeRuntimeHandoffs.targetProviderAccountId)
            : eq(
                schema.nativeRuntimeHandoffs.targetProviderAccountId,
                context.providerAccountId,
              ),
          eq(schema.modelRoutes.modelId, modelId),
          sql`${schema.nativeRuntimeHandoffs.source}->>'contextKind' = 'standalone'`,
          sql`${schema.nativeRuntimeHandoffs.source}->>'threadId' = ${context.threadId}`,
          eq(schema.managedQueueClaims.id, claimId),
        ),
      )
      .limit(1);
    return handoff
      ? {
          reasoningEffort: handoff.reasoningKnown
            ? handoff.reasoningEffort
            : undefined,
        }
      : null;
  }
  async get(ownerId: string, chatId: string, operationId: string) {
    const [row] = await this.database
      .select()
      .from(schema.nativeRuntimeHandoffs)
      .where(
        and(
          eq(schema.nativeRuntimeHandoffs.ownerId, ownerId),
          eq(schema.nativeRuntimeHandoffs.chatId, chatId),
          eq(schema.nativeRuntimeHandoffs.operationId, operationId),
        ),
      );
    if (!row) return null;
    if (
      !row.binding &&
      row.prepared &&
      ["committed", "completed"].includes(row.phase)
    ) {
      // Pre-recovery-schema operations did not persist their destination binding.
      // Expose the actual canonical binding only when it still matches that
      // committed receipt, so the worker can compare it during cold recovery.
      const current = (
        await new NativeSettingsStateRepository(this.database).get(
          ownerId,
          chatId,
        )
      )?.binding;
      if (
        current &&
        isDeepStrictEqual(current, {
          ...row.source,
          bindingId: current.bindingId,
          modelRouteId: row.targetModelRouteId,
          providerAccountId: row.targetProviderAccountId,
          runtimeGeneration: row.prepared.runtimeGeneration,
          nativeEpoch: row.prepared.snapshot.context.settingsVersion.epoch,
        })
      )
        return wire({ ...row, binding: current });
    }
    return wire(row);
  }
  async activeForWorker(ownerId: string, workerId: string) {
    const rows = await this.database
      .select()
      .from(schema.nativeRuntimeHandoffs)
      .where(
        and(
          eq(schema.nativeRuntimeHandoffs.ownerId, ownerId),
          eq(schema.nativeRuntimeHandoffs.workerId, workerId),
          inArray(schema.nativeRuntimeHandoffs.phase, activePhases),
        ),
      );
    return rows.map(wire);
  }
  async activeTaskGoalForChat(ownerId: string, chatId: string) {
    const [row] = await this.database
      .select()
      .from(schema.nativeRuntimeHandoffs)
      .where(
        and(
          eq(schema.nativeRuntimeHandoffs.ownerId, ownerId),
          eq(schema.nativeRuntimeHandoffs.chatId, chatId),
          inArray(schema.nativeRuntimeHandoffs.phase, activePhases),
          sql`${schema.nativeRuntimeHandoffs.queuedSource}->'taskGoal' IS NOT NULL`,
        ),
      )
      .limit(1);
    return row ? wire(row) : null;
  }
  async begin(
    ownerId: string,
    chatId: string,
    value: NativeRuntimeHandoffRequest,
    readTaskGoal?: TaskGoalCaptureReader,
  ) {
    const input = nativeRuntimeHandoffRequestSchema.parse(value);
    // A Task has no managed command to reserve. Capture its actual private
    // native/keeper Source through the authenticated worker, outside DB locks.
    const taskCapture = readTaskGoal
      ? await this.captureTaskGoal(ownerId, chatId, readTaskGoal, input)
      : null;
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      const [existing] = await tx
        .select()
        .from(schema.nativeRuntimeHandoffs)
        .where(eq(schema.nativeRuntimeHandoffs.operationId, input.operationId));
      if (existing) {
        if (
          existing.ownerId !== ownerId ||
          existing.chatId !== chatId ||
          existing.source.bindingId !== input.bindingId ||
          existing.targetModelRouteId !== input.targetModelRouteId ||
          existing.targetProviderAccountId !== input.targetProviderAccountId
        )
          fail("handoff-operation-conflict");
        return wire(existing);
      }
      await assertNativeRuntimeWritable(tx, chatId);
      const state = await new NativeSettingsStateRepository(tx).get(
        ownerId,
        chatId,
      );
      const source = state?.binding;
      if (!source || source.bindingId !== input.bindingId)
        fail("handoff-source-replaced");
      const task = await readTaskGoalHandoff(tx, ownerId, chatId);
      const queuedSource = task
        ? taskCapture && isDeepStrictEqual(task.scope, taskCapture.scope)
          ? reserveTaskGoalHandoff(task, task.scope, taskCapture.value.record)
          : fail("handoff-task-goal-capture-required")
        : await reserveHandoffQueuedSource(tx, source!);
      await this.assertSource(tx, ownerId, source!, queuedSource);
      if (taskCapture) {
        const snapshot = taskCapture.value.snapshot;
        if (
          snapshot.context.workerId !== source!.workerId ||
          snapshot.context.chatId !== chatId ||
          snapshot.context.threadId !== source!.threadId ||
          snapshot.context.runtimeGeneration !== source!.runtimeGeneration ||
          snapshot.context.settingsVersion.epoch !== source!.nativeEpoch
        )
          fail("handoff-source-replaced");
      }
      if (state!.pending.length) fail("handoff-settings-pending");
      const target = await this.target(
        tx,
        ownerId,
        input.targetModelRouteId,
        input.targetProviderAccountId,
      );
      const [sourceRoute] = await tx
        .select()
        .from(schema.modelRoutes)
        .where(eq(schema.modelRoutes.id, source!.modelRouteId ?? ""));
      if (
        sourceRoute?.providerId === target.providerId &&
        source!.providerAccountId === input.targetProviderAccountId &&
        (!task || source!.modelRouteId === input.targetModelRouteId)
      )
        fail("handoff-same-provider-account");
      const [row] = await tx
        .insert(schema.nativeRuntimeHandoffs)
        .values({
          operationId: input.operationId,
          ownerId,
          chatId,
          workerId: source!.workerId,
          source: source!,
          binding: source!,
          queuedSource,
          phase: "preparing",
          targetModelRouteId: input.targetModelRouteId,
          targetProviderAccountId: input.targetProviderAccountId,
        })
        .returning();
      return wire(row!);
    });
  }

  private async captureTaskGoal(
    ownerId: string,
    chatId: string,
    read: TaskGoalCaptureReader,
    input?: NativeRuntimeHandoffRequest,
  ) {
    const before = await this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      if (input) {
        const [existing] = await tx
          .select({ id: schema.nativeRuntimeHandoffs.operationId })
          .from(schema.nativeRuntimeHandoffs)
          .where(
            eq(schema.nativeRuntimeHandoffs.operationId, input.operationId),
          );
        if (existing) return null; // The normal begin transaction deduplicates it.
      }
      await assertNativeRuntimeWritable(tx, chatId);
      const row = await readTaskGoalHandoff(tx, ownerId, chatId);
      if (!row) return null;
      const state = await new NativeSettingsStateRepository(tx).get(
        ownerId,
        chatId,
      );
      if (input && state?.binding?.bindingId !== input.bindingId)
        fail("handoff-source-replaced");
      return {
        scope: row.scope,
        cycleId: row.cycle.id,
        bindingId: state?.binding?.bindingId ?? null,
      };
    });
    if (!before) return null;
    const value = taskGoalCycleCaptureSchema.parse(
      await read(before.scope, before.cycleId),
    );
    return { ...before, value };
  }

  /** Explicit Task provider-selector read; it never prepares a native runtime.
   * A later begin always captures again and synchronously races actual dispatch. */
  async readTaskSource(
    ownerId: string,
    chatId: string,
    read: TaskGoalCaptureReader,
  ) {
    const captured = await this.captureTaskGoal(ownerId, chatId, read);
    if (!captured) fail("handoff-task-goal-source-required");
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      const { value, scope, bindingId } = captured!;
      const snapshot = value.snapshot;
      await assertNativeRuntimeWritable(
        tx,
        chatId,
        snapshot.context.runtimeGeneration,
        snapshot.context.settingsVersion.epoch,
      );
      const row = await readTaskGoalHandoff(tx, ownerId, chatId);
      if (!row) fail("handoff-task-goal-source-replaced");
      assertTaskGoalRecord(row!, scope, value.record);
      if (
        snapshot.context.workerId !== scope.workerId ||
        snapshot.context.chatId !== chatId ||
        snapshot.context.threadId !== scope.threadId
      )
        fail("handoff-task-goal-source-replaced");
      const scoped = await scopedNativeModelAttribution(
        tx,
        ownerId,
        scope,
        snapshot,
      );
      return changeNativeSettingsState(tx, chatId, (state) => {
        if (
          (state.binding?.bindingId ?? null) !== bindingId ||
          state.pending.length
        )
          fail("handoff-source-replaced");
        const source = {
          ...scope,
          runtimeGeneration: snapshot.context.runtimeGeneration,
          nativeEpoch: snapshot.context.settingsVersion.epoch,
        };
        const { bindingId: previous, ...current } = state.binding ?? {};
        return bindNativeSettingsRead(
          state,
          bindingId,
          {
            bindingId:
              previous &&
              isDeepStrictEqual(current, source) &&
              state.effective?.protectedContent.keyRevision ===
                snapshot.protectedContent.keyRevision
                ? previous
                : randomUUID(),
            ...source,
          },
          scoped,
        );
      });
    });
  }

  async taskContext(
    ownerId: string,
    state: ReturnType<typeof nativeRuntimeHandoffStateSchema.parse>,
    providerId: string,
  ) {
    if (!state.queuedSource?.taskGoal) return null;
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, state.chatId);
      const [stored] = await tx
        .select()
        .from(schema.nativeRuntimeHandoffs)
        .where(
          and(
            eq(schema.nativeRuntimeHandoffs.operationId, state.operationId),
            eq(schema.nativeRuntimeHandoffs.ownerId, ownerId),
          ),
        );
      if (
        !stored ||
        stored.phase !== state.phase ||
        stored.updatedAt.toISOString() !== state.updatedAt
      )
        fail("handoff-phase-conflict");
      await this.assertSource(
        tx,
        ownerId,
        stored!.binding ?? stored!.source,
        stored!.queuedSource,
        stored!.cancelRequested,
      );
      const row = await readTaskGoalHandoff(
        tx,
        ownerId,
        state.chatId,
        stored!.cancelRequested,
      );
      if (!row) fail("handoff-task-goal-source-replaced");
      const source = state.queuedSource!.taskGoal!;
      const cycle = source.identity.recovery!.taskGoalCycle!;
      return nativeRuntimeHandoffTaskContextSchema.parse({
        chatId: state.chatId,
        projectId: row!.context.projectId,
        worktreeId: row!.context.worktreeId,
        rootKind: row!.context.rootKind,
        ...(row!.context.osExecution
          ? { osExecution: row!.context.osExecution }
          : {}),
        computerUseEnabled: row!.context.computerUseEnabled === true,
        cycleId: cycle.cycleId,
        goalEpoch: cycle.goalEpoch,
        orderEpoch:
          cycle.orderEpoch +
          (providerId === source.identity.providerId ? 0 : 1),
      });
    });
  }
  async requestCancellation(
    ownerId: string,
    chatId: string,
    operationId: string,
  ) {
    const state = await this.get(ownerId, chatId, operationId);
    if (!state) fail("handoff-not-found");
    return this.mutate(
      ownerId,
      state!.workerId,
      operationId,
      async (tx, row) => {
        if (row.phase === "cancelled") return row;
        if (["committed", "completed"].includes(row.phase))
          fail("handoff-already-committed");
        if (row.cancelRequested) return row;
        return this.update(tx, row, { cancelRequested: true, errorCode: null });
      },
    );
  }
  async prepared(
    ownerId: string,
    workerId: string,
    operationId: string,
    value: NativeRuntimeHandoffPrepared,
    expectedPreparedRuntimeGeneration: string | null = null,
    expectedPreparedNativeEpoch: string | null = null,
  ) {
    const prepared = nativeRuntimeHandoffPreparedSchema.parse(value);
    return this.mutate(ownerId, workerId, operationId, async (tx, row) => {
      if (row.queuedSource && !row.queuedSource.withdrawn)
        fail("handoff-queued-source-unconfirmed");
      if (row.cancelRequested) fail("handoff-cancel-requested");
      if (row.prepared) {
        const prior = row.prepared;
        const same = !(
          prior.threadId !== prepared.threadId ||
          prior.runtimeGeneration !== prepared.runtimeGeneration ||
          prior.snapshot.contentFingerprint !==
            prepared.snapshot.contentFingerprint ||
          prior.snapshot.protectedContent.keyRevision !==
            prepared.snapshot.protectedContent.keyRevision ||
          !isDeepStrictEqual(
            prior.snapshot.context,
            prepared.snapshot.context,
          ) ||
          !isDeepStrictEqual(
            prior.snapshot.modelAttribution,
            prepared.snapshot.modelAttribution,
          )
        );
        if (same) {
          if (
            prior.reasoningEffort !== undefined &&
            prepared.reasoningEffort !== undefined &&
            prior.reasoningEffort !== prepared.reasoningEffort
          )
            fail("handoff-preparation-conflict");
          if (
            row.phase === "prepared" &&
            prior.reasoningEffort === undefined &&
            prepared.reasoningEffort !== undefined
          )
            return this.update(tx, row, {
              prepared: { ...prior, reasoningEffort: prepared.reasoningEffort },
            });
          return row;
        }
        if (
          row.phase !== "prepared" ||
          prior.runtimeGeneration !== expectedPreparedRuntimeGeneration ||
          (expectedPreparedNativeEpoch !== null &&
            prior.snapshot.context.settingsVersion.epoch !==
              expectedPreparedNativeEpoch) ||
          (prepared.runtimeGeneration === prior.runtimeGeneration &&
            (expectedPreparedNativeEpoch === null ||
              prepared.snapshot.context.settingsVersion.epoch ===
                expectedPreparedNativeEpoch))
        )
          fail("handoff-preparation-conflict");
      } else if (
        expectedPreparedRuntimeGeneration !== null ||
        expectedPreparedNativeEpoch !== null
      ) {
        fail("handoff-preparation-conflict");
      }
      if (!["preparing", "prepared"].includes(row.phase))
        fail("handoff-phase-conflict");
      const target = await this.target(
        tx,
        ownerId,
        row.targetModelRouteId,
        row.targetProviderAccountId,
      );
      const context = prepared.snapshot.context;
      const selection = prepared.snapshot.modelAttribution?.selection;
      if (
        prepared.threadId !== row.source.threadId ||
        context.threadId !== prepared.threadId ||
        context.chatId !== row.chatId ||
        context.workerId !== workerId ||
        context.runtimeGeneration !== prepared.runtimeGeneration ||
        prepared.runtimeGeneration ===
          (row.binding ?? row.source).runtimeGeneration ||
        row.retiredRuntimeGenerations.includes(prepared.runtimeGeneration) ||
        epochRetired(
          row,
          prepared.runtimeGeneration,
          context.settingsVersion.epoch,
        ) ||
        selection?.status !== "resolved" ||
        selection.workerId !== workerId ||
        selection.routeId !== row.targetModelRouteId ||
        selection.providerId !== target.providerId ||
        selection.modelId !== target.modelId ||
        selection.providerAccountId !== row.targetProviderAccountId
      )
        fail("handoff-prepared-source-mismatch");
      await this.assertSource(
        tx,
        ownerId,
        row.binding ?? row.source,
        row.queuedSource,
      );
      await this.assertIdle(tx, row.chatId, row.queuedSource?.goalClaim);
      return this.update(tx, row, {
        phase: "prepared",
        prepared,
        retiredNativeEpochs: row.prepared
          ? retireEpoch(
              row,
              row.prepared.runtimeGeneration,
              row.prepared.snapshot.context.settingsVersion.epoch,
            )
          : row.retiredNativeEpochs,
        retiredRuntimeGenerations:
          row.prepared &&
          row.prepared.runtimeGeneration !== prepared.runtimeGeneration
            ? [
                ...new Set([
                  ...row.retiredRuntimeGenerations,
                  row.prepared.runtimeGeneration,
                ]),
              ]
            : row.retiredRuntimeGenerations,
        errorCode: null,
      });
    });
  }
  async commit(ownerId: string, workerId: string, operationId: string) {
    return this.mutate(ownerId, workerId, operationId, async (tx, row) => {
      if (["committed", "completed"].includes(row.phase)) return row;
      if (row.cancelRequested) fail("handoff-cancel-requested");
      if (row.phase !== "prepared" || !row.prepared)
        fail("handoff-not-prepared");
      await this.assertSource(
        tx,
        ownerId,
        row.binding ?? row.source,
        row.queuedSource,
      );
      await this.assertIdle(tx, row.chatId, row.queuedSource?.goalClaim);
      const target = await this.target(
        tx,
        ownerId,
        row.targetModelRouteId,
        row.targetProviderAccountId,
      );
      const state = await new NativeSettingsStateRepository(tx).get(
        ownerId,
        row.chatId,
      );
      if (!state?.binding || state.pending.length)
        fail("handoff-settings-pending");
      const confirmed = row.prepared!.snapshot.modelAttribution?.selection;
      if (
        confirmed?.status !== "resolved" ||
        confirmed.providerId !== target.providerId ||
        confirmed.modelId !== target.modelId
      )
        fail("handoff-target-replaced");
      const prepared = row.prepared!;
      const binding: NativeSettingsBinding = {
        ...row.source,
        bindingId: randomUUID(),
        modelRouteId: row.targetModelRouteId,
        providerAccountId: row.targetProviderAccountId,
        runtimeGeneration: prepared.runtimeGeneration,
        nativeEpoch: prepared.snapshot.context.settingsVersion.epoch,
      };
      const next = bindNativeSettingsRead(
        state!,
        state!.binding!.bindingId,
        binding,
        prepared.snapshot,
      );
      const taskQueuedSource = await commitTaskGoalHandoff(
        tx,
        ownerId,
        state!.binding!,
        row.queuedSource,
        {
          ...target,
          routeId: row.targetModelRouteId,
          accountId: row.targetProviderAccountId,
        },
        prepared,
      );
      const updated = await tx
        .update(schema.chatRuntimeSessions)
        .set({
          modelRouteId: row.targetModelRouteId,
          providerAccountId: row.targetProviderAccountId,
          status: "ready",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.chatRuntimeSessions.chatId, row.chatId),
            eq(schema.chatRuntimeSessions.workerId, workerId),
            eq(schema.chatRuntimeSessions.codexThreadId, row.source.threadId),
            row.source.contextKind === "project"
              ? eq(
                  schema.chatRuntimeSessions.worktreeId,
                  row.source.placementId,
                )
              : eq(
                  schema.chatRuntimeSessions.scratchRootId,
                  row.source.placementId,
                ),
          ),
        )
        .returning({ id: schema.chatRuntimeSessions.id });
      if (updated.length !== 1) fail("handoff-runtime-replaced");
      // Child defaults, permissions, tier and history remain owned by their
      // existing canonical state. The destination snapshot confirms root settings.
      await tx
        .update(schema.chats)
        .set({
          modelId: target.modelId,
          ...(prepared.reasoningEffort !== undefined
            ? { reasoningEffort: prepared.reasoningEffort }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.chats.id, row.chatId));
      await tx
        .update(schema.nativeSettingsStates)
        .set({ state: next, updatedAt: new Date() })
        .where(eq(schema.nativeSettingsStates.chatId, row.chatId));
      await commitGoalRecoveryProvider(
        tx,
        row.source,
        row.queuedSource,
        target.providerId,
      );
      const retargetedPrompt =
        row.source.contextKind === "standalone" && row.queuedSource
          ? await retargetStandaloneHandoffInput(
              tx,
              row.chatId,
              row.queuedSource,
              target.modelId,
            )
          : undefined;
      return this.update(tx, row, {
        phase: "committed",
        binding,
        ...(taskQueuedSource ? { queuedSource: taskQueuedSource } : {}),
        ...(retargetedPrompt
          ? { queuedSource: { ...row.queuedSource!, retargetedPrompt } }
          : {}),
        retiredRuntimeGenerations: [
          ...new Set([
            ...row.retiredRuntimeGenerations,
            (row.binding ?? row.source).runtimeGeneration,
          ]),
        ],
        errorCode: null,
      });
    });
  }
  /** Publish a fresh native read after an actual runtime restart. The reserved
   * source stays immutable for begin retries and namespace ancestry. Recovery
   * changes only the currently canonical side, never the routing decision. */
  async recover(
    ownerId: string,
    workerId: string,
    operationId: string,
    side: "source" | "destination",
    expectedBindingId: string,
    value: NativeRuntimeHandoffPrepared,
  ) {
    const recovered = nativeRuntimeHandoffPreparedSchema.parse(value);
    return this.mutate(ownerId, workerId, operationId, async (tx, row) => {
      if (
        row.queuedSource &&
        !row.queuedSource.withdrawn &&
        !(
          side === "source" &&
          row.phase === "preparing" &&
          row.queuedSource.goalRecovery
        )
      )
        fail("handoff-queued-source-unconfirmed");
      if (
        side === "source"
          ? !["preparing", "prepared"].includes(row.phase)
          : row.phase !== "committed"
      )
        fail("handoff-phase-conflict");
      const state = await new NativeSettingsStateRepository(tx).get(
        ownerId,
        row.chatId,
      );
      if (!state?.binding || state.pending.length)
        fail("handoff-settings-pending");
      const current = state!.binding!;
      // Older persisted operations have no binding column. Establish their
      // authorized identity from the immutable source or committed receipt.
      const prior =
        row.binding ??
        (side === "source"
          ? row.source
          : {
              ...row.source,
              bindingId: current.bindingId,
              runtimeGeneration: row.prepared!.runtimeGeneration,
              nativeEpoch: row.prepared!.snapshot.context.settingsVersion.epoch,
              modelRouteId: row.targetModelRouteId,
              providerAccountId: row.targetProviderAccountId,
            });
      await this.assertSource(
        tx,
        ownerId,
        prior,
        row.queuedSource,
        row.cancelRequested,
      );
      await this.assertIdle(tx, row.chatId, row.queuedSource?.goalClaim);
      const routeId =
        side === "source" ? row.source.modelRouteId! : row.targetModelRouteId;
      const accountId =
        side === "source"
          ? row.source.providerAccountId
          : row.targetProviderAccountId;
      const route = await this.target(tx, ownerId, routeId, accountId);
      const context = recovered.snapshot.context;
      const selection = recovered.snapshot.modelAttribution?.selection;
      // The source's physical route identifies its provider/account, while the
      // native model may have changed within that provider in the CLI. Preserve
      // that actual attribution; only destination selection must match exactly.
      const selectedRoute =
        side === "source" && selection?.status === "resolved"
          ? await this.target(tx, ownerId, selection.routeId, accountId)
          : route;
      const selectionMatches =
        selection?.status === "resolved"
          ? selection.workerId === workerId &&
            selection.providerId === route.providerId &&
            selectedRoute.providerId === route.providerId &&
            selection.modelId === selectedRoute.modelId &&
            selection.providerAccountId === accountId &&
            (side === "source" || selection.routeId === routeId)
          : side === "source";
      if (
        recovered.threadId !== row.source.threadId ||
        context.threadId !== recovered.threadId ||
        context.chatId !== row.chatId ||
        context.workerId !== workerId ||
        context.runtimeGeneration !== recovered.runtimeGeneration ||
        !selectionMatches ||
        row.retiredRuntimeGenerations.includes(recovered.runtimeGeneration) ||
        epochRetired(
          row,
          recovered.runtimeGeneration,
          context.settingsVersion.epoch,
        ) ||
        (side === "source" &&
          row.prepared?.runtimeGeneration === recovered.runtimeGeneration)
      )
        fail("handoff-recovery-source-mismatch");
      if (
        current.runtimeGeneration === recovered.runtimeGeneration &&
        current.nativeEpoch === context.settingsVersion.epoch
      ) {
        if (
          state!.effective &&
          sameSnapshot(state!.effective, recovered.snapshot)
        )
          return row;
        fail("handoff-recovery-conflict");
      }
      if (current.bindingId !== expectedBindingId)
        fail("handoff-recovery-conflict");
      const binding: NativeSettingsBinding = {
        ...current,
        bindingId: randomUUID(),
        runtimeGeneration: recovered.runtimeGeneration,
        nativeEpoch: context.settingsVersion.epoch,
      };
      const next = bindNativeSettingsRead(
        state!,
        expectedBindingId,
        binding,
        recovered.snapshot,
      );
      if (recovered.reasoningEffort !== undefined)
        await tx
          .update(schema.chats)
          .set({
            reasoningEffort: recovered.reasoningEffort,
            updatedAt: new Date(),
          })
          .where(eq(schema.chats.id, row.chatId));
      await tx
        .update(schema.nativeSettingsStates)
        .set({ state: next, updatedAt: new Date() })
        .where(eq(schema.nativeSettingsStates.chatId, row.chatId));
      return this.update(tx, row, {
        binding,
        ...(side === "destination" ? { prepared: recovered } : {}),
        retiredNativeEpochs: retireEpoch(
          row,
          current.runtimeGeneration,
          current.nativeEpoch,
        ),
        retiredRuntimeGenerations:
          current.runtimeGeneration === recovered.runtimeGeneration
            ? row.retiredRuntimeGenerations
            : [
                ...new Set([
                  ...row.retiredRuntimeGenerations,
                  current.runtimeGeneration,
                ]),
              ],
        errorCode: null,
      });
    });
  }
  /** Only the owning worker may acknowledge that it selected the destination or
   * abandoned preparation and restored the source. Timeout is never that proof. */
  async finish(
    ownerId: string,
    workerId: string,
    operationId: string,
    outcome: "completed" | "cancelled",
  ) {
    return this.mutate(ownerId, workerId, operationId, async (tx, row) => {
      if (row.phase === outcome) return row;
      if (
        outcome === "completed"
          ? row.phase !== "committed"
          : !["preparing", "prepared"].includes(row.phase)
      )
        fail("handoff-phase-conflict");
      const result = await this.update(tx, row, {
        phase: outcome,
        errorCode: null,
        retiredRuntimeGenerations:
          outcome === "cancelled" && row.prepared
            ? [
                ...new Set([
                  ...row.retiredRuntimeGenerations,
                  row.prepared.runtimeGeneration,
                ]),
              ]
            : row.retiredRuntimeGenerations,
      });
      // Durable queue delivery retries the wake after a lost worker reply or
      // transient failure, without replaying an input or changing pause/Stop.
      await tx
        .insert(schema.managedQueueStates)
        .values({ chatId: row.chatId })
        .onConflictDoNothing();
      await queueStateChanged(tx, row.chatId);
      return result;
    });
  }
  async withdrawn(
    ownerId: string,
    workerId: string,
    operationId: string,
    record: InferenceJournalRecord | null,
  ) {
    return this.mutate(ownerId, workerId, operationId, async (tx, row) => {
      if (row.queuedSource?.goalRecovery)
        fail("handoff-goal-recovery-receipt-required");
      if (row.queuedSource?.withdrawn) return row;
      if (row.phase !== "preparing" || row.prepared || !row.queuedSource)
        fail("handoff-phase-conflict");
      await this.assertSource(
        tx,
        ownerId,
        row.binding ?? row.source,
        row.queuedSource,
      );
      if (row.queuedSource?.taskGoal)
        await confirmTaskGoalHandoff(
          tx,
          ownerId,
          row.binding ?? row.source,
          row.queuedSource,
          record,
        );
      else
        await confirmHandoffQueuedSource(
          tx,
          this.lanes,
          ownerId,
          workerId,
          row.source,
          row.queuedSource!,
          record,
        );
      await this.assertIdle(tx, row.chatId, row.queuedSource?.goalClaim);
      return this.update(tx, row, {
        queuedSource: { ...row.queuedSource!, withdrawn: true },
        errorCode: null,
      });
    });
  }

  async goalRecoveryWithdrawn(
    ownerId: string,
    workerId: string,
    operationId: string,
    receipt: NativeGoalRecoveryWithdrawal,
  ) {
    return this.mutate(ownerId, workerId, operationId, async (tx, row) => {
      if (row.queuedSource?.withdrawn) {
        if (!isDeepStrictEqual(row.queuedSource.goalWithdrawal, receipt))
          fail("handoff-operation-conflict");
        return row;
      }
      if (
        row.phase !== "preparing" ||
        row.prepared ||
        !row.queuedSource?.goalRecovery
      )
        fail("handoff-phase-conflict");
      const source = row.binding ?? row.source;
      await this.assertSource(tx, ownerId, source, row.queuedSource);
      await confirmGoalRecoveryHandoff(
        tx,
        source,
        row.queuedSource!,
        operationId,
        receipt,
      );
      await this.assertIdle(tx, row.chatId, row.queuedSource?.goalClaim);
      return this.update(tx, row, {
        queuedSource: {
          ...row.queuedSource!,
          withdrawn: true,
          goalWithdrawal: receipt,
        },
        errorCode: null,
      });
    });
  }

  /** Only a worker refusal before sealing the source may take this path. It
   * abandons the route reservation without touching the current input or slot. */
  async declineQueuedSource(
    ownerId: string,
    workerId: string,
    operationId: string,
  ) {
    return this.mutate(ownerId, workerId, operationId, async (tx, row) => {
      if (row.phase === "cancelled") return row;
      if (
        row.phase !== "preparing" ||
        row.prepared ||
        !row.queuedSource ||
        row.queuedSource.withdrawn
      )
        fail("handoff-phase-conflict");
      // A private Task refusal only abandons this reservation. Stop/archival or
      // a newer Task control may already have made the Source ineligible.
      if (!row.queuedSource.taskGoal)
        await this.assertSource(
          tx,
          ownerId,
          row.binding ?? row.source,
          row.queuedSource,
        );
      const result = await this.update(tx, row, {
        phase: "cancelled",
        errorCode: row.cancelRequested
          ? null
          : "handoff-source-no-longer-queued",
      });
      await queueStateChanged(tx, row.chatId);
      return result;
    });
  }

  async failure(
    ownerId: string,
    workerId: string,
    operationId: string,
    errorCode: string,
  ) {
    if (!/^[a-z0-9-]{1,100}$/.test(errorCode)) fail("invalid-handoff-error");
    return this.mutate(ownerId, workerId, operationId, (tx, row) =>
      activePhases.includes(row.phase)
        ? this.update(tx, row, { errorCode })
        : Promise.resolve(row),
    );
  }
  private async mutate(
    ownerId: string,
    workerId: string,
    operationId: string,
    change: (tx: RepositoryTransaction, row: Row) => Promise<Row>,
  ) {
    const [found] = await this.database
      .select()
      .from(schema.nativeRuntimeHandoffs)
      .where(
        and(
          eq(schema.nativeRuntimeHandoffs.operationId, operationId),
          eq(schema.nativeRuntimeHandoffs.ownerId, ownerId),
          eq(schema.nativeRuntimeHandoffs.workerId, workerId),
        ),
      );
    if (!found) fail("handoff-not-found");
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, found!.chatId);
      const [row] = await tx
        .select()
        .from(schema.nativeRuntimeHandoffs)
        .where(eq(schema.nativeRuntimeHandoffs.operationId, operationId));
      if (!row || row.ownerId !== ownerId || row.workerId !== workerId)
        fail("handoff-not-found");
      return wire(await change(tx, row!));
    });
  }
  private async update(
    tx: RepositoryTransaction,
    row: Row,
    patch: Partial<Row>,
  ) {
    const [updated] = await tx
      .update(schema.nativeRuntimeHandoffs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.nativeRuntimeHandoffs.operationId, row.operationId))
      .returning();
    return updated!;
  }
  private async assertSource(
    tx: RepositoryTransaction,
    ownerId: string,
    source: NativeSettingsBinding,
    queued?: NativeRuntimeHandoffQueuedSource | null,
    allowInactiveTask = false,
  ) {
    const context = await new ChatRuntimeContextRepository(tx, {
      getChatExecutionContext: async () => null,
    }).getChatExecutionContext(ownerId, source.chatId);
    if (
      !context ||
      !(
        context.experience === "agent" ||
        (context.experience === "task" && queued?.taskGoal)
      ) ||
      context.workerId !== source.workerId ||
      context.contextKind !== source.contextKind ||
      context.projectId !== source.projectId ||
      (context.contextKind === "project"
        ? context.worktreeId
        : context.scratchRootId) !== source.placementId ||
      context.threadId !== source.threadId ||
      context.modelRouteId !== source.modelRouteId ||
      context.providerAccountId !== source.providerAccountId
    )
      fail("handoff-source-replaced");
    const current = (
      await new NativeSettingsStateRepository(tx).get(ownerId, source.chatId)
    )?.binding;
    if (!current || !isDeepStrictEqual(current, source))
      fail("handoff-source-replaced");
    if (context!.experience === "task")
      await assertTaskGoalHandoff(
        tx,
        ownerId,
        source,
        queued!,
        allowInactiveTask,
      );
  }
  private async assertIdle(
    tx: RepositoryTransaction,
    chatId: string,
    goalClaim?: GoalHandoffClaim,
  ) {
    const [lane] = await tx
      .select({ id: schema.chatExecutionLanes.id })
      .from(schema.chatExecutionLanes)
      .where(
        and(
          eq(schema.chatExecutionLanes.chatId, chatId),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .limit(1);
    const [command] = await tx
      .select({ id: schema.nativeCommands.operationId })
      .from(schema.nativeCommands)
      .where(
        and(
          eq(schema.nativeCommands.chatId, chatId),
          inArray(schema.nativeCommands.status, [
            "accepted",
            "dispatched",
            "uncertain",
          ]),
          sql`NOT (${schema.nativeCommands.executionCompletedAt} IS NOT NULL AND ${schema.nativeCommands.goalRecoverySource} IS NOT NULL)`,
        ),
      )
      .limit(1);
    // Queue claiming and handoff reservation share the chat lock. A claim that
    // won first owns the next dispatch even before native admission is stored.
    const claims = await tx
      .select()
      .from(schema.managedQueueClaims)
      .where(
        and(
          eq(schema.managedQueueClaims.chatId, chatId),
          inArray(schema.managedQueueClaims.status, [
            "claimed",
            "accepted",
            "dispatched",
            "uncertain",
          ]),
        ),
      )
      .limit(2);
    if (
      lane ||
      command ||
      (claims.length &&
        (!goalClaim ||
          claims.length !== 1 ||
          !retainedGoalClaimMatches(claims[0]!, goalClaim)))
    )
      fail("handoff-native-operation-pending");
    if (claims.length) await assertGoalClaimPrompt(tx, chatId, goalClaim!);
  }
  private async target(
    tx: RepositoryTransaction,
    ownerId: string,
    routeId: string,
    accountId: string | null,
  ) {
    const [target] = await tx
      .select({
        modelId: schema.modelRoutes.modelId,
        providerId: schema.modelRoutes.providerId,
        kind: schema.modelProviders.kind,
      })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
      )
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelRoutes.providerId),
      )
      .where(
        and(
          eq(schema.modelRoutes.id, routeId),
          eq(schema.modelProfiles.ownerId, ownerId),
          eq(schema.modelProviders.ownerId, ownerId),
          eq(schema.modelRoutes.enabled, true),
        ),
      );
    if (!target) fail("handoff-target-not-found");
    if (accountId) {
      const [account] = await tx
        .select({ id: schema.modelProviderAccounts.id })
        .from(schema.modelProviderAccounts)
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, target!.providerId),
            eq(schema.modelProviderAccounts.enabled, true),
          ),
        );
      if (!account) fail("handoff-target-account-mismatch");
    } else if (["chatgpt", "grok"].includes(target!.kind))
      fail("handoff-target-account-required");
    return target!;
  }
}
