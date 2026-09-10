import { queuedPromptOpaqueContentSchema } from "./communication-content.js";
import { chatAttachmentOpaqueSummarySchema } from "./attachment-content.js";
import { nativePermissionPolicySchema } from "./native-settings-state.js";
import { permissionTransitionSchema } from "./permission-profiles.js";
import { nativeSettingsApplicationSchema } from "./native-settings-evidence.js";
import { modelConfigurationSchema } from "./model-configuration.js";
import { planModeSchema } from "./chat-runtime.js";
import { worktreePolicySchema } from "./worktrees.js";
import { cuaAgentAuthoritySchema } from "./computer-use-agent.js";
import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";

const id = z.string().min(1).max(255);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeCommandSessionSchema = z
  .object({
    chatId: id,
    threadId: id.nullable(),
    contextKind: z.enum(["project", "standalone"]),
    projectId: id.nullable(),
    placementId: id,
    modelRouteId: id.nullable(),
    providerAccountId: id.nullable(),
    runtimeGeneration: id.nullable(),
    connectionId: id.nullable(),
  })
  .strict();
/** Nonsecret scope declarations. Native JSON stays encrypted and worker-owned. */
export const nativeCommandIntentSchema = z
  .object({
    scope: z.enum(["thread", "account-defaults"]),
    nativeSettingsOperationId: id.optional(),
    nativeClientUserMessageId: id.optional(),
    /** Controller-selected source identity; never forwarded as a native setting. */
    settingsBindingId: id.optional(),
    resumeAutonomy: z.boolean().optional(),
    paused: z.boolean().optional(),
    goalStatus: z.enum(["active", "paused"]).optional(),
    settingKeys: z.array(z.string().min(1).max(120)).max(64).default([]),
    expectedTurnId: id.nullable().default(null),
    permissionProfileId: id.optional(),
    permissionTransition: permissionTransitionSchema.optional(),
    configTarget: z.literal("account-defaults").optional(),
    pathsWithinPlacement: z.boolean().optional(),
  })
  .strict();
export const nativeCommandAdmissionSchema = z
  .object({
    workerId: id,
    operationId: id,
    goalQueueHandoff: z
      .object({
        claimId: id,
        operationId: id,
        operationGeneration: id,
        goalEpoch: id,
      })
      .strict()
      .optional(),
    queueClaim: z
      .object({ id, promptRevision: z.number().int().nonnegative() })
      .strict()
      .optional(),
    origin: z.enum(["gui", "terminal", "autonomous"]),
    session: nativeCommandSessionSchema,
    method: z.string().min(1).max(120),
    payloadDigest: digest,
    protectedPayload: encryptedPayloadEnvelopeSchema,
    expectedActivationGeneration: id.nullable(),
    intent: nativeCommandIntentSchema,
    reply: z
      .object({
        nativeRequestId: id,
        requestMethod: z.string().min(1).max(120),
        turnId: id.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.origin !== "gui" &&
      (!value.session.threadId ||
        !value.session.runtimeGeneration ||
        !value.session.connectionId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Terminal commands require a bound native session.",
      });
    if (
      (value.session.contextKind === "standalone") !==
      (value.session.projectId === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "The placement context is inconsistent.",
      });
  });
export const nativeCommandReceiptSchema = z
  .object({
    resumeQueue: z.boolean().optional(),
    operationId: id,
    operationGeneration: id,
    logicalOperationId: id.nullable().optional(),
    previousOperationId: id.nullable().optional(),
    activationGeneration: id.nullable(),
    chatId: id,
    startsExecution: z.boolean(),
    settingsApplication: nativeSettingsApplicationSchema.nullable().optional(),
    executionLaneId: id.nullable(),
    status: z.enum([
      "accepted",
      "dispatched",
      "applied",
      "rejected",
      "uncertain",
    ]),
    method: z.string(),
    payloadDigest: digest,
    rejectionCode: z.string().nullable(),
    threadId: id.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export const nativeCommandDispatchSchema = z
  .object({
    workerId: id,
    operationId: id,
    operationGeneration: id,
    payloadDigest: digest,
    session: nativeCommandSessionSchema,
  })
  .strict();
export const nativeCommandContinuationSchema = z
  .object({
    workerId: id,
    rootOperationId: id,
    previousOperationId: id,
    previousOperationGeneration: id,
    operationId: id,
    payloadDigest: digest,
    protectedPayload: encryptedPayloadEnvelopeSchema,
    session: nativeCommandSessionSchema,
    reason: z.enum(["capacity", "invalid-compaction"]),
    failure: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("native-terminal"),
          nativeTurnId: id,
          runtimeGeneration: id,
        })
        .strict(),
      z
        .object({
          kind: z.literal("native-rejected"),
          method: z.enum(["turn/start", "thread/resume"]),
          code: z.number().int(),
          runtimeGeneration: id,
        })
        .strict(),
    ]),
    handoff: z
      .object({ expectedThreadId: id, replacementThreadId: id })
      .strict()
      .optional(),
  })
  .strict();
export type NativeCommandContinuation = z.infer<
  typeof nativeCommandContinuationSchema
>;
export const nativeCommandSettlementSchema = z
  .object({
    workerId: id,
    operationId: id,
    operationGeneration: id,
    status: z.enum(["applied", "rejected", "uncertain"]),
    resultDigest: digest.nullable(),
    protectedResult: encryptedPayloadEnvelopeSchema.nullable(),
    goalEpoch: id.optional(),
    terminalResult: z
      .object({
        resultDigest: digest.nullable(),
        protectedResult: encryptedPayloadEnvelopeSchema.nullable(),
      })
      .strict()
      .optional(),
    deferred: z
      .object({
        reason: z.literal("pendingSettings"),
        inputConsumed: z.literal(false),
        threadId: id,
        runtimeGeneration: id,
        retainedPrompt: queuedPromptOpaqueContentSchema.optional(),
        attachments: z.array(chatAttachmentOpaqueSummarySchema).optional(),
      })
      .strict()
      .refine(
        (value) => Boolean(value.retainedPrompt) === Boolean(value.attachments),
        {
          message: "Retained prompt and attachments must be supplied together.",
        },
      )
      .optional(),
    decline: z
      .object({
        nativeTurnId: id,
        runtimeGeneration: id,
        runnerGeneration: id,
        attemptId: id,
      })
      .strict()
      .optional(),
    rejectionCode: z
      .string()
      .regex(/^[a-z0-9-]{1,120}$/u)
      .nullable(),
    /** Admission receipts do not imply turn completion. Only the exact active generation can finish it. */
    executionComplete: z.boolean().default(false),
    executionStatus: z.enum(["idle", "failed"]).optional(),
    reconciliation: z
      .object({ nativeTurnId: id, runtimeGeneration: id })
      .strict()
      .optional(),
  })
  .strict();
export type NativeCommandAdmission = z.infer<
  typeof nativeCommandAdmissionSchema
>;
export type NativeCommandReceipt = z.infer<typeof nativeCommandReceiptSchema>;
export type NativeCommandDispatch = z.infer<typeof nativeCommandDispatchSchema>;
export type NativeCommandSettlement = z.infer<
  typeof nativeCommandSettlementSchema
>;
export type NativeCommandSession = z.infer<typeof nativeCommandSessionSchema>;

export const nativePendingRequestSchema = z
  .object({
    workerId: id,
    session: nativeCommandSessionSchema,
    activationGeneration: id,
    nativeRequestId: id,
    requestMethod: z.string().min(1).max(120),
    turnId: id.nullable(),
  })
  .strict();
export type NativePendingRequest = z.infer<typeof nativePendingRequestSchema>;

export const nativeCommandExecutionSchema = z
  .object({
    chatId: id,
    workerId: id,
    contextKind: z.enum(["project", "standalone"]),
    projectId: id.nullable(),
    worktreeId: id.nullable(),
    scratchRootId: id.nullable(),
    threadId: id.nullable(),
    executionLaneId: id.nullable(),
    cwd: z.string(),
    rootKind: z.enum(["git-worktree", "folder-root"]).nullable(),
    experience: z.enum(["agent", "task", "console"]),
    status: z.string(),
    computerUseEnabled: z.boolean().optional(),
    computerUseAuthorityGeneration: z.number().int().optional(),
    automationPaused: z.boolean(),
    isPrimary: z.boolean(),
    modelId: id.nullable(),
    reasoningEffort: z.string().nullable(),
    modelRouteId: id.nullable(),
    providerAccountId: id.nullable(),
    permissionProfileId: id.nullable(),
    nativePermissionPolicy: nativePermissionPolicySchema.nullable().optional(),
    nativePermissionPolicyConfirmed: z.boolean().optional(),
    defaultPermissionProfileId: z.string().optional(),
    modelConfiguration: modelConfigurationSchema,
    planMode: planModeSchema,
    worktreeMode: z.enum(["agent-managed", "pinned"]).nullable(),
    worktreePolicy: worktreePolicySchema.nullable(),
  })
  .passthrough();
export const nativeCommandAdmissionResultSchema = z
  .object({
    receipt: nativeCommandReceiptSchema,
    execution: nativeCommandExecutionSchema.nullable(),
    computerUseAuthority: cuaAgentAuthoritySchema.nullable(),
    replayed: z.boolean().optional(),
  })
  .strict();
export const nativeCommandSettlementResultSchema = z
  .object({ receipt: nativeCommandReceiptSchema })
  .strict();
export type NativeCommandAdmissionResult = z.infer<
  typeof nativeCommandAdmissionResultSchema
>;

export const nativePermissionTransitionResolveSchema = z
  .object({
    workerId: id,
    session: nativeCommandSessionSchema,
    selectedId: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type NativePermissionTransitionResolve = z.infer<
  typeof nativePermissionTransitionResolveSchema
>;
export const nativePermissionTransitionResolutionSchema = z
  .object({
    permissionTransition: permissionTransitionSchema,
    bindingId: id.nullable(),
  })
  .strict();
export type NativePermissionTransitionResolution = z.infer<
  typeof nativePermissionTransitionResolutionSchema
>;

/** Content-free evidence read from the resumed native thread after worker loss. */
export const nativeTurnRecoveryObservationSchema = z
  .object({
    threadId: id,
    runtimeGeneration: id,
    turnId: id,
    status: z
      .enum(["inProgress", "completed", "failed", "interrupted"])
      .nullable(),
  })
  .strict();
export type NativeTurnRecoveryObservation = z.infer<
  typeof nativeTurnRecoveryObservationSchema
>;
