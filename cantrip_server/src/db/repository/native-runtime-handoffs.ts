import { assertNativeRuntimeWritable } from "./native-runtime-handoff-guard.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import {
  nativeRuntimeHandoffRequestSchema,
  nativeRuntimeHandoffPreparedSchema,
  nativeRuntimeHandoffStateSchema,
  type NativeRuntimeHandoffRequest,
  type NativeRuntimeHandoffPrepared,
  type NativeSettingsBinding,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { NativeCommandError } from "./native-command-errors.js";
import { ChatRuntimeContextRepository } from "./chat-runtime-context.js";
import { NativeSettingsStateRepository } from "./native-settings-persistence.js";
import { bindNativeSettingsRead } from "./native-settings-state.js";

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
  constructor(private readonly database: RepositoryDatabase) {}
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
  async begin(
    ownerId: string,
    chatId: string,
    value: NativeRuntimeHandoffRequest,
  ) {
    const input = nativeRuntimeHandoffRequestSchema.parse(value);
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
      await this.assertSource(tx, ownerId, source!);
      await this.assertIdle(tx, chatId);
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
        source!.providerAccountId === input.targetProviderAccountId
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
          phase: "preparing",
          targetModelRouteId: input.targetModelRouteId,
          targetProviderAccountId: input.targetProviderAccountId,
        })
        .returning();
      return wire(row!);
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
      await this.assertSource(tx, ownerId, row.binding ?? row.source);
      await this.assertIdle(tx, row.chatId);
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
      await this.assertSource(tx, ownerId, row.binding ?? row.source);
      await this.assertIdle(tx, row.chatId);
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
      return this.update(tx, row, {
        phase: "committed",
        binding,
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
      await this.assertSource(tx, ownerId, prior);
      await this.assertIdle(tx, row.chatId);
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
      return this.update(tx, row, {
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
  ) {
    const context = await new ChatRuntimeContextRepository(tx, {
      getChatExecutionContext: async () => null,
    }).getChatExecutionContext(ownerId, source.chatId);
    if (
      !context ||
      context.experience !== "agent" ||
      context.contextKind !== "project" ||
      context.workerId !== source.workerId ||
      context.contextKind !== source.contextKind ||
      context.projectId !== source.projectId ||
      context.worktreeId !== source.placementId ||
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
  }
  private async assertIdle(tx: RepositoryTransaction, chatId: string) {
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
        ),
      )
      .limit(1);
    if (lane || command) fail("handoff-native-operation-pending");
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
