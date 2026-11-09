import { randomUUID } from "node:crypto";
import {
  modelOperationUsageConsistent,
  modelOperationUsageEvidenceSchema,
  modelOperationUsageIdentitySchema,
  modelOperationUsageSchema,
  type ModelOperationUsage,
  type ModelOperationUsageEvidence,
  type ModelOperationUsageIdentity,
} from "@cantrip/protocol";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";

export interface ModelOperationUsageWrite {
  identity: ModelOperationUsageIdentity;
  transportStatus: ModelOperationUsageEvidence["transportStatus"];
  receipt?: ModelOperationUsage;
}
export const observedTokenTotalSql = sql<number>`case
  when jsonb_typeof(${schema.tokenUsageRecords.modelOperationUsage}->'receipt') = 'object'
  then coalesce((${schema.tokenUsageRecords.modelOperationUsage}->'receipt'->>'observedTotalTokens')::bigint, 0)
  else ${schema.tokenUsageRecords.inputTokens} + ${schema.tokenUsageRecords.outputTokens}
end`;
// A missing worker receipt has no known inference start. Include its server
// observation in telemetry ranges without inventing an actual start time.
export const modelOperationObservedAtSql = sql<Date>`case
  when ${schema.tokenUsageRecords.modelOperationUsage} is not null
  then coalesce(${schema.tokenUsageRecords.startedAt}, ${schema.tokenUsageRecords.finalizedAt}, ${schema.tokenUsageRecords.updatedAt})
  else ${schema.tokenUsageRecords.startedAt}
end`;

/** Independent operation identity, not a synthetic chat or native-turn alias. */
export async function persistModelOperationUsage(
  database: RepositoryDatabase,
  ownerId: string,
  input: ModelOperationUsageWrite,
) {
  const identity = modelOperationUsageIdentitySchema.parse(input.identity);
  const receipt = input.receipt
    ? modelOperationUsageSchema.parse(input.receipt)
    : null;
  if (
    receipt &&
    (!modelOperationUsageConsistent(receipt) ||
      ["operation", "modelId", "routeId", "providerId"].some(
        (field) =>
          receipt[field as keyof ModelOperationUsage] !==
          identity[field as keyof ModelOperationUsageIdentity],
      ))
  )
    throw new Error(
      "Model operation usage belongs to another dispatch or has invalid counts.",
    );
  const evidence = modelOperationUsageEvidenceSchema.parse({
    identity,
    receipt,
    transportStatus: input.transportStatus,
  });
  const sourceKey = `model-operation:${JSON.stringify([identity.serverId, identity.workerId, identity.operationId])}`;
  await database.transaction(async (tx) => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, ownerId))
      .for("key share");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["model-operation-usage", ownerId, sourceKey])}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(schema.tokenUsageRecords)
      .where(
        and(
          eq(schema.tokenUsageRecords.ownerId, ownerId),
          eq(schema.tokenUsageRecords.sourceKey, sourceKey),
        ),
      );
    if (existing) {
      const previous = existing.modelOperationUsage;
      if (
        existing.chatId !== null ||
        existing.projectId !== null ||
        !previous ||
        Object.keys(identity).some(
          (key) =>
            previous.identity[key as keyof ModelOperationUsageIdentity] !==
            identity[key as keyof ModelOperationUsageIdentity],
        )
      )
        throw new Error(
          "Model operation usage identity conflicts with its retained dispatch.",
        );
      // A valid terminal receipt is immutable. Late bootstrap, disconnect and
      // replay rejection cannot erase it or count an operation a second time.
      if (
        previous.receipt ||
        (previous.transportStatus !== "running" &&
          input.transportStatus === "running")
      )
        return;
    }
    const [model] = await tx
      .select({ id: schema.modelProfiles.id })
      .from(schema.modelProfiles)
      .where(
        and(
          eq(schema.modelProfiles.id, identity.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .for("key share");
    const [provider] = await tx
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, identity.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .for("key share");
    const [route] = await tx
      .select({ id: schema.modelRoutes.id })
      .from(schema.modelRoutes)
      .where(
        and(
          eq(schema.modelRoutes.id, identity.routeId),
          eq(schema.modelRoutes.modelId, identity.modelId),
          eq(schema.modelRoutes.providerId, identity.providerId),
        ),
      )
      .for("key share");
    const metrics = receipt?.metrics;
    const total = metrics?.totalTokens;
    const values = {
      modelOperationUsage: evidence,
      modelId: model?.id ?? null,
      providerId: provider?.id ?? null,
      modelRouteId: model && provider ? (route?.id ?? null) : null,
      providerAccountId: null,
      workerId: identity.workerId,
      turnId: null,
      executionAttemptId: identity.operationId,
      attemptKind: identity.operation,
      attemptStatus:
        receipt?.status ??
        (input.transportStatus === "running" ? "running" : "unknown"),
      reasoningEffort: null,
      workerVersion: receipt?.workerVersion ?? null,
      inputTokens: metrics?.inputTokens.observed ?? 0,
      outputTokens: metrics?.outputTokens.observed ?? 0,
      cachedInputTokens: metrics?.cachedInputTokens.observed ?? 0,
      cacheWriteInputTokens: metrics?.cacheWriteInputTokens.observed ?? 0,
      reasoningOutputTokens: metrics?.reasoningOutputTokens.observed ?? 0,
      reportedTotalTokens:
        total && total.reportedRequests === receipt?.requests
          ? total.observed
          : null,
      usageSemantics: receipt
        ? "model-operation-observed-v1"
        : "model-operation-unknown-v1",
      startedAt: receipt?.startedAt ? new Date(receipt.startedAt) : null,
      completedAt: receipt ? new Date(receipt.completedAt) : null,
      finalizedAt: input.transportStatus === "running" ? null : new Date(),
      updatedAt: new Date(),
    };
    await tx
      .insert(schema.tokenUsageRecords)
      .values({
        id: randomUUID(),
        ownerId,
        sourceKey,
        projectId: null,
        chatId: null,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          schema.tokenUsageRecords.ownerId,
          schema.tokenUsageRecords.sourceKey,
        ],
        set: values,
      });
  });
}
