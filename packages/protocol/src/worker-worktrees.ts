import { z } from "zod";
import { projectRootKindSchema } from "./project-foundation.js";
import { worktreePolicySchema } from "./worktrees.js";
import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import { gitStatusSchema } from "./git-contracts.js";
import { gitManagedOperationContextSchema } from "./git-actions.js";
import { repositoryRoutingHandleSchema } from "./repository-operation.js";

export const workerWorktreeSummarySchema = z.object({
  path: z.string().min(1),
  head: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  detached: z.boolean(),
  isPrimary: z.boolean(),
  managed: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().min(1).nullable(),
  prunable: z.boolean(),
  pruneReason: z.string().min(1).nullable(),
  missing: z.boolean(),
});

export const worktreeInventorySchema = z.object({
  sourcePath: z.string().min(1),
  primaryPath: z.string().min(1),
  gitCommonDir: z.string().min(1),
  managedRoot: z.string().min(1),
  repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  worktrees: z.array(workerWorktreeSummarySchema),
});

export const worktreeCreateModeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("newBranch"),
    branch: z.string().trim().min(1).max(255),
    startPoint: z.string().trim().min(1).max(1_024).nullable().default(null),
  }),
  z.object({
    type: z.literal("existingBranch"),
    branch: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("detached"),
    revision: z.string().trim().min(1).max(1_024),
  }),
]);

export const worktreeCreateResultSchema = z.object({
  created: z.boolean(),
  worktree: workerWorktreeSummarySchema,
  inventory: worktreeInventorySchema,
});

export const worktreeCreateMutationOutcomeSchema = z.enum([
  "notStarted",
  "committed",
  "rolledBack",
  "partial",
]);

export const worktreeCreateMutationFailureSchema = z
  .object({
    code: z.enum([
      "worktree-create-not-started",
      "worktree-create-committed",
      "worktree-create-rolled-back",
      "worktree-create-partial",
    ]),
    error: z.string().min(1).max(2_000),
    mutation: z
      .object({
        outcome: worktreeCreateMutationOutcomeSchema,
        retryable: z.boolean(),
        target: z
          .object({
            kind: z.literal("worktree"),
            projectId: z.string().min(1).max(200),
            worktreeId: z.string().min(1).max(200),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((failure, context) => {
    const expectedCode = `worktree-create-${
      failure.mutation.outcome === "notStarted"
        ? "not-started"
        : failure.mutation.outcome === "rolledBack"
          ? "rolled-back"
          : failure.mutation.outcome
    }`;
    if (failure.code !== expectedCode) {
      context.addIssue({
        code: "custom",
        message: "Worktree mutation failure code must match its outcome.",
        path: ["code"],
      });
    }
    if (
      (failure.mutation.outcome === "notStarted") !==
      (failure.mutation.target === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Only a worktree mutation that did not start may omit its recovery target.",
        path: ["mutation", "target"],
      });
    }
  });

export const worktreeMutationResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  inventory: worktreeInventorySchema,
});

export const worktreeRemoveResultSchema = z.object({
  removedPath: z.string().min(1),
  inventory: worktreeInventorySchema,
});

export const worktreePruneResultSchema = z.object({
  prunedPaths: z.array(z.string().min(1)),
  inventory: worktreeInventorySchema,
});

export const worktreeStatusResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  status: gitStatusSchema,
});

const cantripMcpWorkerWorktreeSummarySchema = workerWorktreeSummarySchema
  .omit({ path: true })
  .strict();
const cantripMcpGitStatusSchema = gitStatusSchema.extend({
  files: gitStatusSchema.shape.files.max(2_000),
  branches: gitStatusSchema.shape.branches.max(500),
});
export const cantripMcpWorktreeStatusResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z
      .object({
        kind: z.literal("worktree"),
        projectId: z.string().min(1).max(200),
        worktreeId: z.string().min(1).max(200),
      })
      .strict(),
    data: z
      .object({
        worktree: cantripMcpWorkerWorktreeSummarySchema,
        status: cantripMcpGitStatusSchema,
        filesTruncated: z.boolean(),
        branchesTruncated: z.boolean(),
      })
      .strict(),
  });

export const worktreeObservationTargetSchema = z.object({
  projectId: z.string().uuid().optional(),
  worktreeId: z.string().min(1).max(200).optional(),
  sourcePath: z.string().min(1).max(8_192),
  worktreePath: z.string().min(1).max(8_192),
  operation: z
    .object({
      id: z.string().uuid(),
      context: gitManagedOperationContextSchema,
    })
    .strict()
    .nullable()
    .optional(),
});

export const worktreeObservationTargetsSchema = z
  .array(worktreeObservationTargetSchema)
  .max(128)
  .superRefine((targets, context) => {
    const keys = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const key = `${target.sourcePath}\0${target.worktreePath}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Worktree observation targets must be unique.",
          path: [index],
        });
      }
      keys.add(key);
    }
  });

export const codeGraphObservationTargetSchema = z.object({
  projectId: z.string().uuid(),
  worktreeId: z.string().min(1).max(200),
  rootKind: projectRootKindSchema,
  sourcePath: z.string().min(1).max(8_192),
  worktreePath: z.string().min(1).max(8_192),
});

export const codeGraphObservationTargetsSchema = z
  .array(codeGraphObservationTargetSchema)
  .max(128)
  .superRefine((targets, context) => {
    const keys = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const key = `${target.rootKind}\0${target.sourcePath}\0${target.worktreePath}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "CodeGraph observation targets must be unique.",
          path: [index],
        });
      }
      keys.add(key);
    }
  });

export const worktreeObservationPathReconciliationSchema = z.object({
  projectId: z.string().uuid(),
  worktreeId: z.string().min(1).max(200),
  sourcePath: repositoryRoutingHandleSchema,
  worktreePath: repositoryRoutingHandleSchema,
});

export const worktreeObservationConfigurationResultSchema = z.object({
  accepted: z.literal(true),
  paths: z
    .array(worktreeObservationPathReconciliationSchema)
    .max(256)
    .default([]),
});

export const projectWorktreeCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mode: worktreeCreateModeSchema,
});

export const projectWorktreeLockSchema = z.object({
  reason: z.string().trim().min(1).max(1_000).nullable().default(null),
});

export const projectWorktreeRemoveSchema = z.object({
  force: z.boolean().default(false),
  allowExternal: z.boolean().default(false),
});

export const projectWorktreePruneSchema = z.object({
  allowExternal: z.boolean().default(false),
});

export const projectWorktreePolicyUpdateSchema = z.object({
  policy: worktreePolicySchema,
});

export const chatWorktreeUpdateSchema = z.object({
  worktreeId: z.string().min(1),
  mode: z.enum(["agent-managed", "pinned"]),
});

export const worktreeSelectionSchema = z.object({
  worktreeId: z.string().min(1),
});

export type WorkerWorktreeSummary = z.infer<typeof workerWorktreeSummarySchema>;
export type WorktreeInventory = z.infer<typeof worktreeInventorySchema>;
export type WorktreeCreateMode = z.infer<typeof worktreeCreateModeSchema>;
export type WorktreeCreateResult = z.infer<typeof worktreeCreateResultSchema>;
export type WorktreeCreateMutationFailure = z.infer<
  typeof worktreeCreateMutationFailureSchema
>;
export type WorktreeCreateMutationOutcome = z.infer<
  typeof worktreeCreateMutationOutcomeSchema
>;
export type WorktreeMutationResult = z.infer<
  typeof worktreeMutationResultSchema
>;
export type WorktreeRemoveResult = z.infer<typeof worktreeRemoveResultSchema>;
export type WorktreePruneResult = z.infer<typeof worktreePruneResultSchema>;
export type WorktreeStatusResult = z.infer<typeof worktreeStatusResultSchema>;
export type WorktreeObservationTarget = z.infer<
  typeof worktreeObservationTargetSchema
>;
export type CodeGraphObservationTarget = z.infer<
  typeof codeGraphObservationTargetSchema
>;
export type WorktreeObservationPathReconciliation = z.infer<
  typeof worktreeObservationPathReconciliationSchema
>;
export type WorktreeObservationConfigurationResult = z.infer<
  typeof worktreeObservationConfigurationResultSchema
>;
export type ProjectWorktreeCreate = z.infer<typeof projectWorktreeCreateSchema>;
export type ProjectWorktreeLock = z.infer<typeof projectWorktreeLockSchema>;
export type ProjectWorktreeRemove = z.infer<typeof projectWorktreeRemoveSchema>;
export type ProjectWorktreePrune = z.infer<typeof projectWorktreePruneSchema>;
export type ProjectWorktreePolicyUpdate = z.infer<
  typeof projectWorktreePolicyUpdateSchema
>;
export type ChatWorktreeUpdate = z.infer<typeof chatWorktreeUpdateSchema>;
export type WorktreeSelection = z.infer<typeof worktreeSelectionSchema>;
