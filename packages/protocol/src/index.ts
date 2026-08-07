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
export const modelProviderKindSchema = z.enum(["ollama", "openai-compatible"]);
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
  modelLocked: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const chatListSchema = z.array(chatSummarySchema);

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

export const githubWorkerRepositorySchema = githubRepositorySchema.omit({
  imported: true,
});

export const githubWorkerRepositoryListSchema = z.array(
  githubWorkerRepositorySchema,
);

export const projectCloneResultSchema = z.object({
  path: z.string().min(1),
  displayPath: z.string().min(1),
});

export const gitCommitSchema = z.object({
  hash: z.string().min(1),
  shortHash: z.string().min(1),
  subject: z.string(),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
  refs: z.array(z.string()),
});

export const gitHistorySchema = z.object({
  branch: z.string(),
  commits: z.array(gitCommitSchema),
});

export const agentTurnResultSchema = z.object({
  threadId: z.string().min(1),
  text: z.string(),
  status: z.literal("completed"),
});

export const workerCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("github.auth.status") }),
  z.object({ type: z.literal("github.repositories.list") }),
  z.object({
    type: z.literal("project.clone"),
    repository: z.object({
      nameWithOwner: githubRepositorySchema.shape.nameWithOwner,
    }),
  }),
  z.object({
    type: z.literal("git.history"),
    cwd: z.string().min(1),
    limit: z.number().int().min(1).max(500).default(100),
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

export const workerEventSchema = z.object({
  type: z.literal("agent.activity"),
  activity: agentActivitySchema,
});

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
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitHistory = z.infer<typeof gitHistorySchema>;
export type ChatCreate = z.infer<typeof chatCreateSchema>;
export type ChatUpdate = z.infer<typeof chatUpdateSchema>;
export type ChatFork = z.infer<typeof chatForkSchema>;
export type OrderedIds = z.infer<typeof orderedIdsSchema>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>;
export type ChatMessageCreate = z.infer<typeof chatMessageCreateSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatTurnCreate = z.infer<typeof chatTurnCreateSchema>;
export type ChatModelUpdate = z.infer<typeof chatModelUpdateSchema>;
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type WorkerRequestEnvelope = z.infer<typeof workerRequestEnvelopeSchema>;
export type WorkerResponseEnvelope = z.infer<
  typeof workerResponseEnvelopeSchema
>;
export type WorkerEventEnvelope = z.infer<typeof workerEventEnvelopeSchema>;
