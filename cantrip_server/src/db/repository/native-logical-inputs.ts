import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  NativeCommandAdmission,
  NativeCommandContinuation,
  NativeCommandSession,
} from "@cantrip/protocol";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import { ChatExecutionLaneRepository } from "./chat-execution-lanes.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import {
  nativeCommandContext,
  readNativeCommand,
  samePlacement,
  sameRuntimeRoute,
} from "./native-command-context.js";
import { NativeCommandError } from "./native-command-errors.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { nativeCommandReceipt as receipt } from "./native-command-receipt.js";
import { settleQueueClaim } from "./native-command-queue.js";
import { rememberNativeCommandTurn } from "./native-command-turns.js";
import type { NativeCommandAdmissionResult } from "./native-commands.js";

/** Transactional continuation and completion of one accepted logical GUI input. */
export class NativeLogicalInputRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly lanes: ChatExecutionLaneRepository,
  ) {}
  async continueExecution(
    ownerId: string,
    input: NativeCommandContinuation,
  ): Promise<NativeCommandAdmissionResult> {
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, input.session.chatId);
      const previous = await readNativeCommand(
        tx,
        ownerId,
        input.workerId,
        input.previousOperationId,
        input.previousOperationGeneration,
      );
      const [root] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          and(
            eq(schema.nativeCommands.operationId, input.rootOperationId),
            eq(schema.nativeCommands.ownerId, ownerId),
            eq(schema.nativeCommands.workerId, input.workerId),
          ),
        );
      const [existing] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, input.operationId));
      let context = await nativeCommandContext(tx, ownerId, previous.chatId);
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, previous.chatId));
      if (existing) {
        if (
          existing.ownerId !== ownerId ||
          existing.workerId !== input.workerId ||
          existing.logicalOperationId !== input.rootOperationId ||
          existing.previousOperationId !== input.previousOperationId ||
          existing.payloadDigest !== input.payloadDigest ||
          !isDeepStrictEqual(existing.identity, input.session)
        )
          throw new NativeCommandError("operation-id-conflict");
        const current =
          samePlacement(context, input.workerId, input.session) &&
          sameRuntimeRoute(context, input.session) &&
          activation?.active &&
          !activation.logicalCancelled &&
          activation.generation === existing.activationGeneration;
        return {
          receipt: receipt(existing),
          replayed: true,
          execution: current ? context : null,
        };
      }
      if (
        !root ||
        root.logicalOperationId !== root.operationId ||
        previous.logicalOperationId !== root.operationId ||
        root.origin !== "gui" ||
        previous.origin !== "gui" ||
        previous.kind !== "start" ||
        previous.chatId !== input.session.chatId ||
        !previous.executionLaneId ||
        root.executionLaneId !== previous.executionLaneId
      )
        throw new NativeCommandError("invalid-continuation-lineage");
      if (
        !samePlacement(context, input.workerId, input.session) ||
        !sameRuntimeRoute(context, input.session)
      )
        throw new NativeCommandError("stale-session");
      if (
        !activation?.active ||
        activation.logicalCancelled ||
        activation.operationId !== previous.operationId ||
        activation.generation !== previous.activationGeneration ||
        activation.executionLaneId !== context.executionLaneId ||
        context.automationPaused ||
        !["running", "waiting-for-approval"].includes(context.status)
      )
        throw new NativeCommandError("stale-continuation");
      const previousIntent =
        previous.intent as NativeCommandAdmission["intent"];
      if (
        previousIntent.permissionProfileId &&
        previousIntent.permissionProfileId !==
          effectivePermissionProfile(context).effectiveId
      )
        throw new NativeCommandError("permission-profile-mismatch");
      const prior = previous.identity as NativeCommandSession;
      if (
        !input.session.threadId ||
        !input.session.runtimeGeneration ||
        !input.session.connectionId ||
        prior.placementId !== input.session.placementId ||
        prior.projectId !== input.session.projectId ||
        prior.contextKind !== input.session.contextKind ||
        prior.modelRouteId !== input.session.modelRouteId ||
        prior.providerAccountId !== input.session.providerAccountId ||
        (prior.runtimeGeneration !== null &&
          prior.runtimeGeneration !== input.session.runtimeGeneration) ||
        (prior.connectionId !== null &&
          prior.connectionId !== input.session.connectionId) ||
        input.failure.runtimeGeneration !== input.session.runtimeGeneration
      )
        throw new NativeCommandError("stale-session");
      if (input.handoff) {
        if (
          input.reason !== "invalid-compaction" ||
          prior.threadId !== input.handoff.expectedThreadId ||
          context.threadId !== input.handoff.expectedThreadId ||
          input.session.threadId !== input.handoff.replacementThreadId ||
          input.handoff.expectedThreadId === input.handoff.replacementThreadId
        )
          throw new NativeCommandError("thread-identity-mismatch");
      } else if (
        prior.threadId !== input.session.threadId ||
        context.threadId !== input.session.threadId
      )
        throw new NativeCommandError("thread-identity-mismatch");
      if (input.failure.kind === "native-terminal") {
        if (
          !["dispatched", "applied", "uncertain"].includes(previous.status) ||
          (activation.nativeTurnId !== null &&
            activation.nativeTurnId !== input.failure.nativeTurnId)
        )
          throw new NativeCommandError("stale-native-evidence");
      } else {
        if (
          (input.failure.method === "turn/start" &&
            !["dispatched", "uncertain"].includes(previous.status)) ||
          (input.failure.method === "thread/resume" &&
            (input.reason !== "invalid-compaction" ||
              previous.status !== "accepted")) ||
          activation.nativeTurnId !== null
        )
          throw new NativeCommandError("stale-native-evidence");
      }
      const now = new Date();
      if (input.failure.kind === "native-terminal")
        await rememberNativeCommandTurn(tx, previous, input.failure);
      await tx
        .update(schema.nativeCommands)
        .set({
          status:
            input.failure.kind === "native-terminal" ? "applied" : "rejected",
          rejectionCode:
            input.failure.kind === "native-terminal"
              ? null
              : "native-request-rejected",
          executionCompletedAt: now,
          terminalEvidence: { retryReason: input.reason, ...input.failure },
          updatedAt: now,
        })
        .where(eq(schema.nativeCommands.operationId, previous.operationId));
      if (input.handoff) {
        const [lane] = await tx
          .select()
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.id, previous.executionLaneId),
              eq(schema.chatExecutionLanes.chatId, previous.chatId),
            ),
          )
          .for("update");
        if (!lane?.runtimeSessionId)
          throw new NativeCommandError("thread-handoff-failed");
        const changed = await tx
          .update(schema.chatRuntimeSessions)
          .set({
            codexThreadId: input.handoff.replacementThreadId,
            status: "running",
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.chatRuntimeSessions.id, lane.runtimeSessionId),
              eq(
                schema.chatRuntimeSessions.codexThreadId,
                input.handoff.expectedThreadId,
              ),
            ),
          )
          .returning({ id: schema.chatRuntimeSessions.id });
        const changedLane = await tx
          .update(schema.chatExecutionLanes)
          .set({
            codexThreadId: input.handoff.replacementThreadId,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.chatExecutionLanes.id, lane.id),
              eq(
                schema.chatExecutionLanes.codexThreadId,
                input.handoff.expectedThreadId,
              ),
            ),
          )
          .returning({ id: schema.chatExecutionLanes.id });
        if (changed.length !== 1 || changedLane.length !== 1)
          throw new NativeCommandError("thread-handoff-failed");
        context = await nativeCommandContext(tx, ownerId, previous.chatId);
        if (!context || context.threadId !== input.handoff.replacementThreadId)
          throw new NativeCommandError("thread-handoff-failed");
      }
      const operationGeneration = randomUUID();
      const activationGeneration = randomUUID();
      const inserted = firstOrThrow(
        await tx
          .insert(schema.nativeCommands)
          .values({
            operationId: input.operationId,
            ownerId,
            workerId: input.workerId,
            chatId: previous.chatId,
            operationGeneration,
            logicalOperationId: root.operationId,
            logicalClientMessageId: root.logicalClientMessageId,
            previousOperationId: previous.operationId,
            activationGeneration,
            executionLaneId: previous.executionLaneId,
            origin: "gui",
            method: "turn/start",
            kind: "start",
            payloadDigest: input.payloadDigest,
            protectedPayload: input.protectedPayload,
            identity: input.session,
            intent: {
              scope: "thread",
              settingKeys: [],
              expectedTurnId: null,
              ...(previousIntent.permissionProfileId
                ? { permissionProfileId: previousIntent.permissionProfileId }
                : {}),
              continuation: {
                reason: input.reason,
                failure: input.failure,
                handoff: input.handoff ?? null,
              },
            },
            status: "accepted",
          })
          .returning(),
        "recording GUI continuation",
      );
      await tx
        .update(schema.nativeCommandActivations)
        .set({
          generation: activationGeneration,
          operationId: input.operationId,
          runtimeGeneration: input.session.runtimeGeneration,
          nativeTurnId: null,
          logicalCancelled: false,
          active: true,
          createdAt: now,
        })
        .where(eq(schema.nativeCommandActivations.chatId, previous.chatId));
      return { receipt: receipt(inserted), execution: context };
    });
  }
  /** Only the owning GUI closure finishes the head of this logical input. Native events remain exact-generation. */
  async logicalGuiOutcomeRoot(
    ownerId: string,
    workerId: string,
    input: {
      chatId: string;
      executionLaneId: string;
      clientMessageId: string;
      worktreeId: string | null;
      nativeLogicalRoot: { operationId: string; operationGeneration: string };
      threadId?: string;
      turnId?: string | null;
    },
  ) {
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, input.chatId);
      const [root] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          and(
            eq(
              schema.nativeCommands.operationId,
              input.nativeLogicalRoot.operationId,
            ),
            eq(
              schema.nativeCommands.operationGeneration,
              input.nativeLogicalRoot.operationGeneration,
            ),
            eq(schema.nativeCommands.ownerId, ownerId),
            eq(schema.nativeCommands.workerId, workerId),
            eq(schema.nativeCommands.chatId, input.chatId),
          ),
        );
      if (
        !root ||
        root.origin !== "gui" ||
        root.kind !== "start" ||
        root.logicalOperationId !== root.operationId ||
        root.executionLaneId !== input.executionLaneId
      )
        return null;
      const [message] = await tx
        .select()
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.id, input.clientMessageId),
            eq(schema.chatMessages.chatId, input.chatId),
            eq(schema.chatMessages.role, "user"),
            eq(schema.chatMessages.executionLaneId, input.executionLaneId),
          ),
        );
      if (!message) return null;
      const legacyId = `gui:${createHash("sha256")
        .update(JSON.stringify([ownerId, input.chatId, message.idempotencyKey]))
        .digest("hex")}`;
      if (
        root.logicalClientMessageId
          ? root.logicalClientMessageId !== input.clientMessageId
          : root.operationId !== legacyId
      )
        return null;
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, input.chatId));
      if (
        !activation ||
        activation.workerId !== workerId ||
        activation.executionLaneId !== input.executionLaneId
      )
        return null;
      const [head] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, activation.operationId));
      const identity = head?.identity as NativeCommandSession | undefined;
      if (
        !head ||
        head.logicalOperationId !== root.operationId ||
        head.executionLaneId !== input.executionLaneId ||
        identity?.placementId !== input.worktreeId ||
        (input.threadId && identity.threadId !== input.threadId) ||
        (input.turnId &&
          activation.nativeTurnId &&
          activation.nativeTurnId !== input.turnId)
      )
        return null;
      return receipt(root);
    });
  }
  async finishLogicalGui(
    ownerId: string,
    workerId: string,
    rootOperationId: string,
    rootOperationGeneration: string,
    status: "idle" | "failed",
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const root = await readNativeCommand(
        tx,
        ownerId,
        workerId,
        rootOperationId,
        rootOperationGeneration,
      );
      await lockNativeCommandChat(tx, ownerId, root.chatId);
      if (root.origin !== "gui" || root.logicalOperationId !== root.operationId)
        throw new NativeCommandError("invalid-continuation-lineage");
      if (root.logicalCompletedAt) {
        await tx
          .insert(schema.nativeLogicalCompletions)
          .values({
            ownerId,
            workerId,
            chatId: root.chatId,
            rootOperationId,
            rootOperationGeneration,
          })
          .onConflictDoNothing();
        return false;
      }
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, root.chatId));
      if (!activation) return false;
      const [head] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, activation.operationId));
      if (
        !head ||
        head.logicalOperationId !== root.operationId ||
        head.executionLaneId !== root.executionLaneId ||
        !head.executionLaneId
      )
        return false;
      const finished = activation.active
        ? await this.lanes
            .inTransaction(tx)
            .finishChatExecutionLane(root.chatId, head.executionLaneId, status)
        : false;
      await tx
        .update(schema.nativeCommands)
        .set({ logicalCompletedAt: new Date() })
        .where(eq(schema.nativeCommands.operationId, root.operationId));
      await tx
        .insert(schema.nativeLogicalCompletions)
        .values({
          ownerId,
          workerId,
          chatId: root.chatId,
          rootOperationId,
          rootOperationGeneration,
        })
        .onConflictDoNothing();
      await tx
        .update(schema.nativeCommandActivations)
        .set({ active: false })
        .where(eq(schema.nativeCommandActivations.chatId, root.chatId));
      await tx
        .update(schema.nativeCommands)
        .set({
          executionCompletedAt: new Date(),
          ...(head.status === "accepted"
            ? { status: "rejected", rejectionCode: "not-dispatched" }
            : head.status === "dispatched"
              ? { status: "uncertain", rejectionCode: "missing-native-receipt" }
              : {}),
        })
        .where(eq(schema.nativeCommands.operationId, head.operationId));
      const [completedHead] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, head.operationId));
      await settleQueueClaim(tx, completedHead!);
      return finished;
    });
  }

  async hasDeferredLogicalGui(
    ownerId: string,
    workerId: string,
    operationId: string,
    operationGeneration: string,
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const root = await readNativeCommand(
        tx,
        ownerId,
        workerId,
        operationId,
        operationGeneration,
      );
      if (root.origin !== "gui" || root.logicalOperationId !== root.operationId)
        return false;
      const [deferred] = await tx
        .select({ id: schema.nativeCommands.operationId })
        .from(schema.nativeCommands)
        .where(
          and(
            eq(schema.nativeCommands.ownerId, ownerId),
            eq(schema.nativeCommands.workerId, workerId),
            eq(schema.nativeCommands.logicalOperationId, root.operationId),
            eq(schema.nativeCommands.status, "rejected"),
            eq(schema.nativeCommands.rejectionCode, "native-settings-pending"),
            sql`${schema.nativeCommands.terminalEvidence}->>'kind' = 'deferred'`,
            sql`${schema.nativeCommands.executionCompletedAt} IS NOT NULL`,
          ),
        )
        .limit(1);
      return Boolean(deferred);
    });
  }
}
