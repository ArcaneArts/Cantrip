import { z } from "zod";

import { resourceAudienceSchema } from "./audiences.js";
import { encryptionKeyBytesSchema } from "./encryption.js";
import { NATIVE_SUBAGENT_PROTOCOL_VERSION } from "./runtime-capabilities.js";

export const skillSummarySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  displayName: z.string().min(1).nullable(),
});

export const skillListSchema = z.array(skillSummarySchema);

export const customizationCapabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().min(1).nullable(),
  stability: z.enum(["stable", "experimental", "unsupported"]),
});

export const nativeSubagentCustomizationCapabilitySchema =
  customizationCapabilitySchema.extend({
    protocolVersion: z.literal(NATIVE_SUBAGENT_PROTOCOL_VERSION).nullable(),
  });

export const codexCustomizationCapabilitiesSchema = z.object({
  isolatedCodexHome: z.literal(true),
  collaborationModes: customizationCapabilitySchema,
  threadGoals: customizationCapabilitySchema,
  nativeSubagents: nativeSubagentCustomizationCapabilitySchema,
  customAgents: customizationCapabilitySchema,
  hooks: customizationCapabilitySchema,
  skills: z.object({
    list: customizationCapabilitySchema,
    configure: customizationCapabilitySchema,
    extraRoots: customizationCapabilitySchema,
  }),
  mcp: z.object({
    status: customizationCapabilitySchema,
    resourceRead: customizationCapabilitySchema,
    oauth: customizationCapabilitySchema,
    reload: customizationCapabilitySchema,
  }),
  plugins: z.object({
    list: customizationCapabilitySchema,
    read: customizationCapabilitySchema,
    install: customizationCapabilitySchema,
    uninstall: customizationCapabilitySchema,
  }),
  externalImports: z.object({
    detect: customizationCapabilitySchema,
    apply: customizationCapabilitySchema,
  }),
});

export const codexSkillInventoryItemSchema = skillSummarySchema.extend({
  path: z.string().min(1),
  scope: z.enum(["user", "repo", "system", "admin"]),
  enabled: z.boolean(),
});

export const codexInventoryErrorSchema = z.object({
  path: z.string(),
  message: z.string().min(1),
});

export const codexHookInventoryItemSchema = z.object({
  key: z.string().min(1),
  eventName: z.enum([
    "preToolUse",
    "permissionRequest",
    "postToolUse",
    "preCompact",
    "postCompact",
    "sessionStart",
    "sessionEnd",
    "userPromptSubmit",
    "subagentStart",
    "subagentStop",
    "stop",
  ]),
  handlerType: z.enum(["command", "prompt", "agent"]),
  matcher: z.string().nullable(),
  command: z.string().nullable(),
  timeoutSeconds: z.number().int().nonnegative(),
  statusMessage: z.string().nullable(),
  sourcePath: z.string().min(1),
  source: z.enum([
    "system",
    "user",
    "project",
    "mdm",
    "sessionFlags",
    "plugin",
    "cloudRequirements",
    "cloudManagedConfig",
    "legacyManagedConfigFile",
    "legacyManagedConfigMdm",
    "unknown",
  ]),
  pluginId: z.string().nullable(),
  enabled: z.boolean(),
  managed: z.boolean(),
  trust: z.enum(["managed", "untrusted", "trusted", "modified"]),
});

export const codexMcpToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().nullable(),
});

export const codexMcpResourceSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
});

export const codexMcpResourceTemplateSchema = z.object({
  uriTemplate: z.string().min(1),
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string().nullable(),
});

export const codexMcpServerSchema = z.object({
  name: z.string().min(1),
  serverInfo: z
    .object({
      name: z.string().min(1),
      title: z.string().nullable(),
      version: z.string(),
      description: z.string().nullable(),
      websiteUrl: z.string().nullable(),
    })
    .nullable(),
  authStatus: z.enum(["unsupported", "notLoggedIn", "bearerToken", "oAuth"]),
  tools: z.array(codexMcpToolSchema),
  resources: z.array(codexMcpResourceSchema),
  resourceTemplates: z.array(codexMcpResourceTemplateSchema),
});

export const codexCustomizationInventorySchema = z.object({
  capabilities: codexCustomizationCapabilitiesSchema,
  skills: z.object({
    items: z.array(codexSkillInventoryItemSchema),
    errors: z.array(codexInventoryErrorSchema),
  }),
  skillRoots: z.array(z.string().min(1).max(8_192)).max(32).default([]),
  hooks: z.object({
    items: z.array(codexHookInventoryItemSchema),
    warnings: z.array(z.string()),
    errors: z.array(codexInventoryErrorSchema),
  }),
  mcpServers: z.array(codexMcpServerSchema),
});

export const codexExternalImportItemTypeSchema = z.enum([
  "AGENTS_MD",
  "CONFIG",
  "SKILLS",
  "PLUGINS",
  "MCP_SERVER_CONFIG",
  "SUBAGENTS",
  "HOOKS",
  "COMMANDS",
  "MEMORY",
  "SESSIONS",
]);

export const codexExternalImportPreviewItemSchema = z.object({
  id: z.string().min(1),
  itemType: codexExternalImportItemTypeSchema,
  description: z.string(),
  cwd: z.string().nullable(),
  details: z
    .object({
      pluginNames: z.array(z.string().min(1)),
      skillNames: z.array(z.string().min(1)),
      sessionCount: z.number().int().nonnegative(),
      mcpServerNames: z.array(z.string().min(1)),
      hookNames: z.array(z.string().min(1)),
      subagentNames: z.array(z.string().min(1)),
      commandNames: z.array(z.string().min(1)),
      memoryFiles: z.array(z.string().min(1)),
    })
    .nullable(),
});

export const codexExternalImportPreviewSchema = z.object({
  sourceScope: z.literal("project"),
  items: z.array(codexExternalImportPreviewItemSchema),
});

export const codexMcpResourceContentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    uri: z.string().min(1),
    mimeType: z.string().nullable(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("blob"),
    uri: z.string().min(1),
    mimeType: z.string().nullable(),
    blob: z.string(),
  }),
]);

export const codexMcpResourceReadSchema = z.object({
  contents: z.array(codexMcpResourceContentSchema),
});

export const codexMcpResourceReadRequestSchema = z.object({
  server: z.string().trim().min(1).max(256),
  uri: z.string().trim().min(1).max(8_192),
});

export const codexSkillConfigUpdateSchema = z.object({
  path: z.string().trim().min(1).max(8_192),
  enabled: z.boolean(),
});

export const codexSkillConfigResultSchema = z.object({
  path: z.string().min(1).max(8_192),
  effectiveEnabled: z.boolean(),
});

export const codexSkillRootsUpdateSchema = z.object({
  roots: z.array(z.string().trim().min(1).max(8_192)).max(32),
});

export const codexSkillRootsResultSchema = z.object({
  roots: z.array(z.string().min(1)).max(32),
});

export const skillSettingsLocationSchema = z.enum([
  "project",
  "account",
  "user",
  "codexUser",
  "system",
  "admin",
]);

export const skillSettingsItemSchema = skillSummarySchema.extend({
  id: z.string().min(1).max(8_192),
  audienceKey: encryptionKeyBytesSchema,
  audience: resourceAudienceSchema.default("ide"),
  scope: z.enum(["repo", "user", "system", "admin"]),
  location: skillSettingsLocationSchema,
  path: z.string().min(1).max(8_192),
  enabled: z.boolean().default(true),
  editable: z.boolean(),
  deletable: z.boolean(),
});

export const skillSettingsErrorSchema = z.object({
  path: z.string().max(8_192),
  message: z.string().min(1).max(2_000),
});

export const skillSettingsInventorySchema = z.object({
  project: z.array(skillSettingsItemSchema).max(1_000),
  global: z.array(skillSettingsItemSchema).max(1_000),
  errors: z.array(skillSettingsErrorSchema).max(200),
});

export const skillSettingsFileSchema = z.object({
  path: z.string().min(1).max(8_192),
  sizeBytes: z.number().int().nonnegative().max(1_000_000_000),
});

export const skillSettingsDocumentSchema = z.object({
  skill: skillSettingsItemSchema,
  file: skillSettingsFileSchema,
  files: z.array(skillSettingsFileSchema).max(500),
  content: z.string().max(1_000_000),
});

export const skillSettingsContextSchema = z.object({
  workerId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200).nullable().default(null),
});

export const skillAudienceSummarySchema = z
  .object({
    audienceKey: encryptionKeyBytesSchema,
    audience: resourceAudienceSchema.default("ide"),
  })
  .strict();

export const skillAudienceListSchema = z
  .array(skillAudienceSummarySchema)
  .max(5_000);

export const skillAudienceContextSchema = skillSettingsContextSchema
  .omit({ projectId: true })
  .strict();

export const skillAudienceUpdateSchema = skillAudienceContextSchema
  .extend({
    audienceKey: encryptionKeyBytesSchema,
    audience: resourceAudienceSchema.default("ide"),
  })
  .strict();

export const skillSettingsFileRequestSchema = skillSettingsContextSchema.extend(
  {
    skillId: skillSettingsItemSchema.shape.id,
    file: skillSettingsFileSchema.shape.path.default("SKILL.md"),
  },
);

export const skillSettingsFileUpdateSchema =
  skillSettingsFileRequestSchema.extend({
    content: z.string().max(1_000_000),
  });

export const skillSettingsDeleteRequestSchema =
  skillSettingsContextSchema.extend({
    skillId: skillSettingsItemSchema.shape.id,
  });

export const skillSettingsConfigUpdateSchema =
  skillSettingsDeleteRequestSchema.extend({
    enabled: z.boolean(),
  });

export const skillSettingsConfigResultSchema = z.object({
  skillId: skillSettingsItemSchema.shape.id,
  effectiveEnabled: z.boolean(),
});

export const skillSettingsMutationResultSchema = z.object({
  changed: z.literal(true),
  recoveryPath: z.string().min(1).max(8_192).nullable(),
});

export const codexMcpOauthStartSchema = z.object({
  server: z.string().trim().min(1).max(256),
});

export const codexMcpOauthStartResultSchema = z.object({
  server: z.string().min(1).max(256),
  authorizationUrl: z.string().url().max(8_192),
  status: z.literal("pending"),
});

export const codexMcpOauthStatusSchema = z.object({
  server: z.string().min(1).max(256),
  status: z.enum(["pending", "succeeded", "failed", "unknown"]),
  error: z.string().max(2_000).nullable(),
});

export const codexMcpReloadResultSchema = z.object({
  reloaded: z.literal(true),
});

export const codexMcpReloadRequestSchema = z.object({}).strict();

export const codexExternalImportApplySchema = z
  .object({
    itemIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  })
  .superRefine(({ itemIds }, context) => {
    if (new Set(itemIds).size !== itemIds.length) {
      context.addIssue({
        code: "custom",
        message: "Import item ids must be unique.",
        path: ["itemIds"],
      });
    }
  });

export const codexExternalImportFailureSchema = z.object({
  failureStage: z.string().max(200),
  message: z.string().max(2_000),
});

export const codexExternalImportTypeResultSchema = z.object({
  itemType: codexExternalImportItemTypeSchema,
  successCount: z.number().int().nonnegative(),
  failures: z.array(codexExternalImportFailureSchema).max(100),
});

export const codexExternalImportStatusSchema = z.object({
  importId: z.string().min(1).max(200),
  status: z.enum(["pending", "completed", "unknown"]),
  results: z.array(codexExternalImportTypeResultSchema).max(100),
});

export function mentionedSkillNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(
    /(?:^|[^A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/gu,
  )) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

export type SkillSummary = z.infer<typeof skillSummarySchema>;

export type CustomizationCapability = z.infer<
  typeof customizationCapabilitySchema
>;

export type CodexCustomizationCapabilities = z.infer<
  typeof codexCustomizationCapabilitiesSchema
>;

export type CodexSkillInventoryItem = z.infer<
  typeof codexSkillInventoryItemSchema
>;

export type CodexHookInventoryItem = z.infer<
  typeof codexHookInventoryItemSchema
>;

export type CodexMcpServer = z.infer<typeof codexMcpServerSchema>;

export type CodexCustomizationInventory = z.infer<
  typeof codexCustomizationInventorySchema
>;

export type CodexExternalImportPreviewItem = z.infer<
  typeof codexExternalImportPreviewItemSchema
>;

export type CodexExternalImportPreview = z.infer<
  typeof codexExternalImportPreviewSchema
>;

export type CodexMcpResourceRead = z.infer<typeof codexMcpResourceReadSchema>;

export type CodexMcpResourceReadRequest = z.infer<
  typeof codexMcpResourceReadRequestSchema
>;

export type CodexSkillConfigUpdate = z.infer<
  typeof codexSkillConfigUpdateSchema
>;

export type CodexSkillConfigResult = z.infer<
  typeof codexSkillConfigResultSchema
>;

export type CodexSkillRootsUpdate = z.infer<typeof codexSkillRootsUpdateSchema>;

export type CodexSkillRootsResult = z.infer<typeof codexSkillRootsResultSchema>;

export type SkillSettingsLocation = z.infer<typeof skillSettingsLocationSchema>;

export type SkillSettingsItem = z.infer<typeof skillSettingsItemSchema>;

export type SkillSettingsInventory = z.infer<
  typeof skillSettingsInventorySchema
>;

export type SkillSettingsFile = z.infer<typeof skillSettingsFileSchema>;

export type SkillSettingsDocument = z.infer<typeof skillSettingsDocumentSchema>;

export type SkillSettingsContext = z.infer<typeof skillSettingsContextSchema>;

export type SkillSettingsFileRequest = z.infer<
  typeof skillSettingsFileRequestSchema
>;

export type SkillSettingsFileUpdate = z.infer<
  typeof skillSettingsFileUpdateSchema
>;

export type SkillSettingsDeleteRequest = z.infer<
  typeof skillSettingsDeleteRequestSchema
>;

export type SkillSettingsConfigUpdate = z.infer<
  typeof skillSettingsConfigUpdateSchema
>;

export type SkillSettingsConfigResult = z.infer<
  typeof skillSettingsConfigResultSchema
>;

export type SkillSettingsMutationResult = z.infer<
  typeof skillSettingsMutationResultSchema
>;

export type SkillAudienceSummary = z.infer<typeof skillAudienceSummarySchema>;

export type SkillAudienceContext = z.infer<typeof skillAudienceContextSchema>;

export type SkillAudienceUpdate = z.infer<typeof skillAudienceUpdateSchema>;

export type CodexMcpOauthStart = z.infer<typeof codexMcpOauthStartSchema>;

export type CodexMcpOauthStartResult = z.infer<
  typeof codexMcpOauthStartResultSchema
>;

export type CodexMcpOauthStatus = z.infer<typeof codexMcpOauthStatusSchema>;

export type CodexMcpReloadResult = z.infer<typeof codexMcpReloadResultSchema>;

export type CodexExternalImportApply = z.infer<
  typeof codexExternalImportApplySchema
>;

export type CodexExternalImportTypeResult = z.infer<
  typeof codexExternalImportTypeResultSchema
>;

export type CodexExternalImportStatus = z.infer<
  typeof codexExternalImportStatusSchema
>;
