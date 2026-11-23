import { and, eq, inArray } from "drizzle-orm";
import type {
  NativeHistoryBinding,
  NativeHistoryTurn,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { TelemetryRepository } from "./telemetry.js";

/** Part of canonical ingestion: usage and encrypted history share commit/rollback.
 * Catalog loss may remove usable attribution; it must not discard native history. */
export async function persistNativeHistoryUsage(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeHistoryBinding,
  turn: NativeHistoryTurn,
) {
  if (!turn.usage) return;
  const rawCapture = turn.usage.modelAttribution;
  let capture = rawCapture;
  if (
    capture &&
    (capture.threadId !== turn.threadId || capture.turnId !== turn.turnId)
  )
    throw new Error(
      "Native history usage attribution belongs to another turn.",
    );
  if (capture?.selection.status === "resolved") {
    const selected = capture.selection;
    const routes = await tx
      .select({
        id: schema.modelRoutes.id,
        modelId: schema.modelRoutes.modelId,
        providerId: schema.modelRoutes.providerId,
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
    if (
      selected.workerId !== binding.workerId ||
      selected.providerAccountId !== binding.providerAccountId ||
      !routes.some(
        (route) =>
          route.id === selected.routeId &&
          route.modelId === selected.modelId &&
          route.providerId === selected.providerId,
      ) ||
      !routes.some(
        (route) =>
          route.id === binding.modelRouteId &&
          route.providerId === selected.providerId,
      )
    )
      capture = undefined;
  }
  await new TelemetryRepository(tx).recordTokenUsage(ownerId, {
    sourceKey: `native-turn:${JSON.stringify([binding.chatId, turn.threadId, turn.turnId])}`,
    projectId: binding.projectId,
    chatId: binding.chatId,
    // No capture means unknown model, not today's binding/default model.
    modelRouteId: capture ? (binding.modelRouteId ?? "") : "",
    nativeTurn: { threadId: turn.threadId, turnId: turn.turnId },
    nativeModelAttribution: capture,
    nativeUsage: turn.usage,
    workerId: binding.workerId,
    providerAccountId: binding.providerAccountId,
    turnId: turn.turnId,
    attemptStatus: turn.status === "inProgress" ? "running" : turn.status,
    startedAt: turn.startedAtMs === null ? null : new Date(turn.startedAtMs),
    completedAt:
      turn.completedAtMs === null ? null : new Date(turn.completedAtMs),
    finalizedAt:
      turn.completedAtMs === null ? null : new Date(turn.completedAtMs),
  });
}
