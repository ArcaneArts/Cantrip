import { z } from "zod";

import { workflowMeasuredUsageSchema } from "./workflows.js";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const REPOSITORY_OPERATION_PROTECTED_CONTENT_BYTES_LIMIT =
  16 * 1_024 * 1_024;

export const repositoryRoutingHandleSchema = z
  .string()
  .regex(/^ctrr_[A-Za-z0-9_-]{43}$/u);

export const workspaceRootAttachmentSchema = z
  .object({
    rootPathHandle: repositoryRoutingHandleSchema,
    displayHandle: repositoryRoutingHandleSchema,
  })
  .strict();

export const workspaceRootAttachmentErrorCodeSchema = z.enum([
  "invalid-root",
  "root-unavailable",
]);

export const workspaceRootAttachArgumentsSchema = z
  .object({ rootPath: z.string().trim().min(1).max(8_192) })
  .strict();

export const REPOSITORY_METADATA_FIELDS = [
  "branch",
  "canonicalPath",
  "displayPath",
  "existingPath",
  "gitCommonDir",
  "linkPath",
  "lockReason",
  "managedRoot",
  "message",
  "name",
  "nameWithOwner",
  "originalPath",
  "originUrl",
  "path",
  "placementPath",
  "primaryPath",
  "pruneReason",
  "prunedPaths",
  "removedPath",
  "repositoryId",
  "requestedPath",
  "revision",
  "rootPath",
  "sourceDisplayPath",
  "sourcePath",
  "setupError",
  "startPoint",
  "upstream",
  "url",
  "warning",
  "warnings",
  "worktreePath",
] as const;

const repositoryMetadataFieldNames = new Set<string>(
  REPOSITORY_METADATA_FIELDS,
);

export const repositoryMetadataValuesSchema = z
  .record(
    z.string().min(1).max(120),
    z.union([
      z.string().min(1).max(32_768),
      z.array(z.string().min(1).max(32_768)).max(100),
      z.null(),
    ]),
  )
  .refine(
    (values) =>
      Object.keys(values).every((field) =>
        repositoryMetadataFieldNames.has(field),
      ),
    { message: "Repository metadata contains an unsupported field." },
  )
  .refine((values) => Object.keys(values).length <= 64, {
    message: "Repository metadata is too large.",
  });

export const repositoryMetadataResultSchema = z
  .object({ values: repositoryMetadataValuesSchema })
  .strict();

export const repositoryOperationTypeSchema = z.enum([
  "git.history",
  "git.graph.snapshot",
  "git.graph.metrics",
  "git.graph.commit-overlay",
  "git.file.history",
  "git.file.blame",
  "git.commit.search",
  "git.recovery.list",
  "git.recovery.preview",
  "git.recovery.apply",
  "git.commit.get",
  "git.commit.signature.get",
  "git.refs.list",
  "git.compare",
  "git.revision.diff",
  "git.status",
  "git.diff",
  "git.patch.preview",
  "git.patch.apply",
  "git.stash.list",
  "git.stash.create",
  "git.stash.diff",
  "git.stash.action.preview",
  "git.stash.action.apply",
  "git.branch.list",
  "git.branch.action.preview",
  "git.branch.action.apply",
  "git.remote.list",
  "git.remote.action.preview",
  "git.remote.action.apply",
  "git.submodule.list",
  "git.submodule.action.preview",
  "git.submodule.action.apply",
  "git.lfs.status",
  "git.lfs.action.preview",
  "git.lfs.action.apply",
  "git.tag.list",
  "git.tag.get",
  "git.tag.action.preview",
  "git.tag.action.apply",
  "git.commit.action.preview",
  "git.commit.action.apply",
  "git.operation.current",
  "git.operation.preview",
  "git.operation.start",
  "git.operation.control",
  "git.operation.amend",
  "git.conflicts.list",
  "git.conflicts.get",
  "git.conflicts.preview",
  "git.conflicts.apply",
  "git.action",
  "git.force-push.preview",
  "git.force-push.apply",
  "git.agent.generate",
  "worktree.status",
  "repository.metadata.register",
  "repository.metadata.resolve",
  "workspace.root.attach",
  "github.auth.status",
  "github.repositories.cached",
  "github.repositories.list",
  "github.repository-owners.list",
  "github.repositories.create",
  "github.issues.list",
  "github.inbox.list",
  "github.issue.get",
  "github.issue.create",
  "github.issue.comment",
  "github.issue.close",
  "github.pull-requests.list",
  "github.pull-request.get",
  "github.pull-request.create",
  "github.pull-request.comment",
  "github.pull-request.review.submit",
  "github.pull-request.review.comment",
  "github.pull-request.review.reply",
  "github.pull-request.lifecycle.preview",
  "github.pull-request.lifecycle.apply",
  "github.pull-request.checkout.prepare",
  "github.releases.list",
  "github.release.get",
  "github.release.create",
]);

export type RepositoryOperationType = z.infer<
  typeof repositoryOperationTypeSchema
>;

export const repositoryOperationAccessSchema = z.enum(["read", "write"]);

export type RepositoryOperationAccess = z.infer<
  typeof repositoryOperationAccessSchema
>;

const repositoryOperationAccessByType = {
  "git.history": "read",
  "git.graph.snapshot": "read",
  "git.graph.metrics": "read",
  "git.graph.commit-overlay": "read",
  "git.file.history": "read",
  "git.file.blame": "read",
  "git.commit.search": "read",
  "git.recovery.list": "read",
  "git.recovery.preview": "read",
  "git.recovery.apply": "write",
  "git.commit.get": "read",
  "git.commit.signature.get": "read",
  "git.refs.list": "read",
  "git.compare": "read",
  "git.revision.diff": "read",
  "git.status": "read",
  "git.diff": "read",
  "git.patch.preview": "read",
  "git.patch.apply": "write",
  "git.stash.list": "read",
  "git.stash.create": "write",
  "git.stash.diff": "read",
  "git.stash.action.preview": "read",
  "git.stash.action.apply": "write",
  "git.branch.list": "read",
  "git.branch.action.preview": "read",
  "git.branch.action.apply": "write",
  "git.remote.list": "read",
  "git.remote.action.preview": "read",
  "git.remote.action.apply": "write",
  "git.submodule.list": "read",
  "git.submodule.action.preview": "read",
  "git.submodule.action.apply": "write",
  "git.lfs.status": "read",
  "git.lfs.action.preview": "read",
  "git.lfs.action.apply": "write",
  "git.tag.list": "read",
  "git.tag.get": "read",
  "git.tag.action.preview": "read",
  "git.tag.action.apply": "write",
  "git.commit.action.preview": "read",
  "git.commit.action.apply": "write",
  "git.operation.current": "read",
  "git.operation.preview": "read",
  "git.operation.start": "write",
  "git.operation.control": "write",
  "git.operation.amend": "write",
  "git.conflicts.list": "read",
  "git.conflicts.get": "read",
  "git.conflicts.preview": "read",
  "git.conflicts.apply": "write",
  "git.action": "write",
  "git.force-push.preview": "read",
  "git.force-push.apply": "write",
  "git.agent.generate": "read",
  "worktree.status": "read",
  "repository.metadata.register": "write",
  "repository.metadata.resolve": "read",
  "workspace.root.attach": "write",
  "github.auth.status": "read",
  "github.repositories.cached": "read",
  "github.repositories.list": "read",
  "github.repository-owners.list": "read",
  "github.repositories.create": "write",
  "github.issues.list": "read",
  "github.inbox.list": "read",
  "github.issue.get": "read",
  "github.issue.create": "write",
  "github.issue.comment": "write",
  "github.issue.close": "write",
  "github.pull-requests.list": "read",
  "github.pull-request.get": "read",
  "github.pull-request.create": "write",
  "github.pull-request.comment": "write",
  "github.pull-request.review.submit": "write",
  "github.pull-request.review.comment": "write",
  "github.pull-request.review.reply": "write",
  "github.pull-request.lifecycle.preview": "read",
  "github.pull-request.lifecycle.apply": "write",
  "github.pull-request.checkout.prepare": "read",
  "github.releases.list": "read",
  "github.release.get": "read",
  "github.release.create": "write",
} as const satisfies Record<RepositoryOperationType, RepositoryOperationAccess>;

export function repositoryOperationAccess(
  type: RepositoryOperationType,
): RepositoryOperationAccess {
  return repositoryOperationAccessByType[type];
}

export const repositoryOperationDirectionSchema = z.enum([
  "request",
  "response",
]);

export const repositoryOperationContextSchema = z
  .object({
    serverId: z.string().min(1).max(2_000),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: repositoryOperationDirectionSchema,
  })
  .strict();

export const repositoryOperationOpaqueSchema = z
  .object({
    formatVersion: z.literal(1),
    keyRevision: encryptionKeyRevisionSchema,
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict();

export const repositoryOperationRequestContentSchema = z
  .object({
    type: repositoryOperationTypeSchema,
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const repositoryOperationOutcomeContentSchema = z.discriminatedUnion(
  "ok",
  [
    z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
    z
      .object({
        ok: z.literal(false),
        error: z.string().min(1).max(2_000),
        code: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
          .max(100)
          .optional(),
      })
      .strict(),
  ],
);

export const repositoryOperationWireRequestSchema = z
  .object({
    operationId: repositoryOperationContextSchema.shape.operationId,
    protectedRequest: repositoryOperationOpaqueSchema,
    access: repositoryOperationAccessSchema.default("write"),
    agent: z.boolean().default(false),
    modelId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.agent || value.modelId === undefined, {
    message: "Repository model selection is only valid for agent operations.",
    path: ["modelId"],
  });

export const repositoryOperationAgentExecutionSchema = z
  .object({
    routeId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    measuredUsage: workflowMeasuredUsageSchema,
  })
  .strict();

export const repositoryOperationWireResponseSchema = z
  .object({
    operationId: repositoryOperationContextSchema.shape.operationId,
    protectedResponse: repositoryOperationOpaqueSchema,
    agentExecution: repositoryOperationAgentExecutionSchema
      .nullable()
      .default(null),
    workspaceRootAttachment: workspaceRootAttachmentSchema.optional(),
  })
  .strict();

export const repositoryWorkerOperationWireRequestSchema =
  repositoryOperationWireRequestSchema
    .extend({ scopeId: z.string().min(1).max(200) })
    .strict();

export type RepositoryOperationContext = z.infer<
  typeof repositoryOperationContextSchema
>;
export type RepositoryOperationOpaque = z.infer<
  typeof repositoryOperationOpaqueSchema
>;
export type RepositoryOperationRequestContent = z.infer<
  typeof repositoryOperationRequestContentSchema
>;
export type RepositoryOperationOutcomeContent = z.infer<
  typeof repositoryOperationOutcomeContentSchema
>;
export type RepositoryMetadataValues = z.infer<
  typeof repositoryMetadataValuesSchema
>;
export type RepositoryMetadataResult = z.infer<
  typeof repositoryMetadataResultSchema
>;
export type WorkspaceRootAttachment = z.infer<
  typeof workspaceRootAttachmentSchema
>;
export type WorkspaceRootAttachmentErrorCode = z.infer<
  typeof workspaceRootAttachmentErrorCodeSchema
>;
