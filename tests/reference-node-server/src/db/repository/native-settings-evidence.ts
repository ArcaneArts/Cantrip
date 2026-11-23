import { ChatRuntimeContextRepository } from "./chat-runtime-context.js";
import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type {
  NativeCommandSession,
  NativeSettingsApplication,
  NativeSettingsEvidence,
  NativeSettingsEvidenceResult,
} from "@cantrip/protocol";
import {
  nativeCommandIntentSchema,
  nativeSettingsEvidenceSchema,
} from "@cantrip/protocol";
import type { RepositoryDatabase } from "./database.js";
import * as schema from "../schema.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import {
  settleNativeSettingsState,
  changeNativeSettingsState,
  NativeSettingsStateRepository,
} from "./native-settings-persistence.js";
import { NativeCommandError } from "./native-command-errors.js";

/** Facts can arrive before the RPC acknowledgment or after runtime replacement.
 * This records historical results, not authority to perform another mutation. */
export class NativeSettingsEvidenceRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async record(
    ownerId: string,
    value: NativeSettingsEvidence,
  ): Promise<NativeSettingsEvidenceResult> {
    const input = nativeSettingsEvidenceSchema.parse(value);
    return this.database.transaction(async (tx) => {
      const [located] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          and(
            eq(schema.nativeCommands.operationId, input.operationId),
            eq(
              schema.nativeCommands.operationGeneration,
              input.operationGeneration,
            ),
            eq(schema.nativeCommands.ownerId, ownerId),
            eq(schema.nativeCommands.workerId, input.workerId),
          ),
        );
      if (!located)
        throw new NativeCommandError(
          "operation-not-found",
          "Operation not found.",
          404,
        );
      await lockNativeCommandChat(tx, ownerId, located.chatId);
      const [command] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          and(
            eq(schema.nativeCommands.operationId, input.operationId),
            eq(
              schema.nativeCommands.operationGeneration,
              input.operationGeneration,
            ),
            eq(schema.nativeCommands.ownerId, ownerId),
            eq(schema.nativeCommands.workerId, input.workerId),
          ),
        )
        .for("update");
      if (!command)
        throw new NativeCommandError(
          "operation-not-found",
          "Operation not found.",
          404,
        );
      const identity = command.identity as NativeCommandSession;
      const intent = nativeCommandIntentSchema.parse(command.intent);
      if (
        (input.recoveryBindingId && !intent.permissionTransition) ||
        command.method !== "thread/settings/update" ||
        intent.nativeSettingsOperationId !== input.nativeOperationId ||
        identity.threadId !== input.threadId ||
        identity.runtimeGeneration !== input.runtimeGeneration ||
        command.settingsApplication?.nativeOperationId !==
          input.nativeOperationId
      )
        throw new NativeCommandError(
          "native-settings-evidence-scope",
          "Settings evidence does not match a dispatched command.",
        );
      const record = {
        eventId: input.eventId,
        operationId: input.operationId,
        operationGeneration: input.operationGeneration,
        kind: input.kind,
        submissionId: input.submissionId,
        resultDigest: input.resultDigest,
        protectedResult: input.protectedResult,
        permissionPolicy: input.permissionPolicy ?? null,
        recoveryBindingId: input.recoveryBindingId ?? null,
      };
      const inserted = await tx
        .insert(schema.nativeSettingsEvidence)
        .values(record)
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) {
        const [existing] = await tx
          .select()
          .from(schema.nativeSettingsEvidence)
          .where(eq(schema.nativeSettingsEvidence.eventId, input.eventId));
        if (
          !existing ||
          !isDeepStrictEqual(
            { ...existing, createdAt: undefined },
            { ...record, createdAt: undefined },
          )
        )
          throw new NativeCommandError(
            "native-settings-evidence-conflict",
            "Settings evidence identity was reused with different content.",
          );
      }
      const facts = await tx
        .select({
          kind: schema.nativeSettingsEvidence.kind,
          submissionId: schema.nativeSettingsEvidence.submissionId,
          permissionPolicy: schema.nativeSettingsEvidence.permissionPolicy,
          recoveryBindingId: schema.nativeSettingsEvidence.recoveryBindingId,
        })
        .from(schema.nativeSettingsEvidence)
        .where(
          eq(schema.nativeSettingsEvidence.operationId, input.operationId),
        );
      const submissions = new Set(
        facts.flatMap((fact) => (fact.submissionId ? [fact.submissionId] : [])),
      );
      const applied = facts.some((fact) => fact.kind === "applied");
      const rejected = facts.some((fact) => fact.kind === "rejected");
      const claims = facts.flatMap((fact) =>
        fact.permissionPolicy ? [fact.permissionPolicy] : [],
      );
      // Recovery proves current application after a real native read. Its epoch
      // can differ from the original event; it does not rewrite that event.
      const originalClaims = facts.flatMap((fact) =>
        !fact.recoveryBindingId && fact.permissionPolicy
          ? [fact.permissionPolicy]
          : [],
      );
      const permissionConflict = Boolean(
        intent.permissionTransition &&
        applied &&
        (!claims.length ||
          claims.some(
            (claim) =>
              claim.effectiveId !== intent.permissionTransition!.effectiveId,
          ) ||
          originalClaims.some(
            (claim) => !isDeepStrictEqual(claim, originalClaims[0]),
          )),
      );
      const conflict =
        permissionConflict ||
        submissions.size > 1 ||
        (applied && rejected) ||
        facts.some((fact) => fact.kind === "correlation-conflict");
      const application: NativeSettingsApplication = {
        nativeOperationId: input.nativeOperationId,
        submissionId: submissions.size === 1 ? [...submissions][0]! : null,
        evidenceCount: facts.length,
        status: conflict
          ? "uncertain"
          : applied
            ? "applied"
            : rejected
              ? "rejected"
              : facts.some((fact) => fact.kind === "transport-lost")
                ? "uncertain"
                : "pending",
      };
      await tx
        .update(schema.nativeCommands)
        .set({ settingsApplication: application, updatedAt: new Date() })
        .where(eq(schema.nativeCommands.operationId, input.operationId));
      await settleNativeSettingsState(
        tx,
        command,
        application.status === "pending" ? "dispatched" : application.status,
      );
      let permissionPolicyPublished = false;
      if (
        application.status === "applied" &&
        intent.permissionTransition &&
        (input.recoveryBindingId ? input.permissionPolicy : originalClaims[0])
      ) {
        const context = await new ChatRuntimeContextRepository(tx, {
          getChatExecutionContext: async () => {
            throw new Error("Unexpected permission context recursion");
          },
        }).getChatExecutionContext(ownerId, command.chatId);
        const current = await new NativeSettingsStateRepository(tx).get(
          ownerId,
          command.chatId,
        );
        const transition = intent.permissionTransition;
        const previous = current?.permissionPolicy;
        const binding = current?.binding;
        const recovery = Boolean(input.recoveryBindingId);
        const claim = recovery ? input.permissionPolicy : originalClaims[0];
        if (
          recovery &&
          (!binding ||
            input.recoveryBindingId !== binding.bindingId ||
            !claim ||
            binding.nativeEpoch !== claim.settingsVersion.epoch ||
            binding.workerId !== command.workerId ||
            binding.threadId !== identity.threadId ||
            binding.contextKind !== identity.contextKind ||
            binding.projectId !== identity.projectId ||
            binding.placementId !== identity.placementId ||
            binding.modelRouteId !== identity.modelRouteId ||
            binding.providerAccountId !== identity.providerAccountId)
        )
          throw new NativeCommandError(
            "native-permission-recovery-binding",
            "Permission recovery does not match the current native source.",
          );
        const effectiveRuntime = recovery
          ? binding!.runtimeGeneration
          : identity.runtimeGeneration;
        // Historical evidence remains durable, but never changes another runtime,
        // account, placement or newer confirmed permission choice.
        const currentSource =
          context &&
          context.workerId === command.workerId &&
          context.threadId === identity.threadId &&
          context.projectId === identity.projectId &&
          context.contextKind === identity.contextKind &&
          (context.worktreeId ?? context.scratchRootId) ===
            identity.placementId &&
          context.modelRouteId === identity.modelRouteId &&
          context.providerAccountId === identity.providerAccountId &&
          binding &&
          binding.threadId === identity.threadId &&
          binding.runtimeGeneration === effectiveRuntime &&
          claim &&
          binding.nativeEpoch === claim.settingsVersion.epoch;
        const currentPolicy =
          transition.expectedRevision === (previous?.revision ?? "0");
        const sameOperation =
          previous?.operationId === command.operationId &&
          previous.operationGeneration === command.operationGeneration;
        const newerNative =
          !previous ||
          previous.settingsVersion.epoch !== claim!.settingsVersion.epoch ||
          BigInt(claim!.settingsVersion.revision) >=
            BigInt(previous.settingsVersion.revision);
        const permitted =
          !(
            context?.isPrimary &&
            context.worktreePolicy === "required-for-writes"
          ) || transition.effectiveId === ":read-only";
        permissionPolicyPublished = Boolean(
          currentSource &&
          sameOperation &&
          previous &&
          previous.source.runtimeGeneration === effectiveRuntime &&
          isDeepStrictEqual(previous.settingsVersion, claim!.settingsVersion),
        );
        if (
          currentSource &&
          (currentPolicy || sameOperation) &&
          !permissionPolicyPublished &&
          newerNative &&
          permitted
        ) {
          await changeNativeSettingsState(tx, command.chatId, (state) => ({
            ...state,
            revision: (BigInt(state.revision) + 1n).toString(),
            permissionPolicy: {
              selectedId: transition.selectedId,
              resolvedSelectedId: transition.resolvedSelectedId,
              effectiveId: transition.effectiveId,
              revision: sameOperation
                ? previous!.revision
                : (BigInt(previous?.revision ?? "0") + 1n).toString(),
              operationId: command.operationId,
              operationGeneration: command.operationGeneration,
              source: {
                workerId: command.workerId,
                threadId: identity.threadId!,
                runtimeGeneration: effectiveRuntime!,
                contextKind: identity.contextKind,
                projectId: identity.projectId,
                placementId: identity.placementId,
                modelRouteId: identity.modelRouteId,
                providerAccountId: identity.providerAccountId,
              },
              settingsVersion: claim!.settingsVersion,
            },
          }));
          permissionPolicyPublished = true;
          await tx
            .update(schema.chats)
            .set({
              permissionProfileId: transition.selectedId,
              updatedAt: new Date(),
            })
            .where(eq(schema.chats.id, command.chatId));
        }
      }
      return {
        operationId: input.operationId,
        operationGeneration: input.operationGeneration,
        eventId: input.eventId,
        application,
        permissionPolicyPublished,
      };
    });
  }
}
