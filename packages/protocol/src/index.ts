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
  }),
});

export const workerHeartbeatSchema = z.object({
  workerId: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  codexVersion: z.string().nullable(),
  startedAt: z.string().datetime(),
});

export const workerSummarySchema = workerHeartbeatSchema.extend({
  online: z.boolean(),
  lastSeenAt: z.string().datetime(),
});

export const workerListSchema = z.array(workerSummarySchema);

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

export const modelProfileCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  providerId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
});

export const modelProfileUpdateSchema = modelProfileCreateSchema;

export const modelProfileSummarySchema = modelProfileCreateSchema.extend({
  id: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
  providerName: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const modelProfileListSchema = z.array(modelProfileSummarySchema);

export const userSettingsSchema = z.object({
  theme: themePreferenceSchema,
  highContrast: z.boolean(),
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

export const projectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
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
});

export const chatUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const chatForkSchema = z.object({
  messageId: z.string().min(1).optional(),
});

export const orderedIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const chatSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  status: z.enum(["idle", "running", "offline", "failed"]),
  activeWorkerId: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const chatListSchema = z.array(chatSummarySchema);

export const terminalCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Terminal"),
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
  linkedChatId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const terminalListSchema = z.array(terminalSummarySchema);

export const explorerCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Explorer"),
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
export const agentActivityStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "declined",
]);
export const agentActivitySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command"),
    id: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    status: agentActivityStatusSchema,
    exitCode: z.number().int().nullable(),
    output: z.string().nullable(),
  }),
  z.object({
    type: z.literal("fileChange"),
    id: z.string().min(1),
    status: agentActivityStatusSchema,
    changes: z.array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(["add", "delete", "update"]),
      }),
    ),
  }),
]);
export const chatMessageContentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      text: z.string().min(1),
    }),
    z.object({
      type: z.literal("activity"),
      activity: agentActivitySchema,
    }),
  ]),
);

export const chatMessageCreateSchema = z.object({
  role: chatMessageRoleSchema,
  content: chatMessageContentSchema.min(1),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const chatMessageSchema = chatMessageCreateSchema
  .omit({ idempotencyKey: true })
  .extend({
    id: z.string().min(1),
    chatId: z.string().min(1),
    sequence: z.number().int().positive(),
    createdAt: z.string().datetime(),
  });

export const chatMessageListSchema = z.array(chatMessageSchema);

export const chatTurnCreateSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  idempotencyKey: z.string().min(1).max(200),
  modelId: z.string().min(1).optional(),
});

export const chatModelUpdateSchema = z.object({
  modelId: z.string().min(1),
});

export const chatTurnAcceptedSchema = z.object({
  accepted: z.literal(true),
  message: chatMessageSchema,
});

export const chatCompactAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const chatInterruptAcceptedSchema = z.object({
  interrupted: z.boolean(),
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

export const agentTurnResultSchema = z.object({
  threadId: z.string().min(1),
  text: z.string(),
  status: z.literal("completed"),
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
  z.object({ type: z.literal("github.repositories.list") }),
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
    type: z.literal("terminal.open"),
    terminalId: z.string().min(1),
    attachmentId: z.string().min(1),
    cwd: z.string().min(1),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
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
    type: z.literal("chat.turn"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    prompt: z.string().min(1),
    model: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      reasoningEffort: reasoningEffortSchema.nullable(),
    }),
    provider: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: modelProviderKindSchema,
      baseUrl: z.url(),
      apiKey: z.string().min(1).nullable(),
    }),
  }),
  z.object({
    type: z.literal("chat.compact"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      reasoningEffort: reasoningEffortSchema.nullable(),
    }),
    provider: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: modelProviderKindSchema,
      baseUrl: z.url(),
      apiKey: z.string().min(1).nullable(),
    }),
  }),
  z.object({
    type: z.literal("chat.interrupt"),
    chatId: z.string().min(1),
    threadId: z.string().min(1),
    model: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      reasoningEffort: reasoningEffortSchema.nullable(),
    }),
    provider: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: modelProviderKindSchema,
      baseUrl: z.url(),
      apiKey: z.string().min(1).nullable(),
    }),
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
export type UserSummary = z.infer<typeof userSummarySchema>;
export type ServerBootstrap = z.infer<typeof serverBootstrapSchema>;
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
export type WorkerSummary = z.infer<typeof workerSummarySchema>;
export type SystemHealth = z.infer<typeof systemHealthSchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type ModelProviderKind = z.infer<typeof modelProviderKindSchema>;
export type CodexAuthStatus = z.infer<typeof codexAuthStatusSchema>;
export type CodexDeviceLogin = z.infer<typeof codexDeviceLoginSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ModelProviderCreate = z.infer<typeof modelProviderCreateSchema>;
export type ModelProviderUpdate = z.infer<typeof modelProviderUpdateSchema>;
export type ModelProviderSummary = z.infer<typeof modelProviderSummarySchema>;
export type ModelProfileCreate = z.infer<typeof modelProfileCreateSchema>;
export type ModelProfileUpdate = z.infer<typeof modelProfileUpdateSchema>;
export type ModelProfileSummary = z.infer<typeof modelProfileSummarySchema>;
export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;
export type SettingsBundle = z.infer<typeof settingsBundleSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type GithubAuthStatus = z.infer<typeof githubAuthStatusSchema>;
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
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
export type ChatCreate = z.infer<typeof chatCreateSchema>;
export type ChatUpdate = z.infer<typeof chatUpdateSchema>;
export type ChatFork = z.infer<typeof chatForkSchema>;
export type OrderedIds = z.infer<typeof orderedIdsSchema>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export type TerminalCreate = z.infer<typeof terminalCreateSchema>;
export type TerminalUpdate = z.infer<typeof terminalUpdateSchema>;
export type TerminalSummary = z.infer<typeof terminalSummarySchema>;
export type ExplorerCreate = z.infer<typeof explorerCreateSchema>;
export type ExplorerUpdate = z.infer<typeof explorerUpdateSchema>;
export type ExplorerSummary = z.infer<typeof explorerSummarySchema>;
export type BrowserCreate = z.infer<typeof browserCreateSchema>;
export type BrowserUpdate = z.infer<typeof browserUpdateSchema>;
export type BrowserSummary = z.infer<typeof browserSummarySchema>;
export type ExplorerEntry = z.infer<typeof explorerEntrySchema>;
export type ExplorerDirectory = z.infer<typeof explorerDirectorySchema>;
export type ExplorerFile = z.infer<typeof explorerFileSchema>;
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
export type TerminalOpenResult = z.infer<typeof terminalOpenResultSchema>;
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>;
export type ChatMessageCreate = z.infer<typeof chatMessageCreateSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatTurnCreate = z.infer<typeof chatTurnCreateSchema>;
export type ChatModelUpdate = z.infer<typeof chatModelUpdateSchema>;
export type ChatCompactAccepted = z.infer<typeof chatCompactAcceptedSchema>;
export type ChatInterruptAccepted = z.infer<typeof chatInterruptAcceptedSchema>;
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type WorkerRequestEnvelope = z.infer<typeof workerRequestEnvelopeSchema>;
export type WorkerResponseEnvelope = z.infer<
  typeof workerResponseEnvelopeSchema
>;
export type WorkerEventEnvelope = z.infer<typeof workerEventEnvelopeSchema>;
