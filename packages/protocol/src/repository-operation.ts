import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const REPOSITORY_OPERATION_PROTECTED_CONTENT_BYTES_LIMIT =
  16 * 1_024 * 1_024;

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
  "github.issues.list",
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
  "github.releases.list",
  "github.release.get",
  "github.release.create",
]);

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
      })
      .strict(),
  ],
);

export const repositoryOperationWireRequestSchema = z
  .object({
    operationId: repositoryOperationContextSchema.shape.operationId,
    protectedRequest: repositoryOperationOpaqueSchema,
  })
  .strict();

export const repositoryOperationWireResponseSchema = z
  .object({
    operationId: repositoryOperationContextSchema.shape.operationId,
    protectedResponse: repositoryOperationOpaqueSchema,
  })
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
export type RepositoryOperationType = z.infer<
  typeof repositoryOperationTypeSchema
>;
