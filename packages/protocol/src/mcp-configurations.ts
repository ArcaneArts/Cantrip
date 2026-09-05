import { z } from "zod";

import { resourceAudienceSchema } from "./audiences.js";
import { encryptionKeyBytesSchema } from "./encryption.js";
import {
  mcpServerOpaqueRuntimeSchema,
  protectedSecretEnvelopeSchema,
} from "./protected-secrets.js";

const mcpKeyValueSchema = z
  .record(z.string().trim().min(1).max(256), z.string().max(65_536))
  .refine((value) => Object.keys(value).length <= 100, {
    message: "MCP key/value collections cannot contain more than 100 entries.",
  })
  .refine(
    (value) =>
      Object.entries(value).reduce(
        (size, [key, item]) => size + key.length + item.length,
        0,
      ) <= 524_288,
    {
      message: "MCP key/value collections cannot exceed 512 KiB.",
    },
  );

/**
 * Placeholder returned for persisted MCP values that may contain credentials.
 * Sending the placeholder back during an update preserves the existing value;
 * Cantrip never sends the underlying secret to an application client.
 */
export const MCP_SECRET_MASK = "••••••••";

/**
 * Reserved for the worker-synthesized CodeGraph MCP. This is intentionally a
 * protocol-level invariant so old clients cannot create a user server that
 * shadows the managed runtime through a server API.
 */
export const MANAGED_CODEGRAPH_MCP_NAME = "codegraph" as const;
export const MANAGED_CANTRIP_MCP_NAME = "cantrip" as const;
export const MANAGED_CUA_MCP_NAME = "cantrip_cua" as const;

export function isManagedCodeGraphMcpName(name: string): boolean {
  return name.trim().toLowerCase() === MANAGED_CODEGRAPH_MCP_NAME;
}

export function isManagedCantripMcpName(name: string): boolean {
  return name.trim().toLowerCase() === MANAGED_CANTRIP_MCP_NAME;
}

export function isManagedMcpName(name: string): boolean {
  return (
    isManagedCodeGraphMcpName(name) ||
    isManagedCantripMcpName(name) ||
    name.trim().toLowerCase() === MANAGED_CUA_MCP_NAME
  );
}

export const mcpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/u, {
    message: "Use only letters, numbers, hyphens, and underscores.",
  });

const mcpServerSharedSchema = z.object({
  name: mcpServerNameSchema,
  enabled: z.boolean().default(true),
});

export const mcpServerStdioConfigurationSchema = mcpServerSharedSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(8_192),
  args: z.array(z.string().max(8_192)).max(100).default([]),
  environment: mcpKeyValueSchema.default({}),
});

export const mcpServerHttpConfigurationSchema = mcpServerSharedSchema.extend({
  transport: z.literal("http"),
  url: z.url().max(8_192),
  bearerTokenEnvironmentVariable: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .nullable()
    .default(null),
  headers: mcpKeyValueSchema.default({}),
  environmentHeaders: mcpKeyValueSchema.default({}),
});

export const mcpServerConfigurationSchema = z.discriminatedUnion("transport", [
  mcpServerStdioConfigurationSchema,
  mcpServerHttpConfigurationSchema,
]);

export const encryptedMcpServerCreateSchema = z
  .object({
    id: z.string().uuid(),
    audience: resourceAudienceSchema.default("ide"),
    enabled: z.boolean(),
    workerId: z.string().min(1).max(255).nullable().default(null),
    nameBlindIndex: encryptionKeyBytesSchema,
    protectedConfiguration: protectedSecretEnvelopeSchema,
  })
  .strict();

export const encryptedMcpServerUpdateSchema = encryptedMcpServerCreateSchema
  .omit({ id: true, audience: true })
  .extend({ audience: resourceAudienceSchema.optional() })
  .strict();

export const mcpServerDiscoverySourceSchema = z.enum([
  "codex",
  "claude",
  "localhost",
]);
export const mcpServerDiscoveryScopeSchema = z.enum(["user", "project"]);

export const mcpServerDiscoveryCandidateSchema = z
  .object({
    source: mcpServerDiscoverySourceSchema,
    sourceScope: mcpServerDiscoveryScopeSchema,
    configuration: encryptedMcpServerCreateSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (!candidate.configuration.workerId) {
      context.addIssue({
        code: "custom",
        message: "Discovered MCP servers must be bound to their worker.",
        path: ["configuration", "workerId"],
      });
    }
  });

export const mcpServerDiscoveryIssueSchema = z
  .object({
    source: mcpServerDiscoverySourceSchema,
    sourceScope: mcpServerDiscoveryScopeSchema,
    code: z.enum(["invalid-config", "unsupported-transport"]),
    message: z.string().min(1).max(500),
  })
  .strict();

export const mcpServerDiscoveryResultSchema = z
  .object({
    workerId: z.string().min(1).max(255),
    observedAt: z.string().datetime(),
    candidates: z.array(mcpServerDiscoveryCandidateSchema).max(200),
    issues: z.array(mcpServerDiscoveryIssueSchema).max(200),
  })
  .strict();

export const mcpServerScopeSchema = z.enum(["global", "project"]);

export const mcpServerSummarySchema = mcpServerConfigurationSchema.and(
  z.object({
    id: z.string().min(1),
    audience: resourceAudienceSchema.default("ide"),
    scope: mcpServerScopeSchema,
    projectId: z.string().min(1).nullable(),
    workerId: z.string().min(1).max(255).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

export const mcpServerListSchema = z.array(mcpServerSummarySchema).max(200);

export const mcpServerWireSummarySchema = mcpServerOpaqueRuntimeSchema.and(
  z.object({
    audience: resourceAudienceSchema.default("ide"),
    scope: mcpServerScopeSchema,
    projectId: z.string().min(1).nullable(),
    workerId: z.string().min(1).max(255).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

export const mcpServerWireListSchema = z
  .array(mcpServerWireSummarySchema)
  .max(200);

export const mcpServerCopySchema = z.object({
  sourceProjectId: z.string().min(1),
  sourceServerId: z.string().min(1),
});

export type McpServerConfiguration = z.infer<
  typeof mcpServerConfigurationSchema
>;

export type McpServerScope = z.infer<typeof mcpServerScopeSchema>;

export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>;

export type EncryptedMcpServerCreate = z.infer<
  typeof encryptedMcpServerCreateSchema
>;

export type EncryptedMcpServerUpdate = z.infer<
  typeof encryptedMcpServerUpdateSchema
>;

export type McpServerDiscoverySource = z.infer<
  typeof mcpServerDiscoverySourceSchema
>;

export type McpServerDiscoveryScope = z.infer<
  typeof mcpServerDiscoveryScopeSchema
>;

export type McpServerDiscoveryCandidate = z.infer<
  typeof mcpServerDiscoveryCandidateSchema
>;

export type McpServerDiscoveryIssue = z.infer<
  typeof mcpServerDiscoveryIssueSchema
>;

export type McpServerDiscoveryResult = z.infer<
  typeof mcpServerDiscoveryResultSchema
>;

export type McpServerWireSummary = z.infer<typeof mcpServerWireSummarySchema>;

export type McpServerCopy = z.infer<typeof mcpServerCopySchema>;
