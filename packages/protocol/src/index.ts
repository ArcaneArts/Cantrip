import { z } from "zod";

export const protocolVersionSchema = z.literal(1);
export const databaseEngineSchema = z.enum(["pglite", "postgres"]);
export const deploymentModeSchema = z.enum(["local", "hosted"]);
export const bootstrapModeSchema = z.enum([
  "pnpm-dev",
  "tauri",
  "standalone",
  "hosted",
]);
export const authModeSchema = z.enum(["none", "password", "accounts"]);

export const remoteSurfaceProtocolVersionSchema = z.literal(1);
export const remoteSurfaceKindSchema = z.enum(["browser", "desktop"]);
export const remoteSurfaceTransportSchema = z.enum(["websocket", "webrtc"]);
export const remoteSurfaceStatusSchema = z.enum([
  "idle",
  "connecting",
  "active",
  "suspended",
  "offline",
  "error",
]);
export const remoteSurfaceChannelSchema = z.enum([
  "control",
  "frame",
  "cursor",
  "clipboard",
  "webrtc-signal",
]);

export const remoteSurfaceCapabilitiesSchema = z.object({
  browser: z.boolean().default(false),
  desktop: z.boolean().default(false),
  transports: z.array(remoteSurfaceTransportSchema).min(1),
  maxSessions: z.number().int().positive(),
});

export const remoteSurfaceIceServerSchema = z.object({
  urls: z.array(z.string().min(1)).min(1),
  username: z.string().min(1).optional(),
  credential: z.string().min(1).optional(),
});

export const remoteSurfaceWebRtcConfigurationSchema = z.object({
  iceServers: z.array(remoteSurfaceIceServerSchema).min(1),
  iceTransportPolicy: z.literal("relay"),
  negotiationTimeoutMs: z.number().int().min(1_000).max(30_000),
});

export const remoteSurfaceWebRtcSignalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), sdp: z.string().min(1).max(1_000_000) }),
  z.object({
    type: z.literal("answer"),
    sdp: z.string().min(1).max(1_000_000),
  }),
  z.object({
    type: z.literal("candidate"),
    candidate: z.string().min(1).max(16_384),
    sdpMid: z.string().max(1_024).nullable(),
    sdpMLineIndex: z.number().int().nonnegative().nullable(),
    usernameFragment: z.string().max(1_024).nullable(),
  }),
  z.object({ type: z.literal("end-of-candidates") }),
  z.object({
    type: z.literal("transport-state"),
    state: z.enum(["connected", "failed", "closed"]),
    message: z.string().max(2_048).nullable(),
  }),
]);

function defaultRemoteSurfaceCapabilities(): z.infer<
  typeof remoteSurfaceCapabilitiesSchema
> {
  return {
    browser: false,
    desktop: false,
    transports: ["websocket"],
    maxSessions: 4,
  };
}

export const userSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["anonymous", "account"]),
  displayName: z.string().min(1),
  email: z.email().nullable(),
});

export const serverBootstrapSchema = z.object({
  protocolVersion: protocolVersionSchema,
  server: z.object({
    id: z.string().min(1),
    deploymentMode: deploymentModeSchema,
    bootstrapMode: bootstrapModeSchema,
  }),
  auth: z.object({
    mode: authModeSchema,
    currentUser: userSummarySchema,
  }),
  routing: z.object({
    workerConnection: z.literal("server-only"),
    directWorkerConnections: z.literal(false),
  }),
  storage: z.object({
    conversations: z.literal("server"),
    files: z.literal("worker"),
  }),
  agent: z.object({
    model: z.string().min(1),
    modelProvider: z.string().min(1),
  }),
  capabilities: z.object({
    accounts: z.boolean(),
    passwordProtection: z.boolean(),
    linkCodes: z.boolean(),
    multipleWorkers: z.boolean(),
    workerSwitching: z.boolean(),
    gitSync: z.boolean(),
    worktrees: z.boolean(),
    remoteSurfaces: z.object({
      enabled: z.boolean(),
      transports: z.array(remoteSurfaceTransportSchema).min(1),
      relayOnly: z.literal(true),
    }),
  }),
});

export const codexRuntimeMethodStateSchema = z.enum([
  "available",
  "unavailable",
  "unknown",
]);

export const codexRuntimeFeatureStageSchema = z.enum([
  "beta",
  "underDevelopment",
  "stable",
  "deprecated",
  "removed",
]);

export const codexRuntimeFeatureSchema = z.object({
  name: z.string().min(1),
  stage: codexRuntimeFeatureStageSchema,
  enabled: z.boolean(),
  defaultEnabled: z.boolean(),
});

export const codexRuntimeReportSchema = z.object({
  adapter: z.literal("app-server"),
  compatibility: z.enum(["compatible", "partial", "incompatible", "missing"]),
  version: z
    .object({
      raw: z.string().min(1),
      semantic: z.string().regex(/^\d+\.\d+\.\d+$/u),
    })
    .nullable(),
  testedRange: z.string().min(1),
  initialize: z
    .object({
      userAgent: z.string().min(1),
      platformFamily: z.string().min(1),
      platformOs: z.string().min(1),
      experimentalApi: z.boolean(),
    })
    .nullable(),
  methods: z.record(z.string().min(1), codexRuntimeMethodStateSchema),
  features: z.array(codexRuntimeFeatureSchema),
  degradedReasons: z.array(z.string().min(1)),
});

export const unprobedCodexRuntimeReport = codexRuntimeReportSchema.parse({
  adapter: "app-server",
  compatibility: "missing",
  version: null,
  testedRange: ">=0.146.0 <0.147.0",
  initialize: null,
  methods: {},
  features: [],
  degradedReasons: ["This worker has not reported runtime compatibility."],
});

export const workerHeartbeatSchema = z.object({
  workerId: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  codexVersion: z.string().nullable(),
  codexRuntime: codexRuntimeReportSchema.default(unprobedCodexRuntimeReport),
  remoteSurfaces: remoteSurfaceCapabilitiesSchema.default(
    defaultRemoteSurfaceCapabilities,
  ),
  startedAt: z.string().datetime(),
});

export const workerSummarySchema = workerHeartbeatSchema.extend({
  online: z.boolean(),
  lastSeenAt: z.string().datetime(),
});

export const workerListSchema = z.array(workerSummarySchema);

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

export const codexCustomizationCapabilitiesSchema = z.object({
  isolatedCodexHome: z.literal(true),
  collaborationModes: customizationCapabilitySchema,
  threadGoals: customizationCapabilitySchema,
  nativeSubagents: customizationCapabilitySchema,
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

export const systemHealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("cantrip_server"),
  database: z.object({
    engine: databaseEngineSchema,
    ready: z.boolean(),
  }),
  workers: z.object({
    connected: z.number().int().nonnegative(),
  }),
  timestamp: z.string().datetime(),
});

export const themePreferenceSchema = z.enum(["system", "light", "dark"]);
export const modelProviderKindSchema = z.enum([
  "chatgpt",
  "ollama",
  "openai-compatible",
]);

export const codexAuthStatusSchema = z.object({
  authenticated: z.boolean(),
  authMode: z.enum(["chatgpt", "apiKey", "other"]).nullable(),
  email: z.string().nullable(),
  planType: z.string().nullable(),
  weeklyUsage: z
    .object({
      usedPercent: z.number().min(0).max(100),
      resetsAt: z.number().int().nullable(),
    })
    .nullable(),
});

export const codexDeviceLoginSchema = z.object({
  loginId: z.string().min(1),
  verificationUrl: z.url(),
  userCode: z.string().min(1),
});

/**
 * Codex model-provider URLs are API roots. Codex adds the Responses endpoint
 * itself, so accepting a pasted chat/completions or responses URL would create
 * invalid paths such as `/chat/completions/responses`.
 */
export function normalizeResponsesBaseUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname
    .replace(/\/(?:chat\/completions|chat|responses)\/?$/i, "")
    .replace(/\/+$/, "");
  if (url.hostname.toLowerCase() === "openrouter.ai" && url.pathname === "/") {
    url.pathname = "/api/v1";
  }
  return url.toString().replace(/\/$/, "");
}
export const reasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const modelProviderCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: modelProviderKindSchema,
  baseUrl: z.url(),
  apiKey: z.string().trim().min(1).max(10_000).nullable().optional(),
});

export const modelProviderUpdateSchema = modelProviderCreateSchema;

export const modelProviderSummarySchema = modelProviderCreateSchema
  .omit({ apiKey: true })
  .extend({
    id: z.string().min(1),
    hasApiKey: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  });

export const modelProviderListSchema = z.array(modelProviderSummarySchema);

export const modelRouteInputSchema = z.object({
  id: z.string().min(1).optional(),
  providerId: z.string().min(1),
  modelName: z.string().trim().min(1).max(160),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  enabled: z.boolean().default(true),
});

export const modelRouteSummarySchema = modelRouteInputSchema.extend({
  id: z.string().min(1),
  providerName: z.string().min(1),
  position: z.number().int().nonnegative(),
  reasoningEffort: reasoningEffortSchema.nullable(),
});

export const modelProfileCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  routes: z
    .array(modelRouteInputSchema)
    .min(1)
    .max(32)
    .refine((routes) => routes.some((route) => route.enabled), {
      message: "At least one provider route must be enabled.",
    }),
});

export const modelProfileUpdateSchema = modelProfileCreateSchema;

export const modelProfileSummarySchema = modelProfileCreateSchema.extend({
  id: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
  routingPolicy: z.literal("priority"),
  routes: z.array(modelRouteSummarySchema).min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const modelProfileListSchema = z.array(modelProfileSummarySchema);

export const userSettingsSchema = z.object({
  theme: themePreferenceSchema,
  highContrast: z.boolean(),
  desktopFrameRate: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  desktopStreamQuality: z.enum(["adaptive", "data-saver", "balanced", "sharp"]),
  defaultModelId: z.string().min(1).nullable(),
});

export const userSettingsUpdateSchema = userSettingsSchema.partial();

export const settingsBundleSchema = z.object({
  preferences: userSettingsSchema,
  providers: modelProviderListSchema,
  models: modelProfileListSchema,
});

export const githubAuthStatusSchema = z.object({
  authenticated: z.boolean(),
  login: z.string().min(1).nullable(),
  source: z.enum(["gh-cli", "token", "none"]),
});

export const githubRepositorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nameWithOwner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  isFork: z.boolean(),
  url: z.url(),
  defaultBranch: z.string().min(1),
  updatedAt: z.string().datetime(),
  imported: z.boolean().default(false),
});

export const githubRepositoryListSchema = z.array(githubRepositorySchema);

export const githubIssueStateSchema = z.enum(["open", "closed"]);
export const githubIssueKindSchema = z.enum(["issue", "pull-request"]);

export const githubIssueLabelSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
});

export const githubIssueSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  state: githubIssueStateSchema,
  url: z.url(),
  author: z.string().min(1),
  commentCount: z.number().int().nonnegative(),
  labels: z.array(githubIssueLabelSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});

export const githubIssueListSchema = z.object({
  kind: githubIssueKindSchema.default("issue"),
  state: githubIssueStateSchema,
  total: z.number().int().nonnegative(),
  issues: z.array(githubIssueSummarySchema),
  nextPage: z.number().int().positive().nullable().default(null),
});

export const githubIssueCommentSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  body: z.string(),
  url: z.url(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const githubIssueDetailSchema = githubIssueSummarySchema.extend({
  body: z.string().nullable(),
  comments: z.array(githubIssueCommentSchema),
});

export const githubIssueCommentCreateSchema = z.object({
  body: z.string().trim().min(1).max(65_536),
});

export const githubIssueCloseSchema = z.object({
  comment: z.string().trim().min(1).max(65_536).nullable().default(null),
});

export const githubProjectCreateSchema = z.object({
  workerId: z.string().min(1),
  repositoryId: z.string().min(1),
  nameWithOwner: githubRepositorySchema.shape.nameWithOwner,
  url: z.url(),
});

export const projectSourceSummarySchema = z.object({
  id: z.string().min(1),
  workerId: z.string().min(1),
  path: z.string().min(1),
  displayPath: z.string().min(1),
});

export const worktreePolicySchema = z.enum([
  "direct",
  "agent-managed",
  "required-for-writes",
]);
export const worktreeOriginSchema = z.enum([
  "cantrip",
  "agent",
  "user",
  "external",
]);
export const worktreeLifecycleStateSchema = z.enum([
  "creating",
  "ready",
  "missing",
  "prunable",
  "removing",
]);

export const projectWorktreeSummarySchema = z.object({
  id: z.string().min(1),
  projectSourceId: z.string().min(1),
  projectId: z.string().min(1),
  workerId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  isPrimary: z.boolean(),
  isDefault: z.boolean(),
  origin: worktreeOriginSchema,
  lifecycleState: worktreeLifecycleStateSchema,
  branch: z.string().min(1).nullable(),
  head: z.string().min(1).nullable(),
  detached: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().min(1).nullable(),
  lastScannedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectWorktreeListSchema = z.array(projectWorktreeSummarySchema);

export const projectSetupStatusSchema = z.enum(["cloning", "ready", "failed"]);

export const projectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
  setupStatus: projectSetupStatusSchema,
  setupError: z.string().min(1).nullable(),
  worktreePolicy: worktreePolicySchema,
  github: z
    .object({
      repositoryId: z.string().min(1),
      nameWithOwner: z.string().min(1),
      url: z.url(),
    })
    .nullable(),
  source: projectSourceSummarySchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectListSchema = z.array(projectSummarySchema);

export const chatCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("New chat"),
  worktreeId: z.string().min(1).optional(),
  worktreeMode: z.enum(["agent-managed", "pinned"]).default("agent-managed"),
});

export const chatUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const chatForkSchema = z.object({
  messageId: z.string().min(1).optional(),
  worktreeId: z.string().min(1).optional(),
  worktreeMode: z.enum(["agent-managed", "pinned"]).optional(),
});

export const orderedIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const chatSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  status: z.enum([
    "idle",
    "running",
    "waiting-for-approval",
    "offline",
    "failed",
  ]),
  activeWorkerId: z.string().min(1).nullable(),
  activeWorktreeId: z.string().min(1),
  worktreeMode: z.enum(["agent-managed", "pinned"]),
  modelId: z.string().min(1).nullable(),
  permissionProfileId: z.string().min(1).max(200).nullable(),
  planMode: z.enum(["default", "plan"]),
  hasPendingPlanQuestion: z.boolean(),
  automationPaused: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const chatListSchema = z.array(chatSummarySchema);

export const permissionProfileIdSchema = z.string().min(1).max(200);

export const permissionProfileSummarySchema = z.object({
  id: permissionProfileIdSchema,
  description: z.string(),
  allowed: z.boolean(),
});

export const permissionProfileCapabilitySchema = z.object({
  available: z.boolean(),
  profiles: z.array(permissionProfileSummarySchema),
  reason: z.string().min(1).nullable(),
});

export const chatPermissionProfileStateSchema =
  permissionProfileCapabilitySchema.extend({
    selectedId: permissionProfileIdSchema,
    effectiveId: permissionProfileIdSchema,
    forcedByWorktreePolicy: z.boolean(),
  });

export const chatPermissionProfileUpdateSchema = z.object({
  id: permissionProfileIdSchema,
});

export const terminalCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Terminal"),
  worktreeId: z.string().min(1).optional(),
});

export const terminalUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const terminalSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  status: z.enum(["idle", "running", "exited", "offline", "failed"]),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  linkedChatId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const terminalListSchema = z.array(terminalSummarySchema);

export const explorerCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Explorer"),
  worktreeId: z.string().min(1).optional(),
});

export const explorerUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const explorerSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const explorerListSchema = z.array(explorerSummarySchema);

export const browserCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Browser"),
});

export const browserUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    url: z.string().url().max(4_096).optional(),
  })
  .refine((input) => input.title !== undefined || input.url !== undefined, {
    message: "At least one browser field is required.",
  });

export const browserSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  url: z.string().url(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const browserListSchema = z.array(browserSummarySchema);

export const remoteDesktopCreateSchema = z.object({}).strict();

export const remoteDesktopSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  workerId: z.string().min(1),
  status: remoteSurfaceStatusSchema,
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const remoteDesktopListSchema = z.array(remoteDesktopSummarySchema);

export const remoteSurfaceConfigurationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("browser"),
    initialUrl: z.url().max(4_096),
    profileId: z.string().trim().min(1).max(200).nullable().default(null),
  }),
  z.object({
    kind: z.literal("desktop"),
  }),
]);

export const remoteSurfaceCreateSchema = z.object({
  workerId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  configuration: remoteSurfaceConfigurationSchema,
});

export const remoteSurfaceUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    configuration: remoteSurfaceConfigurationSchema.optional(),
    preferredTransport: remoteSurfaceTransportSchema.optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.configuration !== undefined ||
      input.preferredTransport !== undefined,
    { message: "At least one remote surface field is required." },
  );

export const remoteSurfaceSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  workerId: z.string().min(1),
  kind: remoteSurfaceKindSchema,
  title: z.string().min(1),
  status: remoteSurfaceStatusSchema,
  preferredTransport: remoteSurfaceTransportSchema,
  configuration: remoteSurfaceConfigurationSchema,
  lastError: z.string().nullable(),
  lastConnectedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const remoteSurfaceListSchema = z.array(remoteSurfaceSummarySchema);

export const remoteSurfaceViewportSchema = z.object({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  devicePixelRatio: z.number().min(0.25).max(8),
});

export const desktopStreamSettingsSchema = z.object({
  targetFps: z.number().int().min(1).max(60),
  quality: z.enum(["adaptive", "data-saver", "balanced", "sharp"]),
});

export const remoteSurfaceConnectionMessageSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("ready"),
      surfaceId: z.string().min(1),
      attachmentId: z.string().min(1),
      transport: remoteSurfaceTransportSchema,
      webrtc: remoteSurfaceWebRtcConfigurationSchema.nullable().default(null),
    }),
    z.object({
      type: z.literal("error"),
      message: z.string().min(1),
      recoverable: z.boolean(),
    }),
  ],
);

export const remoteSurfaceAttachResultSchema = z.object({
  accepted: z.literal(true),
  transport: remoteSurfaceTransportSchema,
});

export const remoteSurfaceControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resize"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({ type: z.literal("suspend") }),
  z.object({ type: z.literal("resume") }),
]);

export const remoteDesktopProbeResultSchema = z.object({
  available: z.boolean(),
  message: z.string().max(2_048).nullable(),
});

export const remoteDesktopClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("viewport"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({
    type: z.literal("pointer"),
    event: z.enum(["move", "down", "up", "wheel"]),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z
      .enum(["none", "left", "middle", "right", "back", "forward"])
      .default("none"),
    buttons: z.number().int().nonnegative().max(31).default(0),
    clickCount: z.number().int().min(0).max(3).default(0),
    deltaX: z.number().finite().default(0),
    deltaY: z.number().finite().default(0),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("key"),
    event: z.enum(["down", "up"]),
    key: z.string().max(100),
    code: z.string().max(100),
    text: z.string().max(10).default(""),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({ type: z.literal("focus") }),
  z.object({
    type: z.literal("clipboard"),
    operation: z.enum(["copy", "paste-text"]),
    text: z.string().max(1_000_000).default(""),
  }),
  z.object({
    type: z.literal("stream-feedback"),
    intervalMs: z.number().int().min(250).max(10_000),
    receivedFrames: z.number().int().nonnegative().max(1_000),
    renderedFrames: z.number().int().nonnegative().max(1_000),
    droppedFrames: z.number().int().nonnegative().max(1_000),
    averageDecodeMs: z.number().finite().nonnegative().max(10_000),
  }),
]);

export const remoteDesktopServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("desktop-state"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    status: z.enum(["ready", "suspended", "error"]),
    message: z.string().max(2_048).nullable(),
    stream: z
      .object({
        backend: z.enum(["native", "compatibility"]),
        targetFps: z.number().int().min(1).max(60),
        observedFps: z.number().finite().nonnegative().max(240),
        quality: z.number().int().min(1).max(100),
        encodedWidth: z.number().int().positive(),
      })
      .nullable()
      .default(null),
  }),
  z.object({
    type: z.literal("desktop-clipboard"),
    text: z.string().max(1_000_000),
  }),
]);

export const remoteBrowserClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    url: z.url().max(4_096),
  }),
  z.object({
    type: z.literal("history"),
    delta: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("stop") }),
  z.object({
    type: z.literal("viewport"),
    viewport: remoteSurfaceViewportSchema,
  }),
  z.object({
    type: z.literal("pointer"),
    event: z.enum(["move", "down", "up", "wheel"]),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z
      .enum(["none", "left", "middle", "right", "back", "forward"])
      .default("none"),
    buttons: z.number().int().nonnegative().max(31).default(0),
    clickCount: z.number().int().min(0).max(3).default(0),
    deltaX: z.number().finite().default(0),
    deltaY: z.number().finite().default(0),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("key"),
    event: z.enum(["down", "up"]),
    key: z.string().max(100),
    code: z.string().max(100),
    text: z.string().max(10).default(""),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({ type: z.literal("focus") }),
  z.object({
    type: z.literal("touch"),
    event: z.enum(["start", "move", "end", "cancel"]),
    points: z
      .array(
        z.object({
          id: z.number().int().nonnegative(),
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          radiusX: z.number().finite().positive().default(1),
          radiusY: z.number().finite().positive().default(1),
          force: z.number().finite().min(0).max(1).default(1),
        }),
      )
      .max(10),
    modifiers: z.number().int().nonnegative().max(15).default(0),
  }),
  z.object({
    type: z.literal("clipboard"),
    operation: z.enum(["copy-selection", "paste-text"]),
    text: z.string().max(1_000_000).default(""),
  }),
]);

export const remoteBrowserServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser-state"),
    url: z.string().max(4_096),
    title: z.string().max(2_000),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    loading: z.boolean(),
  }),
  z.object({
    type: z.literal("browser-runtime"),
    status: z.enum(["ready", "recovering", "error"]),
    message: z.string().max(2_000).nullable().default(null),
  }),
]);

export const remoteBrowserCursorMessageSchema = z.object({
  type: z.literal("browser-cursor"),
  cursor: z.enum([
    "auto",
    "default",
    "none",
    "context-menu",
    "help",
    "pointer",
    "progress",
    "wait",
    "cell",
    "crosshair",
    "text",
    "vertical-text",
    "alias",
    "copy",
    "move",
    "no-drop",
    "not-allowed",
    "grab",
    "grabbing",
    "all-scroll",
    "col-resize",
    "row-resize",
    "n-resize",
    "e-resize",
    "s-resize",
    "w-resize",
    "ne-resize",
    "nw-resize",
    "se-resize",
    "sw-resize",
    "ew-resize",
    "ns-resize",
    "nesw-resize",
    "nwse-resize",
    "zoom-in",
    "zoom-out",
  ]),
});

export const remoteBrowserClipboardMessageSchema = z.object({
  type: z.literal("browser-clipboard"),
  operation: z.literal("copy-selection"),
  text: z.string().max(1_000_000),
});

export const remoteSurfaceFrameHeaderSchema = z.object({
  protocolVersion: remoteSurfaceProtocolVersionSchema,
  surfaceId: z.string().min(1).max(200),
  attachmentId: z.string().min(1).max(200),
  sequence: z.number().int().nonnegative().safe(),
  channel: remoteSurfaceChannelSchema,
});

export const REMOTE_SURFACE_MAX_HEADER_BYTES = 64 * 1_024;
export const REMOTE_SURFACE_MAX_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
const REMOTE_SURFACE_FRAME_MAGIC = new Uint8Array([0x43, 0x54, 0x52, 0x53]);

export function encodeRemoteSurfaceFrame(
  header: RemoteSurfaceFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const parsedHeader = remoteSurfaceFrameHeaderSchema.parse(header);
  if (payload.byteLength > REMOTE_SURFACE_MAX_PAYLOAD_BYTES) {
    throw new Error("Remote Surface payload exceeds the protocol limit.");
  }
  const encodedHeader = new TextEncoder().encode(JSON.stringify(parsedHeader));
  if (encodedHeader.byteLength > REMOTE_SURFACE_MAX_HEADER_BYTES) {
    throw new Error("Remote Surface header exceeds the protocol limit.");
  }
  const frame = new Uint8Array(
    8 + encodedHeader.byteLength + payload.byteLength,
  );
  frame.set(REMOTE_SURFACE_FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, encodedHeader.byteLength, false);
  frame.set(encodedHeader, 8);
  frame.set(payload, 8 + encodedHeader.byteLength);
  return frame;
}

export function decodeRemoteSurfaceFrame(frame: Uint8Array): {
  header: RemoteSurfaceFrameHeader;
  payload: Uint8Array;
} {
  if (frame.byteLength < 8)
    throw new Error("Remote Surface frame is truncated.");
  for (let index = 0; index < REMOTE_SURFACE_FRAME_MAGIC.length; index += 1) {
    if (frame[index] !== REMOTE_SURFACE_FRAME_MAGIC[index]) {
      throw new Error("Remote Surface frame has an invalid magic value.");
    }
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(4, false);
  if (headerLength < 1 || headerLength > REMOTE_SURFACE_MAX_HEADER_BYTES) {
    throw new Error("Remote Surface frame header length is invalid.");
  }
  const payloadOffset = 8 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error("Remote Surface frame header is truncated.");
  }
  const payloadLength = frame.byteLength - payloadOffset;
  if (payloadLength > REMOTE_SURFACE_MAX_PAYLOAD_BYTES) {
    throw new Error("Remote Surface payload exceeds the protocol limit.");
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      new TextDecoder().decode(frame.subarray(8, payloadOffset)),
    );
  } catch {
    throw new Error("Remote Surface frame header is not valid JSON.");
  }
  return {
    header: remoteSurfaceFrameHeaderSchema.parse(rawHeader),
    payload: frame.subarray(payloadOffset),
  };
}

export const projectViewKindSchema = z.enum([
  "history",
  "issues",
  "remote-desktop",
]);

export const projectViewCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: projectViewKindSchema,
  worktreeId: z.string().min(1).optional(),
});

export const projectViewUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const projectViewSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  kind: projectViewKindSchema,
  worktreeId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectViewListSchema = z.array(projectViewSummarySchema);

export const explorerEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string(),
  kind: z.enum(["directory", "file", "other"]),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string().datetime(),
  viewable: z.boolean(),
  markdown: z.boolean(),
});

export const explorerDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(explorerEntrySchema).max(1_000),
  truncated: z.boolean(),
});

export const explorerFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  size: z.number().int().nonnegative(),
  markdown: z.boolean(),
});

export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string().max(100_000),
  }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
]);

export const terminalServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int(),
    signal: z.number().int().nullable(),
  }),
  z.object({ type: z.literal("error"), message: z.string().min(1) }),
]);

export const terminalOpenResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("detached") }),
  z.object({
    status: z.literal("exited"),
    exitCode: z.number().int(),
    signal: z.number().int().nullable(),
  }),
]);

export const chatMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export const agentMessagePhaseSchema = z.enum(["commentary", "final_answer"]);
export const chatAttachmentKindSchema = z.enum([
  "audio",
  "file",
  "image",
  "text",
]);
export const chatAttachmentSourceSchema = z.enum(["file", "paste"]);
export const chatAttachmentSummarySchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(25 * 1_024 * 1_024),
  kind: chatAttachmentKindSchema,
  source: chatAttachmentSourceSchema,
  status: z.enum(["ready", "failed"]),
  previewText: z.string().max(8_000).nullable(),
  createdAt: z.string().datetime(),
});
export const chatAttachmentListSchema = z
  .array(chatAttachmentSummarySchema)
  .max(20);
export const agentActivityStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "declined",
]);
export const codexEventCorrelationSchema = z.object({
  sourceMethod: z.string().min(1).max(200),
  diagnosticId: z.string().min(1).max(200).nullable(),
  threadId: z.string().min(1).max(200).nullable(),
  turnId: z.string().min(1).max(200).nullable(),
  itemId: z.string().min(1).max(200).nullable(),
});

const agentActivityBaseShape = {
  id: z.string().min(1),
  status: agentActivityStatusSchema,
  correlation: codexEventCorrelationSchema.nullable().optional(),
};

const tokenUsageBreakdownSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
});

const rateLimitWindowSchema = z.object({
  usedPercent: z.number().min(0),
  windowDurationMins: z.number().int().nonnegative().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
});

export const agentActivitySchema = z.discriminatedUnion("type", [
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("command"),
    command: z.string().min(1),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    output: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("fileChange"),
    changes: z.array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(["add", "delete", "update"]),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("worktree"),
    operation: z.string().min(1),
    summary: z.string().min(1),
    worktreeId: z.string().min(1).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("plan"),
    text: z.string(),
    explanation: z.string().nullable(),
    steps: z.array(
      z.object({
        step: z.string().min(1),
        status: z.enum(["pending", "inProgress", "completed"]),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("reasoning"),
    summary: z.array(z.string().min(1)).max(100),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("mcpToolCall"),
    server: z.string().min(1),
    tool: z.string().min(1),
    error: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("dynamicToolCall"),
    namespace: z.string().min(1).nullable(),
    tool: z.string().min(1),
    success: z.boolean().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("collabToolCall"),
    tool: z.string().min(1),
    senderThreadId: z.string().min(1),
    receiverThreadIds: z.array(z.string().min(1)).max(100),
    prompt: z.string().nullable(),
    model: z.string().nullable(),
    agentStates: z.array(
      z.object({
        threadId: z.string().min(1),
        status: z.string().min(1),
        message: z.string().nullable(),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("subAgent"),
    kind: z.enum(["started", "interacted", "interrupted"]),
    agentThreadId: z.string().min(1),
    agentPath: z.string().min(1),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("webSearch"),
    query: z.string(),
    action: z.string().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("imageView"),
    path: z.string().min(1),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("reviewMode"),
    state: z.enum(["entered", "exited"]),
    review: z.string(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("contextCompaction"),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("notice"),
    level: z.enum(["warning", "error"]),
    message: z.string().min(1),
    details: z.string().nullable(),
    willRetry: z.boolean().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("usage"),
    total: tokenUsageBreakdownSchema,
    last: tokenUsageBreakdownSchema,
    modelContextWindow: z.number().int().positive().nullable(),
    contextUsedPercent: z.number().min(0).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("rateLimit"),
    limitName: z.string().nullable(),
    planType: z.string().nullable(),
    reachedType: z.string().nullable(),
    primary: rateLimitWindowSchema.nullable(),
    secondary: rateLimitWindowSchema.nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("turnSummary"),
    durationMs: z.number().int().nonnegative().nullable(),
    startedAt: z.number().int().nonnegative().nullable(),
    completedAt: z.number().int().nonnegative().nullable(),
  }),
]);
export const chatMessageContentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      text: z.string().min(1),
      phase: agentMessagePhaseSchema.nullable().optional(),
      correlation: codexEventCorrelationSchema.nullable().optional(),
    }),
    z.object({
      type: z.literal("activity"),
      activity: agentActivitySchema,
    }),
    z.object({
      type: z.literal("attachment"),
      attachment: chatAttachmentSummarySchema,
    }),
  ]),
);

export const chatTurnModeSchema = z.enum(["default", "plan", "goal"]);

export const chatMessageCreateSchema = z.object({
  role: chatMessageRoleSchema,
  content: chatMessageContentSchema.min(1),
  mode: chatTurnModeSchema.optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const chatMessageSchema = chatMessageCreateSchema
  .omit({ idempotencyKey: true })
  .extend({
    id: z.string().min(1),
    chatId: z.string().min(1),
    worktreeId: z.string().min(1),
    executionLaneId: z.string().min(1).nullable(),
    sequence: z.number().int().positive(),
    mode: chatTurnModeSchema.default("default"),
    modelId: z.string().min(1).nullable(),
    modelRouteId: z.string().min(1).nullable(),
    providerId: z.string().min(1).nullable(),
    providerName: z.string().min(1).nullable(),
    providerModelName: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
  });

export const chatExecutionLaneActorSchema = z.enum(["agent", "user"]);
export const chatExecutionLaneStateSchema = z.enum([
  "active",
  "suspended",
  "delivering",
  "released",
]);
export const chatExecutionLaneSummarySchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  worktreeId: z.string().min(1),
  workerId: z.string().min(1),
  acquiringActor: chatExecutionLaneActorSchema,
  exclusive: z.boolean(),
  purpose: z.string().min(1).nullable(),
  state: chatExecutionLaneStateSchema,
  baseRevision: z.string().min(1).nullable(),
  startingHead: z.string().min(1).nullable(),
  runtimeSessionId: z.string().min(1).nullable(),
  codexThreadId: z.string().min(1).nullable(),
  transitionKind: z.enum(["switch", "release"]).nullable(),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  releasedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export const chatExecutionLaneListSchema = z.array(
  chatExecutionLaneSummarySchema,
);

export const chatExecutionLaneReleaseSchema = z.object({
  allowDirty: z.boolean().default(false),
  returnToPrimary: z.boolean().default(true),
});

export const agentInteractionRequestKindSchema = z.enum([
  "commandExecution",
  "fileChange",
  "permissions",
  "userInput",
  "mcpElicitation",
]);

export const agentInteractionRequestStatusSchema = z.enum([
  "pending",
  "resolved",
  "expired",
  "interrupted",
]);

export const agentInteractionProvenanceSchema = z.object({
  chatId: z.string().min(1).nullable(),
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  itemId: z.string().min(1).nullable(),
  executionLaneId: z.string().min(1).nullable(),
  workflowRunId: z.string().min(1).nullable(),
  workflowNodeId: z.string().min(1).nullable(),
  workerId: z.string().min(1),
});

export const agentInteractionRequestPayloadSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("commandExecution"),
      startedAtMs: z.number().int().nonnegative(),
      approvalId: z.string().min(1).nullable(),
      environmentId: z.string().min(1).nullable(),
      reason: z.string().nullable(),
      command: z.string().nullable(),
      cwd: z.string().nullable(),
      commandActions: z.json().nullable().optional(),
      networkApprovalContext: z
        .object({
          host: z.string().min(1),
          protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
        })
        .nullable(),
      additionalPermissions: z.json().nullable(),
      proposedExecpolicyAmendment: z.array(z.string()).nullable(),
      proposedNetworkPolicyAmendments: z
        .array(
          z.object({
            host: z.string().min(1),
            action: z.enum(["allow", "deny"]),
          }),
        )
        .nullable(),
      availableDecisions: z
        .array(
          z.enum([
            "accept",
            "acceptForSession",
            "acceptWithExecpolicyAmendment",
            "applyNetworkPolicyAmendment",
            "decline",
            "cancel",
          ]),
        )
        .nullable(),
    }),
    z.object({
      kind: z.literal("fileChange"),
      startedAtMs: z.number().int().nonnegative(),
      reason: z.string().nullable(),
      grantRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("permissions"),
      startedAtMs: z.number().int().nonnegative(),
      environmentId: z.string().min(1).nullable(),
      cwd: z.string().min(1),
      reason: z.string().nullable(),
      requestedPermissions: z.json(),
    }),
    z.object({
      kind: z.literal("userInput"),
      questions: z
        .array(
          z.object({
            id: z.string().min(1),
            header: z.string().min(1),
            question: z.string().min(1),
            isOther: z.boolean(),
            isSecret: z.boolean(),
            options: z
              .array(
                z.object({
                  label: z.string().min(1),
                  description: z.string(),
                }),
              )
              .nullable(),
          }),
        )
        .min(1)
        .max(3),
      autoResolutionMs: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("mcpElicitation"),
      serverName: z.string().min(1),
      mode: z.enum(["form", "openai/form", "url"]),
      message: z.string().min(1),
      requestedSchema: z.json().nullable(),
      url: z.url().nullable(),
      elicitationId: z.string().min(1).nullable(),
      metadata: z.json().nullable(),
    }),
  ],
);

export const agentInteractionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commandExecution"),
    decision: z.enum([
      "accept",
      "acceptForSession",
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
      "decline",
      "cancel",
    ]),
    execpolicyAmendment: z.array(z.string()).nullable().default(null),
    networkPolicyAmendment: z
      .object({
        host: z.string().min(1),
        action: z.enum(["allow", "deny"]),
      })
      .nullable()
      .default(null),
  }),
  z.object({
    kind: z.literal("fileChange"),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  }),
  z.object({
    kind: z.literal("permissions"),
    permissions: z.json(),
    scope: z.enum(["turn", "session"]),
    strictAutoReview: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("userInput"),
    answers: z.record(
      z.string().min(1),
      z.object({ answers: z.array(z.string()).min(1) }),
    ),
  }),
  z.object({
    kind: z.literal("mcpElicitation"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.json().nullable(),
    metadata: z.json().nullable().default(null),
  }),
]);

function fitsAgentInteractionStorageLimit(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= 1_000_000;
  } catch {
    return false;
  }
}

export const agentInteractionRequestCreateSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    projectId: z.string().min(1),
    provenance: agentInteractionProvenanceSchema,
    payload: agentInteractionRequestPayloadSchema,
    expiresAt: z.string().datetime().nullable(),
  })
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Agent interaction request exceeds the 1 MB storage limit.",
  });

export const agentInteractionResolutionCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    response: agentInteractionResponseSchema,
  })
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Agent interaction response exceeds the 1 MB storage limit.",
  });

export const agentInteractionRuntimeRequestSchema = z.object({
  requestKey: z.string().min(1).max(200),
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  itemId: z.string().min(1).nullable(),
  payload: agentInteractionRequestPayloadSchema,
  expiresAt: z.string().datetime(),
});

export const agentInteractionAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const agentInteractionRequestSchema = z
  .object({
    id: z.string().min(1),
    requestKey: z.string().min(1),
    projectId: z.string().min(1),
    provenance: agentInteractionProvenanceSchema,
    payload: agentInteractionRequestPayloadSchema,
    status: agentInteractionRequestStatusSchema,
    response: agentInteractionResponseSchema.nullable(),
    resolvedByUserId: z.string().min(1).nullable(),
    expiresAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((request, context) => {
    if (request.response && request.response.kind !== request.payload.kind) {
      context.addIssue({
        code: "custom",
        path: ["response", "kind"],
        message: "Response kind must match request kind.",
      });
    }
    const terminalWithoutResponse =
      request.status === "expired" || request.status === "interrupted";
    if (request.status === "pending") {
      if (request.response || request.resolvedByUserId || request.resolvedAt) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Pending requests cannot contain resolution data.",
        });
      }
    } else if (request.status === "resolved") {
      if (
        !request.response ||
        !request.resolvedByUserId ||
        !request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Resolved requests require response and resolution data.",
        });
      }
    } else if (
      terminalWithoutResponse &&
      (request.response || request.resolvedByUserId || !request.resolvedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Expired and interrupted requests require a terminal timestamp without a response.",
      });
    }
  });

export const agentInteractionRequestListSchema = z.array(
  agentInteractionRequestSchema,
);

export const agentInteractionRequestQuerySchema = z.object({
  chatId: z.string().min(1).optional(),
  status: agentInteractionRequestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const agentWorktreeToolNameSchema = z.enum([
  "cantrip_worktrees_list",
  "cantrip_worktree_acquire",
  "cantrip_worktree_create",
  "cantrip_worktree_switch",
  "cantrip_worktree_status",
  "cantrip_worktree_release",
  "cantrip_worktree_remove",
]);

export const agentWorktreeToolCallSchema = z.object({
  callId: z.string().min(1).max(200),
  chatId: z.string().min(1),
  executionLaneId: z.string().min(1),
  workerId: z.string().min(1),
  tool: agentWorktreeToolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
});

export const agentWorktreeToolResultSchema = z.object({
  summary: z.string().min(1),
  worktreeId: z.string().min(1).nullable().default(null),
  continuationScheduled: z.boolean().default(false),
  data: z.unknown().optional(),
});

export const chatMessageListSchema = z.array(chatMessageSchema);

export const chatTurnCreateSchema = z
  .object({
    text: z.string().trim().max(100_000).default(""),
    attachmentIds: z.array(z.string().min(1)).max(20).default([]),
    mode: chatTurnModeSchema.default("default"),
    idempotencyKey: z.string().min(1).max(200),
    modelId: z.string().min(1).optional(),
  })
  .refine(
    ({ attachmentIds, text }) => text.length > 0 || attachmentIds.length > 0,
    { message: "A prompt needs text or at least one attachment." },
  )
  .refine(({ mode, text }) => mode !== "goal" || text.length > 0, {
    message: "Goal mode needs a text objective.",
  });

export const queuedPromptSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  text: z.string().trim().max(100_000),
  attachments: chatAttachmentListSchema.default([]),
  mode: chatTurnModeSchema.default("default"),
  modelId: z.string().min(1),
  worktreeId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative(),
  frozen: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const queuedPromptListSchema = z.array(queuedPromptSchema);

export const queuedPromptCreateSchema = chatTurnCreateSchema.extend({
  frozen: z.boolean().default(false),
  worktreeId: z.string().min(1).nullable().default(null),
});

export const queuedPromptUpdateSchema = z
  .object({
    text: z.string().trim().max(100_000).optional(),
    attachmentIds: z.array(z.string().min(1)).max(20).optional(),
    mode: chatTurnModeSchema.optional(),
    frozen: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.text !== undefined ||
      value.attachmentIds !== undefined ||
      value.mode !== undefined ||
      value.frozen !== undefined,
    { message: "At least one queued prompt field is required." },
  );

export const queuedPromptOrderSchema = z.object({
  ids: z.array(z.string().min(1)).max(1_000),
});

export const chatModelUpdateSchema = z.object({
  modelId: z.string().min(1),
});

export const chatTurnAcceptedSchema = z.object({
  accepted: z.literal(true),
  message: chatMessageSchema,
});

export const chatPromptSubmitResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), message: chatMessageSchema }),
  z.object({ status: z.literal("queued"), prompt: queuedPromptSchema }),
]);

export const chatPromptSteerResultSchema = z.object({
  steered: z.literal(true),
  message: chatMessageSchema,
});

export const chatCompactAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const chatInterruptAcceptedSchema = z.object({
  interrupted: z.boolean(),
});

export const chatPauseUpdateSchema = z.object({
  paused: z.boolean(),
});

export const chatPauseStateSchema = z.object({
  paused: z.boolean(),
});

export const threadGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export const threadGoalSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string().min(1),
  status: threadGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const chatGoalResponseSchema = z.object({
  goal: threadGoalSchema.nullable(),
});

export const chatGoalCreateSchema = z.object({
  objective: z.string().trim().min(1).max(100_000),
  tokenBudget: z.number().int().positive().nullable().optional(),
});

export const chatGoalUpdateSchema = z.object({
  status: z.enum(["active", "paused"]),
});

export const chatGoalClearSchema = z.object({
  cleared: z.boolean(),
});

export const planModeSchema = z.enum(["default", "plan"]);

export const planStepSchema = z.object({
  step: z.string().min(1),
  status: z.enum(["pending", "inProgress", "completed"]),
});

export const planQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
});

export const planQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(planQuestionOptionSchema).min(1).nullable(),
});

export const pendingPlanQuestionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  questions: z.array(planQuestionSchema).min(1).max(3),
  createdAt: z.string().datetime(),
});

export const chatPlanStateSchema = z.object({
  mode: planModeSchema,
  explanation: z.string().nullable(),
  steps: z.array(planStepSchema),
  question: pendingPlanQuestionSchema.nullable(),
});

export const chatPlanUpdateSchema = z.object({ mode: planModeSchema });

export const chatPlanAnswerSchema = z.object({
  answers: z.record(
    z.string().min(1),
    z.array(z.string().trim().min(1).max(10_000)).min(1).max(16),
  ),
});

export const chatPlanAcceptedSchema = z.object({
  accepted: z.literal(true),
  requestKey: z.string().min(1).optional(),
});

export const githubWorkerRepositorySchema = githubRepositorySchema.omit({
  imported: true,
});

export const githubWorkerRepositoryListSchema = z.array(
  githubWorkerRepositorySchema,
);

export const projectCloneResultSchema = z.object({
  path: z.string().min(1),
  displayPath: z.string().min(1),
  reused: z.boolean().default(false),
  updated: z.boolean().default(false),
  warning: z.string().min(1).nullable().default(null),
  worktreePolicy: worktreePolicySchema.nullable().optional(),
});

export const projectRemoveSchema = z.object({
  deleteLocalFiles: z.boolean().default(false),
});

export const gitRefSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["head", "local", "remote", "tag"]),
  current: z.boolean(),
});

export const gitCommitSchema = z.object({
  hash: z.string().min(1),
  shortHash: z.string().min(1),
  parents: z.array(z.string().min(1)),
  subject: z.string(),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
  refs: z.array(gitRefSchema),
  isHead: z.boolean(),
});

export const gitHistorySchema = z.object({
  branch: z.string(),
  head: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
  commits: z.array(gitCommitSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitFileChangeSchema = z.object({
  path: z.string().min(1),
  originalPath: z.string().min(1).nullable(),
  indexStatus: z.string().length(1),
  worktreeStatus: z.string().length(1),
  staged: z.boolean(),
  unstaged: z.boolean(),
});

export const gitBranchSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote"]),
  current: z.boolean(),
  hash: z.string().min(1),
  upstream: z.string().min(1).nullable(),
});

export const gitStatusSchema = z.object({
  branch: z.string(),
  head: z.string().nullable(),
  upstream: z.string().min(1).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(gitFileChangeSchema),
  branches: z.array(gitBranchSchema),
});

const gitPathsSchema = z.array(z.string().min(1).max(4_096)).min(1).max(1_000);
export const gitActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("unstage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("stageAll") }),
  z.object({ type: z.literal("unstageAll") }),
  z.object({
    type: z.literal("commit"),
    message: z.string().trim().min(1).max(10_000),
    all: z.boolean().default(false),
  }),
  z.object({ type: z.literal("pull") }),
  z.object({ type: z.literal("push") }),
  z.object({
    type: z.literal("checkout"),
    branch: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("createBranch"),
    name: z.string().trim().min(1).max(255),
  }),
]);

export const gitActionResultSchema = z.object({
  status: gitStatusSchema,
  output: z.string(),
});

export const workerWorktreeSummarySchema = z.object({
  path: z.string().min(1),
  head: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  detached: z.boolean(),
  isPrimary: z.boolean(),
  managed: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().min(1).nullable(),
  prunable: z.boolean(),
  pruneReason: z.string().min(1).nullable(),
  missing: z.boolean(),
});

export const worktreeInventorySchema = z.object({
  sourcePath: z.string().min(1),
  primaryPath: z.string().min(1),
  gitCommonDir: z.string().min(1),
  managedRoot: z.string().min(1),
  repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  worktrees: z.array(workerWorktreeSummarySchema),
});

export const worktreeCreateModeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("newBranch"),
    branch: z.string().trim().min(1).max(255),
    startPoint: z.string().trim().min(1).max(1_024).nullable().default(null),
  }),
  z.object({
    type: z.literal("existingBranch"),
    branch: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("detached"),
    revision: z.string().trim().min(1).max(1_024),
  }),
]);

export const worktreeCreateResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  inventory: worktreeInventorySchema,
});

export const worktreeMutationResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  inventory: worktreeInventorySchema,
});

export const worktreeRemoveResultSchema = z.object({
  removedPath: z.string().min(1),
  inventory: worktreeInventorySchema,
});

export const worktreePruneResultSchema = z.object({
  prunedPaths: z.array(z.string().min(1)),
  inventory: worktreeInventorySchema,
});

export const worktreeStatusResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  status: gitStatusSchema,
});

export const projectWorktreeCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mode: worktreeCreateModeSchema,
});

export const projectWorktreeLockSchema = z.object({
  reason: z.string().trim().min(1).max(1_000).nullable().default(null),
});

export const projectWorktreeRemoveSchema = z.object({
  force: z.boolean().default(false),
  allowExternal: z.boolean().default(false),
});

export const projectWorktreePruneSchema = z.object({
  allowExternal: z.boolean().default(false),
});

export const projectWorktreePolicyUpdateSchema = z.object({
  policy: worktreePolicySchema,
});

export const chatWorktreeUpdateSchema = z.object({
  worktreeId: z.string().min(1),
  mode: z.enum(["agent-managed", "pinned"]),
});

export const worktreeSelectionSchema = z.object({
  worktreeId: z.string().min(1),
});

export const agentTurnResultSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  text: z.string(),
  status: z.literal("completed"),
});

export const normalizedAgentMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  phase: agentMessagePhaseSchema.nullable(),
  correlation: codexEventCorrelationSchema.nullable().optional(),
});

export const agentThreadSyncItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("userMessage"),
    id: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("agentMessage"),
    ...normalizedAgentMessageSchema.shape,
  }),
  z.object({
    type: z.literal("activity"),
    activity: agentActivitySchema,
  }),
]);

export const agentThreadSyncSchema = z.object({
  threadId: z.string().min(1),
  status: z.enum(["idle", "running", "failed"]),
  turns: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(["completed", "failed", "interrupted", "inProgress"]),
      startedAt: z.number().int().nonnegative().nullable(),
      completedAt: z.number().int().nonnegative().nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
      items: z.array(agentThreadSyncItemSchema),
    }),
  ),
});

const workerRuntimeModelSchema = z.object({
  id: z.string().min(1),
  routeId: z.string().min(1),
  name: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
});

const workerRuntimeProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: modelProviderKindSchema,
  baseUrl: z.url(),
  apiKey: z.string().min(1).nullable(),
});

export const workerChatAttachmentSchema = z.object({
  id: z.string().min(1).max(200),
  fileName: chatAttachmentSummarySchema.shape.fileName,
  mimeType: chatAttachmentSummarySchema.shape.mimeType,
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
  kind: chatAttachmentKindSchema,
});

export const workerAttachmentUploadResultSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
});

export const workerAttachmentReadResultSchema = z.object({
  data: z.string().max(400_000),
  eof: z.boolean(),
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
});

export const workerCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("codex.auth.status"),
    providerId: z.string().min(1),
  }),
  z.object({
    type: z.literal("codex.auth.login.start"),
    providerId: z.string().min(1),
  }),
  z.object({
    type: z.literal("codex.auth.logout"),
    providerId: z.string().min(1),
  }),
  z.object({ type: z.literal("github.auth.status") }),
  z.object({
    type: z.literal("github.repositories.cached"),
    login: z.string().min(1),
  }),
  z.object({ type: z.literal("github.repositories.list") }),
  z.object({
    type: z.literal("github.issues.list"),
    repository: githubRepositorySchema.shape.nameWithOwner,
    kind: githubIssueKindSchema.default("issue"),
    state: githubIssueStateSchema,
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("github.issue.get"),
    repository: githubRepositorySchema.shape.nameWithOwner,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.issue.comment"),
    repository: githubRepositorySchema.shape.nameWithOwner,
    number: z.number().int().positive(),
    body: z.string().trim().min(1).max(65_536),
  }),
  z.object({
    type: z.literal("github.issue.close"),
    repository: githubRepositorySchema.shape.nameWithOwner,
    number: z.number().int().positive(),
    comment: z.string().trim().min(1).max(65_536).nullable(),
  }),
  z.object({
    type: z.literal("project.clone"),
    repository: z.object({
      nameWithOwner: githubRepositorySchema.shape.nameWithOwner,
    }),
  }),
  z.object({
    type: z.literal("project.files.delete"),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("git.history"),
    cwd: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
    revisions: z
      .array(z.string().regex(/^[0-9a-f]{40,64}$/u))
      .max(500)
      .default([]),
  }),
  z.object({
    type: z.literal("git.status"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("git.action"),
    cwd: z.string().min(1),
    action: gitActionSchema,
  }),
  z.object({
    type: z.literal("worktree.list"),
    sourcePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.reconcile"),
    sourcePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.create"),
    sourcePath: z.string().min(1),
    worktreeId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    mode: worktreeCreateModeSchema,
  }),
  z.object({
    type: z.literal("worktree.remove"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
    force: z.boolean().default(false),
    allowExternal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("worktree.lock"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
    reason: z.string().trim().min(1).max(1_000).nullable().default(null),
  }),
  z.object({
    type: z.literal("worktree.unlock"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.prune"),
    sourcePath: z.string().min(1),
    allowExternal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("worktree.status"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("explorer.directory.list"),
    root: z.string().min(1),
    path: z.string(),
  }),
  z.object({
    type: z.literal("explorer.file.read"),
    root: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("skills.list"),
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.inventory.read"),
    cwd: z.string().min(1),
    forceReload: z.boolean().default(false),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.preview"),
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.resource.read"),
    cwd: z.string().min(1),
    server: z.string().trim().min(1).max(256),
    uri: z.string().trim().min(1).max(8_192),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.skill.configure"),
    cwd: z.string().min(1),
    path: codexSkillConfigUpdateSchema.shape.path,
    enabled: z.boolean(),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.skill-roots.set"),
    cwd: z.string().min(1),
    roots: codexSkillRootsUpdateSchema.shape.roots,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.oauth.start"),
    cwd: z.string().min(1),
    server: codexMcpOauthStartSchema.shape.server,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.oauth.status"),
    cwd: z.string().min(1),
    server: codexMcpOauthStartSchema.shape.server,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.reload"),
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.apply"),
    cwd: z.string().min(1),
    itemIds: codexExternalImportApplySchema.shape.itemIds,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.status"),
    cwd: z.string().min(1),
    importId: codexExternalImportStatusSchema.shape.importId,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("permission-profiles.list"),
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("attachment.upload.begin"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    fileName: chatAttachmentSummarySchema.shape.fileName,
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
  }),
  z.object({
    type: z.literal("attachment.upload.chunk"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    chunkIndex: z.number().int().nonnegative(),
    data: z.string().max(400_000),
  }),
  z.object({
    type: z.literal("attachment.upload.complete"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("attachment.read"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    fileName: chatAttachmentSummarySchema.shape.fileName,
    offset: z.number().int().nonnegative(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(256 * 1_024),
  }),
  z.object({
    type: z.literal("attachment.delete"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("terminal.open"),
    terminalId: z.string().min(1),
    attachmentId: z.string().min(1),
    cwd: z.string().min(1),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
    launch: z.discriminatedUnion("type", [
      z.object({ type: z.literal("shell") }),
      z.object({
        type: z.literal("codex"),
        threadId: z.string().min(1).nullable(),
        model: workerRuntimeModelSchema,
        provider: workerRuntimeProviderSchema,
      }),
    ]),
  }),
  z.object({
    type: z.literal("terminal.detach"),
    terminalId: z.string().min(1),
    attachmentId: z.string().min(1),
  }),
  z.object({
    type: z.literal("terminal.input"),
    terminalId: z.string().min(1),
    data: z.string().max(100_000),
  }),
  z.object({
    type: z.literal("terminal.resize"),
    terminalId: z.string().min(1),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("terminal.close"),
    terminalId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.attach"),
    surfaceId: z.string().min(1),
    attachmentId: z.string().min(1),
    projectId: z.string().min(1),
    configuration: remoteSurfaceConfigurationSchema,
    preferredTransport: remoteSurfaceTransportSchema,
    webrtc: remoteSurfaceWebRtcConfigurationSchema.nullable().default(null),
    viewport: remoteSurfaceViewportSchema,
    desktopStream: desktopStreamSettingsSchema.nullable().default(null),
  }),
  z.object({
    type: z.literal("surface.detach"),
    surfaceId: z.string().min(1),
    attachmentId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.suspend"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.resume"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.close"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.desktop.probe"),
  }),
  z.object({
    type: z.literal("chat.turn"),
    chatId: z.string().min(1),
    clientMessageId: z.string().min(1),
    executionLaneId: z.string().min(1),
    worktreeId: z.string().min(1),
    cwd: z.string().min(1),
    isPrimary: z.boolean(),
    worktreeMode: z.enum(["agent-managed", "pinned"]),
    worktreePolicy: worktreePolicySchema,
    threadId: z.string().min(1).nullable(),
    prompt: z.string().min(1),
    attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
    skillNames: z.array(z.string().min(1)).max(64).default([]),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    planMode: planModeSchema,
    automationPaused: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("chat.pause.set"),
    chatId: z.string().min(1),
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal("chat.compact"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.interrupt"),
    chatId: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.goal.get"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.goal.create"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    objective: chatGoalCreateSchema.shape.objective,
    tokenBudget: chatGoalCreateSchema.shape.tokenBudget,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.goal.update"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    status: chatGoalUpdateSchema.shape.status,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.goal.clear"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.thread.ensure"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    planMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.plan.get"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    fallbackMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.plan.set"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    mode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.plan.answer"),
    questionId: z.string().min(1),
    answers: chatPlanAnswerSchema.shape.answers,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.respond"),
    requestKey: z.string().min(1).max(200),
    response: agentInteractionResponseSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.cancel"),
    requestKey: z.string().min(1).max(200),
    reason: z.string().min(1).max(4_000),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.steer"),
    chatId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    prompt: z.string().trim().min(1).max(100_000),
    attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.sync"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
]);

export const workerRequestEnvelopeSchema = z.object({
  kind: z.literal("request"),
  requestId: z.string().min(1),
  command: workerCommandSchema,
});

export const workerResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.literal(false),
    error: z.object({ message: z.string().min(1) }),
  }),
]);

export const workerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.activity"),
    activity: agentActivitySchema,
  }),
  z.object({
    type: z.literal("agent.message"),
    message: normalizedAgentMessageSchema,
  }),
  z.object({ type: z.literal("terminal.ready") }),
  z.object({
    type: z.literal("agent.checkpoint"),
    turnId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent.plan.updated"),
    turnId: z.string().min(1),
    explanation: z.string().nullable(),
    steps: z.array(planStepSchema),
  }),
  z.object({
    type: z.literal("agent.plan.question"),
    question: pendingPlanQuestionSchema,
  }),
  z.object({
    type: z.literal("agent.plan.question-resolved"),
    questionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("agent.interaction.requested"),
    request: agentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.cleared"),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("agent.interaction.expired"),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("terminal.output"),
    data: z.string(),
  }),
]);

export const workerEventEnvelopeSchema = z.object({
  kind: z.literal("event"),
  requestId: z.string().min(1),
  event: workerEventSchema,
});

export type DatabaseEngine = z.infer<typeof databaseEngineSchema>;
export type DeploymentMode = z.infer<typeof deploymentModeSchema>;
export type BootstrapMode = z.infer<typeof bootstrapModeSchema>;
export type AuthMode = z.infer<typeof authModeSchema>;
export type RemoteSurfaceKind = z.infer<typeof remoteSurfaceKindSchema>;
export type RemoteSurfaceTransport = z.infer<
  typeof remoteSurfaceTransportSchema
>;
export type RemoteSurfaceStatus = z.infer<typeof remoteSurfaceStatusSchema>;
export type RemoteSurfaceChannel = z.infer<typeof remoteSurfaceChannelSchema>;
export type RemoteSurfaceCapabilities = z.infer<
  typeof remoteSurfaceCapabilitiesSchema
>;
export type UserSummary = z.infer<typeof userSummarySchema>;
export type ServerBootstrap = z.infer<typeof serverBootstrapSchema>;
export type CodexRuntimeMethodState = z.infer<
  typeof codexRuntimeMethodStateSchema
>;
export type CodexRuntimeFeatureStage = z.infer<
  typeof codexRuntimeFeatureStageSchema
>;
export type CodexRuntimeFeature = z.infer<typeof codexRuntimeFeatureSchema>;
export type CodexRuntimeReport = z.infer<typeof codexRuntimeReportSchema>;
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
export type WorkerSummary = z.infer<typeof workerSummarySchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SystemHealth = z.infer<typeof systemHealthSchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type ModelProviderKind = z.infer<typeof modelProviderKindSchema>;
export type CodexAuthStatus = z.infer<typeof codexAuthStatusSchema>;
export type CodexDeviceLogin = z.infer<typeof codexDeviceLoginSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ModelProviderCreate = z.infer<typeof modelProviderCreateSchema>;
export type ModelProviderUpdate = z.infer<typeof modelProviderUpdateSchema>;
export type ModelProviderSummary = z.infer<typeof modelProviderSummarySchema>;
export type ModelRouteInput = z.infer<typeof modelRouteInputSchema>;
export type ModelRouteSummary = z.infer<typeof modelRouteSummarySchema>;
export type ModelProfileCreate = z.infer<typeof modelProfileCreateSchema>;
export type ModelProfileUpdate = z.infer<typeof modelProfileUpdateSchema>;
export type ModelProfileSummary = z.infer<typeof modelProfileSummarySchema>;
export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;
export type SettingsBundle = z.infer<typeof settingsBundleSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type WorktreePolicy = z.infer<typeof worktreePolicySchema>;
export type WorktreeOrigin = z.infer<typeof worktreeOriginSchema>;
export type WorktreeLifecycleState = z.infer<
  typeof worktreeLifecycleStateSchema
>;
export type ProjectWorktreeSummary = z.infer<
  typeof projectWorktreeSummarySchema
>;
export type GithubAuthStatus = z.infer<typeof githubAuthStatusSchema>;
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
export type GithubIssueState = z.infer<typeof githubIssueStateSchema>;
export type GithubIssueKind = z.infer<typeof githubIssueKindSchema>;
export type GithubIssueSummary = z.infer<typeof githubIssueSummarySchema>;
export type GithubIssueList = z.infer<typeof githubIssueListSchema>;
export type GithubIssueComment = z.infer<typeof githubIssueCommentSchema>;
export type GithubIssueDetail = z.infer<typeof githubIssueDetailSchema>;
export type GithubWorkerRepository = z.infer<
  typeof githubWorkerRepositorySchema
>;
export type GithubProjectCreate = z.infer<typeof githubProjectCreateSchema>;
export type ProjectCloneResult = z.infer<typeof projectCloneResultSchema>;
export type ProjectRemove = z.infer<typeof projectRemoveSchema>;
export type GitRef = z.infer<typeof gitRefSchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitHistory = z.infer<typeof gitHistorySchema>;
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitAction = z.infer<typeof gitActionSchema>;
export type GitActionResult = z.infer<typeof gitActionResultSchema>;
export type WorkerWorktreeSummary = z.infer<typeof workerWorktreeSummarySchema>;
export type WorktreeInventory = z.infer<typeof worktreeInventorySchema>;
export type WorktreeCreateMode = z.infer<typeof worktreeCreateModeSchema>;
export type WorktreeCreateResult = z.infer<typeof worktreeCreateResultSchema>;
export type WorktreeMutationResult = z.infer<
  typeof worktreeMutationResultSchema
>;
export type WorktreeRemoveResult = z.infer<typeof worktreeRemoveResultSchema>;
export type WorktreePruneResult = z.infer<typeof worktreePruneResultSchema>;
export type WorktreeStatusResult = z.infer<typeof worktreeStatusResultSchema>;
export type ProjectWorktreeCreate = z.infer<typeof projectWorktreeCreateSchema>;
export type ProjectWorktreeLock = z.infer<typeof projectWorktreeLockSchema>;
export type ProjectWorktreeRemove = z.infer<typeof projectWorktreeRemoveSchema>;
export type ProjectWorktreePrune = z.infer<typeof projectWorktreePruneSchema>;
export type ProjectWorktreePolicyUpdate = z.infer<
  typeof projectWorktreePolicyUpdateSchema
>;
export type ChatWorktreeUpdate = z.infer<typeof chatWorktreeUpdateSchema>;
export type WorktreeSelection = z.infer<typeof worktreeSelectionSchema>;
export type ChatCreate = z.infer<typeof chatCreateSchema>;
export type ChatUpdate = z.infer<typeof chatUpdateSchema>;
export type ChatFork = z.infer<typeof chatForkSchema>;
export type OrderedIds = z.infer<typeof orderedIdsSchema>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export type PermissionProfileSummary = z.infer<
  typeof permissionProfileSummarySchema
>;
export type PermissionProfileCapability = z.infer<
  typeof permissionProfileCapabilitySchema
>;
export type ChatPermissionProfileState = z.infer<
  typeof chatPermissionProfileStateSchema
>;
export type ChatPermissionProfileUpdate = z.infer<
  typeof chatPermissionProfileUpdateSchema
>;
export type TerminalCreate = z.infer<typeof terminalCreateSchema>;
export type TerminalUpdate = z.infer<typeof terminalUpdateSchema>;
export type TerminalSummary = z.infer<typeof terminalSummarySchema>;
export type ExplorerCreate = z.infer<typeof explorerCreateSchema>;
export type ExplorerUpdate = z.infer<typeof explorerUpdateSchema>;
export type ExplorerSummary = z.infer<typeof explorerSummarySchema>;
export type BrowserCreate = z.infer<typeof browserCreateSchema>;
export type BrowserUpdate = z.infer<typeof browserUpdateSchema>;
export type BrowserSummary = z.infer<typeof browserSummarySchema>;
export type RemoteDesktopCreate = z.infer<typeof remoteDesktopCreateSchema>;
export type RemoteDesktopSummary = z.infer<typeof remoteDesktopSummarySchema>;
export type RemoteSurfaceConfiguration = z.infer<
  typeof remoteSurfaceConfigurationSchema
>;
export type RemoteSurfaceCreate = z.infer<typeof remoteSurfaceCreateSchema>;
export type RemoteSurfaceUpdate = z.infer<typeof remoteSurfaceUpdateSchema>;
export type RemoteSurfaceSummary = z.infer<typeof remoteSurfaceSummarySchema>;
export type RemoteSurfaceViewport = z.infer<typeof remoteSurfaceViewportSchema>;
export type DesktopStreamSettings = z.infer<typeof desktopStreamSettingsSchema>;
export type RemoteSurfaceConnectionMessage = z.infer<
  typeof remoteSurfaceConnectionMessageSchema
>;
export type RemoteSurfaceIceServer = z.infer<
  typeof remoteSurfaceIceServerSchema
>;
export type RemoteSurfaceWebRtcConfiguration = z.infer<
  typeof remoteSurfaceWebRtcConfigurationSchema
>;
export type RemoteSurfaceWebRtcSignal = z.infer<
  typeof remoteSurfaceWebRtcSignalSchema
>;
export type RemoteSurfaceAttachResult = z.infer<
  typeof remoteSurfaceAttachResultSchema
>;
export type RemoteSurfaceControl = z.infer<typeof remoteSurfaceControlSchema>;
export type RemoteDesktopProbeResult = z.infer<
  typeof remoteDesktopProbeResultSchema
>;
export type RemoteDesktopClientMessage = z.infer<
  typeof remoteDesktopClientMessageSchema
>;
export type RemoteDesktopServerMessage = z.infer<
  typeof remoteDesktopServerMessageSchema
>;
export type RemoteBrowserClientMessage = z.infer<
  typeof remoteBrowserClientMessageSchema
>;
export type RemoteBrowserServerMessage = z.infer<
  typeof remoteBrowserServerMessageSchema
>;
export type RemoteBrowserCursorMessage = z.infer<
  typeof remoteBrowserCursorMessageSchema
>;
export type RemoteBrowserClipboardMessage = z.infer<
  typeof remoteBrowserClipboardMessageSchema
>;
export type RemoteSurfaceFrameHeader = z.infer<
  typeof remoteSurfaceFrameHeaderSchema
>;
export type ProjectViewKind = z.infer<typeof projectViewKindSchema>;
export type ProjectViewCreate = z.infer<typeof projectViewCreateSchema>;
export type ProjectViewUpdate = z.infer<typeof projectViewUpdateSchema>;
export type ProjectViewSummary = z.infer<typeof projectViewSummarySchema>;
export type ExplorerEntry = z.infer<typeof explorerEntrySchema>;
export type ExplorerDirectory = z.infer<typeof explorerDirectorySchema>;
export type ExplorerFile = z.infer<typeof explorerFileSchema>;
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
export type TerminalOpenResult = z.infer<typeof terminalOpenResultSchema>;
export type AgentMessagePhase = z.infer<typeof agentMessagePhaseSchema>;
export type CodexEventCorrelation = z.infer<typeof codexEventCorrelationSchema>;
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>;
export type ChatMessageCreate = z.infer<typeof chatMessageCreateSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatAttachmentKind = z.infer<typeof chatAttachmentKindSchema>;
export type ChatAttachmentSource = z.infer<typeof chatAttachmentSourceSchema>;
export type ChatAttachmentSummary = z.infer<typeof chatAttachmentSummarySchema>;
export type ChatExecutionLaneActor = z.infer<
  typeof chatExecutionLaneActorSchema
>;
export type ChatExecutionLaneState = z.infer<
  typeof chatExecutionLaneStateSchema
>;
export type ChatExecutionLaneSummary = z.infer<
  typeof chatExecutionLaneSummarySchema
>;
export type ChatExecutionLaneRelease = z.infer<
  typeof chatExecutionLaneReleaseSchema
>;
export type AgentInteractionRequestKind = z.infer<
  typeof agentInteractionRequestKindSchema
>;
export type AgentInteractionRequestStatus = z.infer<
  typeof agentInteractionRequestStatusSchema
>;
export type AgentInteractionProvenance = z.infer<
  typeof agentInteractionProvenanceSchema
>;
export type AgentInteractionRequestPayload = z.infer<
  typeof agentInteractionRequestPayloadSchema
>;
export type AgentInteractionResponse = z.infer<
  typeof agentInteractionResponseSchema
>;
export type AgentInteractionRequestCreate = z.infer<
  typeof agentInteractionRequestCreateSchema
>;
export type AgentInteractionResolutionCreate = z.infer<
  typeof agentInteractionResolutionCreateSchema
>;
export type AgentInteractionRuntimeRequest = z.infer<
  typeof agentInteractionRuntimeRequestSchema
>;
export type AgentInteractionAccepted = z.infer<
  typeof agentInteractionAcceptedSchema
>;
export type AgentInteractionRequest = z.infer<
  typeof agentInteractionRequestSchema
>;
export type AgentInteractionRequestQuery = z.infer<
  typeof agentInteractionRequestQuerySchema
>;
export type AgentWorktreeToolName = z.infer<typeof agentWorktreeToolNameSchema>;
export type AgentWorktreeToolCall = z.infer<typeof agentWorktreeToolCallSchema>;
export type AgentWorktreeToolResult = z.infer<
  typeof agentWorktreeToolResultSchema
>;
export type ChatTurnCreate = z.infer<typeof chatTurnCreateSchema>;
export type ChatTurnMode = z.infer<typeof chatTurnModeSchema>;
export type QueuedPrompt = z.infer<typeof queuedPromptSchema>;
export type QueuedPromptCreate = z.infer<typeof queuedPromptCreateSchema>;
export type QueuedPromptUpdate = z.infer<typeof queuedPromptUpdateSchema>;
export type QueuedPromptOrder = z.infer<typeof queuedPromptOrderSchema>;
export type ChatModelUpdate = z.infer<typeof chatModelUpdateSchema>;
export type ChatCompactAccepted = z.infer<typeof chatCompactAcceptedSchema>;
export type ChatInterruptAccepted = z.infer<typeof chatInterruptAcceptedSchema>;
export type ChatPauseUpdate = z.infer<typeof chatPauseUpdateSchema>;
export type ChatPauseState = z.infer<typeof chatPauseStateSchema>;
export type ThreadGoalStatus = z.infer<typeof threadGoalStatusSchema>;
export type ThreadGoal = z.infer<typeof threadGoalSchema>;
export type ChatGoalResponse = z.infer<typeof chatGoalResponseSchema>;
export type ChatGoalCreate = z.infer<typeof chatGoalCreateSchema>;
export type ChatGoalUpdate = z.infer<typeof chatGoalUpdateSchema>;
export type ChatGoalClear = z.infer<typeof chatGoalClearSchema>;
export type PlanMode = z.infer<typeof planModeSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanQuestionOption = z.infer<typeof planQuestionOptionSchema>;
export type PlanQuestion = z.infer<typeof planQuestionSchema>;
export type PendingPlanQuestion = z.infer<typeof pendingPlanQuestionSchema>;
export type ChatPlanState = z.infer<typeof chatPlanStateSchema>;
export type ChatPlanUpdate = z.infer<typeof chatPlanUpdateSchema>;
export type ChatPlanAnswer = z.infer<typeof chatPlanAnswerSchema>;
export type ChatPlanAccepted = z.infer<typeof chatPlanAcceptedSchema>;
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type NormalizedAgentMessage = z.infer<
  typeof normalizedAgentMessageSchema
>;
export type AgentThreadSync = z.infer<typeof agentThreadSyncSchema>;
export type AgentThreadSyncItem = z.infer<typeof agentThreadSyncItemSchema>;
export type WorkerChatAttachment = z.infer<typeof workerChatAttachmentSchema>;
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
export type WorkerAttachmentUploadResult = z.infer<
  typeof workerAttachmentUploadResultSchema
>;
export type WorkerAttachmentReadResult = z.infer<
  typeof workerAttachmentReadResultSchema
>;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type WorkerRequestEnvelope = z.infer<typeof workerRequestEnvelopeSchema>;
export type WorkerResponseEnvelope = z.infer<
  typeof workerResponseEnvelopeSchema
>;
export type WorkerEventEnvelope = z.infer<typeof workerEventEnvelopeSchema>;
