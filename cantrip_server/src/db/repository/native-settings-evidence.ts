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
      const conflict =
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
      return {
        operationId: input.operationId,
        operationGeneration: input.operationGeneration,
        eventId: input.eventId,
        application,
      };
    });
  }
}
