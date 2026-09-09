import { and, eq, inArray } from "drizzle-orm";
import type {
  NativeSettingsReadScope,
  ProtectedNativeSettingsSnapshot,
} from "@cantrip/protocol";
import type { RepositoryTransaction } from "./database.js";
import * as schema from "../schema.js";

/** Validate public route metadata against canonical ownership and the physical
 * session provider/account. A stale catalog must not discard real native state
 * or grant migration; omit only the unusable attribution. Ciphertext is untouched. */
export async function scopedNativeModelAttribution(
  tx: RepositoryTransaction,
  ownerId: string,
  scope: NativeSettingsReadScope,
  snapshot: ProtectedNativeSettingsSnapshot,
): Promise<ProtectedNativeSettingsSnapshot> {
  const selected = snapshot.modelAttribution?.selection;
  if (!selected || selected.status !== "resolved") return snapshot;
  const discard = () => {
    const { modelAttribution: _attribution, ...native } = snapshot;
    return native;
  };
  if (
    !scope.modelRouteId ||
    selected.workerId !== scope.workerId ||
    selected.providerAccountId !== scope.providerAccountId
  )
    return discard();
  const routes = await tx
    .select({
      routeId: schema.modelRoutes.id,
      modelId: schema.modelRoutes.modelId,
      providerId: schema.modelRoutes.providerId,
    })
    .from(schema.modelRoutes)
    .innerJoin(
      schema.modelProviders,
      eq(schema.modelProviders.id, schema.modelRoutes.providerId),
    )
    .where(
      and(
        eq(schema.modelProviders.ownerId, ownerId),
        inArray(schema.modelRoutes.id, [scope.modelRouteId, selected.routeId]),
      ),
    );
  const anchor = routes.find((route) => route.routeId === scope.modelRouteId);
  const model = routes.find((route) => route.routeId === selected.routeId);
  return anchor &&
    model &&
    anchor.providerId === selected.providerId &&
    model.providerId === selected.providerId &&
    model.modelId === selected.modelId
    ? snapshot
    : discard();
}
