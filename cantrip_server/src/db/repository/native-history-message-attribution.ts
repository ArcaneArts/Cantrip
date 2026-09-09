import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  nativeTurnModelAttributionSchema,
  type NativeHistoryBinding,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";

/** Called under the same chat lock/transaction as history ingestion. Retained
 * turn evidence owns labels; mutable chat settings and GUI bootstrap do not. */
export async function persistNativeHistoryMessageAttribution(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeHistoryBinding,
  turnIds: string[],
) {
  for (const turnId of new Set(turnIds)) {
    const [turn] = await tx
      .select()
      .from(schema.nativeHistoryTurns)
      .where(
        and(
          eq(schema.nativeHistoryTurns.bindingId, binding.id),
          eq(schema.nativeHistoryTurns.turnId, turnId),
        ),
      );
    const parsed = nativeTurnModelAttributionSchema.safeParse(
      turn?.capturedModelAttribution,
    );
    if (
      !parsed.success ||
      parsed.data.threadId !== binding.threadId ||
      parsed.data.turnId !== turnId
    )
      continue;
    const capture = parsed.data;
    const selected = capture.selection;
    let labels: {
      modelId: string | null;
      modelRouteId: string | null;
      providerId: string | null;
      providerName: string | null;
      providerModelName: string | null;
    } = {
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
    };
    if (
      selected.status === "resolved" &&
      selected.workerId === binding.workerId &&
      selected.providerAccountId === binding.providerAccountId
    ) {
      const routes = await tx
        .select({
          modelId: schema.modelRoutes.modelId,
          modelRouteId: schema.modelRoutes.id,
          providerId: schema.modelProviders.id,
          providerName: schema.modelProviders.name,
          providerModelName: schema.modelRoutes.modelName,
        })
        .from(schema.modelRoutes)
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
        )
        .innerJoin(
          schema.modelProfiles,
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
        )
        .where(
          and(
            eq(schema.modelProviders.ownerId, ownerId),
            eq(schema.modelProfiles.ownerId, ownerId),
            inArray(schema.modelRoutes.id, [
              selected.routeId,
              binding.modelRouteId ?? "",
            ]),
          ),
        );
      const route = routes.find(
        (row) =>
          row.modelRouteId === selected.routeId &&
          row.modelId === selected.modelId &&
          row.providerId === selected.providerId,
      );
      if (
        route &&
        routes.some(
          (row) =>
            row.modelRouteId === binding.modelRouteId &&
            row.providerId === selected.providerId,
        )
      )
        labels = route;
    }
    // A missing catalog cannot block history, or turn unknown historical model
    // selection into today's defaults. Already captured message labels survive.
    await tx
      .update(schema.chatMessages)
      .set({
        ...labels,
        nativeModelAttribution: capture,
        appliedReasoningEffort: capture.reasoningEffort,
        reasoningAdjusted: sql`${schema.chatMessages.reasoningEffort} IS NOT NULL AND ${schema.chatMessages.reasoningEffort} IS DISTINCT FROM ${capture.reasoningEffort}`,
      })
      .where(
        and(
          eq(schema.chatMessages.chatId, binding.chatId),
          isNull(schema.chatMessages.nativeModelAttribution),
          inArray(
            schema.chatMessages.id,
            tx
              .select({ id: schema.nativeHistoryItems.messageId })
              .from(schema.nativeHistoryItems)
              .where(
                and(
                  eq(schema.nativeHistoryItems.chatId, binding.chatId),
                  eq(schema.nativeHistoryItems.threadId, binding.threadId),
                  eq(schema.nativeHistoryItems.turnId, turnId),
                  gt(schema.nativeHistoryItems.revision, 0),
                ),
              ),
          ),
        ),
      );
  }
}
