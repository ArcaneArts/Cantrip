import { z } from "zod";

export * from "./live.js";

import {
  workflowJsonObjectSchema,
  workflowNodeExecutionRequestSchema,
  workflowNodeExecutionResultSchema,
  workflowRepositoryDocumentSchema,
} from "./workflows.js";

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

export const codeTransportSchema = z.literal("web-proxy");
export const codeCapabilitiesSchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).nullable(),
  upstreamRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  patchset: z.number().int().nonnegative(),
  transport: codeTransportSchema,
  maxSessions: z.number().int().positive(),
  reason: z.string().min(1).nullable(),
});

export const unavailableCodeCapabilities = codeCapabilitiesSchema.parse({
  available: false,
  version: null,
  upstreamRevision: null,
  patchset: 0,
  transport: "web-proxy",
  maxSessions: 1,
  reason: "This worker has not reported a Cantrip Code runtime.",
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
    code: z.object({
      enabled: z.boolean(),
      transport: codeTransportSchema,
      isolatedOrigin: z.literal(true),
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
  code: codeCapabilitiesSchema.optional(),
  startedAt: z.string().datetime(),
});

export const workerSummarySchema = workerHeartbeatSchema.extend({
  code: codeCapabilitiesSchema.default(unavailableCodeCapabilities),
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
  live: z.object({
    acceptedConnectionCount: z.number().int().nonnegative(),
    connectionCount: z.number().int().nonnegative(),
    currentCursor: z.number().int().nonnegative(),
    deliveredEventCount: z.number().int().nonnegative(),
    disconnectedConnectionCount: z.number().int().nonnegative(),
    heartbeatPongCount: z.number().int().nonnegative(),
    heartbeatTimeoutCount: z.number().int().nonnegative(),
    protocolViolationCount: z.number().int().nonnegative(),
    publicationCount: z.number().int().nonnegative(),
    queuePressureCount: z.number().int().nonnegative(),
    replayEventCount: z.number().int().nonnegative(),
    replaySessionCount: z.number().int().nonnegative(),
    replayedEventCount: z.number().int().nonnegative(),
    resyncRequiredCount: z.number().int().nonnegative(),
    resumeAttemptCount: z.number().int().nonnegative(),
    serverEpoch: z.string().uuid(),
    slowConsumerClosureCount: z.number().int().nonnegative(),
  }),
  timestamp: z.string().datetime(),
});

export const themePreferenceSchema = z.enum(["system", "light", "dark"]);

export const DEFAULT_SIDEBAR_WIDTH = 288;
export const MIN_SIDEBAR_WIDTH = 192;
export const MAX_SIDEBAR_WIDTH = 480;
export const sidebarWidthPreferenceSchema = z
  .number()
  .int()
  .min(MIN_SIDEBAR_WIDTH)
  .max(MAX_SIDEBAR_WIDTH);
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
  sidebarWidth: sidebarWidthPreferenceSchema,
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

export const githubPullRequestCreateSchema = z
  .object({
    base: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
        message: "Base branch cannot contain control characters.",
      }),
    head: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
        message: "Head branch cannot contain control characters.",
      }),
    title: z.string().trim().min(1).max(256),
    body: z.string().max(1_000_000).default(""),
    draft: z.boolean().default(false),
    labels: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    reviewers: z
      .array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u))
      .max(100)
      .default([]),
    linkedIssueNumbers: z
      .array(z.number().int().positive())
      .max(100)
      .default([]),
  })
  .superRefine((request, context) => {
    if (request.base === request.head) {
      context.addIssue({
        code: "custom",
        path: ["head"],
        message: "Pull request head and base branches must differ.",
      });
    }
  });

export const githubPullRequestSummarySchema = githubIssueSummarySchema.extend({
  body: z.string().nullable(),
  draft: z.boolean(),
  merged: z.boolean(),
  headRef: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  baseRef: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
});

export const githubPullRequestCreateResultSchema = z.object({
  pullRequest: githubPullRequestSummarySchema,
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
});

export const githubPullRequestCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  shortSha: z.string().regex(/^[0-9a-f]{7,12}$/u),
  message: z.string().max(1_000_000),
  author: z.string().min(1).max(1_000),
  authoredAt: z.string().datetime().nullable(),
  url: z.url(),
});

export const githubPullRequestFileSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  path: z.string().min(1).max(8_192),
  previousPath: z.string().min(1).max(8_192).nullable(),
  status: z.string().min(1).max(64),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  blobUrl: z.url(),
  rawUrl: z.url().nullable(),
  patch: z.string().max(1_000_000).nullable(),
  patchTruncated: z.boolean(),
});

export const githubPullRequestCheckSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(1_000),
  source: z.enum(["check-run", "commit-status"]),
  status: z.enum(["queued", "in-progress", "completed"]),
  conclusion: z.string().min(1).max(100).nullable(),
  url: z.url().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  summary: z.string().max(100_000).nullable(),
});

export const githubPullRequestReviewSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  state: z.enum([
    "approved",
    "changes-requested",
    "commented",
    "dismissed",
    "pending",
  ]),
  body: z.string().max(1_000_000),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  submittedAt: z.string().datetime().nullable(),
  url: z.url().nullable(),
});

export const githubPullRequestDetailSchema =
  githubPullRequestSummarySchema.extend({
    comments: z.array(githubIssueCommentSchema).max(100),
    commentsTruncated: z.boolean(),
    requestedReviewers: z.array(z.string().min(1)).max(100),
    mergeable: z.boolean().nullable(),
    mergeableState: z.string().min(1).max(100),
    reviewDecision: z.enum([
      "approved",
      "changes-requested",
      "review-required",
      "reviewed",
      "none",
    ]),
    checksState: z.enum(["success", "failure", "pending", "neutral", "none"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
    commitCount: z.number().int().nonnegative(),
    commits: z.array(githubPullRequestCommitSchema).max(100),
    commitsTruncated: z.boolean(),
    files: z.array(githubPullRequestFileSchema).max(100),
    filesTruncated: z.boolean(),
    checks: z.array(githubPullRequestCheckSchema).max(200),
    checksTruncated: z.boolean(),
    reviews: z.array(githubPullRequestReviewSchema).max(100),
    reviewsTruncated: z.boolean(),
  });

export const githubReleaseSummarySchema = z.object({
  id: z.number().int().positive(),
  tagName: z.string().min(1).max(1_000),
  name: z.string().min(1).max(10_000),
  body: z.string().max(1_000_000),
  url: z.url(),
  author: z.string().min(1),
  draft: z.boolean(),
  prerelease: z.boolean(),
  createdAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
});

export const githubReleaseListSchema = z.object({
  releases: z.array(githubReleaseSummarySchema).max(100),
  truncated: z.boolean(),
});

export const githubReleaseCreateSchema = z.object({
  tagName: z.string().trim().min(1).max(1_000),
  name: z.string().trim().min(1).max(10_000),
  body: z.string().max(1_000_000),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export const githubProjectCreateSchema = z.object({
  workerId: z.string().min(1),
  repositoryId: z.string().min(1),
  nameWithOwner: githubRepositorySchema.shape.nameWithOwner,
  url: z.url(),
  workspaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
});

export const projectWorkspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const projectWorkspaceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    projectIds: z.array(z.string().min(1)).max(10_000).optional(),
  })
  .refine(
    (input) => input.name !== undefined || input.projectIds !== undefined,
    { message: "At least one workspace field is required." },
  );

export const projectWorkspaceSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  projectIds: z.array(z.string().min(1)),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectWorkspaceListSchema = z.array(
  projectWorkspaceSummarySchema,
);

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
  tabGroupId: z.string().min(1).optional(),
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
  tabGroupId: z.string().min(1).optional(),
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

export const scriptCommandKindSchema = z.enum([
  "package",
  "dart",
  "just",
  "cargo",
  "gradle",
  "make",
]);

const scriptCommandTextSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Script command text cannot contain control characters.",
  });

export const scriptCommandSchema = z.object({
  id: z.string().min(1).max(512),
  kind: scriptCommandKindSchema,
  name: scriptCommandTextSchema.max(200),
  command: scriptCommandTextSchema.max(4_096),
  description: scriptCommandTextSchema.max(4_096).nullable(),
  source: scriptCommandTextSchema.max(512),
});

export const scriptCommandListSchema = z.array(scriptCommandSchema).max(500);

export const explorerCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Explorer"),
  worktreeId: z.string().min(1).optional(),
  tabGroupId: z.string().min(1).optional(),
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

export const codeThemeModeSchema = z.enum(["follow-cantrip", "independent"]);
export const codeAppearanceSchema = z.enum([
  "light",
  "dark",
  "high-contrast-light",
  "high-contrast-dark",
]);
export const codeTabStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "stopped",
  "offline",
  "failed",
]);
export const codeSessionStatusSchema = z.enum([
  "starting",
  "running",
  "idle",
  "stopping",
  "stopped",
  "offline",
  "failed",
]);

export const codeTabCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Code"),
  worktreeId: z.string().min(1).optional(),
  profileId: z.string().trim().min(1).max(200).default("default"),
  themeMode: codeThemeModeSchema.default("follow-cantrip"),
  tabGroupId: z.string().min(1).optional(),
});

export const codeTabUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    themeMode: codeThemeModeSchema.optional(),
  })
  .refine(
    (input) => input.title !== undefined || input.themeMode !== undefined,
    { message: "At least one Code tab field is required." },
  );

export const codeTabSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  profileId: z.string().min(1),
  themeMode: codeThemeModeSchema,
  status: codeTabStatusSchema,
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const codeTabListSchema = z.array(codeTabSummarySchema);

export const codeEditorBuildSchema = z.object({
  version: z.string().min(1),
  upstreamRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  patchset: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const codeProbeResultSchema = z.object({
  capabilities: codeCapabilitiesSchema,
  editorBuild: codeEditorBuildSchema.nullable(),
});

export const codeSessionSummarySchema = z.object({
  id: z.string().min(1),
  codeTabId: z.string().min(1),
  projectId: z.string().min(1),
  workerId: z.string().min(1),
  worktreeId: z.string().min(1),
  profileId: z.string().min(1),
  editorBuild: codeEditorBuildSchema.nullable(),
  status: codeSessionStatusSchema,
  processInstanceId: z.string().min(1).nullable(),
  lastAttachmentAt: z.string().datetime().nullable(),
  lastStartedAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const codeSessionListSchema = z.array(codeSessionSummarySchema);

export const codeDirtyEditorSchema = z.object({
  uri: z.string().min(1).max(16_384),
  relativePath: z.string().max(8_192).nullable(),
  untitled: z.boolean(),
  dirty: z.literal(true),
});

export const codeSaveBeforeAgentTurnSchema = z.enum(["always", "ask", "never"]);

export const codeWorkbenchAgentStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
]);

export const codeWorkbenchActiveEditorSchema = z.object({
  uri: z.string().min(1).max(16_384),
  relativePath: z.string().max(8_192).nullable(),
  selection: z.object({
    startLine: z.number().int().nonnegative(),
    startCharacter: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    endCharacter: z.number().int().nonnegative(),
  }),
});

export const codeWorkbenchGitStateSchema = z.object({
  branch: z.string().max(1_000).nullable(),
  head: z.string().max(200).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  staged: z.number().int().nonnegative(),
  unstaged: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});

export const codeWorkbenchStateSchema = z.object({
  activeEditor: codeWorkbenchActiveEditorSchema.nullable(),
  git: codeWorkbenchGitStateSchema.nullable(),
  conflicts: z.array(codeDirtyEditorSchema).max(1_000),
  savePolicy: codeSaveBeforeAgentTurnSchema,
  agentStatus: codeWorkbenchAgentStatusSchema,
});

export const codeRuntimeStatusSchema = z.object({
  sessionId: z.string().min(1),
  workspaceUri: z.string().min(1).max(16_384).optional(),
  status: codeSessionStatusSchema,
  editorBuild: codeEditorBuildSchema,
  processInstanceId: z.string().min(1).nullable(),
  bridgeConnected: z.boolean(),
  dirtyEditors: z.array(codeDirtyEditorSchema).max(1_000),
  workbench: codeWorkbenchStateSchema,
  startedAt: z.string().datetime().nullable(),
  lastActivityAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});

export const codeSaveAllResultSchema = z.object({
  saved: z.array(z.string().max(16_384)).max(1_000),
  failed: z
    .array(
      z.object({
        uri: z.string().min(1).max(16_384),
        message: z.string().min(1).max(4_000),
      }),
    )
    .max(1_000),
});

export const codeAgentTurnPreparationSessionSchema = z.object({
  sessionId: z.string().min(1),
  bridgeConnected: z.boolean(),
  allowed: z.boolean(),
  policy: codeSaveBeforeAgentTurnSchema.nullable(),
  dirtyEditors: z.array(codeDirtyEditorSchema).max(1_000),
  saved: z.array(z.string().max(16_384)).max(1_000),
  failed: codeSaveAllResultSchema.shape.failed,
  reason: z.string().max(4_000).nullable(),
});

export const codeAgentTurnPreparationResultSchema = z.object({
  prepared: z.boolean(),
  sessions: z.array(codeAgentTurnPreparationSessionSchema).max(128),
});

export const codeAgentTurnNotificationResultSchema = z.object({
  notifiedSessions: z.number().int().nonnegative(),
  refreshed: z.array(z.string().max(8_192)).max(5_000),
  conflicts: z.array(codeDirtyEditorSchema).max(1_000),
});

export const codeAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  sessionId: z.string().min(1),
  url: z.url(),
  expiresAt: z.string().datetime(),
  runtime: codeRuntimeStatusSchema,
});

export const projectShareAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  protocol: z.literal("webdav"),
  url: z.url(),
  username: z.string().min(1).max(128),
  password: z.string().min(24).max(256),
  realm: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
  mountLeaseMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000),
});

export const projectSharePublicBasePathSchema = z
  .string()
  .regex(/^\/project-shares\/[A-Za-z0-9_-]{43}$/u);

export const projectSharePublicOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value
  );
});

export const codeAttachmentCreateSchema = z.object({
  appearance: codeAppearanceSchema.default("dark"),
});

export const codeThemeUpdateSchema = z.object({
  themeMode: codeThemeModeSchema,
  appearance: codeAppearanceSchema,
});

const codeTunnelHeaderListSchema = z
  .array(z.tuple([z.string().min(1).max(256), z.string().max(16 * 1_024)]))
  .max(256);

const codeTunnelFrameBaseSchema = z.object({
  protocolVersion: z.literal(1),
  attachmentId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  streamId: z.string().min(1).max(200),
});

export const codeTunnelFrameHeaderSchema = z.discriminatedUnion("kind", [
  codeTunnelFrameBaseSchema.extend({
    kind: z.literal("http-request-start"),
    method: z
      .string()
      .regex(/^[A-Z]+$/u)
      .max(32),
    path: z
      .string()
      .min(1)
      .max(32 * 1_024)
      .refine((value) => value.startsWith("/") && !value.startsWith("//")),
    basePath: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.startsWith("/") && !value.startsWith("//")),
    headers: codeTunnelHeaderListSchema,
  }),
  codeTunnelFrameBaseSchema.extend({ kind: z.literal("http-request-data") }),
  codeTunnelFrameBaseSchema.extend({ kind: z.literal("http-request-end") }),
  codeTunnelFrameBaseSchema.extend({
    kind: z.literal("http-response-start"),
    statusCode: z.number().int().min(100).max(599),
    headers: codeTunnelHeaderListSchema,
  }),
  codeTunnelFrameBaseSchema.extend({ kind: z.literal("http-response-data") }),
  codeTunnelFrameBaseSchema.extend({ kind: z.literal("http-response-end") }),
  codeTunnelFrameBaseSchema.extend({ kind: z.literal("http-response-pause") }),
  codeTunnelFrameBaseSchema.extend({ kind: z.literal("http-response-resume") }),
  codeTunnelFrameBaseSchema.extend({
    kind: z.literal("websocket-open"),
    path: z
      .string()
      .min(1)
      .max(32 * 1_024)
      .refine((value) => value.startsWith("/") && !value.startsWith("//")),
    basePath: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.startsWith("/") && !value.startsWith("//")),
    headers: codeTunnelHeaderListSchema,
  }),
  codeTunnelFrameBaseSchema.extend({
    kind: z.literal("websocket-opened"),
    headers: codeTunnelHeaderListSchema,
  }),
  codeTunnelFrameBaseSchema.extend({
    kind: z.literal("websocket-data"),
    binary: z.boolean(),
  }),
  codeTunnelFrameBaseSchema.extend({
    kind: z.literal("websocket-close"),
    code: z.number().int().min(1_000).max(4_999),
    reason: z.string().max(1_024),
  }),
  codeTunnelFrameBaseSchema.extend({
    kind: z.literal("cancel"),
    reason: z.string().max(1_024),
  }),
  codeTunnelFrameBaseSchema.extend({
    kind: z.literal("error"),
    message: z.string().min(1).max(4_000),
  }),
]);

export const CODE_TUNNEL_MAX_HEADER_BYTES = 64 * 1_024;
export const CODE_TUNNEL_MAX_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
const CODE_TUNNEL_FRAME_MAGIC = new Uint8Array([0x43, 0x54, 0x43, 0x44]);

export function isCodeTunnelFrame(frame: Uint8Array): boolean {
  return (
    frame.byteLength >= CODE_TUNNEL_FRAME_MAGIC.byteLength &&
    CODE_TUNNEL_FRAME_MAGIC.every((value, index) => frame[index] === value)
  );
}

export function encodeCodeTunnelFrame(
  header: CodeTunnelFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const parsedHeader = codeTunnelFrameHeaderSchema.parse(header);
  if (payload.byteLength > CODE_TUNNEL_MAX_PAYLOAD_BYTES) {
    throw new Error("Cantrip Code tunnel payload exceeds the protocol limit.");
  }
  const encodedHeader = new TextEncoder().encode(JSON.stringify(parsedHeader));
  if (encodedHeader.byteLength > CODE_TUNNEL_MAX_HEADER_BYTES) {
    throw new Error("Cantrip Code tunnel header exceeds the protocol limit.");
  }
  const frame = new Uint8Array(
    8 + encodedHeader.byteLength + payload.byteLength,
  );
  frame.set(CODE_TUNNEL_FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, encodedHeader.byteLength, false);
  frame.set(encodedHeader, 8);
  frame.set(payload, 8 + encodedHeader.byteLength);
  return frame;
}

export function decodeCodeTunnelFrame(frame: Uint8Array): {
  header: CodeTunnelFrameHeader;
  payload: Uint8Array;
} {
  if (frame.byteLength < 8 || !isCodeTunnelFrame(frame)) {
    throw new Error("Cantrip Code tunnel frame has an invalid magic value.");
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(4, false);
  if (headerLength < 1 || headerLength > CODE_TUNNEL_MAX_HEADER_BYTES) {
    throw new Error("Cantrip Code tunnel frame header length is invalid.");
  }
  const payloadOffset = 8 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error("Cantrip Code tunnel frame header is truncated.");
  }
  if (frame.byteLength - payloadOffset > CODE_TUNNEL_MAX_PAYLOAD_BYTES) {
    throw new Error("Cantrip Code tunnel payload exceeds the protocol limit.");
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      new TextDecoder().decode(frame.subarray(8, payloadOffset)),
    );
  } catch {
    throw new Error("Cantrip Code tunnel frame header is not valid JSON.");
  }
  return {
    header: codeTunnelFrameHeaderSchema.parse(rawHeader),
    payload: frame.subarray(payloadOffset),
  };
}

const projectShareTunnelFrameBaseSchema = z.object({
  protocolVersion: z.literal(1),
  shareId: z.string().min(1).max(200),
  streamId: z.string().min(1).max(200),
});

export const projectShareTunnelFrameHeaderSchema = z.discriminatedUnion(
  "kind",
  [
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("http-request-start"),
      method: z
        .string()
        .regex(/^[A-Z]+$/u)
        .max(32),
      path: z
        .string()
        .min(1)
        .max(32 * 1_024)
        .refine((value) => value.startsWith("/") && !value.startsWith("//")),
      headers: codeTunnelHeaderListSchema,
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("http-request-data"),
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("http-request-end"),
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("http-response-start"),
      statusCode: z.number().int().min(100).max(599),
      headers: codeTunnelHeaderListSchema,
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("http-response-data"),
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("http-response-end"),
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("http-response-pause"),
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("http-response-resume"),
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("cancel"),
      reason: z.string().max(1_024),
    }),
    projectShareTunnelFrameBaseSchema.extend({
      kind: z.literal("error"),
      message: z.string().min(1).max(4_000),
    }),
  ],
);

export const PROJECT_SHARE_TUNNEL_MAX_HEADER_BYTES = 64 * 1_024;
export const PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
const PROJECT_SHARE_TUNNEL_FRAME_MAGIC = new Uint8Array([
  0x43, 0x54, 0x50, 0x53,
]);

export function isProjectShareTunnelFrame(frame: Uint8Array): boolean {
  return (
    frame.byteLength >= PROJECT_SHARE_TUNNEL_FRAME_MAGIC.byteLength &&
    PROJECT_SHARE_TUNNEL_FRAME_MAGIC.every(
      (value, index) => frame[index] === value,
    )
  );
}

export function encodeProjectShareTunnelFrame(
  header: ProjectShareTunnelFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const parsedHeader = projectShareTunnelFrameHeaderSchema.parse(header);
  if (payload.byteLength > PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES) {
    throw new Error("Project share tunnel payload exceeds the protocol limit.");
  }
  const encodedHeader = new TextEncoder().encode(JSON.stringify(parsedHeader));
  if (encodedHeader.byteLength > PROJECT_SHARE_TUNNEL_MAX_HEADER_BYTES) {
    throw new Error("Project share tunnel header exceeds the protocol limit.");
  }
  const frame = new Uint8Array(
    8 + encodedHeader.byteLength + payload.byteLength,
  );
  frame.set(PROJECT_SHARE_TUNNEL_FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, encodedHeader.byteLength, false);
  frame.set(encodedHeader, 8);
  frame.set(payload, 8 + encodedHeader.byteLength);
  return frame;
}

export function decodeProjectShareTunnelFrame(frame: Uint8Array): {
  header: ProjectShareTunnelFrameHeader;
  payload: Uint8Array;
} {
  if (frame.byteLength < 8 || !isProjectShareTunnelFrame(frame)) {
    throw new Error("Project share tunnel frame has an invalid magic value.");
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(4, false);
  if (
    headerLength < 1 ||
    headerLength > PROJECT_SHARE_TUNNEL_MAX_HEADER_BYTES
  ) {
    throw new Error("Project share tunnel frame header length is invalid.");
  }
  const payloadOffset = 8 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error("Project share tunnel frame header is truncated.");
  }
  if (
    frame.byteLength - payloadOffset >
    PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES
  ) {
    throw new Error("Project share tunnel payload exceeds the protocol limit.");
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      new TextDecoder().decode(frame.subarray(8, payloadOffset)),
    );
  } catch {
    throw new Error("Project share tunnel frame header is not valid JSON.");
  }
  return {
    header: projectShareTunnelFrameHeaderSchema.parse(rawHeader),
    payload: frame.subarray(payloadOffset),
  };
}

export const browserCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Browser"),
  tabGroupId: z.string().min(1).optional(),
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

export const remoteDesktopCreateSchema = z
  .object({ tabGroupId: z.string().min(1).optional() })
  .strict();

export const remoteDesktopTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("monitor"),
    id: z.string().min(1).max(200).nullable().default(null),
    name: z.string().trim().min(1).max(500).nullable().default(null),
  }),
  z.object({
    kind: z.literal("window"),
    id: z.string().min(1).max(200).nullable().default(null),
    application: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(1_000).nullable().default(null),
  }),
]);

export const remoteDesktopMonitorSchema = z.object({
  kind: z.literal("monitor"),
  id: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(500),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  primary: z.boolean(),
});

export const remoteDesktopWindowSchema = z.object({
  kind: z.literal("window"),
  id: z.string().min(1).max(200),
  application: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(1_000),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  minimized: z.boolean(),
  focused: z.boolean(),
});

export const remoteDesktopTargetInventorySchema = z.object({
  monitors: z.array(remoteDesktopMonitorSchema).max(64),
  windows: z.array(remoteDesktopWindowSchema).max(2_000),
});

export const remoteDesktopUpdateSchema = z.object({
  target: remoteDesktopTargetSchema,
});

export const remoteDesktopSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  workerId: z.string().min(1),
  target: remoteDesktopTargetSchema.default({
    kind: "monitor",
    id: null,
    name: null,
  }),
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
    target: remoteDesktopTargetSchema.default({
      kind: "monitor",
      id: null,
      name: null,
    }),
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
  z.object({ type: z.literal("refresh-targets") }),
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
    status: z.enum(["ready", "launching", "suspended", "error"]),
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
    type: z.literal("desktop-targets"),
    inventory: remoteDesktopTargetInventorySchema,
    requested: remoteDesktopTargetSchema,
    active: remoteDesktopTargetSchema,
    launchingApplication: z.string().trim().min(1).max(500).nullable(),
    message: z.string().max(2_048).nullable(),
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
  tabGroupId: z.string().min(1).optional(),
});

export const projectTabKindSchema = z.enum([
  "chat",
  "terminal",
  "explorer",
  "browser",
  "code",
  "history",
  "issues",
  "remote-desktop",
]);

export const projectTabMemberSummarySchema = z.object({
  tabKey: z.string().min(1),
  groupId: z.string().min(1),
  projectId: z.string().min(1),
  tabKind: projectTabKindSchema,
  tabId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const tabGroupSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  anchorTabKey: z.string().min(1),
  members: z.array(projectTabMemberSummarySchema).min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectTabLayoutSummarySchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  groups: z.array(tabGroupSummarySchema),
});

export const tabGroupOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  groupIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((groupIds) => new Set(groupIds).size === groupIds.length, {
      message: "Tab group ids must be unique.",
    }),
});

export const tabGroupMemberOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  tabKeys: z
    .array(z.string().min(1))
    .min(1)
    .refine((tabKeys) => new Set(tabKeys).size === tabKeys.length, {
      message: "Tab keys must be unique.",
    }),
});

export const tabGroupMemberMoveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    tabKey: z.string().min(1),
    targetGroupId: z.string().min(1).nullable(),
    targetMemberPosition: z.number().int().nonnegative(),
    targetGroupPosition: z.number().int().nonnegative().optional(),
  })
  .superRefine((input, context) => {
    if (
      input.targetGroupId === null &&
      input.targetGroupPosition === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A sidebar position is required when splitting a tab into a new group.",
        path: ["targetGroupPosition"],
      });
    }
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
  version: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const explorerFileWriteSchema = z.object({
  path: z.string().min(1).max(8_192),
  content: z.string().max(2 * 1024 * 1024),
  version: explorerFileSchema.shape.version,
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

export const gitCommitPersonSchema = z.object({
  name: z.string().min(1),
  email: z.string(),
  date: z.string().datetime({ offset: true }),
});

export const gitSignatureSchema = z.object({
  status: z.enum([
    "unsigned",
    "valid",
    "valid-unknown",
    "invalid",
    "expired",
    "revoked",
    "unverifiable",
  ]),
  signer: z.string().nullable(),
  key: z.string().nullable(),
  fingerprint: z.string().nullable(),
});

export const gitRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.includes("\0"),
    "Expected a safe repository-relative path.",
  );

export const gitCommitFileSchema = z.object({
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "type-changed",
    "unmerged",
    "unknown",
  ]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const gitCommitDetailSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  message: z.string().max(1_000_000),
  messageTruncated: z.boolean(),
  parents: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).max(64),
  children: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).max(10_000),
  parentIndex: z.number().int().nonnegative().nullable(),
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  author: gitCommitPersonSchema,
  committer: gitCommitPersonSchema,
  signature: gitSignatureSchema,
  refs: z.array(gitRefSchema).max(10_000),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const gitRevisionFileDiffSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  baseRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const gitRevisionCandidateSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  name: z.string().min(1).max(1_024),
  kind: z.enum(["head", "local", "remote", "tag", "worktree"]),
  current: z.boolean(),
  worktreeId: z.string().min(1).nullable(),
  worktreeName: z.string().min(1).nullable(),
});

export const gitRevisionCandidateListSchema = z
  .array(gitRevisionCandidateSchema)
  .max(20_000);

export const gitComparisonModeSchema = z.enum(["direct", "merge-base"]);

export const gitComparisonCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  authorName: z.string().min(1),
  authoredAt: z.string().datetime({ offset: true }),
});

export const gitComparisonSchema = z.object({
  mode: gitComparisonModeSchema,
  left: z.string().regex(/^[0-9a-f]{40,64}$/u),
  right: z.string().regex(/^[0-9a-f]{40,64}$/u),
  mergeBase: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  diffBase: z.string().regex(/^[0-9a-f]{40,64}$/u),
  leftAhead: z.number().int().nonnegative(),
  rightAhead: z.number().int().nonnegative(),
  leftCommits: z.array(gitComparisonCommitSchema).max(100),
  rightCommits: z.array(gitComparisonCommitSchema).max(100),
  leftCommitsTruncated: z.boolean(),
  rightCommitsTruncated: z.boolean(),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
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

export const gitDiffScopeSchema = z.enum(["unstaged", "staged"]);

export const gitFileDiffSchema = z.object({
  path: gitRelativePathSchema,
  scope: gitDiffScopeSchema,
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
});

export const gitPartialPatchOperationSchema = z.enum([
  "stage",
  "unstage",
  "discard",
]);

export const gitPartialPatchHunkSelectionSchema = z.object({
  hunkIndex: z.number().int().nonnegative(),
  lineIndexes: z.array(z.number().int().nonnegative()).max(100_000).nullable(),
});

export const gitPartialPatchRequestSchema = z.object({
  operation: gitPartialPatchOperationSchema,
  path: gitRelativePathSchema,
  hunks: z.array(gitPartialPatchHunkSelectionSchema).min(1).max(10_000),
});

export const gitPartialPatchPreviewSchema = z.object({
  operation: gitPartialPatchOperationSchema,
  path: gitRelativePathSchema,
  scope: gitDiffScopeSchema,
  patch: z.string().min(1).max(2_000_000),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  selectedHunks: z.number().int().positive(),
  selectedLines: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitPartialPatchApplySchema = z.object({
  request: gitPartialPatchRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitStashFileSchema = z.object({
  path: gitRelativePathSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const gitStashSummarySchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(7).max(64),
  message: z.string().max(10_000),
  createdAt: z.string().datetime({ offset: true }),
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  files: z.array(gitStashFileSchema).max(10_000),
  filesChanged: z.number().int().nonnegative(),
  filesTruncated: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  includesUntracked: z.boolean(),
});

export const gitStashListSchema = z.object({
  stashes: z.array(gitStashSummarySchema).max(10_000),
  truncated: z.boolean(),
});

export const gitStashCreateSchema = z
  .object({
    message: z.string().trim().min(1).max(10_000),
    includeStaged: z.boolean(),
    includeUnstaged: z.boolean(),
    includeUntracked: z.boolean(),
  })
  .superRefine((value, context) => {
    if (
      !value.includeStaged &&
      !value.includeUnstaged &&
      !value.includeUntracked
    ) {
      context.addIssue({
        code: "custom",
        message: "Select at least one change scope.",
      });
    }
    if (
      value.includeStaged &&
      !value.includeUnstaged &&
      value.includeUntracked
    ) {
      context.addIssue({
        code: "custom",
        message: "Git cannot combine staged-only and untracked stash scopes.",
      });
    }
  });

const gitStashIdentitySchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
});

export const gitBranchNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\0\r\n]+$/u);

export const gitStashActionSchema = z.discriminatedUnion("type", [
  gitStashIdentitySchema.extend({ type: z.literal("apply") }),
  gitStashIdentitySchema.extend({ type: z.literal("pop") }),
  gitStashIdentitySchema.extend({ type: z.literal("drop") }),
  z.object({ type: z.literal("clear") }),
  gitStashIdentitySchema.extend({
    type: z.literal("branch"),
    branch: gitBranchNameInputSchema,
  }),
]);

export const gitStashActionPreviewSchema = z.object({
  action: gitStashActionSchema,
  stashes: z.array(gitStashSummarySchema).min(1).max(10_000),
  destructive: z.boolean(),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitStashActionApplySchema = z.object({
  action: gitStashActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitStashMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  stash: gitStashSummarySchema.nullable(),
  conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
  operation: z
    .object({
      type: z.literal("stash"),
      state: z.literal("conflicted"),
      originalHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
      currentHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
      sourceRef: z.string().min(1).max(1_024),
      sourceRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
      targetRef: z.string().min(1).max(1_024).nullable(),
      targetRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
      pendingCommits: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).length(1),
      currentStep: z.literal(1),
      totalSteps: z.literal(1),
      checkpointRef: z.string().min(1).max(1_024),
      conflictedPaths: z.array(gitRelativePathSchema).min(1).max(100_000),
    })
    .nullable()
    .default(null),
});

export const gitStashFileDiffSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  path: gitRelativePathSchema,
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const gitBranchCommitSummarySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(7).max(64),
  subject: z.string().max(100_000),
  authorName: z.string().min(1).max(10_000),
  authoredAt: z.string().datetime({ offset: true }),
});

const gitBranchDisplayNameSchema = z.string().min(1).max(1_000);

export const gitManagedBranchSchema = z.object({
  name: gitBranchDisplayNameSchema,
  fullRef: z.string().min(1).max(1_000),
  kind: z.enum(["local", "remote"]),
  current: z.boolean(),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  upstream: z.string().min(1).max(1_000).nullable(),
  upstreamGone: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  mergedIntoHead: z.boolean().nullable(),
  remoteName: z.string().min(1).max(255).nullable(),
  remoteAvailable: z.boolean(),
  trackingLocalBranches: z.array(gitBranchDisplayNameSchema).max(10_000),
  worktree: z
    .object({
      label: z.string().min(1).max(1_000),
      current: z.boolean(),
    })
    .nullable(),
  lastCommit: gitBranchCommitSummarySchema,
});

export const gitPullStrategySchema = z.object({
  mode: z.enum(["fast-forward-only", "rebase", "merge", "unspecified"]),
  description: z.string().min(1).max(1_000),
});

export const gitBranchListSchema = z.object({
  currentBranch: gitBranchDisplayNameSchema.nullable(),
  head: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  detached: z.boolean(),
  defaultRemote: z.string().min(1).max(255).nullable(),
  remotes: z.array(z.string().min(1).max(255)).max(1_000),
  pullStrategy: gitPullStrategySchema,
  branches: z.array(gitManagedBranchSchema).max(20_000),
  truncated: z.boolean(),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitRemoteNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);
const gitRevisionInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitBranchActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    name: gitBranchNameInputSchema,
    startPoint: gitRevisionInputSchema.nullable(),
    checkout: z.boolean(),
  }),
  z.object({
    type: z.literal("switch"),
    name: gitBranchNameInputSchema,
    kind: z.enum(["local", "remote"]),
  }),
  z.object({
    type: z.literal("publish"),
    name: gitBranchNameInputSchema,
    remote: gitRemoteNameInputSchema,
  }),
  z.object({
    type: z.literal("rename"),
    name: gitBranchNameInputSchema,
    newName: gitBranchNameInputSchema,
  }),
  z.object({
    type: z.literal("deleteLocal"),
    name: gitBranchNameInputSchema,
    force: z.boolean(),
  }),
  z.object({
    type: z.literal("deleteRemote"),
    remote: gitRemoteNameInputSchema,
    name: gitBranchNameInputSchema,
  }),
  z.object({
    type: z.literal("setUpstream"),
    name: gitBranchNameInputSchema,
    upstream: z.string().trim().min(1).max(1_000).nullable(),
  }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema.nullable(),
    prune: z.boolean(),
  }),
]);

export const gitBranchActionPreviewSchema = z.object({
  action: gitBranchActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  branch: gitManagedBranchSchema.nullable(),
});

export const gitBranchActionApplySchema = z.object({
  action: gitBranchActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitBranchMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  branches: gitBranchListSchema,
});

export const gitRemoteSummarySchema = z.object({
  name: z.string().min(1).max(255),
  fetchUrl: z.string().min(1).max(8_192),
  fetchUrlRedacted: z.boolean(),
  pushUrl: z.string().min(1).max(8_192),
  pushUrlRedacted: z.boolean(),
  defaultFetch: z.boolean(),
  defaultPush: z.boolean(),
});

export const gitRemoteListSchema = z.object({
  remotes: z.array(gitRemoteSummarySchema).max(1_000),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitRemoteUrlInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitRemoteActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    name: gitRemoteNameInputSchema,
    fetchUrl: gitRemoteUrlInputSchema,
    pushUrl: gitRemoteUrlInputSchema.nullable(),
  }),
  z.object({
    type: z.literal("edit"),
    name: gitRemoteNameInputSchema,
    fetchUrl: gitRemoteUrlInputSchema,
    pushUrl: gitRemoteUrlInputSchema.nullable(),
  }),
  z.object({ type: z.literal("remove"), name: gitRemoteNameInputSchema }),
  z.object({
    type: z.literal("setDefaults"),
    fetchRemote: gitRemoteNameInputSchema.nullable(),
    pushRemote: gitRemoteNameInputSchema.nullable(),
  }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema,
    prune: z.boolean(),
  }),
]);

export const gitRemoteActionPreviewSchema = z.object({
  action: gitRemoteActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  remote: gitRemoteSummarySchema.nullable(),
});

export const gitRemoteActionApplySchema = z.object({
  action: gitRemoteActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitRemoteMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  remotes: gitRemoteListSchema,
});

export const gitTagNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitTagSummarySchema = z.object({
  name: z.string().min(1).max(1_000),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  targetHash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  targetType: z.enum(["commit", "tree", "blob", "tag", "other"]),
  annotated: z.boolean(),
  subject: z.string().max(100_000),
  taggerName: z.string().min(1).max(10_000).nullable(),
  createdAt: z.string().datetime({ offset: true }).nullable(),
  signature: gitSignatureSchema,
  publishedRemotes: z.array(z.string().min(1).max(255)).max(1_000),
});

export const gitTagDetailSchema = gitTagSummarySchema.extend({
  message: z.string().max(1_000_000),
  messageTruncated: z.boolean(),
});

export const gitTagListSchema = z.object({
  tags: z.array(gitTagSummarySchema).max(10_000),
  truncated: z.boolean(),
  remoteChecks: z.array(
    z.object({
      remote: z.string().min(1).max(255),
      available: z.boolean(),
      error: z.string().max(1_000).nullable(),
    }),
  ),
  generatedAt: z.string().datetime({ offset: true }),
});

export const gitTagActionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("create"),
      name: gitTagNameInputSchema,
      target: gitRevisionInputSchema.nullable(),
      annotated: z.boolean(),
      message: z.string().trim().min(1).max(1_000_000).nullable(),
    }),
    z.object({
      type: z.literal("push"),
      name: gitTagNameInputSchema,
      remote: gitRemoteNameInputSchema,
    }),
    z.object({ type: z.literal("deleteLocal"), name: gitTagNameInputSchema }),
    z.object({
      type: z.literal("deleteRemote"),
      name: gitTagNameInputSchema,
      remote: gitRemoteNameInputSchema,
    }),
  ])
  .superRefine((action, context) => {
    if (action.type !== "create") return;
    if (action.annotated && !action.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Annotated tags require a message.",
      });
    }
    if (!action.annotated && action.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Lightweight tags do not have a tag message.",
      });
    }
  });

export const gitTagActionPreviewSchema = z.object({
  action: gitTagActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  tag: gitTagSummarySchema.nullable(),
});

export const gitTagActionApplySchema = z.object({
  action: gitTagActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitTagMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  tags: gitTagListSchema,
});

const gitCommitHashInputSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);

export const gitCherryPickSelectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("commits"),
    revisions: z.array(gitCommitHashInputSchema).min(1).max(1_000),
  }),
  z.object({
    type: z.literal("range"),
    fromRevision: gitCommitHashInputSchema,
    toRevision: gitCommitHashInputSchema,
  }),
]);

export const gitCommitActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cherryPick"),
    selection: gitCherryPickSelectionSchema,
  }),
  z.object({
    type: z.literal("revert"),
    revision: gitCommitHashInputSchema,
    mainlineParent: z.number().int().positive().max(64).nullable(),
  }),
  z.object({
    type: z.literal("amend"),
    message: z.string().min(1).max(1_000_000).nullable(),
  }),
  z.object({
    type: z.literal("fixup"),
    revision: gitCommitHashInputSchema,
  }),
]);

export const gitOperationSummarySchema = z.object({
  type: z.enum(["cherry-pick", "revert"]),
  state: z.enum([
    "queued",
    "running",
    "conflicted",
    "awaiting-user-action",
    "completed",
    "failed",
    "aborted",
  ]),
  originalHead: gitCommitHashInputSchema,
  currentHead: gitCommitHashInputSchema,
  sourceRevisions: z.array(gitCommitHashInputSchema).max(1_000),
  currentStep: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive().max(1_000),
  conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
});

export const gitManagedOperationTypeSchema = z.enum([
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
]);

export const gitManagedOperationStateSchema = z.enum([
  "queued",
  "running",
  "conflicted",
  "awaiting-user-action",
  "completed",
  "failed",
  "aborted",
]);

export const gitInteractiveRebaseTodoActionSchema = z.enum([
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "drop",
]);

export const gitInteractiveRebaseTodoItemSchema = z
  .object({
    action: gitInteractiveRebaseTodoActionSchema,
    revision: gitCommitHashInputSchema,
    message: z.string().trim().min(1).max(1_000_000).nullable().default(null),
  })
  .superRefine((item, context) => {
    if (item.action === "reword" && !item.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Reword steps require a replacement commit message.",
      });
    }
    if (item.action !== "reword" && item.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Only reword steps accept a replacement commit message.",
      });
    }
  });

export const gitMergeRebaseActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("merge"),
    sourceRef: gitRevisionInputSchema,
  }),
  z.object({
    type: z.literal("rebase"),
    sourceRef: gitRevisionInputSchema,
  }),
  z.object({
    type: z.literal("interactiveRebase"),
    upstreamRef: gitRevisionInputSchema,
    todo: z.array(gitInteractiveRebaseTodoItemSchema).max(10_000).default([]),
  }),
]);

export const gitManagedOperationContextSchema = z.object({
  type: gitManagedOperationTypeSchema,
  originalHead: gitCommitHashInputSchema,
  sourceRef: z.string().min(1).max(1_024).nullable(),
  sourceRevision: gitCommitHashInputSchema.nullable(),
  targetRef: z.string().min(1).max(1_024).nullable(),
  targetRevision: gitCommitHashInputSchema,
  pendingCommits: z.array(gitCommitHashInputSchema).max(10_000),
  totalSteps: z.number().int().positive().max(10_000),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
});

export const gitManagedOperationWorkerStateSchema =
  gitManagedOperationContextSchema.extend({
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    pendingCommits: z.array(gitCommitHashInputSchema).max(10_000),
    conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
    output: z.string().max(1_000_000),
    status: gitStatusSchema,
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable().optional(),
  });

export const gitManagedOperationPreviewSchema = z.object({
  action: gitMergeRebaseActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  context: gitManagedOperationContextSchema,
  commits: z.array(gitComparisonCommitSchema).max(10_000),
  files: z.array(gitCommitFileSchema).max(100_000),
  patch: z.string().max(2_000_000),
  patchTruncated: z.boolean(),
  wouldConflict: z.boolean(),
  todo: z.array(gitInteractiveRebaseTodoItemSchema).max(10_000).default([]),
  todoText: z.string().max(2_000_000).default(""),
  publishedRefs: z.array(z.string().min(1).max(1_024)).max(1_000).default([]),
});

export const gitManagedOperationStartSchema = z.object({
  action: gitMergeRebaseActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitManagedOperationControlSchema = z.object({
  action: z.enum(["continue", "skip", "abort"]),
});

export const gitManagedOperationAmendSchema = z.object({
  message: z.string().trim().min(1).max(1_000_000).nullable().default(null),
});

export const gitManagedOperationRecordSchema =
  gitManagedOperationContextSchema.extend({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    worktreeId: z.string().uuid(),
    workerId: z.string().min(1).max(255),
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
    output: z.string().max(1_000_000),
    error: z.string().max(1_000_000).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable().optional(),
  });

export const gitManagedOperationResponseSchema = z.object({
  operation: gitManagedOperationRecordSchema.nullable(),
});

export const gitConflictKindSchema = z.enum([
  "both-modified",
  "both-added",
  "both-deleted",
  "added-by-ours",
  "added-by-theirs",
  "deleted-by-ours",
  "deleted-by-theirs",
  "unknown",
]);

export const gitConflictStageSchema = z.object({
  available: z.boolean(),
  oid: gitCommitHashInputSchema.nullable(),
  mode: z
    .string()
    .regex(/^[0-7]{6}$/u)
    .nullable(),
  size: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  content: z.string().max(2_000_000).nullable(),
  truncated: z.boolean(),
});

export const gitConflictSummarySchema = z.object({
  path: gitRelativePathSchema,
  code: z.string().length(2),
  kind: gitConflictKindSchema,
  baseAvailable: z.boolean(),
  oursAvailable: z.boolean(),
  theirsAvailable: z.boolean(),
});

export const gitConflictListSchema = z.object({
  files: z.array(gitConflictSummarySchema).max(100_000),
  truncated: z.boolean(),
});

export const gitConflictDetailSchema = gitConflictSummarySchema.extend({
  base: gitConflictStageSchema,
  ours: gitConflictStageSchema,
  theirs: gitConflictStageSchema,
  result: z.object({
    exists: z.boolean(),
    oid: gitCommitHashInputSchema.nullable(),
    size: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
    content: z.string().max(2_000_000).nullable(),
    truncated: z.boolean(),
  }),
});

export const gitConflictResolutionStrategySchema = z.enum([
  "ours",
  "theirs",
  "both",
  "result",
  "manual",
  "delete",
]);

export const gitConflictResolutionRequestSchema = z
  .object({
    path: gitRelativePathSchema,
    strategy: gitConflictResolutionStrategySchema,
    content: z.string().max(2_000_000).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.strategy === "manual" && value.content === null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Manual conflict resolution requires result content.",
      });
    }
    if (value.strategy !== "manual" && value.content !== null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Only manual conflict resolution accepts result content.",
      });
    }
  });

export const gitConflictResolutionPreviewSchema = z.object({
  request: gitConflictResolutionRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  resultDeleted: z.boolean(),
  resultBinary: z.boolean(),
  resultContent: z.string().max(2_000_000).nullable(),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitConflictResolutionApplySchema = z.object({
  request: gitConflictResolutionRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitConflictResolutionResultSchema = z.object({
  path: gitRelativePathSchema,
  resolved: z.boolean(),
  remainingPaths: z.array(gitRelativePathSchema).max(100_000),
  status: gitStatusSchema,
});

export const gitCommitActionPreviewSchema = z.object({
  action: gitCommitActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  resolvedRevisions: z.array(gitCommitHashInputSchema).max(1_000),
  commits: z.array(gitComparisonCommitSchema).max(1_000),
  files: z.array(gitFileChangeSchema).max(100_000),
  patch: z.string().max(2_000_000),
  patchTruncated: z.boolean(),
  wouldConflict: z.boolean(),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
});

export const gitCommitActionApplySchema = z.object({
  action: gitCommitActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitCommitActionResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  headBefore: gitCommitHashInputSchema,
  headAfter: gitCommitHashInputSchema,
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  operation: gitOperationSummarySchema.nullable(),
});

const gitPathsSchema = z.array(gitRelativePathSchema).min(1).max(1_000);
export const gitActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("unstage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("discard"), paths: gitPathsSchema }),
  z.object({ type: z.literal("stageAll") }),
  z.object({ type: z.literal("unstageAll") }),
  z.object({ type: z.literal("discardAll") }),
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

export const gitForcePushPreviewSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.literal(true),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  remote: gitRemoteNameInputSchema,
  localBranch: gitBranchNameInputSchema,
  remoteBranch: gitBranchNameInputSchema,
  localHead: gitCommitHashInputSchema,
  expectedRemoteHead: gitCommitHashInputSchema,
  localCommits: z.array(gitComparisonCommitSchema).max(200),
  localCommitCount: z.number().int().nonnegative(),
  localCommitsTruncated: z.boolean(),
  remoteCommits: z.array(gitComparisonCommitSchema).max(200),
  remoteCommitCount: z.number().int().positive(),
  remoteCommitsTruncated: z.boolean(),
});

export const gitForcePushApplySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/u),
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

export const worktreeObservationTargetSchema = z.object({
  sourcePath: z.string().min(1).max(8_192),
  worktreePath: z.string().min(1).max(8_192),
});

export const worktreeObservationTargetsSchema = z
  .array(worktreeObservationTargetSchema)
  .max(128)
  .superRefine((targets, context) => {
    const keys = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const key = `${target.sourcePath}\0${target.worktreePath}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Worktree observation targets must be unique.",
          path: [index],
        });
      }
      keys.add(key);
    }
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

export const workerProjectShareOpenResultSchema = z.object({
  shareId: z.string().min(1).max(200),
  protocol: z.literal("webdav"),
  publicBasePath: projectSharePublicBasePathSchema,
  publicOrigin: projectSharePublicOriginSchema,
  loopbackHost: z.literal("127.0.0.1"),
  loopbackPort: z.number().int().min(1).max(65_535),
  username: z.string().min(1).max(128),
  password: z.string().min(24).max(256),
  realm: z.string().min(1).max(200),
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
    type: z.literal("github.pull-request.create"),
    cwd: z.string().min(1).max(8_192),
    repository: githubRepositorySchema.shape.nameWithOwner,
    request: githubPullRequestCreateSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.get"),
    cwd: z.string().min(1).max(8_192),
    repository: githubRepositorySchema.shape.nameWithOwner,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.releases.list"),
    cwd: z.string().min(1).max(8_192),
    repository: githubRepositorySchema.shape.nameWithOwner,
  }),
  z.object({
    type: z.literal("github.release.get"),
    cwd: z.string().min(1).max(8_192),
    repository: githubRepositorySchema.shape.nameWithOwner,
    releaseId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.release.create"),
    cwd: z.string().min(1).max(8_192),
    repository: githubRepositorySchema.shape.nameWithOwner,
    request: githubReleaseCreateSchema,
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
    type: z.literal("project.script-commands"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("project.share.open"),
    shareId: z.string().min(1).max(200),
    root: z.string().min(1).max(8_192),
    publicBasePath: projectSharePublicBasePathSchema,
    publicOrigin: projectSharePublicOriginSchema,
  }),
  z.object({
    type: z.literal("project.share.close"),
    shareId: z.string().min(1).max(200),
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
    type: z.literal("git.commit.get"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
    parentIndex: z.number().int().nonnegative().default(0),
    revisions: z
      .array(z.string().regex(/^[0-9a-f]{40,64}$/u))
      .max(500)
      .default([]),
  }),
  z.object({
    type: z.literal("git.refs.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.compare"),
    cwd: z.string().min(1).max(8_192),
    left: z.string().regex(/^[0-9a-f]{40,64}$/u),
    right: z.string().regex(/^[0-9a-f]{40,64}$/u),
    mode: gitComparisonModeSchema,
  }),
  z.object({
    type: z.literal("git.revision.diff"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
    baseRevision: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/u)
      .nullable(),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.status"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("git.diff"),
    cwd: z.string().min(1),
    path: gitRelativePathSchema,
    scope: gitDiffScopeSchema,
  }),
  z.object({
    type: z.literal("git.patch.preview"),
    cwd: z.string().min(1).max(8_192),
    request: gitPartialPatchRequestSchema,
  }),
  z
    .object({
      type: z.literal("git.patch.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitPartialPatchApplySchema.shape),
  z.object({
    type: z.literal("git.stash.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.stash.create"),
    cwd: z.string().min(1).max(8_192),
    request: gitStashCreateSchema,
  }),
  z.object({
    type: z.literal("git.stash.diff"),
    cwd: z.string().min(1).max(8_192),
    hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.stash.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitStashActionSchema,
  }),
  z
    .object({
      type: z.literal("git.stash.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitStashActionApplySchema.shape),
  z.object({
    type: z.literal("git.branch.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.branch.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitBranchActionSchema,
  }),
  z
    .object({
      type: z.literal("git.branch.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitBranchActionApplySchema.shape),
  z.object({
    type: z.literal("git.remote.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.remote.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitRemoteActionSchema,
  }),
  z
    .object({
      type: z.literal("git.remote.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitRemoteActionApplySchema.shape),
  z.object({
    type: z.literal("git.tag.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.tag.get"),
    cwd: z.string().min(1).max(8_192),
    name: gitTagNameInputSchema,
  }),
  z.object({
    type: z.literal("git.tag.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitTagActionSchema,
  }),
  z
    .object({
      type: z.literal("git.tag.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitTagActionApplySchema.shape),
  z.object({
    type: z.literal("git.commit.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitCommitActionSchema,
  }),
  z
    .object({
      type: z.literal("git.commit.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitCommitActionApplySchema.shape),
  z.object({
    type: z.literal("git.operation.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitMergeRebaseActionSchema,
  }),
  z
    .object({
      type: z.literal("git.operation.start"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitManagedOperationStartSchema.shape),
  z.object({
    type: z.literal("git.operation.inspect"),
    cwd: z.string().min(1).max(8_192),
    context: gitManagedOperationContextSchema,
  }),
  z.object({
    type: z.literal("git.operation.control"),
    cwd: z.string().min(1).max(8_192),
    context: gitManagedOperationContextSchema,
    action: gitManagedOperationControlSchema.shape.action,
  }),
  z
    .object({
      type: z.literal("git.operation.amend"),
      cwd: z.string().min(1).max(8_192),
      context: gitManagedOperationContextSchema,
    })
    .extend(gitManagedOperationAmendSchema.shape),
  z.object({
    type: z.literal("git.conflicts.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.conflicts.get"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.conflicts.preview"),
    cwd: z.string().min(1).max(8_192),
    request: gitConflictResolutionRequestSchema,
  }),
  z
    .object({
      type: z.literal("git.conflicts.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitConflictResolutionApplySchema.shape),
  z.object({
    type: z.literal("git.action"),
    cwd: z.string().min(1),
    action: gitActionSchema,
  }),
  z.object({
    type: z.literal("git.force-push.preview"),
    cwd: z.string().min(1).max(8_192),
  }),
  z
    .object({
      type: z.literal("git.force-push.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitForcePushApplySchema.shape),
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
    type: z.literal("worktree.observation.configure"),
    targets: worktreeObservationTargetsSchema,
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
    type: z.literal("explorer.file.write"),
    root: z.string().min(1),
    path: explorerFileWriteSchema.shape.path,
    content: explorerFileWriteSchema.shape.content,
    version: explorerFileWriteSchema.shape.version,
  }),
  z.object({ type: z.literal("code.probe") }),
  z.object({
    type: z.literal("code.open"),
    sessionId: z.string().min(1),
    codeTabId: z.string().min(1),
    projectId: z.string().min(1),
    projectName: z.string().trim().min(1).max(200).optional(),
    worktreeId: z.string().min(1),
    worktreeName: z.string().trim().min(1).max(200).optional(),
    cwd: z.string().min(1),
    profileId: z.string().min(1).max(200),
    themeMode: codeThemeModeSchema,
    appearance: codeAppearanceSchema,
  }),
  z.object({
    type: z.literal("code.status"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.stop"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.saveAll"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.getDirtyEditors"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.setTheme"),
    sessionId: z.string().min(1),
    themeMode: codeThemeModeSchema,
    appearance: codeAppearanceSchema,
  }),
  z.object({
    type: z.literal("code.prepareAgentTurn"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.agentTurnState"),
    cwd: z.string().min(1),
    phase: z.enum(["started", "completed", "failed"]),
    paths: z.array(z.string().min(1).max(8_192)).max(5_000).default([]),
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
    type: z.literal("surface.configure"),
    surfaceId: z.string().min(1),
    configuration: remoteSurfaceConfigurationSchema,
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
  workflowNodeExecutionRequestSchema.extend({
    type: z.literal("workflow.node.execute"),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("workflow.definition.generate"),
    generationId: z.string().min(1).max(200),
    cwd: z.string().trim().min(1).max(8_192),
    prompt: z.string().trim().min(1).max(100_000),
    developerInstructions: z.string().trim().min(1).max(100_000),
    outputSchema: workflowJsonObjectSchema,
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(15 * 60 * 1_000),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("workflow.repository.scan"),
    cwd: z.string().trim().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("workflow.repository.write"),
    cwd: z.string().trim().min(1).max(8_192),
    document: workflowRepositoryDocumentSchema,
    overwrite: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("workflow.node.interrupt"),
    workflowRunId: z.string().min(1).max(200),
    runNodeId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
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
    type: z.literal("workflow.node.activity"),
    attemptId: z.string().min(1).max(200),
    activity: agentActivitySchema,
  }),
  z.object({
    type: z.literal("workflow.node.message"),
    attemptId: z.string().min(1).max(200),
    message: normalizedAgentMessageSchema,
  }),
  z.object({
    type: z.literal("workflow.node.plan.updated"),
    attemptId: z.string().min(1).max(200),
    turnId: z.string().min(1),
    explanation: z.string().nullable(),
    steps: z.array(planStepSchema),
  }),
  z.object({
    type: z.literal("workflow.node.interaction.requested"),
    attemptId: z.string().min(1).max(200),
    request: agentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("workflow.node.interaction.cleared"),
    attemptId: z.string().min(1).max(200),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("workflow.node.interaction.expired"),
    attemptId: z.string().min(1).max(200),
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

export const workerNotificationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("worktree.inventory.observed"),
    sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
    inventory: worktreeInventorySchema,
  }),
  z.object({
    type: z.literal("worktree.status.observed"),
    sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
    worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
    result: worktreeStatusResultSchema,
  }),
]);

export const workerNotificationEnvelopeSchema = z.object({
  kind: z.literal("notification"),
  notification: workerNotificationSchema,
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
export type CodeTransport = z.infer<typeof codeTransportSchema>;
export type CodeCapabilities = z.infer<typeof codeCapabilitiesSchema>;
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
export type ProjectWorkspaceCreate = z.infer<
  typeof projectWorkspaceCreateSchema
>;
export type ProjectWorkspaceUpdate = z.infer<
  typeof projectWorkspaceUpdateSchema
>;
export type ProjectWorkspaceSummary = z.infer<
  typeof projectWorkspaceSummarySchema
>;
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
export type GithubPullRequestCreate = z.infer<
  typeof githubPullRequestCreateSchema
>;
export type GithubPullRequestSummary = z.infer<
  typeof githubPullRequestSummarySchema
>;
export type GithubPullRequestCreateResult = z.infer<
  typeof githubPullRequestCreateResultSchema
>;
export type GithubPullRequestCommit = z.infer<
  typeof githubPullRequestCommitSchema
>;
export type GithubPullRequestFile = z.infer<typeof githubPullRequestFileSchema>;
export type GithubPullRequestCheck = z.infer<
  typeof githubPullRequestCheckSchema
>;
export type GithubPullRequestReview = z.infer<
  typeof githubPullRequestReviewSchema
>;
export type GithubPullRequestDetail = z.infer<
  typeof githubPullRequestDetailSchema
>;
export type GithubReleaseSummary = z.infer<typeof githubReleaseSummarySchema>;
export type GithubReleaseList = z.infer<typeof githubReleaseListSchema>;
export type GithubReleaseCreate = z.infer<typeof githubReleaseCreateSchema>;
export type GithubWorkerRepository = z.infer<
  typeof githubWorkerRepositorySchema
>;
export type GithubProjectCreate = z.infer<typeof githubProjectCreateSchema>;
export type ProjectCloneResult = z.infer<typeof projectCloneResultSchema>;
export type ProjectRemove = z.infer<typeof projectRemoveSchema>;
export type GitRef = z.infer<typeof gitRefSchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitHistory = z.infer<typeof gitHistorySchema>;
export type GitCommitPerson = z.infer<typeof gitCommitPersonSchema>;
export type GitSignature = z.infer<typeof gitSignatureSchema>;
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>;
export type GitRevisionFileDiff = z.infer<typeof gitRevisionFileDiffSchema>;
export type GitRevisionCandidate = z.infer<typeof gitRevisionCandidateSchema>;
export type GitComparisonMode = z.infer<typeof gitComparisonModeSchema>;
export type GitComparisonCommit = z.infer<typeof gitComparisonCommitSchema>;
export type GitComparison = z.infer<typeof gitComparisonSchema>;
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitDiffScope = z.infer<typeof gitDiffScopeSchema>;
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>;
export type GitPartialPatchOperation = z.infer<
  typeof gitPartialPatchOperationSchema
>;
export type GitPartialPatchRequest = z.infer<
  typeof gitPartialPatchRequestSchema
>;
export type GitPartialPatchPreview = z.infer<
  typeof gitPartialPatchPreviewSchema
>;
export type GitPartialPatchApply = z.infer<typeof gitPartialPatchApplySchema>;
export type GitStashFile = z.infer<typeof gitStashFileSchema>;
export type GitStashSummary = z.infer<typeof gitStashSummarySchema>;
export type GitStashList = z.infer<typeof gitStashListSchema>;
export type GitStashCreate = z.infer<typeof gitStashCreateSchema>;
export type GitStashAction = z.infer<typeof gitStashActionSchema>;
export type GitStashActionPreview = z.infer<typeof gitStashActionPreviewSchema>;
export type GitStashActionApply = z.infer<typeof gitStashActionApplySchema>;
export type GitStashMutationResult = z.infer<
  typeof gitStashMutationResultSchema
>;
export type GitStashFileDiff = z.infer<typeof gitStashFileDiffSchema>;
export type GitBranchCommitSummary = z.infer<
  typeof gitBranchCommitSummarySchema
>;
export type GitManagedBranch = z.infer<typeof gitManagedBranchSchema>;
export type GitPullStrategy = z.infer<typeof gitPullStrategySchema>;
export type GitBranchList = z.infer<typeof gitBranchListSchema>;
export type GitBranchAction = z.infer<typeof gitBranchActionSchema>;
export type GitBranchActionPreview = z.infer<
  typeof gitBranchActionPreviewSchema
>;
export type GitBranchActionApply = z.infer<typeof gitBranchActionApplySchema>;
export type GitBranchMutationResult = z.infer<
  typeof gitBranchMutationResultSchema
>;
export type GitRemoteSummary = z.infer<typeof gitRemoteSummarySchema>;
export type GitRemoteList = z.infer<typeof gitRemoteListSchema>;
export type GitRemoteAction = z.infer<typeof gitRemoteActionSchema>;
export type GitRemoteActionPreview = z.infer<
  typeof gitRemoteActionPreviewSchema
>;
export type GitRemoteActionApply = z.infer<typeof gitRemoteActionApplySchema>;
export type GitRemoteMutationResult = z.infer<
  typeof gitRemoteMutationResultSchema
>;
export type GitTagSummary = z.infer<typeof gitTagSummarySchema>;
export type GitTagDetail = z.infer<typeof gitTagDetailSchema>;
export type GitTagList = z.infer<typeof gitTagListSchema>;
export type GitTagAction = z.infer<typeof gitTagActionSchema>;
export type GitTagActionPreview = z.infer<typeof gitTagActionPreviewSchema>;
export type GitTagActionApply = z.infer<typeof gitTagActionApplySchema>;
export type GitTagMutationResult = z.infer<typeof gitTagMutationResultSchema>;
export type GitCherryPickSelection = z.infer<
  typeof gitCherryPickSelectionSchema
>;
export type GitCommitAction = z.infer<typeof gitCommitActionSchema>;
export type GitOperationSummary = z.infer<typeof gitOperationSummarySchema>;
export type GitManagedOperationType = z.infer<
  typeof gitManagedOperationTypeSchema
>;
export type GitManagedOperationState = z.infer<
  typeof gitManagedOperationStateSchema
>;
export type GitMergeRebaseAction = z.infer<typeof gitMergeRebaseActionSchema>;
export type GitInteractiveRebaseTodoAction = z.infer<
  typeof gitInteractiveRebaseTodoActionSchema
>;
export type GitInteractiveRebaseTodoItem = z.infer<
  typeof gitInteractiveRebaseTodoItemSchema
>;
export type GitManagedOperationContext = z.infer<
  typeof gitManagedOperationContextSchema
>;
export type GitManagedOperationWorkerState = z.infer<
  typeof gitManagedOperationWorkerStateSchema
>;
export type GitManagedOperationPreview = z.infer<
  typeof gitManagedOperationPreviewSchema
>;
export type GitManagedOperationStart = z.infer<
  typeof gitManagedOperationStartSchema
>;
export type GitManagedOperationControl = z.infer<
  typeof gitManagedOperationControlSchema
>;
export type GitManagedOperationAmend = z.infer<
  typeof gitManagedOperationAmendSchema
>;
export type GitManagedOperationRecord = z.infer<
  typeof gitManagedOperationRecordSchema
>;
export type GitManagedOperationResponse = z.infer<
  typeof gitManagedOperationResponseSchema
>;
export type GitConflictKind = z.infer<typeof gitConflictKindSchema>;
export type GitConflictStage = z.infer<typeof gitConflictStageSchema>;
export type GitConflictSummary = z.infer<typeof gitConflictSummarySchema>;
export type GitConflictList = z.infer<typeof gitConflictListSchema>;
export type GitConflictDetail = z.infer<typeof gitConflictDetailSchema>;
export type GitConflictResolutionStrategy = z.infer<
  typeof gitConflictResolutionStrategySchema
>;
export type GitConflictResolutionRequest = z.infer<
  typeof gitConflictResolutionRequestSchema
>;
export type GitConflictResolutionPreview = z.infer<
  typeof gitConflictResolutionPreviewSchema
>;
export type GitConflictResolutionApply = z.infer<
  typeof gitConflictResolutionApplySchema
>;
export type GitConflictResolutionResult = z.infer<
  typeof gitConflictResolutionResultSchema
>;
export type GitCommitActionPreview = z.infer<
  typeof gitCommitActionPreviewSchema
>;
export type GitCommitActionApply = z.infer<typeof gitCommitActionApplySchema>;
export type GitCommitActionResult = z.infer<typeof gitCommitActionResultSchema>;
export type GitAction = z.infer<typeof gitActionSchema>;
export type GitActionResult = z.infer<typeof gitActionResultSchema>;
export type GitForcePushPreview = z.infer<typeof gitForcePushPreviewSchema>;
export type GitForcePushApply = z.infer<typeof gitForcePushApplySchema>;
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
export type WorktreeObservationTarget = z.infer<
  typeof worktreeObservationTargetSchema
>;
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
export type ScriptCommandKind = z.infer<typeof scriptCommandKindSchema>;
export type ScriptCommand = z.infer<typeof scriptCommandSchema>;
export type ExplorerCreate = z.infer<typeof explorerCreateSchema>;
export type ExplorerUpdate = z.infer<typeof explorerUpdateSchema>;
export type ExplorerSummary = z.infer<typeof explorerSummarySchema>;
export type CodeThemeMode = z.infer<typeof codeThemeModeSchema>;
export type CodeAppearance = z.infer<typeof codeAppearanceSchema>;
export type CodeTabStatus = z.infer<typeof codeTabStatusSchema>;
export type CodeSessionStatus = z.infer<typeof codeSessionStatusSchema>;
export type CodeTabCreate = z.infer<typeof codeTabCreateSchema>;
export type CodeTabUpdate = z.infer<typeof codeTabUpdateSchema>;
export type CodeTabSummary = z.infer<typeof codeTabSummarySchema>;
export type CodeEditorBuild = z.infer<typeof codeEditorBuildSchema>;
export type CodeProbeResult = z.infer<typeof codeProbeResultSchema>;
export type CodeSessionSummary = z.infer<typeof codeSessionSummarySchema>;
export type CodeDirtyEditor = z.infer<typeof codeDirtyEditorSchema>;
export type CodeSaveBeforeAgentTurn = z.infer<
  typeof codeSaveBeforeAgentTurnSchema
>;
export type CodeWorkbenchState = z.infer<typeof codeWorkbenchStateSchema>;
export type CodeRuntimeStatus = z.infer<typeof codeRuntimeStatusSchema>;
export type CodeSaveAllResult = z.infer<typeof codeSaveAllResultSchema>;
export type CodeAgentTurnPreparationResult = z.infer<
  typeof codeAgentTurnPreparationResultSchema
>;
export type CodeAgentTurnNotificationResult = z.infer<
  typeof codeAgentTurnNotificationResultSchema
>;
export type CodeAttachment = z.infer<typeof codeAttachmentSchema>;
export type CodeAttachmentCreate = z.infer<typeof codeAttachmentCreateSchema>;
export type CodeThemeUpdate = z.infer<typeof codeThemeUpdateSchema>;
export type CodeTunnelFrameHeader = z.infer<typeof codeTunnelFrameHeaderSchema>;
export type ProjectShareAttachment = z.infer<
  typeof projectShareAttachmentSchema
>;
export type ProjectShareTunnelFrameHeader = z.infer<
  typeof projectShareTunnelFrameHeaderSchema
>;
export type BrowserCreate = z.infer<typeof browserCreateSchema>;
export type BrowserUpdate = z.infer<typeof browserUpdateSchema>;
export type BrowserSummary = z.infer<typeof browserSummarySchema>;
export type RemoteDesktopCreate = z.infer<typeof remoteDesktopCreateSchema>;
export type RemoteDesktopTarget = z.infer<typeof remoteDesktopTargetSchema>;
export type RemoteDesktopMonitor = z.infer<typeof remoteDesktopMonitorSchema>;
export type RemoteDesktopWindow = z.infer<typeof remoteDesktopWindowSchema>;
export type RemoteDesktopTargetInventory = z.infer<
  typeof remoteDesktopTargetInventorySchema
>;
export type RemoteDesktopUpdate = z.infer<typeof remoteDesktopUpdateSchema>;
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
export type ProjectTabKind = z.infer<typeof projectTabKindSchema>;
export type ProjectTabMemberSummary = z.infer<
  typeof projectTabMemberSummarySchema
>;
export type TabGroupSummary = z.infer<typeof tabGroupSummarySchema>;
export type ProjectTabLayoutSummary = z.infer<
  typeof projectTabLayoutSummarySchema
>;
export type TabGroupOrder = z.infer<typeof tabGroupOrderSchema>;
export type TabGroupMemberOrder = z.infer<typeof tabGroupMemberOrderSchema>;
export type TabGroupMemberMove = z.infer<typeof tabGroupMemberMoveSchema>;
export type ExplorerEntry = z.infer<typeof explorerEntrySchema>;
export type ExplorerDirectory = z.infer<typeof explorerDirectorySchema>;
export type ExplorerFile = z.infer<typeof explorerFileSchema>;
export type ExplorerFileWrite = z.infer<typeof explorerFileWriteSchema>;
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
export type WorkflowNodeExecutionWorkerResult = z.infer<
  typeof workflowNodeExecutionResultSchema
>;
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
export type WorkerProjectShareOpenResult = z.infer<
  typeof workerProjectShareOpenResultSchema
>;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type WorkerRequestEnvelope = z.infer<typeof workerRequestEnvelopeSchema>;
export type WorkerResponseEnvelope = z.infer<
  typeof workerResponseEnvelopeSchema
>;
export type WorkerEventEnvelope = z.infer<typeof workerEventEnvelopeSchema>;
export type WorkerNotification = z.infer<typeof workerNotificationSchema>;
export type WorkerNotificationEnvelope = z.infer<
  typeof workerNotificationEnvelopeSchema
>;
