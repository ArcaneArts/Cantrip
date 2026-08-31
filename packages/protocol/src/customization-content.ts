import { z } from "zod";

import { endpointContentOpaqueSchema } from "./endpoint-content.js";

export const customizationContentOperationSchema = z.enum([
  "skills.list",
  "skills.settings.list",
  "skills.settings.read",
  "skills.settings.write",
  "skills.settings.delete",
  "skills.settings.configure",
  "customization.inventory.read",
  "customization.external.preview",
  "customization.external.apply",
  "customization.external.status",
  "customization.skill.configure",
  "customization.skill-roots.set",
  "customization.mcp.resource.read",
  "customization.mcp.oauth.start",
  "customization.mcp.oauth.status",
  "customization.mcp.reload",
]);

export const customizationContentScopeSchema = z
  .object({
    workerId: z.string().min(1).max(255),
    projectId: z.string().min(1).max(200).nullable(),
    chatId: z.string().min(1).max(200).nullable(),
    providerId: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const customizationContentResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z
        .object({ message: z.string().trim().min(1).max(2_000) })
        .strict(),
    })
    .strict(),
]);

export const customizationContentLifecycleSchema = z
  .enum(["pending", "completed", "unknown"])
  .nullable();

export const protectedCustomizationRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    operation: customizationContentOperationSchema,
    scope: customizationContentScopeSchema,
    protectedRequest: endpointContentOpaqueSchema,
  })
  .strict();

export const protectedCustomizationResponseSchema = z
  .object({
    operationId: z.string().uuid(),
    operation: customizationContentOperationSchema,
    scope: customizationContentScopeSchema,
    result: z.enum(["succeeded", "failed"]),
    lifecycle: customizationContentLifecycleSchema,
    protectedResponse: endpointContentOpaqueSchema,
  })
  .strict();

export type CustomizationContentOperation = z.infer<
  typeof customizationContentOperationSchema
>;
export type CustomizationContentScope = z.infer<
  typeof customizationContentScopeSchema
>;
export type CustomizationContentResult = z.infer<
  typeof customizationContentResultSchema
>;
export type ProtectedCustomizationRequest = z.infer<
  typeof protectedCustomizationRequestSchema
>;
export type ProtectedCustomizationResponse = z.infer<
  typeof protectedCustomizationResponseSchema
>;
