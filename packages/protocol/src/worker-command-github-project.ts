import { z } from "zod";
import { repositoryRoutingHandleSchema } from "./repository-operation.js";
import { protectedTunnelContentRecordSchema } from "./tunnel-content.js";
import {
  runConfigurationCapabilitiesWorkerCommandSchema,
  runConfigurationDetectWorkerCommandSchema,
  runConfigurationDeleteWorkerCommandSchema,
  runConfigurationFlutterDevicesWorkerCommandSchema,
  runConfigurationGetWorkerCommandSchema,
  runConfigurationListWorkerCommandSchema,
  runConfigurationPathsWorkerCommandSchema,
  runConfigurationValidateWorkerCommandSchema,
  runConfigurationWriteWorkerCommandSchema,
} from "./run-configuration-operations.js";
import {
  runConfigurationRuntimeOutputWorkerCommandSchema,
  runConfigurationRuntimeReconcileWorkerCommandSchema,
  runConfigurationRuntimeRestartWorkerCommandSchema,
  runConfigurationRuntimeStartWorkerCommandSchema,
  runConfigurationRuntimeStatusWorkerCommandSchema,
  runConfigurationRuntimeStopWorkerCommandSchema,
} from "./run-configuration-runtime.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { terminalPrivateStateOpaqueSchema } from "./surface-private-state.js";
import { projectAutomationOpaqueContentSchema } from "./automations.js";
import { reasoningEffortSchema } from "./providers.js";
import {
  githubRepositoryCreateSchema,
  githubIssueStateSchema,
  githubIssueKindSchema,
  githubInboxViewSchema,
  githubIssueListFiltersSchema,
  githubListCursorSchema,
  githubIssueCreateSchema,
  githubIssueCommentCreateSchema,
  githubPullRequestCreateSchema,
  githubPullRequestReviewSubmitSchema,
  githubPullRequestInlineCommentCreateSchema,
  githubPullRequestLifecycleActionSchema,
  githubPullRequestLifecycleApplySchema,
  githubActionsWorkflowDispatchSchema,
  githubActionsRunActionSchema,
  githubReleaseCreateSchema,
} from "./github.js";
import {
  projectGithubWireRepositorySchema,
  projectReplicaPlacementRequestSchema,
  projectReplicaPlacementResultSchema,
  gitObjectRevisionSchema,
  projectReplicaSynchronizationPolicySchema,
  projectWorkspaceStorageContextSchema,
} from "./projects.js";
import { chatTurnModeSchema } from "./chat-messages.js";
import {
  projectGithubConversionPreflightReadySchema,
  projectGithubConversionStartSchema,
} from "./project-provisioning.js";
import {
  externalChatSourceKindSchema,
  externalChatThreadMetadataSchema,
  externalChatSourceSchema,
  externalChatDiscoveryTargetSchema,
  externalChatAttachmentSchema,
} from "./external-chat-imports.js";
import { projectExportTargetSchema } from "./project-exports.js";
import { workerRepositoryNameSchema } from "./worker-command-shared.js";

export const workerGithubProjectCommandSchemas = [
  z.object({ type: z.literal("github.auth.status") }),
  z.object({
    type: z.literal("github.repositories.cached"),
    login: z.string().min(1),
  }),
  z.object({ type: z.literal("github.repositories.list") }),
  z.object({ type: z.literal("github.repository-owners.list") }),
  z.object({
    type: z.literal("github.repositories.create"),
    request: githubRepositoryCreateSchema,
  }),
  z.object({
    type: z.literal("automation.dispatch.protect"),
    automationId: z.string().uuid(),
    content: projectAutomationOpaqueContentSchema,
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema.nullable(),
    promptId: z.string().uuid(),
    messageId: z.string().uuid(),
    mode: chatTurnModeSchema,
    modelId: z.string().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.nullable(),
    customSubagentModel: z.boolean().optional(),
    subagentModelId: z.string().min(1).max(200).nullable().optional(),
    subagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("github.issues.list"),
    repository: workerRepositoryNameSchema,
    state: githubIssueStateSchema,
    cursor: githubListCursorSchema,
    limit: z.number().int().min(1).max(100).default(100),
    filters: githubIssueListFiltersSchema.prefault({}),
  }),
  z.object({
    type: z.literal("github.inbox.list"),
    repository: workerRepositoryNameSchema,
    kind: githubIssueKindSchema.default("issue"),
    state: githubIssueStateSchema,
    view: githubInboxViewSchema.default("all"),
    cursor: z.string().min(1).max(2_000).nullable().default(null),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    type: z.literal("github.issue.get"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.issue.create"),
    repository: workerRepositoryNameSchema,
    request: githubIssueCreateSchema,
  }),
  z.object({
    type: z.literal("github.issue.comment"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    body: z.string().trim().min(1).max(65_536),
  }),
  z.object({
    type: z.literal("github.issue.close"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    comment: z.string().trim().min(1).max(65_536).nullable(),
  }),
  z.object({
    type: z.literal("github.pull-request.create"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    request: githubPullRequestCreateSchema,
  }),
  z.object({
    type: z.literal("github.pull-requests.list"),
    repository: workerRepositoryNameSchema,
    state: githubIssueStateSchema,
    cursor: githubListCursorSchema,
    limit: z.number().int().min(1).max(100).default(100),
    filters: githubIssueListFiltersSchema.prefault({}),
  }),
  z.object({
    type: z.literal("github.pull-request.get"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    section: z
      .enum(["all", "overview", "files", "commits", "checks"])
      .default("all"),
  }),
  z.object({
    type: z.literal("github.pull-request.comment"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    body: githubIssueCommentCreateSchema.shape.body,
  }),
  z.object({
    type: z.literal("github.pull-request.review.submit"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    review: githubPullRequestReviewSubmitSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.review.comment"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    comment: githubPullRequestInlineCommentCreateSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.review.reply"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    commentId: z.number().int().positive(),
    body: githubIssueCommentCreateSchema.shape.body,
  }),
  z.object({
    type: z.literal("github.pull-request.lifecycle.preview"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    action: githubPullRequestLifecycleActionSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.lifecycle.apply"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    request: githubPullRequestLifecycleApplySchema,
  }),
  z.object({
    type: z.literal("github.pull-request.checkout.prepare"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.actions.overview"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    type: z.literal("github.actions.run.get"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    runId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.actions.run.logs"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    runId: z.number().int().positive(),
    jobId: z.number().int().positive().nullable().default(null),
  }),
  z.object({
    type: z.literal("github.actions.workflow.dispatch"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    request: githubActionsWorkflowDispatchSchema,
  }),
  z.object({
    type: z.literal("github.actions.run.action"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    request: githubActionsRunActionSchema,
  }),
  z.object({
    type: z.literal("github.actions.run.checkout.prepare"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    runId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.releases.list"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
  }),
  z.object({
    type: z.literal("github.release.get"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    releaseId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.release.create"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    request: githubReleaseCreateSchema,
  }),
  z.object({
    type: z.literal("project.clone"),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
  }),
  z.object({
    type: z.literal("project.folder.materialize"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid(),
    workspaceStorage: projectWorkspaceStorageContextSchema.default({
      kind: "system",
    }),
    existingPath: z.string().trim().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("project.folder.delete"),
    projectId: z.string().uuid(),
    workspaceStorage: projectWorkspaceStorageContextSchema.default({
      kind: "system",
    }),
  }),
  z
    .object({
      type: z.literal("project.folder-conversion.preflight"),
      projectId: z.string().uuid(),
      repository: projectGithubWireRepositorySchema,
      sourcePath: repositoryRoutingHandleSchema.optional(),
      sourceDisplayPath: repositoryRoutingHandleSchema.optional(),
      workspaceStorage: projectWorkspaceStorageContextSchema.default({
        kind: "system",
      }),
    })
    .refine(
      (input) =>
        (input.sourcePath === undefined) ===
        (input.sourceDisplayPath === undefined),
      {
        message: "External conversion source fields must be provided together.",
      },
    ),
  z
    .object({
      type: z.literal("project.folder-conversion.execute"),
      jobId: z.string().uuid(),
      attempt: z.number().int().positive(),
      projectId: z.string().uuid(),
      repository: projectGithubWireRepositorySchema,
      sourcePath: repositoryRoutingHandleSchema.optional(),
      sourceDisplayPath: repositoryRoutingHandleSchema.optional(),
      workspaceStorage: projectWorkspaceStorageContextSchema.default({
        kind: "system",
      }),
      confirmationToken:
        projectGithubConversionPreflightReadySchema.shape.confirmationToken,
      initialCommit: projectGithubConversionStartSchema.shape.initialCommit,
    })
    .refine(
      (input) =>
        (input.sourcePath === undefined) ===
        (input.sourceDisplayPath === undefined),
      {
        message: "External conversion source fields must be provided together.",
      },
    ),
  z.object({
    type: z.literal("project.replica.provision"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z
      .object({
        nameWithOwner: workerRepositoryNameSchema,
      })
      .nullable(),
    workspaceStorage: projectWorkspaceStorageContextSchema.default({
      kind: "system",
    }),
    placement: projectReplicaPlacementRequestSchema.optional(),
    expectedRevision: gitObjectRevisionSchema.nullable(),
  }),
  z.object({
    type: z.literal("project.replica.synchronize"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    sourcePath: z.string().min(1).max(8_192),
    placement: projectReplicaPlacementResultSchema.optional(),
    repositoryFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedRevision: gitObjectRevisionSchema,
    policy: projectReplicaSynchronizationPolicySchema,
  }),
  z.object({
    type: z.literal("project.replica.remove"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z
      .object({
        nameWithOwner: workerRepositoryNameSchema,
      })
      .nullable(),
    sourcePath: z.string().min(1).max(8_192),
    placement: projectReplicaPlacementResultSchema.optional(),
    repositoryFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    deleteLocalFiles: z.boolean(),
  }),
  z.object({
    type: z.literal("project.replica.link.repair"),
    projectId: z.string().uuid(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    sourcePath: z.string().min(1).max(8_192),
    linkPath: z.string().min(1).max(8_192),
    repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.object({
    type: z.literal("project.files.delete"),
    path: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("project.script-commands"),
      operationId: z.string().uuid(),
      terminalId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(255),
      worktreePath: z.string().min(1).max(8_192),
      stateProtection: terminalPrivateStateOpaqueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.script-commands.inspect"),
      operationId: z.string().uuid(),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      sourcePath: z.string().min(1).max(8_192),
    })
    .strict(),
  runConfigurationListWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.list"),
  }),
  runConfigurationGetWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.get"),
  }),
  runConfigurationCapabilitiesWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.capabilities"),
  }),
  runConfigurationDetectWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.detect"),
  }),
  runConfigurationPathsWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.paths"),
  }),
  runConfigurationFlutterDevicesWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.flutter-devices"),
  }),
  runConfigurationValidateWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.validate"),
  }),
  runConfigurationWriteWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.write"),
  }),
  runConfigurationDeleteWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.delete"),
  }),
  runConfigurationRuntimeStartWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.start"),
  }),
  runConfigurationRuntimeRestartWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.restart"),
  }),
  runConfigurationRuntimeStopWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.stop"),
  }),
  runConfigurationRuntimeStatusWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.status"),
  }),
  runConfigurationRuntimeOutputWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.output"),
  }),
  runConfigurationRuntimeReconcileWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.reconcile"),
  }),
  z.object({
    type: z.literal("project.repository-stats"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("project.folder-stats"),
    root: z.string().min(1).max(8_192),
  }),
  z
    .object({
      type: z.literal("project.export.target.inspect"),
      target: projectExportTargetSchema,
      cwd: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.export.chat.begin"),
      operationId: z.string().uuid(),
      target: projectExportTargetSchema,
      chatId: z.string().min(1).max(200),
      cwd: z.string().min(1).max(8_192),
      titleProtection: privateDisplayLabelOpaqueSchema,
      transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .max(256 * 1_024 * 1_024),
    })
    .strict()
    .refine(
      (command) => command.titleProtection.classification.recordKind === "chat",
      {
        message: "Project export title protection must be a chat label.",
        path: ["titleProtection"],
      },
    ),
  z
    .object({
      type: z.literal("project.export.chat.chunk"),
      operationId: z.string().uuid(),
      chatId: z.string().min(1).max(200),
      chunkIndex: z.number().int().nonnegative(),
      data: z.string().max(400_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.export.chat.complete"),
      operationId: z.string().uuid(),
      chatId: z.string().min(1).max(200),
    })
    .strict(),
  z.object({
    type: z.literal("external.chat-history.discover"),
    includeArchived: z.boolean().default(false),
    targets: z.array(externalChatDiscoveryTargetSchema).min(1).max(64),
  }),
  z.object({
    type: z.literal("external.chat-history.read"),
    ownerId: z.string().min(1).max(200),
    chatId: z.string().uuid(),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    targets: z.array(externalChatDiscoveryTargetSchema).min(1).max(64),
  }),
  z.object({
    type: z.literal("external.chat-history.attachment.read"),
    ownerId: z.string().min(1).max(200),
    chatId: z.string().uuid(),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    attachmentId: externalChatAttachmentSchema.shape.sourceAttachmentId,
    targetAttachmentId: externalChatAttachmentSchema.shape.id,
    operationId: z.string().uuid(),
    sequence: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(256 * 1_024),
  }),
  z.object({
    type: z.literal("external.chat-history.attachments.release"),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  }),
  z.object({ type: z.literal("browser.services.discover") }),
  z
    .object({
      type: z.literal("mcp.configurations.discover"),
      projectRoot: z.string().min(1).max(8_192).nullable().default(null),
    })
    .strict(),
  z.object({
    type: z.literal("project.share.open"),
    shareId: z.string().min(1).max(200),
    protectedRecord: protectedTunnelContentRecordSchema,
    standaloneRoot: z
      .object({
        chatId: z.string().uuid(),
        rootId: z.string().uuid(),
      })
      .strict()
      .nullable()
      .default(null),
  }),
  z.object({
    type: z.literal("project.share.close"),
    shareId: z.string().min(1).max(200),
  }),
] as const;
