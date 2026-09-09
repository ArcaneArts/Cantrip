import { z } from "zod";
import { modelProviderKindSchema } from "./providers.js";
import { workerRuntimeModelSchema } from "./worker-runtime-support.js";

const id = z.string().min(1).max(255);
export const nativeModelInventoryRequestSchema = z
  .object({
    workerId: id,
    providerId: id,
    providerAccountId: id.nullable(),
  })
  .strict();
export const nativeModelInventorySchema = z
  .object({
    workerId: id,
    providerId: id,
    providerAccountId: id.nullable(),
    providerKind: modelProviderKindSchema,
    models: z.array(workerRuntimeModelSchema),
  })
  .strict();
export type NativeModelInventory = z.infer<typeof nativeModelInventorySchema>;
export type NativeModelInventoryRequest = z.infer<
  typeof nativeModelInventoryRequestSchema
>;

/** Native names do not identify a different provider/account or resolve aliases.
 * Retain an exact current route when possible; otherwise report ambiguity. */
export function resolveNativeModelSelection(
  inventory: NativeModelInventory,
  nativeName: string,
  currentRouteId?: string | null,
):
  | { status: "resolved"; model: NativeModelInventory["models"][number] }
  | { status: "unmapped" }
  | { status: "ambiguous"; candidates: NativeModelInventory["models"] } {
  const candidates = inventory.models.filter(
    (model) => model.name === nativeName,
  );
  const current = currentRouteId
    ? candidates.find((model) => model.routeId === currentRouteId)
    : undefined;
  if (current) return { status: "resolved", model: current };
  if (candidates.length === 1)
    return { status: "resolved", model: candidates[0]! };
  return candidates.length
    ? { status: "ambiguous", candidates }
    : { status: "unmapped" };
}
