import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const WORKFLOW_CONTENT_PROTECTED_BYTES_LIMIT = 4 * 1_024 * 1_024;

export const workflowContentRecordKindSchema = z.enum([
  "project-automation",
  "workflow-definition",
  "workflow-revision",
  "workflow-run",
  "workflow-run-node",
  "workflow-run-node-item",
  "workflow-attempt",
  "workflow-worktree-lease",
  "workflow-event",
  "workflow-gate",
  "workflow-trigger",
  "workflow-delivery",
  "workflow-operation",
]);

export const workflowContentFieldSchema = z.enum([
  "name",
  "slug",
  "description",
  "provenance",
  "content-hash",
  "prompt",
  "condition",
  "metadata",
  "content",
  "input",
  "result",
  "error",
  "reason",
  "payload",
  "request",
  "response",
]);

export const workflowContentContextSchema = z
  .object({
    recordKind: workflowContentRecordKindSchema,
    recordId: z.string().trim().min(1).max(500),
    field: workflowContentFieldSchema,
  })
  .strict();

export const workflowContentOpaqueSchema = z
  .object({
    formatVersion: z.literal(1),
    keyRevision: encryptionKeyRevisionSchema,
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict()
  .refine(
    ({ envelope }) =>
      envelope.ciphertext.length <=
      Math.ceil(((WORKFLOW_CONTENT_PROTECTED_BYTES_LIMIT + 16) * 4) / 3),
    "Encrypted workflow content exceeds its byte limit.",
  );

export type WorkflowContentContext = z.infer<
  typeof workflowContentContextSchema
>;
export type WorkflowContentOpaque = z.infer<typeof workflowContentOpaqueSchema>;
