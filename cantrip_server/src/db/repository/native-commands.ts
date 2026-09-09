import { QueuedPromptRepository } from "./queued-prompts.js";
import type { NativePermissionTransitionResolve } from "@cantrip/protocol";
import {
  assertPermissionTransition,
  resolvePermissionTransition,
} from "./native-permission-transitions.js";
import { nativeCommandReceipt as receipt } from "./native-command-receipt.js";
import { NativeSettingsEvidenceRepository } from "./native-settings-evidence.js";
import type { NativeSettingsEvidence } from "@cantrip/protocol";
import { NativeLogicalCompletionRepository } from "./native-logical-completions.js";
import { rememberNativeCommandTurn } from "./native-command-turns.js";
import {
  settleQueueClaim,
  cancelGoalHandoffs,
  queueStateChanged,
} from "./native-command-queue.js";
import { isDeepStrictEqual } from "node:util";
import { managedConsoleSessionContext } from "../../terminals/managed-session.js";
import type { ServerRepository } from "../repository.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import { createHash, randomUUID } from "node:crypto";
import {
  classifyManagedNativeMethod,
  managedNativeServerRequests,
  type NativeCommandAdmission,
  type NativeCommandContinuation,
  type NativeCommandDispatch,
  type NativeCommandReceipt,
  type NativeCommandSession,
  type NativeCommandSettlement,
  type NativePendingRequest,
} from "@cantrip/protocol";
import { isNull, or, inArray, and, eq, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import {
  admitNativeSettingsState,
  assertNativeSettingsWriteBinding,
  settleNativeSettingsState,
  settleNativeSettingsTransport,
  NativeSettingsStateRepository,
} from "./native-settings-persistence.js";
import {
  ChatExecutionLaneRepository,
  ExecutionLaneConflictError,
  type ChatExecutionContext,
} from "./chat-execution-lanes.js";
import { ChatRuntimeContextRepository } from "./chat-runtime-context.js";
import {
  firstOrThrow,
  type RepositoryDatabase,
  type RepositoryTransaction,
} from "./database.js";

type CommandRow = typeof schema.nativeCommands.$inferSelect;
import { NativeCommandError } from "./native-command-errors.js";
export { NativeCommandError } from "./native-command-errors.js";
export interface NativeCommandAdmissionResult {
  receipt: NativeCommandReceipt;
  execution: ChatExecutionContext | null;
  replayed?: boolean;
}
const settingKeys = new Set([
  "applyAt",
  "model",
  "effort",
  "summary",
  "reasoningEffort",
  "reasoningSummary",
  "cwd",
  "multiAgentMode",
  "serviceTier",
  "unsetServiceTier",
  "personality",
  "collaborationMode",
  "collaborationModeKind",
  "multiAgentEnabled",
  "subagentModel",
  "subagentReasoningEffort",
  "approvalPolicy",
  "approvalsReviewer",
  "sandboxPolicy",
  "permissions",
  "permissionProfile",
  "permissionProfileId",
]);
const defaultKeys = new Set([
  "model",
  "model_reasoning_effort",
  "service_tier",
  "personality",
]);
const activeMutations = new Set([
  "mcpServer/tool/call",
  "command/exec",
  "command/exec/write",
  "command/exec/terminate",
  "command/exec/resize",
  "process/spawn",
  "process/writeStdin",
  "process/kill",
  "process/resizePty",
  "thread/approveGuardianDeniedAction",
]);
const scopedMutations = new Set([
  "thread/name/set",
  "thread/goal/set",
  "thread/goal/clear",
  "thread/queue/start",
  "thread/queue/add",
  "thread/queue/update",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/metadata/update",
  "thread/memoryMode/set",
  "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/terminate",
  "thread/rollback",
  "thread/revert",
  "thread/inject_items",
  "mcpServerStatus/list",
  "mcpServer/resource/read",
  "project/list",
  "project/read",
  "skills/list",
  "hooks/list",
  "fs/readFile",
  "fs/getMetadata",
  "fs/readDirectory",
  "environment/info",
  "environment/status",
  "plugin/list",
  "plugin/installed",
  "plugin/read",
  "app/list",
  "app/installed",
  "app/read",
  "getConversationSummary",
  "gitDiffToRemote",
  "fuzzyFileSearch",
  "fuzzyFileSearch/sessionStart",
  "fuzzyFileSearch/sessionUpdate",
  "fuzzyFileSearch/sessionStop",
]);

/** Server policy classifies the actual method, independently of a caller's labels. */
export function nativeCommandPolicy(input: NativeCommandAdmission): {
  kind: string;
  active: boolean;
} {
  if (
    input.intent.settingsBindingId &&
    (input.method !== "thread/settings/update" ||
      !input.intent.nativeSettingsOperationId)
  )
    throw new NativeCommandError("invalid-settings-binding-scope");
  if (
    input.intent.nativeSettingsOperationId &&
    input.method !== "thread/settings/update"
  )
    throw new NativeCommandError("invalid-settings-operation-scope");
  if (input.method === "serverRequest/reply") {
    if (
      !input.reply ||
      !managedNativeServerRequests.has(input.reply.requestMethod)
    )
      throw new NativeCommandError("unsupported-reply");
    return { kind: "reply", active: true };
  }
  if (input.reply) throw new NativeCommandError("invalid-reply-scope");
  const kind =
    input.method === "thread/queue/start"
      ? "mutation"
      : classifyManagedNativeMethod(input.method);
  if (!kind || kind === "read")
    throw new NativeCommandError("unsupported-mutation");
  if (kind === "defaults") {
    if (
      input.intent.scope !== "account-defaults" ||
      input.intent.configTarget !== "account-defaults" ||
      !["config/value/write", "config/batchWrite"].includes(input.method) ||
      input.intent.settingKeys.some((key) => !defaultKeys.has(key))
    )
      throw new NativeCommandError("unsupported-default-scope");
  } else if (input.intent.scope !== "thread")
    throw new NativeCommandError("invalid-target-scope");
  if (
    kind === "settings" &&
    (input.method === "thread/managedConfig/update" ||
      input.intent.settingKeys.some((key) => !settingKeys.has(key)))
  )
    throw new NativeCommandError("unsupported-settings");
  if (
    kind === "mutation" &&
    !activeMutations.has(input.method) &&
    !scopedMutations.has(input.method)
  )
    throw new NativeCommandError("unsupported-mutation");
  return {
    kind,
    active:
      kind === "control" ||
      activeMutations.has(input.method) ||
      input.method === "turn/settings/update",
  };
}
function samePlacement(
  context: ChatExecutionContext | null,
  workerId: string,
  session: NativeCommandSession,
): context is ChatExecutionContext {
  return (
    !!context &&
    context.workerId === workerId &&
    context.chatId === session.chatId &&
    context.projectId === session.projectId &&
    context.contextKind === session.contextKind &&
    (context.worktreeId ?? context.scratchRootId) === session.placementId
  );
}

function sameRuntimeRoute(
  context: ChatExecutionContext,
  session: NativeCommandSession,
): boolean {
  return (
    context.modelRouteId === session.modelRouteId &&
    context.providerAccountId === session.providerAccountId
  );
}

export class NativeCommandRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly lanes: ChatExecutionLaneRepository,
    private readonly transactionRepository: (
      transaction: RepositoryTransaction,
    ) => ServerRepository,
  ) {}
  refreshSettingsState(
    ownerId: string,
    chatId: string,
    read: Parameters<NativeSettingsStateRepository["refresh"]>[2],
  ) {
    return new NativeSettingsStateRepository(this.database).refresh(
      ownerId,
      chatId,
      read,
    );
  }
  observeSettingsState(
    ownerId: string,
    input: Parameters<NativeSettingsStateRepository["observe"]>[1],
  ) {
    return new NativeSettingsStateRepository(this.database).observe(
      ownerId,
      input,
    );
  }
  settingsState(ownerId: string, chatId: string) {
    return new NativeSettingsStateRepository(this.database).get(
      ownerId,
      chatId,
    );
  }
  resolveSettingsWriteBinding(
    ownerId: string,
    chatId: string,
    expectedBindingId: string,
  ) {
    return new NativeSettingsStateRepository(this.database).resolveWriteBinding(
      ownerId,
      chatId,
      expectedBindingId,
    );
  }
  async resolvePermissionTransition(
    ownerId: string,
    input: NativePermissionTransitionResolve,
  ) {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, input.session.chatId);
      const context = await this.context(tx, ownerId, input.session.chatId);
      if (
        !samePlacement(context, input.workerId, input.session) ||
        !sameRuntimeRoute(context, input.session) ||
        !input.session.threadId ||
        context.threadId !== input.session.threadId ||
        !input.session.runtimeGeneration
      )
        throw new NativeCommandError("stale-session");
      const state = await new NativeSettingsStateRepository(tx).get(
        ownerId,
        input.session.chatId,
      );
      if (!state) throw new NativeCommandError("chat-not-found");
      if (!state.binding)
        throw new NativeCommandError(
          "permission-binding-required",
          "Read and publish the current native settings source before changing permissions.",
        );
      if (
        state.binding &&
        (state.binding.threadId !== input.session.threadId ||
          state.binding.runtimeGeneration !== input.session.runtimeGeneration)
      )
        throw new NativeCommandError("settings-binding-replaced");
      await assertNativeSettingsWriteBinding(
        tx,
        ownerId,
        input.session.chatId,
        state.binding.bindingId,
        { workerId: input.workerId, session: input.session },
      );
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(
          eq(schema.nativeCommandActivations.chatId, input.session.chatId),
        );
      if (
        activation?.active &&
        activation.runtimeGeneration !== input.session.runtimeGeneration
      )
        throw new NativeCommandError("stale-activation");
      return {
        permissionTransition: resolvePermissionTransition(
          context,
          input.selectedId,
          state.permissionPolicy?.revision ?? "0",
        ),
        bindingId: state.binding?.bindingId ?? null,
      };
    });
  }
  recordSettingsEvidence(ownerId: string, input: NativeSettingsEvidence) {
    return new NativeSettingsEvidenceRepository(this.database).record(
      ownerId,
      input,
    );
  }
  private async lock(
    tx: RepositoryTransaction,
    ownerId: string,
    chatId: string,
  ): Promise<void> {
    await lockNativeCommandChat(tx, ownerId, chatId);
  }
  private context(tx: RepositoryTransaction, ownerId: string, chatId: string) {
    const repository = new ChatRuntimeContextRepository(tx, {
      getChatExecutionContext: async () => {
        throw new Error("Unexpected context recursion");
      },
    });
    return repository.getChatExecutionContext(ownerId, chatId);
  }
  async admit(
    ownerId: string,
    input: NativeCommandAdmission,
    executionOptions: {
      acquiringActor?: "agent" | "user";
      purpose?: string;
      canonicalQueueMutation?: boolean;
      clientMessageId?: string;
      queueClaim?: { id: string; promptRevision: number };
    } = {},
  ): Promise<NativeCommandAdmissionResult> {
    const queueClaim = executionOptions.queueClaim ?? input.queueClaim;
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, input.session.chatId);
      const [existing] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, input.operationId));
      if (existing) {
        if (
          existing.ownerId !== ownerId ||
          existing.workerId !== input.workerId ||
          existing.chatId !== input.session.chatId ||
          existing.payloadDigest !== input.payloadDigest ||
          existing.method !== input.method ||
          existing.origin !== input.origin ||
          JSON.stringify(Object.entries(existing.intent as object).sort()) !==
            JSON.stringify(Object.entries(input.intent).sort())
        )
          throw new NativeCommandError("operation-id-conflict");
        const context = await this.context(tx, ownerId, existing.chatId);
        const [activation] = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, existing.chatId));
        const current =
          samePlacement(
            context,
            existing.workerId,
            existing.identity as NativeCommandSession,
          ) &&
          sameRuntimeRoute(
            context,
            existing.identity as NativeCommandSession,
          ) &&
          (existing.activationGeneration
            ? activation?.active &&
              activation.generation === existing.activationGeneration &&
              context.executionLaneId === existing.executionLaneId
            : !["running", "waiting-for-approval"].includes(context.status));
        return {
          receipt: receipt(existing),
          replayed: true,
          execution: current ? context : null,
        };
      }
      let context = await this.context(tx, ownerId, input.session.chatId);
      if (!samePlacement(context, input.workerId, input.session))
        throw new NativeCommandError("stale-placement");
      const initial = {
        operationId: input.operationId,
        ownerId,
        workerId: input.workerId,
        chatId: input.session.chatId,
        operationGeneration: randomUUID(),
        logicalOperationId: null as string | null,
        logicalClientMessageId: executionOptions.clientMessageId ?? null,
        activationGeneration: null as string | null,
        executionLaneId: null as string | null,
        origin: input.origin,
        method: input.method,
        kind: "unknown",
        payloadDigest: input.payloadDigest,
        protectedPayload: input.protectedPayload,
        identity: input.session,
        intent: input.intent,
        replyIdentity: input.reply ?? null,
        status: "accepted",
        rejectionCode: null as string | null,
      };
      let starts = false;
      let consumeReply = false;
      try {
        if (!managedConsoleSessionContext(context))
          throw new NativeCommandError("managed-session-ineligible");
        if (
          (input.method === "turn/pause" &&
            (typeof input.intent.paused !== "boolean" ||
              Boolean(input.intent.resumeAutonomy) !== !input.intent.paused)) ||
          (input.method !== "turn/pause" && input.intent.paused !== undefined)
        )
          throw new NativeCommandError("invalid-pause-intent");
        if (
          input.intent.resumeAutonomy &&
          ![
            "thread/queue/add",
            "thread/queue/start",
            "thread/goal/set",
            "turn/pause",
          ].includes(input.method)
        )
          throw new NativeCommandError("invalid-autonomy-resume");
        let goalClaim:
          typeof schema.managedQueueClaims.$inferSelect | undefined;
        if (
          input.intent.goalStatus !== undefined &&
          input.method !== "thread/goal/set"
        )
          throw new NativeCommandError("invalid-goal-status");
        if (input.goalQueueHandoff) {
          const handoff = input.goalQueueHandoff;
          if (input.origin !== "autonomous" || input.method !== "turn/start")
            throw new NativeCommandError("invalid-goal-handoff");
          [goalClaim] = await tx
            .select()
            .from(schema.managedQueueClaims)
            .where(eq(schema.managedQueueClaims.id, handoff.claimId));
          const [parent] = await tx
            .select()
            .from(schema.nativeCommands)
            .where(eq(schema.nativeCommands.operationId, handoff.operationId));
          if (
            !goalClaim ||
            !goalClaim.awaitingGoal ||
            goalClaim.goalOperationId ||
            goalClaim.chatId !== input.session.chatId ||
            goalClaim.operationId !== handoff.operationId ||
            goalClaim.operationGeneration !== handoff.operationGeneration ||
            goalClaim.goalEpoch !== handoff.goalEpoch ||
            !["dispatched", "uncertain"].includes(goalClaim.status) ||
            !parent ||
            parent.ownerId !== ownerId ||
            parent.workerId !== input.workerId ||
            parent.status !== "applied" ||
            parent.method !== "thread/goal/set" ||
            !isDeepStrictEqual(
              {
                ...(parent.identity as NativeCommandSession),
                runtimeGeneration: null,
                connectionId: null,
              },
              { ...input.session, runtimeGeneration: null, connectionId: null },
            )
          )
            throw new NativeCommandError("stale-goal-handoff");
        }
        if (
          input.method === "thread/goal/set" &&
          input.intent.goalStatus !== "paused"
        ) {
          const [pendingGoal] = await tx
            .select({ id: schema.managedQueueClaims.id })
            .from(schema.managedQueueClaims)
            .where(
              and(
                eq(schema.managedQueueClaims.chatId, input.session.chatId),
                eq(schema.managedQueueClaims.awaitingGoal, true),
                inArray(schema.managedQueueClaims.status, [
                  "accepted",
                  "dispatched",
                  "uncertain",
                ]),
              ),
            );
          if (pendingGoal)
            throw new NativeCommandError("queue-goal-handoff-pending");
        }
        if (input.origin === "autonomous") {
          const [chat] = await tx
            .select({ stopped: schema.chats.managedAutonomyStopped })
            .from(schema.chats)
            .where(eq(schema.chats.id, input.session.chatId));
          if (chat?.stopped) throw new NativeCommandError("autonomy-stopped");
          const [queued] = await tx
            .select({ id: schema.queuedPrompts.id })
            .from(schema.queuedPrompts)
            .where(
              and(
                eq(schema.queuedPrompts.chatId, input.session.chatId),
                eq(schema.queuedPrompts.state, "pending"),
                eq(schema.queuedPrompts.frozen, false),
                sql`NOT EXISTS (SELECT 1 FROM managed_queue_claims c WHERE c.prompt_id = ${schema.queuedPrompts.id} AND c.prompt_revision = ${schema.queuedPrompts.revision} AND c.status = 'rejected')`,
              ),
            )
            .limit(1);
          const [claimed] = await tx
            .select({ id: schema.managedQueueClaims.id })
            .from(schema.managedQueueClaims)
            .where(
              and(
                eq(schema.managedQueueClaims.chatId, input.session.chatId),
                inArray(schema.managedQueueClaims.status, [
                  "claimed",
                  "accepted",
                  "dispatched",
                  "uncertain",
                ]),
              ),
            )
            .limit(1);
          if ((queued || claimed) && !goalClaim)
            throw new NativeCommandError("canonical-queue-pending");
        }
        if (queueClaim) {
          const [claim] = await tx
            .select()
            .from(schema.managedQueueClaims)
            .where(eq(schema.managedQueueClaims.id, queueClaim.id));
          if (
            !claim ||
            claim.chatId !== input.session.chatId ||
            claim.promptRevision !== queueClaim.promptRevision ||
            claim.status !== "claimed" ||
            claim.operationId
          )
            throw new NativeCommandError("stale-queue-claim");
          const [prompt] = await tx
            .select()
            .from(schema.queuedPrompts)
            .where(eq(schema.queuedPrompts.id, claim.promptId));
          const method =
            prompt?.opaqueContent?.executionMethod ??
            (prompt?.mode === "goal" ? "thread/goal/set" : "turn/start");
          if (
            !prompt ||
            prompt.state !== "claimed" ||
            prompt.revision !== claim.promptRevision ||
            (input.method !== method &&
              !(
                input.method === "turn/steer" &&
                prompt.mode === "default" &&
                method === "turn/start"
              ))
          )
            throw new NativeCommandError("queue-action-mismatch");
        }
        const policy = nativeCommandPolicy(input);
        if (input.intent.settingsBindingId)
          await assertNativeSettingsWriteBinding(
            tx,
            ownerId,
            input.session.chatId,
            input.intent.settingsBindingId,
            input,
          );
        initial.kind = policy.kind;
        starts = policy.kind === "start";
        if (starts && input.origin === "gui")
          initial.logicalOperationId = input.operationId;
        const securityKeys = [
          "approvalPolicy",
          "approvalsReviewer",
          "sandboxPolicy",
          "permissions",
          "permissionProfile",
          "permissionProfileId",
        ];
        if (
          !input.intent.permissionTransition &&
          input.intent.settingKeys.some((key) => securityKeys.includes(key)) &&
          input.intent.permissionProfileId !==
            effectivePermissionProfile(context).effectiveId
        )
          throw new NativeCommandError("permission-profile-mismatch");
        if (input.intent.permissionTransition) {
          const state = await new NativeSettingsStateRepository(tx).get(
            ownerId,
            context.chatId,
          );
          if (!state) throw new NativeCommandError("chat-not-found");
          assertPermissionTransition(context, state, input);
        }
        if (
          (input.method.startsWith("fs/") ||
            input.intent.settingKeys.includes("cwd")) &&
          input.intent.pathsWithinPlacement !== true
        )
          throw new NativeCommandError("path-scope-mismatch");

        if (
          context.threadId !== input.session.threadId ||
          (!input.session.threadId &&
            (input.origin !== "gui" ||
              (!starts && !executionOptions.canonicalQueueMutation)))
        )
          throw new NativeCommandError("thread-identity-mismatch");
        if (!sameRuntimeRoute(context, input.session))
          throw new NativeCommandError("runtime-route-mismatch");
        const [activation] = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(
            eq(schema.nativeCommandActivations.chatId, input.session.chatId),
          );
        if (starts) {
          if (input.expectedActivationGeneration !== null)
            throw new NativeCommandError("stale-activation");
          context = await this.lanes
            .inTransaction(tx)
            .startChatExecutionLane(
              ownerId,
              input.session.chatId,
              executionOptions.acquiringActor ?? "user",
              executionOptions.purpose ?? "Managed native command",
            );
          if (!context?.executionLaneId)
            throw new NativeCommandError("execution-unavailable");
          initial.activationGeneration = randomUUID();
          initial.executionLaneId = context.executionLaneId;
        } else {
          const active =
            context.status === "running" ||
            context.status === "waiting-for-approval";
          if (policy.active || active) {
            if (
              !activation?.active ||
              !active ||
              input.expectedActivationGeneration !== activation.generation ||
              activation.workerId !== input.workerId ||
              activation.executionLaneId !== context.executionLaneId ||
              activation.runtimeGeneration !== input.session.runtimeGeneration
            )
              throw new NativeCommandError("stale-activation");
            initial.activationGeneration = activation.generation;
            initial.executionLaneId = activation.executionLaneId;
            if (
              input.intent.expectedTurnId &&
              activation.nativeTurnId !== input.intent.expectedTurnId
            )
              throw new NativeCommandError("stale-native-turn");
            if (input.reply) {
              const [pending] = await tx
                .select()
                .from(schema.nativePendingRequests)
                .where(
                  and(
                    eq(
                      schema.nativePendingRequests.chatId,
                      input.session.chatId,
                    ),
                    eq(
                      schema.nativePendingRequests.runtimeGeneration,
                      input.session.runtimeGeneration!,
                    ),
                    eq(
                      schema.nativePendingRequests.nativeRequestId,
                      input.reply.nativeRequestId,
                    ),
                  ),
                );
              if (
                !pending ||
                pending.resolutionOperationId ||
                pending.activationGeneration !== activation.generation ||
                pending.requestMethod !== input.reply.requestMethod ||
                pending.turnId !== input.reply.turnId
              )
                throw new NativeCommandError("stale-native-reply");
              consumeReply = true;
            }
          } else if (input.expectedActivationGeneration !== null)
            throw new NativeCommandError("stale-activation");
        }
      } catch (error) {
        if (
          !(error instanceof NativeCommandError) &&
          !(error instanceof ExecutionLaneConflictError)
        )
          throw error;
        initial.status = "rejected";
        initial.rejectionCode =
          error instanceof NativeCommandError
            ? error.code
            : "execution-conflict";
      }
      const inserted = firstOrThrow(
        await tx.insert(schema.nativeCommands).values(initial).returning(),
        "recording native admission",
      );
      await admitNativeSettingsState(tx, inserted);
      if (consumeReply && initial.status === "accepted") {
        await tx
          .update(schema.nativePendingRequests)
          .set({ resolutionOperationId: input.operationId })
          .where(
            and(
              eq(schema.nativePendingRequests.chatId, input.session.chatId),
              eq(
                schema.nativePendingRequests.runtimeGeneration,
                input.session.runtimeGeneration!,
              ),
              eq(
                schema.nativePendingRequests.nativeRequestId,
                input.reply!.nativeRequestId,
              ),
            ),
          );
      }
      if (starts && initial.status === "accepted") {
        const activation = {
          chatId: input.session.chatId,
          generation: initial.activationGeneration!,
          operationId: input.operationId,
          executionLaneId: initial.executionLaneId!,
          workerId: input.workerId,
          runtimeGeneration: input.session.runtimeGeneration,
          nativeTurnId: input.intent.expectedTurnId,
          logicalCancelled: false,
          active: true,
          createdAt: new Date(),
        };
        await tx
          .insert(schema.nativeCommandActivations)
          .values(activation)
          .onConflictDoUpdate({
            target: schema.nativeCommandActivations.chatId,
            set: activation,
          });
      }
      if (queueClaim && initial.status === "accepted") {
        await tx
          .update(schema.managedQueueClaims)
          .set({
            operationId: inserted.operationId,
            operationGeneration: inserted.operationGeneration,
            status: "accepted",
            awaitingGoal:
              input.method === "thread/goal/set" &&
              input.intent.resumeAutonomy === true,
          })
          .where(eq(schema.managedQueueClaims.id, queueClaim.id));
      }
      if (input.goalQueueHandoff && initial.status === "accepted")
        await tx
          .update(schema.managedQueueClaims)
          .set({
            goalOperationId: inserted.operationId,
            goalOperationGeneration: inserted.operationGeneration,
          })
          .where(
            eq(schema.managedQueueClaims.id, input.goalQueueHandoff.claimId),
          );
      return { receipt: receipt(inserted), execution: context };
    });
  }
  async continueExecution(
    ownerId: string,
    input: NativeCommandContinuation,
  ): Promise<NativeCommandAdmissionResult> {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, input.session.chatId);
      const previous = await this.command(
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
      let context = await this.context(tx, ownerId, previous.chatId);
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
        context = await this.context(tx, ownerId, previous.chatId);
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
      await this.lock(tx, ownerId, input.chatId);
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
      const root = await this.command(
        tx,
        ownerId,
        workerId,
        rootOperationId,
        rootOperationGeneration,
      );
      await this.lock(tx, ownerId, root.chatId);
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
  listPendingLogicalCompletions(
    ...args: Parameters<
      NativeLogicalCompletionRepository["listPendingLogicalCompletions"]
    >
  ) {
    return new NativeLogicalCompletionRepository(
      this.database,
    ).listPendingLogicalCompletions(...args);
  }
  getLogicalCompletion(
    ...args: Parameters<
      NativeLogicalCompletionRepository["getLogicalCompletion"]
    >
  ) {
    return new NativeLogicalCompletionRepository(
      this.database,
    ).getLogicalCompletion(...args);
  }
  acknowledgeLogicalCompletion(
    ...args: Parameters<
      NativeLogicalCompletionRepository["acknowledgeLogicalCompletion"]
    >
  ) {
    return new NativeLogicalCompletionRepository(
      this.database,
    ).acknowledgeLogicalCompletion(...args);
  }
  deferLogicalCompletion(
    ...args: Parameters<
      NativeLogicalCompletionRepository["deferLogicalCompletion"]
    >
  ) {
    return new NativeLogicalCompletionRepository(
      this.database,
    ).deferLogicalCompletion(...args);
  }
  /** Binds an accepted GUI preparation without dispatching its turn or issuing execution authority. */
  async bindPreparation(
    ownerId: string,
    input: NativeCommandDispatch,
  ): Promise<NativeCommandReceipt> {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, input.session.chatId);
      const row = await this.command(
        tx,
        ownerId,
        input.workerId,
        input.operationId,
        input.operationGeneration,
      );
      const context = await this.context(tx, ownerId, row.chatId);
      const prior = row.identity as NativeCommandSession;
      if (
        row.payloadDigest !== input.payloadDigest ||
        row.chatId !== input.session.chatId
      )
        throw new NativeCommandError("operation-id-conflict");
      if (
        row.kind !== "start" ||
        row.origin !== "gui" ||
        row.status !== "accepted"
      )
        throw new NativeCommandError("preparation-no-longer-accepted");
      if (
        !samePlacement(context, input.workerId, input.session) ||
        !sameRuntimeRoute(context, input.session) ||
        !input.session.threadId ||
        context.threadId !== input.session.threadId ||
        prior.threadId !== input.session.threadId ||
        prior.placementId !== input.session.placementId ||
        prior.projectId !== input.session.projectId ||
        prior.contextKind !== input.session.contextKind ||
        prior.modelRouteId !== input.session.modelRouteId ||
        prior.providerAccountId !== input.session.providerAccountId ||
        !input.session.runtimeGeneration ||
        !input.session.connectionId ||
        (prior.runtimeGeneration !== null &&
          prior.runtimeGeneration !== input.session.runtimeGeneration) ||
        (prior.connectionId !== null &&
          prior.connectionId !== input.session.connectionId)
      )
        throw new NativeCommandError("stale-session");
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
      if (
        !activation?.active ||
        activation.generation !== row.activationGeneration ||
        activation.executionLaneId !== context.executionLaneId ||
        !["running", "waiting-for-approval"].includes(context.status) ||
        (activation.runtimeGeneration !== null &&
          activation.runtimeGeneration !== input.session.runtimeGeneration)
      )
        throw new NativeCommandError("stale-activation");
      await tx
        .update(schema.nativeCommandActivations)
        .set({ runtimeGeneration: input.session.runtimeGeneration })
        .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
      const [bound] = await tx
        .update(schema.nativeCommands)
        .set({ identity: input.session, updatedAt: new Date() })
        .where(eq(schema.nativeCommands.operationId, row.operationId))
        .returning();
      return receipt(bound!);
    });
  }
  async dispatch(
    ownerId: string,
    input: NativeCommandDispatch,
  ): Promise<NativeCommandAdmissionResult> {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, input.session.chatId);
      const row = await this.command(
        tx,
        ownerId,
        input.workerId,
        input.operationId,
        input.operationGeneration,
      );
      if (
        row.payloadDigest !== input.payloadDigest ||
        row.chatId !== input.session.chatId
      )
        throw new NativeCommandError("operation-id-conflict");
      if (row.status === "rejected")
        throw new NativeCommandError(row.rejectionCode ?? "operation-rejected");
      if (row.status !== "accepted")
        throw new NativeCommandError("operation-already-dispatched");
      const prior = row.identity as NativeCommandSession;
      let context = await this.context(tx, ownerId, row.chatId);
      if (
        !samePlacement(context, input.workerId, input.session) ||
        prior.placementId !== input.session.placementId ||
        prior.projectId !== input.session.projectId ||
        prior.contextKind !== input.session.contextKind ||
        (prior.threadId !== null &&
          prior.threadId !== input.session.threadId) ||
        (prior.runtimeGeneration !== null &&
          prior.runtimeGeneration !== input.session.runtimeGeneration) ||
        (prior.connectionId !== null &&
          prior.connectionId !== input.session.connectionId) ||
        !input.session.threadId ||
        !input.session.runtimeGeneration ||
        !input.session.connectionId
      )
        throw new NativeCommandError("stale-session");
      if (
        !sameRuntimeRoute(context, input.session) ||
        (prior.threadId !== null &&
          (prior.modelRouteId !== input.session.modelRouteId ||
            prior.providerAccountId !== input.session.providerAccountId))
      )
        throw new NativeCommandError("runtime-route-mismatch");
      if (context.threadId && context.threadId !== input.session.threadId)
        throw new NativeCommandError("thread-identity-mismatch");
      const intent = row.intent as NativeCommandAdmission["intent"];
      if (intent.settingsBindingId)
        await assertNativeSettingsWriteBinding(
          tx,
          ownerId,
          row.chatId,
          intent.settingsBindingId,
          input,
        );
      if (
        !intent.permissionTransition &&
        intent.permissionProfileId &&
        intent.permissionProfileId !==
          effectivePermissionProfile(context).effectiveId
      )
        throw new NativeCommandError("permission-profile-mismatch");

      if (intent.permissionTransition) {
        const state = await new NativeSettingsStateRepository(tx).get(
          ownerId,
          row.chatId,
        );
        if (!state) throw new NativeCommandError("chat-not-found");
        assertPermissionTransition(context, state, {
          method: row.method,
          operationId: row.operationId,
          intent,
        });
      }

      if (row.activationGeneration) {
        const [activation] = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
        if (
          !activation?.active ||
          activation.generation !== row.activationGeneration ||
          activation.executionLaneId !== context.executionLaneId ||
          !["running", "waiting-for-approval"].includes(context.status) ||
          (activation.runtimeGeneration !== null &&
            activation.runtimeGeneration !== input.session.runtimeGeneration)
        )
          throw new NativeCommandError("stale-activation");
        await tx
          .update(schema.nativeCommandActivations)
          .set({ runtimeGeneration: input.session.runtimeGeneration })
          .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
      } else if (["running", "waiting-for-approval"].includes(context.status))
        throw new NativeCommandError("stale-activation");
      if (!context.threadId) {
        if (
          row.kind !== "start" ||
          row.origin !== "gui" ||
          !row.executionLaneId
        )
          throw new NativeCommandError("thread-identity-mismatch");
        await this.lanes
          .inTransaction(tx)
          .updateChatExecutionLaneRuntime(
            row.chatId,
            row.executionLaneId,
            input.session.threadId,
            "running",
          );
        context = await this.context(tx, ownerId, row.chatId);
      }
      if (
        row.method === "thread/goal/clear" ||
        (row.method === "thread/goal/set" && intent.goalStatus === "paused")
      )
        await cancelGoalHandoffs(tx, row.chatId);
      if (row.method === "turn/interrupt")
        await this.stopAutonomyInTransaction(tx, row.chatId);
      else if (intent.resumeAutonomy)
        await tx
          .update(schema.chats)
          .set({ managedAutonomyStopped: false })
          .where(eq(schema.chats.id, row.chatId));
      if (row.method === "turn/pause") {
        await tx
          .update(schema.chats)
          .set({ automationPaused: intent.paused! })
          .where(eq(schema.chats.id, row.chatId));
        context = await this.context(tx, ownerId, row.chatId);
      }
      if (intent.resumeAutonomy || row.method === "turn/pause")
        await queueStateChanged(tx, row.chatId);
      const updated = firstOrThrow(
        await tx
          .update(schema.nativeCommands)
          .set({
            identity: input.session,
            status: "dispatched",
            ...(row.method === "thread/settings/update" &&
            intent.nativeSettingsOperationId
              ? {
                  settingsApplication: {
                    nativeOperationId: intent.nativeSettingsOperationId,
                    submissionId: null,
                    status: "pending" as const,
                    evidenceCount: 0,
                  },
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.nativeCommands.operationId, row.operationId))
          .returning(),
        "dispatching native command",
      );
      await settleNativeSettingsState(tx, updated, "dispatched");
      await tx
        .update(schema.managedQueueClaims)
        .set({ status: "dispatched" })
        .where(
          and(
            eq(schema.managedQueueClaims.operationId, row.operationId),
            eq(
              schema.managedQueueClaims.operationGeneration,
              row.operationGeneration,
            ),
            eq(schema.managedQueueClaims.status, "accepted"),
          ),
        );
      return { receipt: receipt(updated), execution: context };
    });
  }
  private async command(
    tx: RepositoryTransaction,
    ownerId: string,
    workerId: string,
    operationId: string,
    operationGeneration: string,
  ) {
    const [row] = await tx
      .select()
      .from(schema.nativeCommands)
      .where(
        and(
          eq(schema.nativeCommands.operationId, operationId),
          eq(schema.nativeCommands.ownerId, ownerId),
          eq(schema.nativeCommands.workerId, workerId),
          eq(schema.nativeCommands.operationGeneration, operationGeneration),
        ),
      );
    if (!row)
      throw new NativeCommandError(
        "operation-not-found",
        "Operation not found.",
        404,
      );
    return row;
  }
  async registerPending(
    ownerId: string,
    input: NativePendingRequest,
  ): Promise<void> {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, input.session.chatId);
      const context = await this.context(tx, ownerId, input.session.chatId);
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(
          eq(schema.nativeCommandActivations.chatId, input.session.chatId),
        );
      if (
        !samePlacement(context, input.workerId, input.session) ||
        context.threadId !== input.session.threadId ||
        !sameRuntimeRoute(context, input.session) ||
        !input.session.runtimeGeneration ||
        !activation?.active ||
        activation.generation !== input.activationGeneration ||
        activation.runtimeGeneration !== input.session.runtimeGeneration ||
        activation.executionLaneId !== context.executionLaneId ||
        !managedNativeServerRequests.has(input.requestMethod)
      )
        throw new NativeCommandError("stale-native-request");
      const values = {
        chatId: input.session.chatId,
        runtimeGeneration: input.session.runtimeGeneration,
        nativeRequestId: input.nativeRequestId,
        activationGeneration: input.activationGeneration,
        requestMethod: input.requestMethod,
        turnId: input.turnId,
      };
      const [prior] = await tx
        .select()
        .from(schema.nativePendingRequests)
        .where(
          and(
            eq(schema.nativePendingRequests.chatId, values.chatId),
            eq(
              schema.nativePendingRequests.runtimeGeneration,
              values.runtimeGeneration,
            ),
            eq(
              schema.nativePendingRequests.nativeRequestId,
              values.nativeRequestId,
            ),
          ),
        );
      if (prior) {
        if (
          prior.activationGeneration !== values.activationGeneration ||
          prior.requestMethod !== values.requestMethod ||
          prior.turnId !== values.turnId ||
          prior.resolutionOperationId
        )
          throw new NativeCommandError("native-request-id-conflict");
        return;
      }
      await tx.insert(schema.nativePendingRequests).values(values);
    });
  }
  private async stopAutonomyInTransaction(
    tx: RepositoryTransaction,
    chatId: string,
  ): Promise<void> {
    await tx
      .update(schema.chats)
      .set({ managedAutonomyStopped: true })
      .where(eq(schema.chats.id, chatId));
    await tx
      .update(schema.nativeCommandActivations)
      .set({ logicalCancelled: true })
      .where(
        and(
          eq(schema.nativeCommandActivations.chatId, chatId),
          eq(schema.nativeCommandActivations.active, true),
        ),
      );
    await queueStateChanged(tx, chatId);
    await cancelGoalHandoffs(tx, chatId);
    // A resume accepted before Stop cannot reopen autonomy by dispatching late.
    await tx
      .update(schema.nativeCommands)
      .set({
        status: "rejected",
        rejectionCode: "autonomy-stopped",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.nativeCommands.chatId, chatId),
          eq(schema.nativeCommands.status, "accepted"),
          sql`${schema.nativeCommands.intent}->>'resumeAutonomy' = 'true'`,
        ),
      );
  }
  async stopAutonomy(
    ownerId: string,
    chatId: string,
    expectedActivation: string | null,
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, chatId);
      const context = await this.context(tx, ownerId, chatId);
      if (!context || !managedConsoleSessionContext(context)) return false;
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, chatId));
      if (
        (activation?.active ? activation.generation : null) !==
        expectedActivation
      )
        return false;
      await this.stopAutonomyInTransaction(tx, chatId);
      return true;
    });
  }
  async resumeAutonomy(ownerId: string, chatId: string): Promise<void> {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, chatId);
      const context = await this.context(tx, ownerId, chatId);
      if (!context || !managedConsoleSessionContext(context)) return;
      await tx
        .update(schema.chats)
        .set({ managedAutonomyStopped: false })
        .where(eq(schema.chats.id, chatId));
      await queueStateChanged(tx, chatId);
    });
  }
  async cancelPreparing(
    ownerId: string,
    chatId: string,
    activationGeneration: string,
  ): Promise<{
    workerId: string;
    logicalRoot: { operationId: string; operationGeneration: string } | null;
  } | null> {
    return this.database.transaction(async (tx) => {
      await this.lock(tx, ownerId, chatId);
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, chatId));
      if (!activation?.active || activation.generation !== activationGeneration)
        return null;
      const [operation] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, activation.operationId));
      if (!operation || operation.status !== "accepted") return null;
      const [logicalRoot] = operation.logicalOperationId
        ? await tx
            .select()
            .from(schema.nativeCommands)
            .where(
              and(
                eq(
                  schema.nativeCommands.operationId,
                  operation.logicalOperationId,
                ),
                eq(schema.nativeCommands.ownerId, ownerId),
                eq(schema.nativeCommands.chatId, chatId),
              ),
            )
        : [];
      await this.stopAutonomyInTransaction(tx, chatId);
      await tx
        .update(schema.nativeCommands)
        .set({
          status: "rejected",
          rejectionCode: "cancelled-before-dispatch",
          updatedAt: new Date(),
        })
        .where(eq(schema.nativeCommands.operationId, operation.operationId));
      await this.lanes
        .inTransaction(tx)
        .finishChatExecutionLane(chatId, activation.executionLaneId, "idle");
      await tx
        .update(schema.nativeCommandActivations)
        .set({ active: false })
        .where(eq(schema.nativeCommandActivations.chatId, chatId));
      if (logicalRoot)
        await tx
          .update(schema.nativeCommands)
          .set({ logicalCompletedAt: new Date() })
          .where(
            eq(schema.nativeCommands.operationId, logicalRoot.operationId),
          );
      const [cancelled] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, operation.operationId));
      await settleQueueClaim(tx, cancelled!);
      return {
        workerId: operation.workerId,
        logicalRoot: logicalRoot
          ? {
              operationId: logicalRoot.operationId,
              operationGeneration: logicalRoot.operationGeneration,
            }
          : null,
      };
    });
  }
  async controlContext(
    ownerId: string,
    chatId: string,
  ): Promise<{
    context: ChatExecutionContext | null;
    activationGeneration: string | null;
    runtimeGeneration: string | null;
  }> {
    return this.database.transaction(async (tx) => {
      const context = await this.context(tx, ownerId, chatId);
      if (!context)
        return {
          context: null,
          activationGeneration: null,
          runtimeGeneration: null,
        };
      await this.lock(tx, ownerId, chatId);
      const current = await this.context(tx, ownerId, chatId);
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, chatId));
      const [operation] = activation?.active
        ? await tx
            .select()
            .from(schema.nativeCommands)
            .where(
              eq(schema.nativeCommands.operationId, activation.operationId),
            )
        : [];
      return {
        context: current,
        runtimeGeneration:
          current &&
          activation?.active &&
          activation.executionLaneId === current.executionLaneId &&
          operation
            ? (operation.identity as NativeCommandSession).runtimeGeneration
            : null,
        activationGeneration:
          current &&
          activation?.active &&
          activation.executionLaneId === current.executionLaneId
            ? activation.generation
            : null,
      };
    });
  }
  async withEventContext<T>(
    ownerId: string,
    workerId: string,
    operationId: string,
    operationGeneration: string,
    apply: (
      context: ChatExecutionContext,
      repository: ServerRepository,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      const row = await this.command(
        tx,
        ownerId,
        workerId,
        operationId,
        operationGeneration,
      );
      await this.lock(tx, ownerId, row.chatId);
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
      const context = await this.context(tx, ownerId, row.chatId);
      if (
        !samePlacement(
          context,
          workerId,
          row.identity as NativeCommandSession,
        ) ||
        !sameRuntimeRoute(context, row.identity as NativeCommandSession) ||
        row.kind !== "start" ||
        !["dispatched", "applied", "uncertain"].includes(row.status) ||
        !activation?.active ||
        activation.generation !== row.activationGeneration ||
        activation.executionLaneId !== context.executionLaneId
      )
        throw new NativeCommandError("stale-operation-event");
      return apply(context, this.transactionRepository(tx));
    });
  }
  async finishExecution(
    ownerId: string,
    workerId: string,
    operationId: string,
    operationGeneration: string,
    status: "idle" | "failed",
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const original = await this.command(
        tx,
        ownerId,
        workerId,
        operationId,
        operationGeneration,
      );
      await this.lock(tx, ownerId, original.chatId);
      const row = await this.command(
        tx,
        ownerId,
        workerId,
        operationId,
        operationGeneration,
      );
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
      if (
        row.kind !== "start" ||
        !row.executionLaneId ||
        !activation?.active ||
        activation.generation !== row.activationGeneration
      )
        return false;
      const finished = await this.lanes
        .inTransaction(tx)
        .finishChatExecutionLane(row.chatId, row.executionLaneId, status);
      await tx
        .update(schema.nativeCommandActivations)
        .set({ active: false })
        .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
      if (row.status === "accepted" || row.status === "dispatched") {
        await tx
          .update(schema.nativeCommands)
          .set({
            status: row.status === "accepted" ? "rejected" : "uncertain",
            rejectionCode:
              row.status === "accepted"
                ? "not-dispatched"
                : "missing-native-receipt",
            updatedAt: new Date(),
          })
          .where(eq(schema.nativeCommands.operationId, row.operationId));
      }
      return finished;
    });
  }
  async lookup(
    ownerId: string,
    workerId: string,
    operationId: string,
  ): Promise<NativeCommandReceipt | null> {
    const [row] = await this.database
      .select()
      .from(schema.nativeCommands)
      .where(
        and(
          eq(schema.nativeCommands.ownerId, ownerId),
          eq(schema.nativeCommands.workerId, workerId),
          eq(schema.nativeCommands.operationId, operationId),
        ),
      );
    return row ? receipt(row) : null;
  }
  async get(
    ownerId: string,
    workerId: string,
    operationId: string,
    operationGeneration: string,
  ): Promise<NativeCommandReceipt> {
    return this.database.transaction(async (tx) =>
      receipt(
        await this.command(
          tx,
          ownerId,
          workerId,
          operationId,
          operationGeneration,
        ),
      ),
    );
  }
  async hasDeferredLogicalGui(
    ownerId: string,
    workerId: string,
    operationId: string,
    operationGeneration: string,
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const root = await this.command(
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
  private async deferredQueueReady(
    tx: RepositoryTransaction,
    ownerId: string,
    chatId: string,
  ) {
    const state = await new NativeSettingsStateRepository(tx).get(
      ownerId,
      chatId,
    );
    return Boolean(
      state &&
      !state.pending.some((entry) => entry.intent.permissionTransition) &&
      !(
        state.desired?.permissionTransition &&
        state.desiredStatus === "uncertain"
      ),
    );
  }
  async settle(
    ownerId: string,
    input: NativeCommandSettlement,
  ): Promise<NativeCommandReceipt> {
    return this.database.transaction(async (tx) => {
      const row = await this.command(
        tx,
        ownerId,
        input.workerId,
        input.operationId,
        input.operationGeneration,
      );
      await this.lock(tx, ownerId, row.chatId);
      const current = await this.command(
        tx,
        ownerId,
        input.workerId,
        input.operationId,
        input.operationGeneration,
      );
      if (input.terminalResult && !input.executionComplete)
        throw new NativeCommandError("terminal-result-requires-completion");
      const terminalEvidence = input.deferred
        ? {
            kind: "deferred",
            reason: input.deferred.reason,
            inputConsumed: false,
            threadId: input.deferred.threadId,
            runtimeGeneration: input.deferred.runtimeGeneration,
          }
        : input.decline
          ? { kind: "declined", ...input.decline }
          : input.reconciliation
            ? { kind: "terminal", ...input.reconciliation }
            : null;
      // Retirement is administrative, not evidence that native consumed input.
      // An exact captured no-input result may arrive after its worker restarted.
      const missingNativeReceipt =
        current.status === "uncertain" &&
        current.rejectionCode === "missing-native-receipt" &&
        !current.resultDigest &&
        !current.protectedResult &&
        !current.terminalResultDigest &&
        !current.protectedTerminalResult &&
        !current.terminalEvidence;
      if (
        current.executionCompletedAt &&
        input.executionComplete &&
        !(input.deferred && missingNativeReceipt)
      ) {
        if (
          current.status !== input.status ||
          (input.resultDigest && current.resultDigest !== input.resultDigest) ||
          (input.terminalResult?.resultDigest &&
            current.terminalResultDigest !==
              input.terminalResult.resultDigest) ||
          (terminalEvidence &&
            !isDeepStrictEqual(current.terminalEvidence, terminalEvidence))
        )
          throw new NativeCommandError("receipt-conflict");
        return {
          ...receipt(current),
          ...(input.deferred
            ? {
                resumeQueue: await this.deferredQueueReady(
                  tx,
                  ownerId,
                  row.chatId,
                ),
              }
            : {}),
        };
      }
      if (input.deferred) {
        const [activation] = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
        const identity = row.identity as NativeCommandSession;
        if (
          input.status !== "rejected" ||
          !input.executionComplete ||
          input.decline ||
          input.reconciliation ||
          input.terminalResult ||
          (current.status !== "dispatched" && !missingNativeReceipt) ||
          current.resultDigest ||
          current.protectedResult ||
          current.terminalResultDigest ||
          current.protectedTerminalResult ||
          current.terminalEvidence ||
          !input.protectedResult ||
          !input.resultDigest ||
          row.method !== "turn/start" ||
          row.kind !== "start" ||
          (activation?.generation === row.activationGeneration &&
            (activation.nativeTurnId ||
              activation.runtimeGeneration !==
                input.deferred.runtimeGeneration)) ||
          identity.threadId !== input.deferred.threadId ||
          identity.runtimeGeneration !== input.deferred.runtimeGeneration
        )
          throw new NativeCommandError("stale-native-deferral");
        const [observedTurn] = await tx
          .select({ operationId: schema.nativeCommandTurns.operationId })
          .from(schema.nativeCommandTurns)
          .where(eq(schema.nativeCommandTurns.operationId, row.operationId));
        if (observedTurn) throw new NativeCommandError("stale-native-deferral");
        const [claim] = await tx
          .select()
          .from(schema.managedQueueClaims)
          .where(
            and(
              eq(schema.managedQueueClaims.operationId, row.operationId),
              eq(
                schema.managedQueueClaims.operationGeneration,
                row.operationGeneration,
              ),
            ),
          );
        if (claim && (claim.status === "consumed" || claim.nativeTurnId))
          throw new NativeCommandError("stale-native-deferral");
        if (input.deferred.retainedPrompt) {
          const prompt = input.deferred.retainedPrompt;
          const [root] = await tx
            .select()
            .from(schema.nativeCommands)
            .where(
              and(
                eq(
                  schema.nativeCommands.operationId,
                  row.logicalOperationId ?? row.operationId,
                ),
                eq(schema.nativeCommands.ownerId, ownerId),
                eq(schema.nativeCommands.chatId, row.chatId),
              ),
            );
          const originalIntent = row.intent as NativeCommandAdmission["intent"];
          const guiIdentityMatches =
            row.origin === "gui" &&
            Boolean(root?.logicalClientMessageId) &&
            prompt.pendingMessage.id === root!.logicalClientMessageId &&
            (prompt.nativeClientUserMessageId ===
              root!.logicalClientMessageId ||
              prompt.nativeClientUserMessageId ===
                `cantrip:${root!.logicalClientMessageId}`) &&
            isDeepStrictEqual(
              prompt.pendingMessage.protectedContent.envelope,
              root!.protectedPayload,
            );
          const terminalIdentityMatches =
            row.origin === "terminal" &&
            Boolean(prompt.nativeClientUserMessageId) &&
            (!originalIntent.nativeClientUserMessageId ||
              prompt.nativeClientUserMessageId ===
                originalIntent.nativeClientUserMessageId);
          if (
            claim ||
            (!guiIdentityMatches && !terminalIdentityMatches) ||
            prompt.pendingMessage.classification.role !== "user" ||
            prompt.executionMethod !== "turn/start" ||
            prompt.nativeAction !== "literal" ||
            !prompt.protectedNativeInput ||
            input.deferred.attachments!.some(
              (item) => item.chatId !== row.chatId,
            ) ||
            !isDeepStrictEqual(
              prompt.classification.attachmentIds,
              input.deferred.attachments!.map((item) => item.id),
            )
          )
            throw new NativeCommandError("invalid-deferred-prompt");
          const retained = await new QueuedPromptRepository(
            tx,
          ).createEncryptedQueuedPrompt(
            ownerId,
            row.chatId,
            prompt,
            input.deferred.attachments!,
          );
          if (
            !retained ||
            retained.id !== prompt.id ||
            !isDeepStrictEqual(
              retained.pendingMessage,
              prompt.pendingMessage,
            ) ||
            !isDeepStrictEqual(
              retained.protectedContent,
              prompt.protectedContent,
            ) ||
            !isDeepStrictEqual(
              retained.protectedNativeInput,
              prompt.protectedNativeInput,
            )
          )
            throw new NativeCommandError("deferred-prompt-conflict");
          await tx
            .insert(schema.managedQueueStates)
            .values({ chatId: row.chatId })
            .onConflictDoNothing();
          await queueStateChanged(tx, row.chatId);
        } else if (
          (row.origin === "gui" || row.origin === "terminal") &&
          !claim
        ) {
          throw new NativeCommandError("deferred-prompt-required");
        }
      }
      if (input.decline) {
        const [activation] = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
        if (
          input.status !== "rejected" ||
          !input.executionComplete ||
          input.reconciliation ||
          row.origin !== "autonomous" ||
          row.kind !== "start" ||
          row.operationId !==
            `native:${input.decline.runnerGeneration}:${input.decline.attemptId}` ||
          !activation?.active ||
          activation.generation !== row.activationGeneration ||
          activation.runtimeGeneration !== input.decline.runtimeGeneration ||
          activation.nativeTurnId !== input.decline.nativeTurnId
        )
          throw new NativeCommandError("stale-native-evidence");
      }
      if (input.reconciliation) {
        const [activation] = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
        if (
          row.kind !== "start" ||
          !activation?.active ||
          activation.generation !== row.activationGeneration ||
          activation.runtimeGeneration !==
            input.reconciliation.runtimeGeneration ||
          (activation.nativeTurnId &&
            activation.nativeTurnId !== input.reconciliation.nativeTurnId)
        )
          throw new NativeCommandError("stale-native-evidence");
        await tx
          .update(schema.nativeCommandActivations)
          .set({ nativeTurnId: input.reconciliation.nativeTurnId })
          .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
      }
      let goalEvidence = false;
      if (
        input.goalEpoch &&
        input.status === "applied" &&
        input.protectedResult &&
        input.resultDigest &&
        row.method === "thread/goal/set"
      ) {
        const [claim] = await tx
          .select()
          .from(schema.managedQueueClaims)
          .where(
            and(
              eq(schema.managedQueueClaims.operationId, row.operationId),
              eq(
                schema.managedQueueClaims.operationGeneration,
                row.operationGeneration,
              ),
              eq(schema.managedQueueClaims.awaitingGoal, true),
            ),
          );
        goalEvidence = Boolean(
          claim && (!claim.goalEpoch || claim.goalEpoch === input.goalEpoch),
        );
      }
      if (current.status === "rejected" && current.status !== input.status)
        throw new NativeCommandError("receipt-conflict");
      if (
        current.status === "uncertain" &&
        input.status !== "uncertain" &&
        !(
          input.status === "applied" &&
          (input.reconciliation || goalEvidence)
        ) &&
        !(input.status === "rejected" && (input.decline || input.deferred))
      )
        throw new NativeCommandError("native-evidence-required");
      if (current.status === "accepted" && input.status === "applied")
        throw new NativeCommandError("operation-not-dispatched");
      if (current.status === "applied" && input.status !== "applied")
        throw new NativeCommandError("receipt-conflict");
      if (
        current.resultDigest &&
        input.resultDigest &&
        current.resultDigest !== input.resultDigest
      )
        throw new NativeCommandError("receipt-conflict");
      if (
        current.terminalResultDigest &&
        input.terminalResult?.resultDigest &&
        current.terminalResultDigest !== input.terminalResult.resultDigest
      )
        throw new NativeCommandError("receipt-conflict");
      if (input.reconciliation)
        await rememberNativeCommandTurn(tx, current, input.reconciliation);
      const updated = firstOrThrow(
        await tx
          .update(schema.nativeCommands)
          .set({
            status: input.status,
            resultDigest: input.resultDigest ?? current.resultDigest,
            protectedResult: current.protectedResult ?? input.protectedResult,
            terminalResultDigest:
              input.terminalResult?.resultDigest ??
              current.terminalResultDigest,
            protectedTerminalResult:
              current.protectedTerminalResult ??
              input.terminalResult?.protectedResult ??
              null,
            terminalEvidence: input.executionComplete
              ? terminalEvidence
              : current.terminalEvidence,
            executionCompletedAt: input.executionComplete
              ? new Date()
              : current.executionCompletedAt,
            rejectionCode: input.deferred
              ? "native-settings-pending"
              : (input.rejectionCode ?? current.rejectionCode),
            updatedAt: new Date(),
          })
          .where(eq(schema.nativeCommands.operationId, row.operationId))
          .returning(),
        "settling native command",
      );
      await settleNativeSettingsTransport(tx, updated);
      if (
        input.executionComplete &&
        row.kind === "start" &&
        row.activationGeneration &&
        row.executionLaneId
      ) {
        const [activation] = await tx
          .select()
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
        if (
          activation?.active &&
          activation.generation === row.activationGeneration
        ) {
          await this.lanes
            .inTransaction(tx)
            .finishChatExecutionLane(
              row.chatId,
              row.executionLaneId,
              input.deferred
                ? "idle"
                : (input.executionStatus ??
                    (input.status === "applied" ? "idle" : "failed")),
            );
          await tx
            .update(schema.nativeCommandActivations)
            .set({ active: false })
            .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
        } else if (
          input.deferred &&
          activation?.generation === row.activationGeneration
        ) {
          // Administrative retirement can mark this attempt failed before its
          // captured no-consumption receipt arrives. Correct only that idle
          // attempt; never finish or relabel a replacement execution lane.
          await tx
            .update(schema.chats)
            .set({ status: "idle", updatedAt: new Date() })
            .where(
              and(
                eq(schema.chats.id, row.chatId),
                eq(schema.chats.status, "failed"),
                sql`NOT EXISTS (SELECT 1 FROM chat_execution_lanes l WHERE l.chat_id = ${row.chatId} AND l.state = 'active')`,
              ),
            );
        }
      }
      await settleQueueClaim(
        tx,
        updated,
        input.reconciliation?.nativeTurnId ?? null,
        input.goalEpoch,
      );
      return {
        ...receipt(updated),
        ...(input.deferred
          ? {
              resumeQueue: await this.deferredQueueReady(
                tx,
                ownerId,
                row.chatId,
              ),
            }
          : {}),
      };
    });
  }
}
