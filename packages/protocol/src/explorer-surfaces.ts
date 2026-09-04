import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { explorerPrivateStateOpaqueSchema } from "./surface-private-state.js";
import { executionTargetSchema } from "./execution-targets.js";
import {
  hasUnambiguousProjectPaneDestination,
  projectPaneDestinationShape,
} from "./project-pane-identifiers.js";

export const explorerFileModeSchema = z.enum(["preview", "visual", "edit"]);

const explorerCreateBaseSchema = z
  .object({
    worktreeId: z.string().min(1).optional(),
    ...projectPaneDestinationShape,
    target: executionTargetSchema.optional(),
    attachToTabLayout: z.boolean().optional(),
    fileMode: explorerFileModeSchema.optional(),
  })
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
          "Specify either paneId or the deprecated tabGroupId, not both.",
        path: ["paneId"],
      });
    }
  });

export const explorerCreateSchema = explorerCreateBaseSchema.safeExtend({
  title: z.string().trim().min(1).max(200).default("Explorer"),
});

export const encryptedExplorerCreateSchema = explorerCreateBaseSchema
  .safeExtend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: explorerPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "explorer",
    {
      message: "Explorer title classification must be explorer.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const explorerUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const encryptedExplorerUpdateSchema = z
  .object({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "explorer",
    {
      message: "Explorer title classification must be explorer.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const encryptedExplorerPinSchema = z
  .object({
    ...projectPaneDestinationShape,
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: explorerPrivateStateOpaqueSchema,
    fileMode: explorerFileModeSchema,
  })
  .strict()
  .refine(hasUnambiguousProjectPaneDestination, {
    message: "Specify either paneId or the deprecated tabGroupId, not both.",
    path: ["paneId"],
  })
  .refine(
    (input) => input.titleProtection.classification.recordKind === "explorer",
    {
      message: "Explorer title classification must be explorer.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const explorerViewStateUpdateSchema = z.object({
  selectedPath: z.string().min(1).max(8_192).nullable(),
  fileMode: explorerFileModeSchema,
});

export const encryptedExplorerViewStateUpdateSchema = z
  .object({
    stateProtection: explorerPrivateStateOpaqueSchema,
    fileMode: explorerFileModeSchema,
  })
  .strict();

export const encryptedExplorerWorktreeUpdateSchema = z
  .object({
    worktreeId: z.string().min(1),
    stateProtection: explorerPrivateStateOpaqueSchema,
  })
  .strict();

const explorerSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  activeWorkerId: z.string().min(1),
  worktreeId: z.string().min(1),
  fileMode: explorerFileModeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const explorerSummarySchema = explorerSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
  selectedPath: explorerViewStateUpdateSchema.shape.selectedPath,
});

export const explorerWireSummarySchema = explorerSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema,
    stateProtection: explorerPrivateStateOpaqueSchema,
  })
  .strict()
  .refine(
    (explorer) =>
      explorer.titleProtection.classification.recordKind === "explorer",
    {
      message: "Explorer title classification must be explorer.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const explorerListSchema = z.array(explorerSummarySchema);
export const explorerWireListSchema = z.array(explorerWireSummarySchema);

export type ExplorerCreate = z.infer<typeof explorerCreateSchema>;
export type EncryptedExplorerCreate = z.infer<
  typeof encryptedExplorerCreateSchema
>;
export type ExplorerUpdate = z.infer<typeof explorerUpdateSchema>;
export type EncryptedExplorerUpdate = z.infer<
  typeof encryptedExplorerUpdateSchema
>;
export type EncryptedExplorerPin = z.infer<typeof encryptedExplorerPinSchema>;
export type ExplorerFileMode = z.infer<typeof explorerFileModeSchema>;
export type ExplorerViewStateUpdate = z.infer<
  typeof explorerViewStateUpdateSchema
>;
export type EncryptedExplorerViewStateUpdate = z.infer<
  typeof encryptedExplorerViewStateUpdateSchema
>;
export type EncryptedExplorerWorktreeUpdate = z.infer<
  typeof encryptedExplorerWorktreeUpdateSchema
>;
export type ExplorerSummary = z.infer<typeof explorerSummarySchema>;
export type ExplorerWireSummary = z.infer<typeof explorerWireSummarySchema>;
