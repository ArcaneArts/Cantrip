import {
  resolveNativeModelSelection,
  type NativeModelAttribution,
  type NativeModelInventory,
  type NativeSettingsReadScope,
} from "@cantrip/protocol";

/** Resolve only within the runtime's already-selected provider/account catalog.
 * This never performs discovery or blocks an actual native operation. */
export function nativeModelAttribution(
  scope: Pick<
    NativeSettingsReadScope,
    "workerId" | "modelRouteId" | "providerAccountId"
  >,
  nativeName: string,
  inventory: NativeModelInventory | null | undefined,
): NativeModelAttribution {
  if (
    !inventory ||
    inventory.workerId !== scope.workerId ||
    inventory.providerAccountId !== scope.providerAccountId
  )
    return { status: "unavailable" };
  const result = resolveNativeModelSelection(
    inventory,
    nativeName,
    scope.modelRouteId,
  );
  if (result.status !== "resolved") return { status: result.status };
  return {
    status: "resolved",
    workerId: inventory.workerId,
    providerId: inventory.providerId,
    providerAccountId: inventory.providerAccountId,
    modelId: result.model.id,
    routeId: result.model.routeId,
  };
}
