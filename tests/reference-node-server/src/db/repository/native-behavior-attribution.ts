import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import {
  emptyNativeBehaviorAttribution,
  mergeNativeBehaviorAttribution,
  summarizeNativeBehaviorAttribution,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import type { ModelBehaviorObservationInput } from "./telemetry.js";

type Route = {
  modelId: string | null;
  modelRouteId: string | null;
  providerId: string | null;
};
export async function resolveBehaviorAttribution(
  tx: RepositoryTransaction,
  ownerId: string,
  input: ModelBehaviorObservationInput,
  existing: typeof schema.modelBehaviorObservations.$inferSelect | undefined,
  anchor: Route | undefined,
) {
  if (!input.nativeAttribution && !existing?.nativeAttribution)
    return {
      route: anchor,
      reasoningEffort: input.reasoningEffort ?? null,
      turnId: input.turnId ?? null,
      signals: {} as Record<string, boolean>,
      evidence: undefined,
    };
  if (
    existing?.nativeAttribution &&
    ((input.workerId !== undefined && existing.workerId !== input.workerId) ||
      (input.providerAccountId !== undefined &&
        existing.providerAccountId !== input.providerAccountId))
  )
    throw new Error(
      "Native behavior observation belongs to another worker/account.",
    );
  if (
    existing?.nativeAttribution &&
    anchor &&
    existing.providerId &&
    anchor.providerId !== existing.providerId
  )
    throw new Error(
      "Native behavior source belongs to another session provider.",
    );
  const incoming = input.nativeAttribution ?? emptyNativeBehaviorAttribution();
  const evidence = mergeNativeBehaviorAttribution(existing?.nativeAttribution, {
    ...incoming,
    turnIds: [...incoming.turnIds, ...(input.turnId ? [input.turnId] : [])],
  });
  for (const capture of evidence.captures) {
    if (
      capture.selection.status === "resolved" &&
      (capture.selection.workerId !==
        (input.workerId === undefined ? existing?.workerId : input.workerId) ||
        capture.selection.providerAccountId !==
          (input.providerAccountId === undefined
            ? (existing?.providerAccountId ?? null)
            : input.providerAccountId))
    )
      throw new Error(
        "Native behavior capture belongs to another worker/account.",
      );
  }
  const summary = summarizeNativeBehaviorAttribution(evidence);
  let route: Route | undefined;
  // A catalog deletion cannot reassign captured statistics to bootstrap/defaults.
  if (
    existing?.nativeAttribution &&
    isDeepStrictEqual(existing.nativeAttribution, evidence)
  ) {
    route = {
      modelId: existing.modelId,
      modelRouteId: existing.modelRouteId,
      providerId: existing.providerId,
    };
  } else {
    const selections = evidence.captures.flatMap((capture) =>
      capture.selection.status === "resolved" ? [capture.selection] : [],
    );
    if (selections.length) {
      const routes = await tx
        .select({
          modelId: schema.modelRoutes.modelId,
          modelRouteId: schema.modelRoutes.id,
          providerId: schema.modelRoutes.providerId,
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
        .where(
          inArray(schema.modelRoutes.id, [
            ...new Set(selections.map((selection) => selection.routeId)),
          ]),
        );
      const valid = selections.every((selection) =>
        routes.some(
          (row) =>
            row.modelRouteId === selection.routeId &&
            row.modelId === selection.modelId &&
            row.providerId === selection.providerId &&
            anchor?.providerId === selection.providerId,
        ),
      );
      if (valid && summary.selection)
        route = routes.find(
          (row) => row.modelRouteId === summary.selection!.routeId,
        );
    }
  }
  return {
    route,
    evidence,
    turnId: summary.turnId,
    reasoningEffort: summary.reasoningEffort,
    signals: {
      nativeModelKnown: Boolean(route?.modelId),
      nativeReasoningKnown: summary.reasoningKnown,
    },
  };
}
