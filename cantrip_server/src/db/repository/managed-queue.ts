import { toEncryptedQueuedPrompt } from "./queued-prompts.js";
import { retainManagedQueueInput } from "./managed-queue-input-snapshot.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  managedQueueClaimSchema,
  managedQueueSnapshotSchema,
  type ManagedQueueImport,
  type ManagedQueueImportAck,
  type ManagedQueueClaim,
  type ManagedQueueMutate,
  type ManagedQueueMutation,
  type NativeCommandAdmission,
  type NativeCommandSession,
} from "@cantrip/protocol";
import type { ServerRepository } from "../repository.js";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import { NativeCommandError } from "./native-commands.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";
import { managedConsoleSessionContext } from "../../terminals/managed-session.js";

type ClaimRow = typeof schema.managedQueueClaims.$inferSelect;
const claimValue = (row: ClaimRow): ManagedQueueClaim =>
  managedQueueClaimSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
const methods: Record<ManagedQueueMutation["kind"], string> = {
  add: "thread/queue/add",
  update: "thread/queue/update",
  delete: "thread/queue/delete",
  reorder: "thread/queue/reorder",
  start: "thread/queue/start",
};
function noPendingPermission(chatId: typeof schema.chats.id | string) {
  return sql`NOT EXISTS (SELECT 1 FROM native_settings_states s WHERE s.chat_id = ${chatId} AND (
    EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.state->'pending','[]'::jsonb)) p WHERE p->'intent'->'permissionTransition' IS NOT NULL)
    OR (s.state->>'desiredStatus' = 'uncertain' AND s.state->'desired'->'permissionTransition' IS NOT NULL)
  ))`;
}
function noPendingHandoff(chatId: typeof schema.chats.id | string) {
  return sql`NOT EXISTS (SELECT 1 FROM native_runtime_handoffs h WHERE h.chat_id = ${chatId} AND h.phase IN ('preparing','prepared','committed'))`;
}
/** Canonical executable queue. Native requests mutate this state; they never enqueue a second native copy. */
export class ManagedQueueRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly repository: (
      tx: RepositoryTransaction,
    ) => ServerRepository,
  ) {}
  async pendingDispatches() {
    return this.database
      .selectDistinct({
        ownerId: schema.chats.ownerId,
        chatId: schema.chats.id,
      })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.chats.experience, "agent"),
          eq(schema.chats.contextKind, "project"),
          eq(schema.chats.automationPaused, false),
          eq(schema.chats.managedAutonomyStopped, false),
          noPendingPermission(schema.chats.id),
          noPendingHandoff(schema.chats.id),
          sql`((${schema.queuedPrompts.state} = 'pending' AND ${schema.queuedPrompts.frozen} = false AND NOT EXISTS (SELECT 1 FROM managed_queue_claims c WHERE c.prompt_id = ${schema.queuedPrompts.id} AND c.prompt_revision = ${schema.queuedPrompts.revision} AND c.status = 'rejected')) OR (${schema.queuedPrompts.state} = 'claimed' AND EXISTS (SELECT 1 FROM managed_queue_claims c WHERE c.prompt_id = ${schema.queuedPrompts.id} AND c.status = 'claimed' AND c.operation_id IS NULL)))`,
        ),
      );
  }
  async pendingNotifications(limit = 64) {
    const rows = await this.database
      .select({
        state: schema.managedQueueStates,
        ownerId: schema.chats.ownerId,
      })
      .from(schema.managedQueueStates)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.managedQueueStates.chatId),
      )
      .where(
        sql`${schema.managedQueueStates.notifiedRevision} < ${schema.managedQueueStates.revision} AND ${schema.managedQueueStates.notificationDueAt} <= now()`,
      )
      .orderBy(asc(schema.managedQueueStates.notificationDueAt))
      .limit(limit);
    const result = [];
    for (const row of rows) {
      const context = await this.repository(
        this.database as RepositoryTransaction,
      ).getChatExecutionContext(row.ownerId, row.state.chatId);
      if (context)
        result.push({
          ownerId: row.ownerId,
          workerId: context.workerId,
          chatId: row.state.chatId,
          revision: row.state.revision,
        });
    }
    return result;
  }
  async acknowledgeNotification(chatId: string, revision: number) {
    await this.database
      .update(schema.managedQueueStates)
      .set({
        notifiedRevision: sql`GREATEST(${schema.managedQueueStates.notifiedRevision},${revision})`,
        notificationDueAt: new Date(),
      })
      .where(
        and(
          eq(schema.managedQueueStates.chatId, chatId),
          sql`${schema.managedQueueStates.revision} >= ${revision}`,
        ),
      );
  }
  async deferNotification(chatId: string) {
    await this.database
      .update(schema.managedQueueStates)
      .set({ notificationDueAt: new Date(Date.now() + 5000) })
      .where(eq(schema.managedQueueStates.chatId, chatId));
  }
  private async lock(
    tx: RepositoryTransaction,
    ownerId: string,
    chatId: string,
  ) {
    await tx.execute(projectChatExecutionLock(ownerId, chatId));
    const [chat] = await tx
      .select()
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .for("update");
    if (!chat || chat.experience !== "agent" || chat.contextKind !== "project")
      throw new NativeCommandError("managed-session-ineligible");
    await tx
      .insert(schema.managedQueueStates)
      .values({ chatId })
      .onConflictDoNothing();
    return chat;
  }
  private async authorize(
    tx: RepositoryTransaction,
    ownerId: string,
    workerId: string,
    session: NativeCommandSession,
  ) {
    await this.lock(tx, ownerId, session.chatId);
    const context = await this.repository(tx).getChatExecutionContext(
      ownerId,
      session.chatId,
    );
    if (
      !context ||
      !managedConsoleSessionContext(context) ||
      context.workerId !== workerId ||
      context.projectId !== session.projectId ||
      context.contextKind !== session.contextKind ||
      context.worktreeId !== session.placementId ||
      context.threadId !== session.threadId ||
      context.modelRouteId !== session.modelRouteId ||
      context.providerAccountId !== session.providerAccountId
    )
      throw new NativeCommandError("stale-queue-session");
    return context;
  }
  private async snapshotTx(
    tx: RepositoryTransaction,
    ownerId: string,
    chatId: string,
  ) {
    const [state] = await tx
      .select()
      .from(schema.managedQueueStates)
      .where(eq(schema.managedQueueStates.chatId, chatId));
    const [chat] = await tx
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, chatId));
    const items = await this.repository(tx).listEncryptedQueuedPrompts(
      ownerId,
      chatId,
    );
    const claims = await tx
      .select()
      .from(schema.managedQueueClaims)
      .where(
        and(
          eq(schema.managedQueueClaims.chatId, chatId),
          sql`(${schema.managedQueueClaims.status} IN ('claimed','accepted','dispatched','uncertain') OR (${schema.managedQueueClaims.status} = 'rejected' AND EXISTS (SELECT 1 FROM queued_prompts p WHERE p.id = ${schema.managedQueueClaims.promptId} AND p.revision = ${schema.managedQueueClaims.promptRevision} AND p.state = 'pending')))`,
        ),
      )
      .orderBy(asc(schema.managedQueueClaims.createdAt));
    const imports = await tx
      .select({
        record: schema.managedQueueImports,
        prompt: schema.queuedPrompts,
      })
      .from(schema.managedQueueImports)
      .innerJoin(
        schema.queuedPrompts,
        eq(schema.queuedPrompts.id, schema.managedQueueImports.promptId),
      )
      .where(
        and(
          eq(schema.managedQueueImports.chatId, chatId),
          inArray(schema.managedQueueImports.status, [
            "pending",
            "conflict",
            "uncertain",
          ]),
        ),
      )
      .orderBy(asc(schema.managedQueueImports.createdAt));
    return managedQueueSnapshotSchema.parse({
      revision: state?.revision ?? 0,
      paused: Boolean(chat?.automationPaused || chat?.managedAutonomyStopped),
      items,
      claims: claims.map(claimValue),
      pendingImports: imports.map(({ record, prompt }) => ({
        importId: record.id,
        nativeItemId: record.nativeItemId,
        status: record.status,
        prompt: toEncryptedQueuedPrompt(prompt),
      })),
    });
  }
  async snapshot(ownerId: string, chatId: string) {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, chatId);
      return this.snapshotTx(tx, ownerId, chatId);
    });
  }
  async read(ownerId: string, workerId: string, session: NativeCommandSession) {
    return this.database.transaction(async (tx) => {
      await this.authorize(tx, ownerId, workerId, session);
      return this.snapshotTx(tx, ownerId, session.chatId);
    });
  }
  private async bump(tx: RepositoryTransaction, chatId: string) {
    await tx
      .update(schema.managedQueueStates)
      .set({ revision: sql`${schema.managedQueueStates.revision}+1` })
      .where(eq(schema.managedQueueStates.chatId, chatId));
  }
  private async priorMutation(
    tx: RepositoryTransaction,
    ownerId: string,
    admission: NativeCommandAdmission,
    currentAuthorizedRead = false,
  ) {
    const chatId = admission.session.chatId;
    const repository = this.repository(tx);
    const [prior] = await tx
      .select()
      .from(schema.nativeCommands)
      .where(eq(schema.nativeCommands.operationId, admission.operationId));
    if (prior) {
      const stored = prior.identity as NativeCommandSession;
      if (
        prior.ownerId !== ownerId ||
        prior.workerId !== admission.workerId ||
        prior.chatId !== chatId ||
        prior.method !== admission.method ||
        prior.payloadDigest !== admission.payloadDigest ||
        !isDeepStrictEqual(
          {
            ...stored,
            connectionId: null,
            runtimeGeneration: null,
            ...(currentAuthorizedRead
              ? { modelRouteId: null, providerAccountId: null }
              : {}),
          },
          {
            ...admission.session,
            connectionId: null,
            runtimeGeneration: null,
            ...(currentAuthorizedRead
              ? { modelRouteId: null, providerAccountId: null }
              : {}),
          },
        )
      )
        throw new NativeCommandError("operation-id-conflict");
      const [claim] = await tx
        .select()
        .from(schema.managedQueueClaims)
        .where(
          eq(
            schema.managedQueueClaims.requestOperationId,
            admission.operationId,
          ),
        );
      return {
        ...(await this.snapshotTx(tx, ownerId, chatId)),
        receipt: await repository.nativeCommands.get(
          ownerId,
          admission.workerId,
          prior.operationId,
          prior.operationGeneration,
        ),
        ...(claim ? { claim: claimValue(claim) } : {}),
        ...(prior.queueResult?.acceptedItem
          ? { acceptedItem: prior.queueResult.acceptedItem }
          : {}),
      };
    }
    return null;
  }
  async guiOperation(ownerId: string, chatId: string, operationId: string) {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, chatId);
      const [row] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          and(
            eq(schema.nativeCommands.operationId, operationId),
            eq(schema.nativeCommands.ownerId, ownerId),
            eq(schema.nativeCommands.chatId, chatId),
            eq(schema.nativeCommands.origin, "gui"),
            inArray(schema.nativeCommands.method, [
              "thread/queue/add",
              "thread/queue/update",
              "thread/queue/delete",
              "thread/queue/reorder",
            ]),
          ),
        );
      if (!row) return { found: false as const };
      return {
        found: true as const,
        ...(await this.snapshotTx(tx, ownerId, chatId)),
        receipt: await this.repository(tx).nativeCommands.get(
          ownerId,
          row.workerId,
          row.operationId,
          row.operationGeneration,
        ),
        ...(row.queueResult?.acceptedItem
          ? { acceptedItem: row.queueResult.acceptedItem }
          : {}),
      };
    });
  }
  async lookup(ownerId: string, admission: NativeCommandAdmission) {
    return this.database.transaction(async (tx) => {
      await this.authorize(tx, ownerId, admission.workerId, admission.session);
      if (!Object.values(methods).includes(admission.method))
        throw new NativeCommandError("queue-method-mismatch");
      const prior = await this.priorMutation(tx, ownerId, admission, true);
      return prior
        ? { found: true as const, ...prior }
        : { found: false as const };
    });
  }
  async mutate(
    ownerId: string,
    input: ManagedQueueMutate,
    options: { expectedInputRevision?: number } = {},
  ) {
    return this.database.transaction(async (tx) => {
      const { admission, mutation } = input;
      const chatId = admission.session.chatId;
      await this.authorize(tx, ownerId, admission.workerId, admission.session);
      if (admission.method !== methods[mutation.kind])
        throw new NativeCommandError("queue-method-mismatch");
      const repository = this.repository(tx);
      const prior = await this.priorMutation(tx, ownerId, admission);
      if (prior) return prior;
      // Queue edits carry no model input to native. Bind their receipt to the current
      // activation under this same chat lock, rather than a pre-request GUI snapshot.
      const control = await repository.nativeCommands.controlContext(
        ownerId,
        chatId,
      );
      const effectiveAdmission = {
        ...admission,
        expectedActivationGeneration: control.activationGeneration,
        session: {
          ...admission.session,
          runtimeGeneration: control.runtimeGeneration,
        },
      };
      const grant = await repository.nativeCommands.admit(
        ownerId,
        effectiveAdmission,
        {
          canonicalQueueMutation: true,
          expectedInputRevision: options.expectedInputRevision,
        },
      );
      if (grant.receipt.status !== "accepted")
        return {
          ...(await this.snapshotTx(tx, ownerId, chatId)),
          receipt: grant.receipt,
        };
      let claim: ManagedQueueClaim | undefined;
      let acceptedItem:
        import("@cantrip/protocol").EncryptedQueuedPrompt | undefined;
      try {
        const [state] = await tx
          .select()
          .from(schema.managedQueueStates)
          .where(eq(schema.managedQueueStates.chatId, chatId));
        if (state!.revision !== input.expectedRevision)
          throw new NativeCommandError("queue-revision-conflict");
        const prompts = await tx
          .select()
          .from(schema.queuedPrompts)
          .where(eq(schema.queuedPrompts.chatId, chatId))
          .orderBy(
            asc(schema.queuedPrompts.position),
            asc(schema.queuedPrompts.createdAt),
          );
        if (mutation.kind === "add" || mutation.kind === "update") {
          const modelIds = [
            mutation.prompt.modelId,
            ...(mutation.prompt.subagentModelId
              ? [mutation.prompt.subagentModelId]
              : []),
          ];
          const models = await tx
            .select({ id: schema.modelProfiles.id })
            .from(schema.modelProfiles)
            .where(
              and(
                eq(schema.modelProfiles.ownerId, ownerId),
                inArray(schema.modelProfiles.id, modelIds),
              ),
            );
          if (modelIds.some((id) => !models.some((model) => model.id === id)))
            throw new NativeCommandError("queue-model-unavailable");
          if (mutation.prompt.worktreeId) {
            const [target] = await tx
              .select({ id: schema.projectWorktrees.id })
              .from(schema.projectWorktrees)
              .innerJoin(
                schema.projectSources,
                eq(
                  schema.projectSources.id,
                  schema.projectWorktrees.projectSourceId,
                ),
              )
              .where(
                and(
                  eq(schema.projectWorktrees.id, mutation.prompt.worktreeId),
                  eq(
                    schema.projectSources.projectId,
                    admission.session.projectId!,
                  ),
                ),
              );
            if (!target)
              throw new NativeCommandError("queue-worktree-unavailable");
          }
          const ids = mutation.prompt.classification.attachmentIds;
          const attachments = await repository.getChatAttachments(
            ownerId,
            chatId,
            ids,
          );
          if (
            ids.some((id) => !attachments.some((item) => item.id === id)) ||
            mutation.attachments.some((item) => !ids.includes(item.id))
          )
            throw new NativeCommandError("queue-attachment-unavailable");
        }
        if (mutation.kind === "add") {
          const existing = prompts.find(
            (p) =>
              p.id === mutation.prompt.id ||
              p.idempotencyKey === mutation.prompt.idempotencyKey,
          );
          if (existing) throw new NativeCommandError("queue-item-conflict");
          const result = await repository.createEncryptedQueuedPrompt(
            ownerId,
            chatId,
            mutation.prompt,
            mutation.attachments,
          );
          if (!result) throw new NativeCommandError("queue-item-unavailable");
        } else if (mutation.kind === "reorder") {
          const pending = prompts.filter(
            (p) => p.state === "pending" || p.state === "claimed",
          );
          if (pending.some((p) => p.state === "claimed"))
            throw new NativeCommandError("queue-item-claimed");
          if (
            new Set(mutation.ids).size !== pending.length ||
            mutation.ids.length !== pending.length ||
            pending.some((p) => !mutation.ids.includes(p.id))
          )
            throw new NativeCommandError("queue-order-conflict");
          for (const [position, id] of mutation.ids.entries())
            await tx
              .update(schema.queuedPrompts)
              .set({
                position,
                revision: sql`${schema.queuedPrompts.revision}+1`,
                updatedAt: new Date(),
              })
              .where(eq(schema.queuedPrompts.id, id));
        } else {
          const prompt =
            mutation.kind === "start" && !mutation.id
              ? prompts.find((p) => p.state === "pending" && !p.frozen)
              : prompts.find((p) => p.id === mutation.id);
          if (!prompt || prompt.state !== "pending")
            throw new NativeCommandError(
              prompt?.state === "claimed"
                ? "queue-item-claimed"
                : "queue-item-unavailable",
            );
          if (
            mutation.kind !== "start" &&
            prompt.revision !== mutation.expectedItemRevision
          )
            throw new NativeCommandError("queue-item-revision-conflict");
          if (mutation.kind === "update") {
            if (mutation.prompt.id !== prompt.id)
              throw new NativeCommandError("queue-item-conflict");
            await repository.replaceEncryptedQueuedPrompt(
              ownerId,
              prompt.id,
              mutation.prompt,
              mutation.attachments,
            );
            await tx
              .update(schema.queuedPrompts)
              .set({
                modelId: mutation.prompt.modelId,
                revision: sql`${schema.queuedPrompts.revision}+1`,
              })
              .where(eq(schema.queuedPrompts.id, prompt.id));
          } else if (mutation.kind === "delete")
            await tx
              .update(schema.queuedPrompts)
              .set({
                state: "removed",
                revision: sql`${schema.queuedPrompts.revision}+1`,
                updatedAt: new Date(),
              })
              .where(eq(schema.queuedPrompts.id, prompt.id));
          else {
            const [chat] = await tx
              .select()
              .from(schema.chats)
              .where(eq(schema.chats.id, chatId));
            if (chat!.automationPaused)
              throw new NativeCommandError("queue-paused");
            const [created] = await tx
              .insert(schema.managedQueueClaims)
              .values({
                id: `queue:${createHash("sha256").update(admission.operationId).digest("hex")}`,
                requestOperationId: admission.operationId,
                chatId,
                promptId: prompt.id,
                promptRevision: prompt.revision,
              })
              .returning();
            claim = claimValue(created!);
            await retainManagedQueueInput(tx, created!.id, prompt);
            await tx
              .update(schema.queuedPrompts)
              .set({ state: "claimed", updatedAt: new Date() })
              .where(eq(schema.queuedPrompts.id, prompt.id));
          }
        }
        await this.bump(tx, chatId);
        if (admission.intent.resumeAutonomy)
          await repository.nativeCommands.resumeAutonomy(ownerId, chatId);
        if (mutation.kind === "add" || mutation.kind === "update")
          acceptedItem =
            (await repository.getEncryptedQueuedPrompt(
              ownerId,
              mutation.prompt.id,
            )) ?? undefined;
        // Both the effect and its immutable encrypted receipt commit together.

        await tx
          .update(schema.nativeCommands)
          .set({
            status: "applied",
            queueResult: { ...(acceptedItem ? { acceptedItem } : {}) },
            updatedAt: new Date(),
          })
          .where(eq(schema.nativeCommands.operationId, admission.operationId));
      } catch (error) {
        if (!(error instanceof NativeCommandError)) throw error;
        await tx
          .update(schema.nativeCommands)
          .set({
            status: "rejected",
            rejectionCode: error.code,
            updatedAt: new Date(),
          })
          .where(eq(schema.nativeCommands.operationId, admission.operationId));
      }
      return {
        ...(await this.snapshotTx(tx, ownerId, chatId)),
        receipt: await repository.nativeCommands.get(
          ownerId,
          admission.workerId,
          admission.operationId,
          grant.receipt.operationGeneration,
        ),
        ...(claim ? { claim } : {}),
        ...(acceptedItem ? { acceptedItem } : {}),
      };
    });
  }
  async claimItem(
    ownerId: string,
    chatId: string,
    promptId: string,
    promptRevision: number,
    claimId: string,
  ) {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, chatId);
      const [existing] = await tx
        .select()
        .from(schema.managedQueueClaims)
        .where(eq(schema.managedQueueClaims.id, claimId));
      if (existing) {
        if (
          existing.chatId !== chatId ||
          existing.promptId !== promptId ||
          existing.promptRevision !== promptRevision
        )
          throw new NativeCommandError("queue-claim-conflict");
        return claimValue(existing);
      }
      const [prompt] = await tx
        .select()
        .from(schema.queuedPrompts)
        .where(
          and(
            eq(schema.queuedPrompts.id, promptId),
            eq(schema.queuedPrompts.chatId, chatId),
          ),
        );
      if (
        !prompt ||
        prompt.state !== "pending" ||
        prompt.revision !== promptRevision
      )
        throw new NativeCommandError("queue-item-revision-conflict");
      const [claim] = await tx
        .insert(schema.managedQueueClaims)
        .values({ id: claimId, chatId, promptId, promptRevision })
        .returning();
      await retainManagedQueueInput(tx, claimId, prompt);
      await tx
        .update(schema.queuedPrompts)
        .set({ state: "claimed" })
        .where(eq(schema.queuedPrompts.id, promptId));
      await this.bump(tx, chatId);
      return claimValue(claim!);
    });
  }
  async claimNext(ownerId: string, chatId: string) {
    return this.database.transaction(async (tx) => {
      const chat = await this.lock(tx, ownerId, chatId);
      if (chat.automationPaused || chat.managedAutonomyStopped) return null;
      const [eligible] = await tx
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, chatId),
            noPendingPermission(chatId),
            noPendingHandoff(chatId),
          ),
        );
      if (!eligible) return null;
      const [existing] = await tx
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
        .orderBy(asc(schema.managedQueueClaims.createdAt))
        .limit(1);
      if (existing)
        return existing.status === "claimed" ? claimValue(existing) : null;
      const [prompt] = await tx
        .select()
        .from(schema.queuedPrompts)
        .where(
          and(
            eq(schema.queuedPrompts.chatId, chatId),
            eq(schema.queuedPrompts.state, "pending"),
            eq(schema.queuedPrompts.frozen, false),
            sql`NOT EXISTS (SELECT 1 FROM managed_queue_claims c WHERE c.prompt_id = ${schema.queuedPrompts.id} AND c.prompt_revision = ${schema.queuedPrompts.revision} AND c.status = 'rejected')`,
          ),
        )
        .orderBy(
          asc(schema.queuedPrompts.position),
          asc(schema.queuedPrompts.createdAt),
        )
        .limit(1);
      if (!prompt) return null;
      const [claim] = await tx
        .insert(schema.managedQueueClaims)
        .values({
          id: randomUUID(),
          chatId,
          promptId: prompt.id,
          promptRevision: prompt.revision,
        })
        .returning();
      await retainManagedQueueInput(tx, claim!.id, prompt);
      await tx
        .update(schema.queuedPrompts)
        .set({ state: "claimed" })
        .where(eq(schema.queuedPrompts.id, prompt.id));
      await this.bump(tx, chatId);
      return claimValue(claim!);
    });
  }
  async claim(ownerId: string, chatId: string, id: string) {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, chatId);
      const [row] = await tx
        .select()
        .from(schema.managedQueueClaims)
        .where(
          and(
            eq(schema.managedQueueClaims.id, id),
            eq(schema.managedQueueClaims.chatId, chatId),
          ),
        );
      return row ? claimValue(row) : null;
    });
  }
  async releaseUnadmitted(ownerId: string, chatId: string, id: string) {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, chatId);
      const [row] = await tx
        .select()
        .from(schema.managedQueueClaims)
        .where(
          and(
            eq(schema.managedQueueClaims.id, id),
            eq(schema.managedQueueClaims.chatId, chatId),
          ),
        );
      if (!row || row.status !== "claimed" || row.operationId) return false;
      await tx
        .update(schema.managedQueueClaims)
        .set({ status: "rejected" })
        .where(eq(schema.managedQueueClaims.id, id));
      await tx
        .update(schema.queuedPrompts)
        .set({ state: "pending" })
        .where(eq(schema.queuedPrompts.id, row.promptId));
      await this.bump(tx, chatId);
      return true;
    });
  }
  async importNative(ownerId: string, input: ManagedQueueImport) {
    return this.database.transaction(async (tx) => {
      await this.authorize(tx, ownerId, input.workerId, input.session);
      const repository = this.repository(tx);
      const imported = [];
      for (const item of input.items) {
        if (!item.prompt.protectedNativeInput)
          throw new NativeCommandError("native-queue-input-required");
        const sourceKey = createHash("sha256")
          .update(
            JSON.stringify([
              ownerId,
              input.workerId,
              { ...input.session, runtimeGeneration: null, connectionId: null },
              item.nativeItemId,
            ]),
          )
          .digest("hex");
        const importId = createHash("sha256")
          .update(JSON.stringify([sourceKey, item.sourceDigest]))
          .digest("hex");
        const [existing] = await tx
          .select()
          .from(schema.managedQueueImports)
          .where(eq(schema.managedQueueImports.id, importId));
        if (existing) {
          await tx
            .update(schema.managedQueueImports)
            .set({
              runnerGeneration: input.runnerGeneration,
              identity: input.session,
            })
            .where(eq(schema.managedQueueImports.id, importId));
          imported.push(existing);
          continue;
        }
        const prior = await tx
          .select()
          .from(schema.managedQueueImports)
          .where(eq(schema.managedQueueImports.sourceKey, sourceKey));
        if (prior.some((row) => row.status !== "conflict"))
          throw new NativeCommandError("queue-import-conflict");
        let replacementPosition: number | undefined;
        if (prior.length) {
          const [old] = await tx
            .select()
            .from(schema.queuedPrompts)
            .where(eq(schema.queuedPrompts.id, prior[0]!.promptId));
          if (!old || old.state !== "importing")
            throw new NativeCommandError("queue-import-conflict");
          replacementPosition = old.position;
          await tx
            .delete(schema.managedQueueImports)
            .where(eq(schema.managedQueueImports.sourceKey, sourceKey));
          await tx
            .delete(schema.queuedPrompts)
            .where(eq(schema.queuedPrompts.id, old.id));
        }
        const state = await this.snapshotTx(tx, ownerId, input.session.chatId);
        const control = await repository.nativeCommands.controlContext(
          ownerId,
          input.session.chatId,
        );
        const result = await repository.managedQueue.mutate(ownerId, {
          expectedRevision: state.revision,
          mutation: {
            kind: "add",
            prompt: item.prompt,
            attachments: item.attachments,
          },
          admission: {
            workerId: input.workerId,
            operationId: `queue-import:${importId}`,
            origin: "terminal",
            method: "thread/queue/add",
            session: input.session,
            payloadDigest: item.sourceDigest,
            protectedPayload: item.prompt.protectedNativeInput,
            expectedActivationGeneration: control.activationGeneration,
            intent: { scope: "thread", settingKeys: [], expectedTurnId: null },
          },
        });
        if (result.receipt.status !== "applied")
          throw new NativeCommandError(
            result.receipt.rejectionCode ?? "queue-import-rejected",
          );
        await tx
          .update(schema.queuedPrompts)
          .set({
            state: "importing",
            ...(replacementPosition !== undefined
              ? { position: replacementPosition }
              : {}),
          })
          .where(eq(schema.queuedPrompts.id, item.prompt.id));
        const [created] = await tx
          .insert(schema.managedQueueImports)
          .values({
            id: importId,
            sourceKey,
            sourceDigest: item.sourceDigest,
            chatId: input.session.chatId,
            workerId: input.workerId,
            nativeItemId: item.nativeItemId,
            protectedSource: item.protectedSource,
            identity: input.session,
            runnerGeneration: input.runnerGeneration,
            promptId: item.prompt.id,
          })
          .returning();
        imported.push(created!);
      }
      const outstanding = await tx
        .select()
        .from(schema.managedQueueImports)
        .where(
          and(
            eq(schema.managedQueueImports.chatId, input.session.chatId),
            eq(schema.managedQueueImports.workerId, input.workerId),
            inArray(schema.managedQueueImports.status, [
              "pending",
              "uncertain",
            ]),
          ),
        );
      for (const row of outstanding) {
        if (
          !isDeepStrictEqual(
            {
              ...(row.identity as NativeCommandSession),
              runtimeGeneration: null,
              connectionId: null,
            },
            { ...input.session, runtimeGeneration: null, connectionId: null },
          )
        )
          continue;
        await tx
          .update(schema.managedQueueImports)
          .set({
            runnerGeneration: input.runnerGeneration,
            identity: input.session,
          })
          .where(eq(schema.managedQueueImports.id, row.id));
        if (!imported.some((item) => item.id === row.id)) imported.push(row);
      }
      return {
        ...(await this.snapshotTx(tx, ownerId, input.session.chatId)),
        imports: imported.map((row) => ({
          importId: row.id,
          nativeItemId: row.nativeItemId,
          sourceDigest: row.sourceDigest,
          protectedSource: row.protectedSource,
          nativeDeleteOperationId: `queue-delete:${row.id}`,
          promptId: row.promptId,
          status: row.status,
        })),
      };
    });
  }
  async acknowledgeImport(ownerId: string, input: ManagedQueueImportAck) {
    return this.database.transaction(async (tx) => {
      await this.authorize(tx, ownerId, input.workerId, input.session);
      const [record] = await tx
        .select()
        .from(schema.managedQueueImports)
        .where(eq(schema.managedQueueImports.id, input.importId));
      if (
        !record ||
        record.chatId !== input.session.chatId ||
        record.workerId !== input.workerId ||
        record.sourceDigest !== input.sourceDigest ||
        record.runnerGeneration !== input.runnerGeneration ||
        !isDeepStrictEqual(record.identity, input.session)
      )
        throw new NativeCommandError("stale-queue-import");
      if (record.status !== "imported") {
        const status = input.receipt.conflict
          ? "conflict"
          : input.receipt.deleted
            ? "imported"
            : "uncertain";
        if (status !== record.status) {
          await tx
            .update(schema.managedQueueImports)
            .set({ status })
            .where(eq(schema.managedQueueImports.id, record.id));
          if (status === "imported") {
            await tx
              .update(schema.queuedPrompts)
              .set({ state: "pending" })
              .where(
                and(
                  eq(schema.queuedPrompts.id, record.promptId),
                  eq(schema.queuedPrompts.state, "importing"),
                ),
              );
          }
          await this.bump(tx, record.chatId);
        }
      }
      return this.snapshotTx(tx, ownerId, input.session.chatId);
    });
  }
  async startReceipt(
    ownerId: string,
    workerId: string,
    session: NativeCommandSession,
    claimId: string,
  ) {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, session.chatId);
      const [claim] = await tx
        .select()
        .from(schema.managedQueueClaims)
        .where(
          and(
            eq(schema.managedQueueClaims.id, claimId),
            eq(schema.managedQueueClaims.chatId, session.chatId),
          ),
        );
      if (!claim) throw new NativeCommandError("queue-claim-not-found");
      if (claim.requestOperationId) {
        const [request] = await tx
          .select()
          .from(schema.nativeCommands)
          .where(
            and(
              eq(schema.nativeCommands.operationId, claim.requestOperationId),
              eq(schema.nativeCommands.ownerId, ownerId),
              eq(schema.nativeCommands.workerId, workerId),
            ),
          );
        if (!request) throw new NativeCommandError("stale-queue-session");
        const stored = request.identity as NativeCommandSession;
        const original = {
          ...stored,
          connectionId: null,
          runtimeGeneration: null,
        };
        const current = {
          ...session,
          connectionId: null,
          runtimeGeneration: null,
        };
        if (!isDeepStrictEqual(original, current)) {
          // A per-item model choice may change the canonical route while the
          // original start request is awaiting its receipt. Only an authorized
          // current view of that same thread and placement may reconcile it.
          await this.authorize(tx, ownerId, workerId, session);
          if (
            !isDeepStrictEqual(
              { ...original, modelRouteId: null, providerAccountId: null },
              { ...current, modelRouteId: null, providerAccountId: null },
            )
          )
            throw new NativeCommandError("stale-queue-session");
        }
      } else await this.authorize(tx, ownerId, workerId, session);

      if (!claim.operationId || !claim.operationGeneration) {
        if (claim.status === "rejected")
          throw new NativeCommandError("queue-claim-rejected");
        return null;
      }
      const [operation] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          and(
            eq(schema.nativeCommands.operationId, claim.operationId),
            eq(
              schema.nativeCommands.operationGeneration,
              claim.operationGeneration,
            ),
            eq(schema.nativeCommands.ownerId, ownerId),
            eq(schema.nativeCommands.chatId, session.chatId),
          ),
        );
      if (!operation) throw new NativeCommandError("stale-queue-claim");
      if (
        claim.status === "rejected" &&
        !(claim.awaitingGoal && operation.status === "applied")
      )
        throw new NativeCommandError("queue-claim-rejected");
      if (operation.status === "rejected")
        throw new NativeCommandError(
          operation.rejectionCode ?? "queue-claim-rejected",
        );
      if (operation.status === "uncertain")
        throw new NativeCommandError("queue-dispatch-uncertain");
      if (
        operation.status !== "applied" ||
        !operation.protectedResult ||
        !operation.resultDigest
      )
        return null;
      return {
        claim: claimValue(claim),
        receipt: await this.repository(tx).nativeCommands.get(
          ownerId,
          operation.workerId,
          operation.operationId,
          operation.operationGeneration,
        ),
        protectedResult: operation.protectedResult,
        resultDigest: operation.resultDigest,
      };
    });
  }
}
