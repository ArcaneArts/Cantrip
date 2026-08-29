import { z } from "zod";

import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";

export const executionResourceIdSchema = z.string().min(1).max(200);

export const executionSurfaceKindSchema = z.enum([
  "chat",
  "terminal",
  "explorer",
  "code",
  "browser",
  "remote-desktop",
  "remote-surface",
]);

export const executionPlacementSchema = z
  .object({
    projectId: executionResourceIdSchema,
    workerId: executionResourceIdSchema,
    projectReplicaId: executionResourceIdSchema.nullable(),
    worktreeId: executionResourceIdSchema.nullable(),
    surface: z
      .object({
        kind: executionSurfaceKindSchema,
        id: executionResourceIdSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((placement, context) => {
    if (placement.worktreeId !== null && placement.projectReplicaId === null) {
      context.addIssue({
        code: "custom",
        message: "A worktree placement requires a project replica.",
        path: ["projectReplicaId"],
      });
    }
  });

export const executionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      projectId: executionResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker"),
      projectId: executionResourceIdSchema,
      workerId: executionResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replica"),
      projectId: executionResourceIdSchema,
      projectReplicaId: executionResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worktree"),
      projectId: executionResourceIdSchema,
      worktreeId: executionResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("surface"),
      projectId: executionResourceIdSchema,
      surfaceKind: executionSurfaceKindSchema,
      surfaceId: executionResourceIdSchema,
    })
    .strict(),
]);

export const executionPlacementSelectionSchema = z.enum([
  "explicit",
  "project-preference",
  "default-worker",
  "fallback",
]);

export const executionPlacementResolveRequestSchema = z
  .object({
    surfaceKind: executionSurfaceKindSchema,
    target: executionTargetSchema.optional(),
  })
  .strict();

export const executionPlacementResolutionSchema = z.object({
  placement: executionPlacementSchema,
  selection: executionPlacementSelectionSchema,
});

export const executionTargetResourceKindSchema = z.enum([
  "project",
  "worker",
  "replica",
  "worktree",
  "chat",
  "terminal",
  "explorer",
  "code",
  "browser",
  "remote-desktop",
  "remote-surface",
]);

export const executionTargetAvailabilitySchema = z.enum([
  "available",
  "worker-offline",
  "capability-unavailable",
  "resource-unavailable",
]);

const executionTargetWorkerSchema = z.object({
  workerId: executionResourceIdSchema,
  name: z.string().min(1).max(200),
  online: z.boolean(),
});

export const executionTargetResolutionSchema = z
  .object({
    target: executionTargetSchema,
    placement: executionPlacementSchema,
    worker: executionTargetWorkerSchema,
    availability: executionTargetAvailabilitySchema,
    unavailableReason: z.string().min(1).max(4_000).nullable(),
  })
  .strict();

export const executionTargetResolveRequestSchema = z
  .object({
    target: executionTargetSchema,
    allowUnavailable: z.boolean().default(false),
  })
  .strict();

const executionTargetDescriptorBaseSchema = executionTargetResolutionSchema
  .extend({
    resourceKind: executionTargetResourceKindSchema,
    status: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const executionTargetDescriptorSchema =
  executionTargetDescriptorBaseSchema.extend({
    title: z.string().min(1).max(500),
  });

export const executionTargetWireDescriptorSchema =
  executionTargetDescriptorBaseSchema
    .extend({
      title: z.string().min(1).max(500).nullable(),
      titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    })
    .superRefine((descriptor, context) => {
      const expectedRecordKind =
        descriptor.resourceKind === "chat"
          ? "chat"
          : descriptor.resourceKind === "terminal"
            ? "terminal"
            : descriptor.resourceKind === "explorer"
              ? "explorer"
              : descriptor.resourceKind === "code"
                ? "code-tab"
                : descriptor.resourceKind === "browser"
                  ? "browser"
                  : descriptor.resourceKind === "remote-desktop"
                    ? "project-view"
                    : descriptor.resourceKind === "remote-surface"
                      ? "remote-surface"
                      : null;
      const protectedResource = expectedRecordKind !== null;
      if (
        protectedResource !== (descriptor.titleProtection !== null) ||
        protectedResource === (descriptor.title !== null)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Surface execution targets require an opaque title; placement targets require a plaintext title.",
          path: ["titleProtection"],
        });
      }
      if (
        descriptor.titleProtection &&
        descriptor.titleProtection.classification.recordKind !==
          expectedRecordKind
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Execution-target title classification must match its resource kind.",
          path: ["titleProtection", "classification", "recordKind"],
        });
      }
      if (protectedResource && descriptor.target.kind !== "surface") {
        context.addIssue({
          code: "custom",
          message: "Protected execution targets must identify a surface.",
          path: ["target"],
        });
      }
      if (
        protectedResource &&
        descriptor.target.kind === "surface" &&
        descriptor.target.surfaceKind !== descriptor.resourceKind
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Execution-target resource and surface kinds must describe the same surface.",
          path: ["target", "surfaceKind"],
        });
      }
      if (
        protectedResource &&
        descriptor.placement.surface?.kind !== descriptor.resourceKind
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Execution-target placement must point at the protected surface.",
          path: ["placement", "surface"],
        });
      }
    });

export const executionTargetCatalogSchema = z
  .object({
    projectId: executionResourceIdSchema,
    targets: z.array(executionTargetDescriptorSchema).max(2_000),
    truncated: z.boolean(),
  })
  .strict();

export const executionTargetWireCatalogSchema = z
  .object({
    projectId: executionResourceIdSchema,
    targets: z.array(executionTargetWireDescriptorSchema).max(2_000),
    truncated: z.boolean(),
  })
  .strict();

export type ExecutionSurfaceKind = z.infer<typeof executionSurfaceKindSchema>;

export type ExecutionPlacement = z.infer<typeof executionPlacementSchema>;

export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export type ExecutionPlacementSelection = z.infer<
  typeof executionPlacementSelectionSchema
>;

export type ExecutionPlacementResolveRequest = z.infer<
  typeof executionPlacementResolveRequestSchema
>;

export type ExecutionPlacementResolution = z.infer<
  typeof executionPlacementResolutionSchema
>;

export type ExecutionTargetResourceKind = z.infer<
  typeof executionTargetResourceKindSchema
>;

export type ExecutionTargetAvailability = z.infer<
  typeof executionTargetAvailabilitySchema
>;

export type ExecutionTargetResolution = z.infer<
  typeof executionTargetResolutionSchema
>;

export type ExecutionTargetResolveRequest = z.infer<
  typeof executionTargetResolveRequestSchema
>;

export type ExecutionTargetDescriptor = z.infer<
  typeof executionTargetDescriptorSchema
>;

export type ExecutionTargetWireDescriptor = z.infer<
  typeof executionTargetWireDescriptorSchema
>;

export type ExecutionTargetCatalog = z.infer<
  typeof executionTargetCatalogSchema
>;

export type ExecutionTargetWireCatalog = z.infer<
  typeof executionTargetWireCatalogSchema
>;
