import { z } from "zod";
import {
  endpointContentContextSchema,
  endpointContentOpaqueSchema,
} from "./endpoint-content.js";

const id = z.string().min(1).max(255);
export const projectAlertKindSchema = z.enum([
  "permission",
  "user-input",
  "task-questions",
  "plan-ready",
  "blocked",
  "goal-stalled",
  "action-required",
]);
export const projectAlertSourceSchema = z.enum([
  "interaction",
  "task-review",
  "task-blocker",
  "goal",
  "agent",
]);
export const projectAlertTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("interaction"),
      chatId: id.nullable(),
      requestId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      chatId: id,
      planningRound: z.number().int().nonnegative(),
      section: z.enum(["questions", "plan", "overview"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("goal"), chatId: id, threadId: id.nullable() })
    .strict(),
  z
    .object({ kind: z.literal("chat"), chatId: id, turnId: id.nullable() })
    .strict(),
]);
export const projectAlertDetailSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(8_000),
    nextStep: z.string().trim().max(2_000),
  })
  .strict();
export const projectAlertProtectedDetailSchema = z
  .object({
    context: endpointContentContextSchema,
    protectedContent: endpointContentOpaqueSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.context.domain !== "alert-content" ||
      value.protectedContent.domain !== "alert-content" ||
      value.context.direction !== "stored"
    )
      ctx.addIssue({
        code: "custom",
        message: "Alerts require stored alert-content ciphertext.",
      });
  });

const identity = z.object({
  projectId: id,
  chatId: id.nullable(),
  source: projectAlertSourceSchema,
  sourceId: id,
  episodeId: id,
});
/** Internal projection input. Public response actions continue to own source state. */
export const projectAlertProjectionSchema = identity
  .extend({
    sourceRevision: z.number().int().min(1).max(2_147_483_647),
    kind: projectAlertKindSchema,
    priority: z.number().int().min(0).max(2).default(1),
    status: z.enum(["open", "resolved"]),
    target: projectAlertTargetSchema,
    occurredAt: z.iso.datetime(),
    protectedDetail: projectAlertProtectedDetailSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected =
      value.source === "interaction"
        ? "interaction"
        : value.source === "goal"
          ? "goal"
          : value.source === "agent"
            ? "chat"
            : "task";
    if (value.target.kind !== expected || value.target.chatId !== value.chatId)
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "Alert target does not match its source.",
      });
    if (
      value.source === "interaction" &&
      value.target.kind === "interaction" &&
      value.target.requestId !== value.sourceId
    )
      ctx.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "Interaction alert must identify its exact request.",
      });
    if (
      value.source === "agent" &&
      (!value.chatId ||
        !value.protectedDetail ||
        value.protectedDetail.context.scopeId !== value.chatId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["protectedDetail"],
        message:
          "Agent alerts need protected details bound to their originating chat.",
      });
    if (value.source !== "agent" && value.protectedDetail !== null)
      ctx.addIssue({
        code: "custom",
        path: ["protectedDetail"],
        message: "System alerts retain details in their authoritative source.",
      });
    if (
      value.source === "agent" &&
      !["blocked", "action-required"].includes(value.kind)
    )
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "Agents cannot forge system-owned attention requests.",
      });
  });
export const projectAlertSchema = identity
  .extend({
    id: z.string().regex(/^alert_[a-f0-9]{64}$/),
    sourceRevision: z.number().int().positive(),
    kind: projectAlertKindSchema,
    priority: z.number().int().min(0).max(2),
    status: z.enum(["open", "resolved"]),
    target: projectAlertTargetSchema,
    protectedDetail: projectAlertProtectedDetailSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const projectAlertQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    after: projectAlertSchema.shape.id.optional(),
  })
  .strict();
export const projectAlertPageSchema = z
  .object({
    items: z.array(projectAlertSchema).max(100),
    nextCursor: projectAlertSchema.shape.id.nullable(),
  })
  .strict();
export const projectAlertCountsSchema = z.array(
  z
    .object({
      projectId: id,
      count: z.number().int().positive(),
    })
    .strict(),
);
export const projectAlertChangeSchema = z
  .object({ ownerId: id, projectId: id })
  .strict();
export type ProjectAlert = z.infer<typeof projectAlertSchema>;
export type ProjectAlertProjection = z.infer<
  typeof projectAlertProjectionSchema
>;
export type ProjectAlertQuery = z.infer<typeof projectAlertQuerySchema>;
export type ProjectAlertPage = z.infer<typeof projectAlertPageSchema>;
export type ProjectAlertCounts = z.infer<typeof projectAlertCountsSchema>;
export type ProjectAlertChange = z.infer<typeof projectAlertChangeSchema>;
