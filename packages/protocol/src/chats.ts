import { z } from "zod";
import { taskOpaqueContentSchema, taskOpaqueSummarySchema } from "./tasks.js";
import { taskPrioritySchema } from "./task-scheduling.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { reasoningEffortSchema } from "./providers.js";
import { executionTargetSchema } from "./execution-targets.js";
import { githubAgentWorkflowContextSchema } from "./github.js";
import {
  hasUnambiguousProjectPaneDestination,
  projectPaneDestinationShape,
} from "./project-pane-identifiers.js";

const chatPlacementCreateFields = {
  worktreeId: z.string().min(1).optional(),
  worktreeMode: z.enum(["agent-managed", "pinned"]).default("agent-managed"),
  ...projectPaneDestinationShape,
  target: executionTargetSchema.optional(),
} as const;

const chatPlacementCreateSchema = z
  .object(chatPlacementCreateFields)
  .strict()
  .superRefine((input, context) => {
    if (input.worktreeId && input.target) {
      context.addIssue({
        code: "custom",
        message: "Choose either a legacy worktreeId or an execution target.",
      });
    }
    if (!hasUnambiguousProjectPaneDestination(input)) {
      context.addIssue({
        code: "custom",
        message:
          "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
        path: ["paneId"],
      });
    }
  });

export const chatCreateSchema = chatPlacementCreateSchema
  .safeExtend({
    title: z.string().trim().min(1).max(200).default("New agent"),
    githubAgentContext: githubAgentWorkflowContextSchema.optional(),
  })
  .strict();

export const encryptedChatCreateSchema = chatPlacementCreateSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    githubAgentContext: githubAgentWorkflowContextSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.titleProtection.classification.recordKind !== "chat") {
      context.addIssue({
        code: "custom",
        message: "Chat title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

const taskCreateBaseSchema = chatPlacementCreateSchema.safeExtend({
  chatId: z.string().uuid(),
  planGoalEnabled: z.boolean().default(false),
  priority: taskPrioritySchema.default(0),
  requestedTaskWorkerId: z.string().uuid().nullable().default(null),
  task: taskOpaqueContentSchema,
});

function refineInitialTask(
  input: z.infer<typeof taskCreateBaseSchema>,
  context: z.RefinementCtx,
): void {
  const classification = input.task.classification;
  if (
    classification.state !== "draft" ||
    classification.stableStateBeforeFailure !== null ||
    classification.activeOperationKind !== null ||
    classification.planAuthorship !== "agent" ||
    classification.planningRound !== 0 ||
    classification.hasPlan ||
    classification.hasQuestions ||
    classification.hasFinalPlan ||
    classification.hasGoalPrompt ||
    classification.lastError !== null
  ) {
    context.addIssue({
      code: "custom",
      message: "A new encrypted Task must begin as an empty draft.",
      path: ["task", "classification"],
    });
  }
}

export const taskCreateSchema = taskCreateBaseSchema
  .safeExtend({
    title: z.string().trim().min(1).max(200).default("New task"),
  })
  .strict()
  .superRefine(refineInitialTask);

export const encryptedTaskCreateSchema = taskCreateBaseSchema
  .safeExtend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .superRefine((input, context) => {
    refineInitialTask(input, context);
    if (input.titleProtection.classification.recordKind !== "chat") {
      context.addIssue({
        code: "custom",
        message: "Task title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
  });

export const chatUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const encryptedChatUpdateSchema = z
  .object({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "chat",
    {
      message: "Chat title classification must be chat.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const chatForkSchema = z.object({
  messageId: z.string().min(1).optional(),
  worktreeId: z.string().min(1).optional(),
  worktreeMode: z.enum(["agent-managed", "pinned"]).optional(),
});

export const encryptedChatForkSchema = chatForkSchema
  .extend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "chat",
    {
      message: "Forked chat title classification must be chat.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const orderedIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const chatContextKindSchema = z.enum(["project", "standalone"]);

export const projectChatExecutionRootSchema = z
  .object({
    contextKind: z.literal("project"),
    worktreeId: z.string().min(1),
    scratchRootId: z.null(),
  })
  .strict();

export const standaloneChatExecutionRootSchema = z
  .object({
    contextKind: z.literal("standalone"),
    worktreeId: z.null(),
    scratchRootId: z.string().min(1),
  })
  .strict();

export const chatExecutionRootSchema = z.discriminatedUnion("contextKind", [
  projectChatExecutionRootSchema,
  standaloneChatExecutionRootSchema,
]);

export const standaloneChatRootStatusSchema = z.enum([
  "provisioning",
  "ready",
  "offline",
  "failed",
  "deleting",
]);

export const standaloneChatRootSummarySchema = z
  .object({
    id: z.string().uuid(),
    chatId: z.string().uuid(),
    workerId: z.string().min(1),
    status: standaloneChatRootStatusSchema,
    provisioningRevision: z.number().int().positive(),
    archivedAt: z.string().datetime().nullable(),
    archiveExpiresAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const standaloneChatIdentitySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    "Standalone Chat identities must be canonical lowercase UUIDs.",
  );

export const standaloneChatCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).default("New chat"),
  })
  .strict();

export const encryptedStandaloneChatCreateSchema = z
  .object({
    id: standaloneChatIdentitySchema,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "chat",
    {
      message: "Standalone Chat title classification must be chat.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const standaloneChatRootJobKindSchema = z.enum(["provision", "delete"]);

export const standaloneChatRootJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
]);

export const standaloneChatRootJobErrorSchema = z
  .object({
    code: z.enum([
      "worker-offline",
      "capability-missing",
      "worker-error",
      "invalid-result",
      "root-conflict",
    ]),
    retryable: z.boolean(),
  })
  .strict();

export const standaloneChatRootJobSummarySchema = z
  .object({
    id: standaloneChatIdentitySchema,
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
    workerId: z.string().min(1).max(500),
    kind: standaloneChatRootJobKindSchema,
    state: standaloneChatRootJobStateSchema,
    stateRevision: z.number().int().positive(),
    attempt: z.number().int().nonnegative(),
    error: standaloneChatRootJobErrorSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

const standaloneChatScratchIdentityFields = {
  rootId: standaloneChatIdentitySchema,
  chatId: standaloneChatIdentitySchema,
};

export const standaloneChatScratchProvisionResultSchema = z
  .object({
    status: z.literal("ready"),
    jobId: standaloneChatIdentitySchema,
    attempt: z.number().int().positive(),
    ...standaloneChatScratchIdentityFields,
    path: z.string().min(1).max(32_768),
    displayPath: z.string().min(1).max(32_768),
    reused: z.boolean(),
  })
  .strict();

export const standaloneChatScratchResolveResultSchema = z
  .object({
    ...standaloneChatScratchIdentityFields,
    path: z.string().min(1).max(32_768),
    displayPath: z.string().min(1).max(32_768),
  })
  .strict();

export const standaloneChatScratchDeleteResultSchema = z
  .object({
    jobId: standaloneChatIdentitySchema,
    attempt: z.number().int().positive(),
    ...standaloneChatScratchIdentityFields,
    deleted: z.boolean(),
  })
  .strict();

export const standaloneChatScratchArchiveResultSchema = z
  .object({
    ...standaloneChatScratchIdentityFields,
    archivedAt: z.string().datetime().nullable(),
    archiveExpiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.archivedAt === null) !== (value.archiveExpiresAt === null)) {
      context.addIssue({
        code: "custom",
        message: "Archive timestamps must both be present or both be absent.",
      });
    } else if (
      value.archivedAt &&
      value.archiveExpiresAt &&
      Date.parse(value.archiveExpiresAt) <= Date.parse(value.archivedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Archive expiry must be later than the archive timestamp.",
      });
    }
  });

export const standaloneChatScratchReconciliationTargetSchema = z
  .object({
    ...standaloneChatScratchIdentityFields,
    archivedAt: z.string().datetime().nullable(),
    archiveExpiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine(
    (target) =>
      (target.archivedAt === null) === (target.archiveExpiresAt === null) &&
      (!target.archivedAt ||
        !target.archiveExpiresAt ||
        Date.parse(target.archiveExpiresAt) > Date.parse(target.archivedAt)),
    {
      message: "Archive timestamps and expiry are invalid.",
    },
  );

export const standaloneChatScratchReconciliationInventorySchema = z
  .object({
    roots: z.array(standaloneChatScratchReconciliationTargetSchema).max(10_000),
  })
  .strict();

export const standaloneChatScratchReconciliationResultSchema = z
  .object({
    retainedRootIds: z.array(standaloneChatIdentitySchema).max(10_000),
    missingRootIds: z.array(standaloneChatIdentitySchema).max(10_000),
    orphanedRootIds: z.array(standaloneChatIdentitySchema).max(10_000),
    dueRootIds: z.array(standaloneChatIdentitySchema).max(10_000),
  })
  .strict();

const chatSummaryBaseSchema = z.object({
  id: z.string().min(1),
  experience: z.enum(["agent", "task"]).default("agent"),
  position: z.number().int().nonnegative(),
  status: z.enum([
    "idle",
    "running",
    "waiting-for-approval",
    "offline",
    "failed",
  ]),
  activeWorkerId: z.string().min(1).nullable(),
  placementRevision: z.number().int().positive().default(1),
  modelId: z.string().min(1).nullable(),
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  customSubagentModel: z.boolean().optional(),
  subagentModelId: z.string().min(1).nullable().optional(),
  subagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
  permissionProfileId: z.string().min(1).max(200).nullable(),
  planMode: z.enum(["default", "plan"]),
  hasPendingPlanQuestion: z.boolean(),
  hasUnreadCompletion: z.boolean().default(false),
  automationPaused: z.boolean().default(false),
  githubAgentContext: githubAgentWorkflowContextSchema.nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const projectChatContextFields = {
  contextKind: z.literal("project").default("project"),
  projectId: z.string().min(1),
  activeWorktreeId: z.string().min(1),
  activeScratchRootId: z.null().default(null),
  worktreeMode: z.enum(["agent-managed", "pinned"]),
} as const;

const legacyProjectChatContextFields = {
  contextKind: z.literal("project").optional(),
  projectId: z.string().min(1),
  activeWorktreeId: z.string().min(1),
  activeScratchRootId: z.null().optional(),
  worktreeMode: z.enum(["agent-managed", "pinned"]),
} as const;

const standaloneChatContextFields = {
  contextKind: z.literal("standalone"),
  projectId: z.null(),
  activeWorktreeId: z.null(),
  activeScratchRootId: z.string().min(1),
  worktreeMode: z.null(),
  experience: z.literal("agent"),
  customSubagentModel: z.literal(false).optional(),
  subagentModelId: z.null().optional(),
  subagentReasoningEffort: z.null().optional(),
  planMode: z.literal("default"),
  hasPendingPlanQuestion: z.literal(false),
} as const;

export const projectChatSummarySchema = chatSummaryBaseSchema
  .extend({
    ...projectChatContextFields,
    title: z.string().min(1).max(200),
  })
  .strict();

export const standaloneChatSummarySchema = chatSummaryBaseSchema
  .extend({
    ...standaloneChatContextFields,
    title: z.string().min(1).max(200),
  })
  .strict();

export const contextualChatSummarySchema = z.union([
  projectChatSummarySchema,
  standaloneChatSummarySchema,
]);

export const chatSummarySchema = chatSummaryBaseSchema
  .extend({
    ...legacyProjectChatContextFields,
    title: z.string().min(1).max(200),
  })
  .strict();

export const projectChatWireSummarySchema = chatSummaryBaseSchema
  .extend({
    ...projectChatContextFields,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine((chat) => chat.titleProtection.classification.recordKind === "chat", {
    message: "Chat title classification must be chat.",
    path: ["titleProtection", "classification", "recordKind"],
  });

export const standaloneChatWireSummarySchema = chatSummaryBaseSchema
  .extend({
    ...standaloneChatContextFields,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine((chat) => chat.titleProtection.classification.recordKind === "chat", {
    message: "Chat title classification must be chat.",
    path: ["titleProtection", "classification", "recordKind"],
  });

export const contextualChatWireSummarySchema = z.union([
  projectChatWireSummarySchema,
  standaloneChatWireSummarySchema,
]);

export const chatWireSummarySchema = chatSummaryBaseSchema
  .extend({
    ...legacyProjectChatContextFields,
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine((chat) => chat.titleProtection.classification.recordKind === "chat", {
    message: "Chat title classification must be chat.",
    path: ["titleProtection", "classification", "recordKind"],
  });

export const taskCreateResultSchema = z.object({
  chat: chatSummarySchema,
  task: taskOpaqueSummarySchema,
});

export const taskWireCreateResultSchema = z.object({
  chat: chatWireSummarySchema,
  task: taskOpaqueSummarySchema,
});

export const chatListSchema = z.array(chatSummarySchema);
export const chatWireListSchema = z.array(chatWireSummarySchema);

const archivedChatSummaryBaseSchema = z.object({
  id: z.string().min(1),
  experience: z.enum(["agent", "task"]).default("agent"),
  messageCount: z.number().int().nonnegative(),
  archivedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const archivedProjectChatSummarySchema = archivedChatSummaryBaseSchema
  .extend({
    contextKind: z.literal("project").default("project"),
    projectId: z.string().min(1),
    title: z.string().min(1).max(200),
  })
  .strict();

export const archivedStandaloneChatSummarySchema = archivedChatSummaryBaseSchema
  .extend({
    contextKind: z.literal("standalone"),
    projectId: z.null(),
    experience: z.literal("agent"),
    title: z.string().min(1).max(200),
  })
  .strict();

export const contextualArchivedChatSummarySchema = z.union([
  archivedProjectChatSummarySchema,
  archivedStandaloneChatSummarySchema,
]);

export const archivedChatSummarySchema = archivedChatSummaryBaseSchema
  .extend({
    contextKind: z.literal("project").optional(),
    projectId: z.string().min(1),
    title: z.string().min(1).max(200),
  })
  .strict();

export const archivedProjectChatWireSummarySchema =
  archivedChatSummaryBaseSchema
    .extend({
      contextKind: z.literal("project").default("project"),
      projectId: z.string().min(1),
      titleProtection: privateDisplayLabelOpaqueSchema,
    })
    .strict()
    .refine(
      (chat) => chat.titleProtection.classification.recordKind === "chat",
      {
        message: "Archived chat title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      },
    );

export const archivedStandaloneChatWireSummarySchema =
  archivedChatSummaryBaseSchema
    .extend({
      contextKind: z.literal("standalone"),
      projectId: z.null(),
      experience: z.literal("agent"),
      titleProtection: privateDisplayLabelOpaqueSchema,
    })
    .strict()
    .refine(
      (chat) => chat.titleProtection.classification.recordKind === "chat",
      {
        message: "Archived chat title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      },
    );

export const contextualArchivedChatWireSummarySchema = z.union([
  archivedProjectChatWireSummarySchema,
  archivedStandaloneChatWireSummarySchema,
]);

export const archivedChatWireSummarySchema = archivedChatSummaryBaseSchema
  .extend({
    contextKind: z.literal("project").optional(),
    projectId: z.string().min(1),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine((chat) => chat.titleProtection.classification.recordKind === "chat", {
    message: "Archived chat title classification must be chat.",
    path: ["titleProtection", "classification", "recordKind"],
  });

export const archivedChatListSchema = z.array(archivedChatSummarySchema);
export const archivedChatWireListSchema = z.array(
  archivedChatWireSummarySchema,
);

export const archivedChatCleanupResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
});

export type StandaloneChatRootJobKind = z.infer<
  typeof standaloneChatRootJobKindSchema
>;
export type StandaloneChatRootJobState = z.infer<
  typeof standaloneChatRootJobStateSchema
>;
export type StandaloneChatRootJobError = z.infer<
  typeof standaloneChatRootJobErrorSchema
>;
export type StandaloneChatRootJobSummary = z.infer<
  typeof standaloneChatRootJobSummarySchema
>;
export type StandaloneChatScratchProvisionResult = z.infer<
  typeof standaloneChatScratchProvisionResultSchema
>;
export type StandaloneChatScratchResolveResult = z.infer<
  typeof standaloneChatScratchResolveResultSchema
>;
export type StandaloneChatScratchDeleteResult = z.infer<
  typeof standaloneChatScratchDeleteResultSchema
>;
export type StandaloneChatScratchArchiveResult = z.infer<
  typeof standaloneChatScratchArchiveResultSchema
>;
export type StandaloneChatScratchReconciliationTarget = z.infer<
  typeof standaloneChatScratchReconciliationTargetSchema
>;
export type StandaloneChatScratchReconciliationResult = z.infer<
  typeof standaloneChatScratchReconciliationResultSchema
>;
export type ChatCreate = z.infer<typeof chatCreateSchema>;
export type EncryptedChatCreate = z.infer<typeof encryptedChatCreateSchema>;
export type StandaloneChatCreate = z.infer<typeof standaloneChatCreateSchema>;
export type EncryptedStandaloneChatCreate = z.infer<
  typeof encryptedStandaloneChatCreateSchema
>;
export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type EncryptedTaskCreate = z.infer<typeof encryptedTaskCreateSchema>;
export type TaskCreateResult = z.infer<typeof taskCreateResultSchema>;
export type TaskWireCreateResult = z.infer<typeof taskWireCreateResultSchema>;
export type ChatUpdate = z.infer<typeof chatUpdateSchema>;
export type EncryptedChatUpdate = z.infer<typeof encryptedChatUpdateSchema>;
export type ChatFork = z.infer<typeof chatForkSchema>;
export type EncryptedChatFork = z.infer<typeof encryptedChatForkSchema>;
export type OrderedIds = z.infer<typeof orderedIdsSchema>;
export type ChatContextKind = z.infer<typeof chatContextKindSchema>;
export type ProjectChatExecutionRoot = z.infer<
  typeof projectChatExecutionRootSchema
>;
export type StandaloneChatExecutionRoot = z.infer<
  typeof standaloneChatExecutionRootSchema
>;
export type ChatExecutionRoot = z.infer<typeof chatExecutionRootSchema>;
export type StandaloneChatRootStatus = z.infer<
  typeof standaloneChatRootStatusSchema
>;
export type StandaloneChatRootSummary = z.infer<
  typeof standaloneChatRootSummarySchema
>;
export type ProjectChatSummary = z.infer<typeof projectChatSummarySchema>;
export type StandaloneChatSummary = z.infer<typeof standaloneChatSummarySchema>;
export type ProjectChatWireSummary = z.infer<
  typeof projectChatWireSummarySchema
>;
export type StandaloneChatWireSummary = z.infer<
  typeof standaloneChatWireSummarySchema
>;
export type ContextualChatSummary = z.infer<typeof contextualChatSummarySchema>;
export type ContextualChatWireSummary = z.infer<
  typeof contextualChatWireSummarySchema
>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export type ChatWireSummary = z.infer<typeof chatWireSummarySchema>;
export type ArchivedChatSummary = z.infer<typeof archivedChatSummarySchema>;
export type ArchivedChatWireSummary = z.infer<
  typeof archivedChatWireSummarySchema
>;
export type ArchivedStandaloneChatSummary = z.infer<
  typeof archivedStandaloneChatSummarySchema
>;
export type ArchivedStandaloneChatWireSummary = z.infer<
  typeof archivedStandaloneChatWireSummarySchema
>;
export type ArchivedChatCleanupResult = z.infer<
  typeof archivedChatCleanupResultSchema
>;
