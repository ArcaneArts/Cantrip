import { z } from "zod";

import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";

const id = z.string().min(1).max(255);
const section = z.enum(["projects", "chats", "tasks"]);
const page = {
  cursor: z.number().int().nonnegative().max(100_000).default(0),
  limit: z.number().int().min(1).max(100).default(25),
};

export const councilInventoryInputSchema = z.discriminatedUnion("section", [
  z.object({ ...page, section: z.literal("projects") }).strict(),
  z.object({ ...page, section: z.literal("chats"), projectId: id }).strict(),
  z.object({ ...page, section: z.literal("tasks"), projectId: id }).strict(),
]);

const entry = z
  .object({
    id,
    kind: z.enum(["project", "chat", "task"]),
    projectId: id,
    workerId: id.nullable(),
    status: z.string().min(1).max(64).nullable(),
    permissionProfileId: id.nullable(),
  })
  .strict();

const result = z
  .object({
    section,
    nextCursor: z.number().int().positive().safe().nullable(),
  })
  .strict();

export const councilInventoryWireSchema = result.extend({
  entries: z
    .array(entry.extend({ titleProtection: privateDisplayLabelOpaqueSchema }))
    .max(100),
});

export const councilInventoryResultSchema = result.extend({
  entries: z
    .array(entry.extend({ title: z.string().min(1).max(1000).nullable() }))
    .max(100),
});

export const councilInventoryToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    data: councilInventoryResultSchema,
  });
