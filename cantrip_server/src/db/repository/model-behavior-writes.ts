import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import type { ModelBehaviorObservationInput } from "./telemetry.js";
import { resolveBehaviorAttribution } from "./native-behavior-attribution.js";

/** Atomic source-scoped aggregation; never holds a lock during native execution. */
export async function persistModelBehaviorObservation(
  database: RepositoryDatabase,
  ownerId: string,
  input: ModelBehaviorObservationInput,
) {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["model-behavior", ownerId, input.sourceKey])}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(schema.modelBehaviorObservations)
      .where(
        and(
          eq(schema.modelBehaviorObservations.ownerId, ownerId),
          eq(schema.modelBehaviorObservations.sourceKey, input.sourceKey),
        ),
      );
    if (
      existing &&
      (existing.chatId !== input.chatId ||
        existing.projectId !== input.projectId ||
        existing.executionAttemptId !== input.executionAttemptId)
    )
      throw new Error("Model behavior source belongs to a different attempt.");
    if (input.chatId) {
      const [chat] = await tx
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        );
      if (!chat)
        throw new Error("Model behavior chat is not owned by this account.");
    }
    const routeRows = await tx
      .select({
        modelId: schema.modelProfiles.id,
        modelRouteId: schema.modelRoutes.id,
        providerId: schema.modelProviders.id,
      })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        and(
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(eq(schema.modelRoutes.id, input.modelRouteId))
      .limit(1);
    const anchor = routeRows[0];
    const attribution = await resolveBehaviorAttribution(
      tx,
      ownerId,
      input,
      existing,
      anchor,
    );
    const route = attribution.route;
    const count = (value: number | undefined): number =>
      Math.max(0, Math.round(value ?? 0));
    const nullableCount = (value: number | null | undefined): number | null =>
      typeof value === "number" ? count(value) : null;
    const contextUsedPercentBasisPoints =
      typeof input.contextUsedPercent === "number"
        ? Math.max(0, Math.round(input.contextUsedPercent * 100))
        : null;
    const updatedAt = new Date();
    const values = {
      projectId: input.projectId,
      chatId: input.chatId,
      modelId: route?.modelId ?? null,
      modelRouteId: route?.modelRouteId ?? null,
      providerId: anchor?.providerId ?? existing?.providerId ?? null,
      providerAccountId:
        input.providerAccountId === undefined
          ? (existing?.providerAccountId ?? null)
          : input.providerAccountId,
      workerId:
        input.workerId === undefined
          ? (existing?.workerId ?? null)
          : input.workerId,
      turnId: attribution.turnId,
      executionAttemptId: input.executionAttemptId,
      attemptKind: input.attemptKind ?? "chat-turn",
      attemptStatus: input.attemptStatus,
      reasoningEffort: attribution.reasoningEffort,
      nativeAttribution: attribution.evidence ?? null,
      routeAttemptIndex: count(input.routeAttemptIndex),
      retryFailoverCount: count(input.retryFailoverCount),
      firstActivityAt: input.firstActivityAt ?? null,
      firstVisibleResponseAt: input.firstVisibleResponseAt ?? null,
      completedAt: input.completedAt ?? null,
      finalizedAt: input.finalizedAt ?? null,
      durationMs: nullableCount(input.durationMs),
      finalAnswerAppeared: input.finalAnswerAppeared ?? false,
      toolCallCount: count(input.toolCallCount),
      invalidToolCallCount: count(input.invalidToolCallCount),
      compactionCount: count(input.compactionCount),
      approvalRequestCount: count(input.approvalRequestCount),
      inputTokens: count(input.inputTokens),
      cachedInputTokens: count(input.cachedInputTokens),
      cacheWriteInputTokens: count(input.cacheWriteInputTokens),
      outputTokens: count(input.outputTokens),
      reasoningOutputTokens: count(input.reasoningOutputTokens),
      modelContextWindow: nullableCount(input.modelContextWindow),
      contextUsedPercentBasisPoints,
      filesChangedCount: count(input.filesChangedCount),
      testCommandCount: count(input.testCommandCount),
      testPassCount: count(input.testPassCount),
      testFailureCount: count(input.testFailureCount),
      userInterrupted: input.userInterrupted ?? false,
      userRetryRegeneration: input.userRetryRegeneration ?? null,
      immediateCorrectiveFollowup: input.immediateCorrectiveFollowup ?? false,
      workerVersion: input.workerVersion ?? null,
      serverVersion: input.serverVersion ?? null,
      codexVersion: input.codexVersion ?? null,
      signalAvailability: {
        ...(existing?.signalAvailability ?? {}),
        ...(input.signalAvailability ?? {}),
        ...attribution.signals,
      },
      updatedAt,
    };
    // A delayed running snapshot may fill attribution gaps but cannot reopen or
    // erase the measurements of an already finalized logical attempt.
    if (
      existing?.nativeAttribution &&
      existing.attemptStatus !== "running" &&
      input.attemptStatus === "running"
    ) {
      const attributionFields = new Set([
        "modelId",
        "modelRouteId",
        "providerId",
        "reasoningEffort",
        "nativeAttribution",
        "turnId",
        "signalAvailability",
        "updatedAt",
      ]);
      for (const key of Object.keys(values)) {
        if (!attributionFields.has(key))
          Object.assign(values, {
            [key]: existing[key as keyof typeof existing],
          });
      }
    }
    await tx
      .insert(schema.modelBehaviorObservations)
      .values({
        id: randomUUID(),
        ownerId,
        sourceKey: input.sourceKey,
        startedAt: input.startedAt ?? updatedAt,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          schema.modelBehaviorObservations.ownerId,
          schema.modelBehaviorObservations.sourceKey,
        ],
        set: values,
      });
  });
}
