import { z } from "zod";
import { endpointModelInventoryItemSchema } from "./endpoint-models.js";
import { ollamaModelInventoryItemSchema } from "./worker-runtime-support.js";

export const MODEL_CATALOG_MODEL_LIMIT = 50_000;
export const MODEL_CATALOG_BYTES_LIMIT = 32 * 1024 * 1024;
export const MODEL_CATALOG_PAGE_ITEMS = 200;
export const MODEL_CATALOG_PAGE_BYTES = 2 * 1024 * 1024;

/** Opt-in paging keeps older servers from interpreting a page as a full list. */
export const modelCatalogPageRequestSchema = z.object({
  transferId: z.uuid(),
  snapshotId: z.uuid().optional(),
  offset: z.number().int().min(0).max(MODEL_CATALOG_MODEL_LIMIT).default(0),
});
export type ModelCatalogPageRequest = z.infer<
  typeof modelCatalogPageRequestSchema
>;

const observation = { observedAt: z.string().datetime() };
const page = {
  ...observation,
  transferId: z.uuid(),
  snapshotId: z.uuid(),
  offset: z.number().int().min(0).max(MODEL_CATALOG_MODEL_LIMIT),
  nextOffset: z
    .number()
    .int()
    .positive()
    .max(MODEL_CATALOG_MODEL_LIMIT)
    .nullable(),
  total: z.number().int().min(0).max(MODEL_CATALOG_MODEL_LIMIT),
};
export const modelCatalogPageSchema = z.discriminatedUnion("kind", [
  z.object({
    ...page,
    kind: z.literal("endpoint"),
    models: z
      .array(endpointModelInventoryItemSchema)
      .max(MODEL_CATALOG_PAGE_ITEMS),
  }),
  z.object({
    ...page,
    kind: z.literal("ollama"),
    models: z
      .array(ollamaModelInventoryItemSchema)
      .max(MODEL_CATALOG_PAGE_ITEMS),
  }),
]);
export type ModelCatalogPage = z.infer<typeof modelCatalogPageSchema>;

/** Worker-local snapshot; the full value never crosses the control channel. */
export const modelCatalogSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({
    ...observation,
    kind: z.literal("endpoint"),
    models: z
      .array(endpointModelInventoryItemSchema)
      .max(MODEL_CATALOG_MODEL_LIMIT),
  }),
  z.object({
    ...observation,
    kind: z.literal("ollama"),
    models: z
      .array(ollamaModelInventoryItemSchema)
      .max(MODEL_CATALOG_MODEL_LIMIT),
  }),
]);
export type ModelCatalogSnapshot = z.infer<typeof modelCatalogSnapshotSchema>;
