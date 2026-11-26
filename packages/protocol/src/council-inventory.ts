import { z } from "zod";

import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import { protectedSecretEnvelopeSchema } from "./protected-secrets.js";
import { encryptedPolicySummaryContentSchema } from "./policies.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";

const id = z.string().min(1).max(255);
const accountSections = [
  "projects",
  "agents",
  "settings",
  "models",
  "policies",
  "tools",
] as const;
const section = z.enum([...accountSections, "chats", "tasks"]);
const page = {
  cursor: z.number().int().nonnegative().max(100_000).default(0),
  limit: z.number().int().min(1).max(100).default(25),
};

export const councilInventoryInputSchema = z.discriminatedUnion("section", [
  z.object({ ...page, section: z.enum(accountSections) }).strict(),
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

const title = z.string().min(1).max(1000).nullable();
const agent = z
  .object({
    id,
    kind: z.literal("agent"),
    workerId: id,
    primary: z.boolean(),
    status: z.string().min(1).max(64),
  })
  .strict();
const setting = z
  .object({
    id,
    kind: z.literal("setting"),
    title,
    value: id.nullable(),
  })
  .strict();
const model = z
  .object({
    id,
    kind: z.literal("model"),
    title,
    enabledRoutes: z.number().int().nonnegative(),
  })
  .strict();
const policy = z.object({ id, kind: z.literal("policy") }).strict();
const tool = z.object({ id, kind: z.literal("mcp-server") }).strict();

export const councilInventoryWireSchema = result.extend({
  entries: z
    .array(
      z.discriminatedUnion("kind", [
        entry.extend({ titleProtection: privateDisplayLabelOpaqueSchema }),
        agent.extend({ titleProtection: privateDisplayLabelOpaqueSchema }),
        setting,
        model,
        policy.extend({
          protectedSummary: encryptedPolicySummaryContentSchema,
        }),
        tool.extend({
          enabled: z.literal(true),
          protectedConfiguration: protectedSecretEnvelopeSchema,
        }),
      ]),
    )
    .max(100),
});

export const councilInventoryResultSchema = result.extend({
  entries: z
    .array(
      z.discriminatedUnion("kind", [
        entry.extend({ title }),
        agent.extend({ title }),
        setting,
        model,
        policy.extend({ title, key: id.nullable() }),
        tool.extend({ title, transport: z.enum(["stdio", "http"]).nullable() }),
      ]),
    )
    .max(100),
  managedTools: z.array(id).max(100).optional(),
});

export const councilInventoryToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    data: councilInventoryResultSchema,
  });
