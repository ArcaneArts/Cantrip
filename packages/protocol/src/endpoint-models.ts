import { z } from "zod";
import { providerModelCatalogEntrySchema } from "./providers.js";

/** Only normalized model metadata crosses the worker control channel. */
export const endpointModelInventoryItemSchema = providerModelCatalogEntrySchema
  .omit({
    id: true,
    providerId: true,
    canonicalModelId: true,
    matchConfidence: true,
    hidden: true,
    isDefault: true,
    createdAt: true,
    updatedAt: true,
    lastSeenAt: true,
  })
  .extend({
    metadataSource: z.literal("compatible-api"),
    loaded: z.boolean().nullable(),
  });

export const endpointModelInventorySchema = z.object({
  models: z.array(endpointModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
});

export type EndpointModelInventory = z.infer<
  typeof endpointModelInventorySchema
>;
export type EndpointModelInventoryItem = z.infer<
  typeof endpointModelInventoryItemSchema
>;
