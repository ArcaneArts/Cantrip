import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  nativeCommandIntentSchema,
  nativeCommandSessionSchema,
  nativeSuspensionExecutionAdmissionSchema,
  type NativeSuspensionExecutionAdmission,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import {
  nativeCommandContext,
  samePlacement,
  sameRuntimeRoute,
} from "./native-command-context.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { NativeCommandError } from "./native-command-errors.js";
import { nativeCommandReceipt } from "./native-command-receipt.js";
import {
  NativeSuspensionRepository,
  sameNativeSuspensionSource,
} from "./native-suspensions.js";
import { assertNativeRuntimeWritable } from "./native-runtime-handoff-guard.js";
import { rememberNativeCommandTurn } from "./native-command-turns.js";
import { retainedNativeSuspension } from "./native-suspended-execution.js";

function fail(code: string): never {
  throw new NativeCommandError(code);
}
const operation = (row: typeof schema.nativeCommands.$inferSelect) => ({
  operationId: row.operationId,
  operationGeneration: row.operationGeneration,
});

/** An explicitly requested Resume can replace a dead physical observer. It
 * retains the lane and accepted logical input and does not dispatch native IPC. */
export class NativeSuspensionExecutionAdmissionRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async admit(ownerId: string, raw: NativeSuspensionExecutionAdmission) {
    const input = nativeSuspensionExecutionAdmissionSchema.parse(raw);
    const action = input.action ?? "resume";
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, input.session.chatId);
      const suspensions = new NativeSuspensionRepository(
        this.database,
      ).inTransaction(tx);
      const state = await suspensions.read(ownerId, input.session.chatId);
      if (
        !state ||
        state.controlId !== input.controlId ||
        state.action !== action ||
        state.phase !== (action === "stop" ? "stopping" : "resuming") ||
        !state.checkpoint ||
        !state.active ||
        !isDeepStrictEqual(state.checkpoint, input.checkpoint)
      )
        fail("suspension-control-stale");
      const context = await nativeCommandContext(
        tx,
        ownerId,
        input.session.chatId,
      );
      const [chat] = await tx
        .select()
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.session.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        );
      if (
        !context ||
        !chat ||
        !samePlacement(context, input.workerId, input.session) ||
        !sameRuntimeRoute(context, input.session) ||
        !sameNativeSuspensionSource(context, chat, state) ||
        !input.session.runtimeGeneration ||
        !input.session.connectionId ||
        input.session.threadId !== state.active.threadId
      )
        fail("suspension-authority-changed");
      await assertNativeRuntimeWritable(
        tx,
        chat.id,
        input.session.runtimeGeneration,
        undefined,
        "write",
      );
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, chat.id));
      const expectedHead =
        state.executionOwner?.operationId ?? state.target.originalOperationId;
      if (
        !activation?.active ||
        (activation.logicalCancelled && action !== "stop") ||
        activation.workerId !== input.workerId ||
        activation.operationId !== expectedHead ||
        activation.executionLaneId !== context.executionLaneId ||
        context.executionLaneId !== state.target.executionLaneId
      )
        fail("suspension-execution-replaced");
      const [source] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          eq(
            schema.nativeCommands.operationId,
            state.target.originalOperationId!,
          ),
        );
      const [head] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, activation.operationId));
      if (
        !source ||
        !head ||
        source.ownerId !== ownerId ||
        source.workerId !== input.workerId ||
        source.chatId !== chat.id ||
        source.kind !== "start" ||
        head.ownerId !== ownerId ||
        head.workerId !== input.workerId ||
        head.chatId !== chat.id ||
        head.activationGeneration !== activation.generation ||
        head.executionLaneId !== context.executionLaneId ||
        source.executionLaneId !== context.executionLaneId
      )
        fail("suspension-execution-replaced");
      const original = nativeCommandSessionSchema.parse(source.identity);
      if (!(await retainedNativeSuspension(suspensions, ownerId, head)))
        fail("suspension-not-held");
      if (
        original.threadId !== state.active.threadId ||
        !original.runtimeGeneration
      )
        fail("suspension-source-mismatch");
      const [logical] = source.logicalOperationId
        ? await tx
            .select()
            .from(schema.nativeCommands)
            .where(
              eq(schema.nativeCommands.operationId, source.logicalOperationId),
            )
        : [];
      if (
        source.logicalOperationId &&
        (!logical ||
          logical.ownerId !== ownerId ||
          logical.workerId !== input.workerId ||
          logical.chatId !== chat.id ||
          logical.logicalOperationId !== logical.operationId ||
          logical.logicalCompletedAt ||
          head.logicalOperationId !== logical.operationId)
      )
        fail("suspension-logical-input-ended");
      const response = (
        row: typeof schema.nativeCommands.$inferSelect,
        suspension: NonNullable<typeof state>,
        replayed = false,
      ) => ({
        receipt: nativeCommandReceipt(row),
        execution: context,
        replayed,
        suspension,
        source: operation(source),
        logicalRoot: logical ? operation(logical) : null,
      });
      const [existing] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, input.operationId));
      if (existing && existing.operationId !== head.operationId)
        fail("operation-id-conflict");
      const intent = nativeCommandIntentSchema.parse(head.intent);
      // A new Stop control may replace a failed/unprepared observer in this
      // same runtime. Its old authority is fenced by the new activation; it
      // cannot release inference. Retries of one control still join exactly.
      const replacesControl =
        action === "stop" &&
        intent.restoredSuspension?.controlId !== input.controlId;
      if (
        state.executionOwner?.workerGeneration === input.workerGeneration &&
        state.executionOwner.runtimeGeneration ===
          input.session.runtimeGeneration &&
        !replacesControl
      ) {
        if (
          head.operationGeneration !==
            state.executionOwner.operationGeneration ||
          !isDeepStrictEqual(head.identity, input.session) ||
          head.payloadDigest !== input.payloadDigest ||
          intent.restoredSuspension?.controlId !== input.controlId ||
          (intent.restoredSuspension?.action ?? "resume") !== action ||
          !isDeepStrictEqual(
            intent.restoredSuspension.checkpoint,
            input.checkpoint.suspension,
          ) ||
          head.executionCompletedAt
        )
          fail("suspension-observer-conflict");
        return response(head, state, true);
      }
      if (existing) fail("operation-id-conflict");
      // The committed pause is native evidence for the original canonical turn.
      // Keep its unique provenance; a fresh observer is not a second input.
      await rememberNativeCommandTurn(tx, source, {
        nativeTurnId: state.active.turnId,
        runtimeGeneration: original.runtimeGeneration,
      });
      const generation = randomUUID(),
        activationGeneration = randomUUID();
      const row = firstOrThrow(
        await tx
          .insert(schema.nativeCommands)
          .values({
            operationId: input.operationId,
            operationGeneration: generation,
            ownerId,
            workerId: input.workerId,
            chatId: chat.id,
            origin: source.origin,
            logicalOperationId: logical?.operationId ?? null,
            previousOperationId: head.operationId,
            executionLaneId: context.executionLaneId,
            activationGeneration,
            method: "thread/resume",
            kind: "start",
            payloadDigest: input.payloadDigest,
            protectedPayload: input.protectedPayload,
            identity: input.session,
            intent: {
              scope: "thread",
              settingKeys: [],
              expectedTurnId: state.active.turnId,
              permissionProfileId:
                effectivePermissionProfile(context).effectiveId,
              restoredSuspension: {
                ...(action === "stop" ? { action } : {}),
                controlId: input.controlId,
                checkpoint: input.checkpoint.suspension,
                source: operation(source),
              },
            },
            status: "accepted",
          })
          .returning(),
        "admitting suspended native observer",
      );
      await tx
        .update(schema.nativeCommands)
        .set({
          executionCompletedAt: head.executionCompletedAt ?? new Date(),
          terminalEvidence: head.terminalEvidence ?? {
            kind: "suspension-owner-replaced",
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.nativeCommands.operationId, head.operationId));
      await tx
        .update(schema.nativeCommandActivations)
        .set({
          operationId: row.operationId,
          generation: activationGeneration,
          runtimeGeneration: input.session.runtimeGeneration,
          nativeTurnId: state.active.turnId,
        })
        .where(eq(schema.nativeCommandActivations.chatId, chat.id));
      const actor = {
        workerGeneration: input.workerGeneration,
        runtimeGeneration: input.session.runtimeGeneration,
        operationId: row.operationId,
        operationGeneration: generation,
      };
      const claimed = await suspensions.claim(
        ownerId,
        chat.id,
        input.controlId,
        state.actor,
        actor,
        state.active,
        actor,
      );
      return response(row, claimed.state);
    });
  }
}
