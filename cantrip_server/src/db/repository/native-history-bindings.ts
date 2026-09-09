import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  nativeCommandSessionSchema,
  nativeHistoryBindingOpenSchema,
  nativeHistoryBindingSchema,
  type NativeHistoryBinding,
  type NativeHistoryBindingOpen,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";
import { ChatRuntimeContextRepository } from "./chat-runtime-context.js";
import {
  firstOrThrow,
  type RepositoryDatabase,
  type RepositoryTransaction,
} from "./database.js";

export class NativeHistoryError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(`Native history request failed: ${code}.`);
    this.name = "NativeHistoryError";
  }
}

type BindingRow = typeof schema.nativeHistoryBindings.$inferSelect;
function binding(row: BindingRow): NativeHistoryBinding {
  const { ownerId: _owner, createdAt, ...fields } = row;
  return nativeHistoryBindingSchema.parse({
    ...fields,
    createdAt: createdAt.toISOString(),
  });
}

/** Never acquires a lane or changes chat/native status, settings, or CUA authority. */
export class NativeHistoryBindingRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  private async lockChat(
    tx: RepositoryTransaction,
    ownerId: string,
    workerId: string,
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
    if (!chat) throw new NativeHistoryError("chat-not-found", 404);
    if (
      chat.experience !== "agent" ||
      chat.contextKind !== "project" ||
      !chat.projectId
    )
      throw new NativeHistoryError("ineligible-chat");
    const [worker] = await tx
      .select({ id: schema.workers.id })
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.ownerId, ownerId),
        ),
      );
    if (!worker) throw new NativeHistoryError("worker-not-found", 404);
    return chat;
  }

  async open(
    ownerId: string,
    raw: NativeHistoryBindingOpen,
  ): Promise<NativeHistoryBinding> {
    const input = nativeHistoryBindingOpenSchema.parse(raw);
    return this.database.transaction(async (tx) => {
      const chat = await this.lockChat(
        tx,
        ownerId,
        input.workerId,
        input.chatId,
      );
      const [existing] = await tx
        .select()
        .from(schema.nativeHistoryBindings)
        .where(
          and(
            eq(schema.nativeHistoryBindings.ownerId, ownerId),
            eq(schema.nativeHistoryBindings.workerId, input.workerId),
            eq(schema.nativeHistoryBindings.chatId, input.chatId),
            eq(schema.nativeHistoryBindings.threadId, input.threadId),
          ),
        );
      if (input.provenance.kind === "binding") {
        if (!existing || existing.id !== input.provenance.bindingId)
          throw new NativeHistoryError("binding-not-found", 404);
        return binding(existing);
      }
      // Once persisted, exact history ownership does not expire with an active
      // turn or the currently selected route. This is a read/import association.
      if (existing) return binding(existing);

      let source: Pick<
        BindingRow,
        | "projectId"
        | "worktreeId"
        | "modelRouteId"
        | "providerAccountId"
        | "createdFromOperationId"
      >;
      if (input.provenance.kind === "current") {
        const context = await new ChatRuntimeContextRepository(tx, {
          getChatExecutionContext: async () => {
            throw new Error("Unexpected history context recursion");
          },
        }).getChatExecutionContext(ownerId, input.chatId);
        if (
          !context ||
          context.contextKind !== "project" ||
          context.workerId !== input.workerId ||
          context.threadId !== input.threadId
        )
          throw new NativeHistoryError("thread-not-bound");
        source = {
          projectId: context.projectId,
          worktreeId: context.worktreeId,
          modelRouteId: context.modelRouteId,
          providerAccountId: context.providerAccountId,
          createdFromOperationId: null,
        };
      } else {
        const [command] = await tx
          .select()
          .from(schema.nativeCommands)
          .where(
            and(
              eq(
                schema.nativeCommands.operationId,
                input.provenance.operationId,
              ),
              eq(
                schema.nativeCommands.operationGeneration,
                input.provenance.operationGeneration,
              ),
              eq(schema.nativeCommands.ownerId, ownerId),
              eq(schema.nativeCommands.workerId, input.workerId),
              eq(schema.nativeCommands.chatId, input.chatId),
            ),
          );
        // Failed or interrupted executed turns still have history. Require the
        // actual admitted start/lane association, not a successful final result.
        if (!command || command.kind !== "start" || !command.executionLaneId)
          throw new NativeHistoryError("command-not-bound");
        const session = nativeCommandSessionSchema.parse(command.identity);
        if (
          session.contextKind !== "project" ||
          session.chatId !== input.chatId ||
          session.threadId !== input.threadId ||
          session.projectId !== chat.projectId
        )
          throw new NativeHistoryError("command-thread-mismatch");
        const [lane] = await tx
          .select()
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.id, command.executionLaneId),
              eq(schema.chatExecutionLanes.chatId, input.chatId),
              eq(schema.chatExecutionLanes.worktreeId, session.placementId),
            ),
          );
        if (!lane) throw new NativeHistoryError("command-placement-mismatch");
        source = {
          projectId: chat.projectId!,
          worktreeId: session.placementId,
          modelRouteId: session.modelRouteId,
          providerAccountId: session.providerAccountId,
          createdFromOperationId: command.operationId,
        };
      }
      const rows = await tx
        .insert(schema.nativeHistoryBindings)
        .values({
          id: randomUUID(),
          ownerId,
          workerId: input.workerId,
          chatId: input.chatId,
          threadId: input.threadId,
          ...source,
        })
        .returning();
      return binding(firstOrThrow(rows, "binding native history"));
    });
  }

  /** Historical writes can share this transaction without borrowing active-turn authority. */
  async withBinding<T>(
    ownerId: string,
    workerId: string,
    chatId: string,
    bindingId: string,
    apply: (
      tx: RepositoryTransaction,
      binding: NativeHistoryBinding,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      await this.lockChat(tx, ownerId, workerId, chatId);
      const [row] = await tx
        .select()
        .from(schema.nativeHistoryBindings)
        .where(
          and(
            eq(schema.nativeHistoryBindings.id, bindingId),
            eq(schema.nativeHistoryBindings.ownerId, ownerId),
            eq(schema.nativeHistoryBindings.workerId, workerId),
            eq(schema.nativeHistoryBindings.chatId, chatId),
          ),
        )
        .for("update");
      if (!row) throw new NativeHistoryError("binding-not-found", 404);
      return apply(tx, binding(row));
    });
  }
}
