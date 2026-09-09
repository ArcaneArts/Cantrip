import {
  nativeSettingsUpdateCommandSchema,
  nativePermissionUpdateCommandSchema,
} from "./native-settings-update.js";
import { nativeSettingsReadScopeSchema } from "./native-settings-state.js";
import { queuedPromptOpaqueContentSchema } from "./communication-content.js";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";
import { nativeCommandReceiptSchema } from "./native-commands.js";
import { z } from "zod";
import {
  managedSessionContextSchema,
  managedSessionSubagentDefaultsSchema,
} from "./managed-session.js";
import { cuaAgentAuthoritySchema } from "./computer-use-agent.js";
import {
  chatPlanOpaqueStateSchema,
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
  interactionResponseOpaqueContentSchema,
} from "./communication-content.js";
import { chatAttachmentOpaqueListSchema } from "./attachment-content.js";
import {
  effectivePolicyWireListSchema,
  standalonePolicyWireListSchema,
} from "./policies.js";
import {
  taskGoalSyncContextSchema,
  taskOperationPrepareRequestSchema,
  taskOperationRelayGoalSchema,
} from "./tasks.js";
import { taskDispatchWorkerLeaseSchema } from "./task-scheduling.js";
import { encryptionKeyBytesSchema } from "./encryption.js";
import { mcpServerOpaqueRuntimeSchema } from "./protected-secrets.js";
import { NATIVE_SUBAGENT_PROTOCOL_VERSION } from "./runtime-capabilities.js";
import { reasoningEffortSchema } from "./providers.js";
import { projectRootKindSchema } from "./project-foundation.js";
import { worktreePolicySchema } from "./worktrees.js";
import { chatContextKindSchema } from "./chats.js";
import { permissionProfileIdSchema } from "./permission-profiles.js";
import {
  chatTurnModeSchema,
  chatMessageCreateSchema,
} from "./chat-messages.js";
import { agentInteractionResponseSchema } from "./agent-interactions.js";
import {
  chatGoalCreateSchema,
  chatGoalUpdateSchema,
  planModeSchema,
} from "./chat-runtime.js";
import { agentTurnResultModeSchema } from "./agent-thread-sync.js";
import {
  workerRuntimeModelSchema,
  workerRuntimeProviderSchema,
  workerChatAttachmentSchema,
} from "./worker-runtime-support.js";

export const workerChatCommandSchemas = [
  nativeAccountDefaultsCommandSchema,
  nativeSettingsUpdateCommandSchema,
  nativePermissionUpdateCommandSchema,
  z
    .object({
      type: z.literal("chat.settings.read"),
      scope: nativeSettingsReadScopeSchema,
    })
    .strict(),
  z.object({
    type: z.literal("chat.message.protect"),
    message: chatMessageCreateSchema
      .extend({
        id: z.string().uuid(),
        idempotencyKey: z.string().min(1).max(200),
      })
      .strict(),
    attachments: chatAttachmentOpaqueListSchema.default([]),
  }),
  taskOperationPrepareRequestSchema.extend({
    type: z.literal("task.operation.prepare"),
  }),
  z.object({
    type: z.literal("chat.messages.protect"),
    messages: z
      .array(
        chatMessageCreateSchema
          .extend({
            id: z.string().uuid(),
            idempotencyKey: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(100_000),
    attachments: chatAttachmentOpaqueListSchema.default([]),
  }),
  z.object({
    type: z.literal("chat.messages.reprotect"),
    messages: z
      .array(
        z
          .object({
            source: chatMessageOpaqueSummarySchema,
            id: z.string().uuid(),
            idempotencyKey: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(100_000),
  }),
  z.object({
    type: z.literal("chat.turn.protect"),
    promptId: z.string().uuid(),
    messageId: z.string().uuid(),
    text: z.string().trim().min(1).max(100_000),
    mode: chatTurnModeSchema,
    modelId: z.string().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.nullable(),
    customSubagentModel: z.boolean().optional(),
    subagentModelId: z.string().min(1).max(200).nullable().optional(),
    subagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("chat.turn"),
      nativeCommandReceipt: nativeCommandReceiptSchema.optional(),
      protectedNativeInput: encryptedPayloadEnvelopeSchema.optional(),
      nativeClientUserMessageId: z.string().min(1).max(255).optional(),
      queuedPromptId: z.string().min(1).optional(),
      computerUseAuthority: cuaAgentAuthoritySchema.optional(),
      executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
      contextKind: chatContextKindSchema.default("project"),
      chatId: z.string().min(1),
      clientMessageId: z.string().min(1),
      executionLaneId: z.string().min(1),
      worktreeId: z.string().min(1).nullable(),
      scratchRootId: z.string().min(1).nullable().default(null),
      rootKind: projectRootKindSchema.nullable().default("git-worktree"),
      cwd: z.string().min(1),
      isPrimary: z.boolean(),
      worktreeMode: z.enum(["agent-managed", "pinned"]).nullable(),
      worktreePolicy: worktreePolicySchema.nullable(),
      policyProjectId: z.string().min(1).max(200).nullable(),
      policies: effectivePolicyWireListSchema.default({ policies: [] }),
      standalonePolicies: standalonePolicyWireListSchema.default({
        policies: [],
      }),
      threadId: z.string().min(1).nullable(),
      prompt: z.string().min(1).optional(),
      protectedPrompt: chatMessageOpaqueContentSchema.optional(),
      protectedHistory: z
        .array(chatMessageOpaqueSummarySchema)
        .max(100_000)
        .default([]),
      protectedPlan: chatPlanOpaqueStateSchema.nullable().default(null),
      attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
      skillNames: z.array(z.string().min(1)).max(64).default([]),
      chatSkillAudienceKeys: z
        .array(encryptionKeyBytesSchema)
        .max(5_000)
        .default([]),
      model: workerRuntimeModelSchema,
      provider: workerRuntimeProviderSchema,
      subagentDefaults: z
        .object({
          model: workerRuntimeModelSchema,
          provider: workerRuntimeProviderSchema,
        })
        .strict()
        .nullable()
        .optional(),
      subagentProtocolVersion: z
        .literal(NATIVE_SUBAGENT_PROTOCOL_VERSION)
        .optional(),
      permissionProfileId: permissionProfileIdSchema,
      planMode: planModeSchema,
      mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
      automationPaused: z.boolean().default(false),
      resultMode: agentTurnResultModeSchema.default({ kind: "visible" }),
      taskDispatchLease: taskDispatchWorkerLeaseSchema.optional(),
    })
    .superRefine((command, context) => {
      const projectShape =
        command.executionProfile === "ide" &&
        command.contextKind === "project" &&
        command.worktreeId !== null &&
        command.scratchRootId === null &&
        command.rootKind !== null &&
        command.worktreeMode !== null &&
        command.worktreePolicy !== null &&
        command.policyProjectId !== null;
      const standaloneShape =
        command.executionProfile === "standalone-chat" &&
        command.contextKind === "standalone" &&
        command.worktreeId === null &&
        command.scratchRootId !== null &&
        command.rootKind === null &&
        command.isPrimary &&
        command.worktreeMode === null &&
        command.worktreePolicy === null &&
        command.policyProjectId === null &&
        command.planMode === "default" &&
        command.automationPaused === false &&
        command.subagentDefaults == null &&
        command.subagentProtocolVersion === undefined &&
        command.taskDispatchLease === undefined;
      if (!projectShape && !standaloneShape) {
        context.addIssue({
          code: "custom",
          message:
            "Chat turn execution profile does not match its execution root and capabilities.",
          path: ["executionProfile"],
        });
      }
      if (
        command.executionProfile === "ide" &&
        (command.standalonePolicies.policies.length > 0 ||
          command.chatSkillAudienceKeys.length > 0)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "IDE chat turns cannot receive standalone Policy bodies or Chat Skill audiences.",
          path: ["standalonePolicies"],
        });
      }
      if (Boolean(command.prompt) === Boolean(command.protectedPrompt)) {
        context.addIssue({
          code: "custom",
          message:
            "Chat turns require exactly one visible or protected prompt.",
          path: ["protectedPrompt"],
        });
      }
      if (
        command.protectedPrompt &&
        command.resultMode.kind !== "chat-message-encrypted"
      ) {
        context.addIssue({
          code: "custom",
          message: "Protected chat prompts require protected chat results.",
          path: ["resultMode"],
        });
      }
      if (
        command.taskDispatchLease &&
        command.resultMode.kind !== "task-encrypted" &&
        command.resultMode.kind !== "task-message-encrypted"
      ) {
        context.addIssue({
          code: "custom",
          message: "Task dispatch leases are only valid for Task turns.",
          path: ["taskDispatchLease"],
        });
      }
    }),
  z
    .object({
      type: z.literal("chat.native-logical.complete"),
      chatId: z.string().min(1),
      rootOperationId: z.string().min(1),
      rootOperationGeneration: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.native-logical.cancel"),
      chatId: z.string().min(1),
      rootOperationId: z.string().min(1),
      rootOperationGeneration: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.native-control"),
      operationId: z.string().min(1).max(255).optional(),
      queueClaim: z
        .object({
          id: z.string().min(1),
          promptRevision: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
      protectedNativeInput: encryptedPayloadEnvelopeSchema.optional(),
      queuedPromptId: z.string().min(1).optional(),
      nativeClientUserMessageId: z.string().min(1).max(255).optional(),
      chatId: z.string().min(1),
      threadId: z.string().min(1).nullable(),
      nativeActivationGeneration: z.string().min(1).nullable(),
      nativeRuntimeGeneration: z.string().min(1).nullable(),
      modelRouteId: z.string().min(1).nullable(),
      providerAccountId: z.string().min(1).nullable(),
      control: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("interrupt") }).strict(),
        z.object({ kind: z.literal("pause"), paused: z.boolean() }).strict(),
        z
          .object({
            kind: z.literal("steer"),
            protectedPrompt: chatMessageOpaqueContentSchema,
            attachments: z
              .array(workerChatAttachmentSchema)
              .max(20)
              .default([]),
          })
          .strict(),
        z
          .object({
            kind: z.literal("reply"),
            requestKey: z.string().min(1).max(200),
            protectedResponse:
              interactionResponseOpaqueContentSchema.optional(),
            response: agentInteractionResponseSchema.optional(),
          })
          .strict()
          .superRefine((value, context) => {
            if (Boolean(value.protectedResponse) === Boolean(value.response))
              context.addIssue({
                code: "custom",
                message: "Provide exactly one interaction response.",
              });
          }),
      ]),
    })
    .strict(),
  z.object({
    type: z.literal("chat.pause.set"),
    nativeActivationGeneration: z.string().min(1).nullable().optional(),
    chatId: z.string().min(1),
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal("chat.compact"),
    session: managedSessionContextSchema.optional(),
    subagentDefaults: managedSessionSubagentDefaultsSchema
      .nullable()
      .optional(),
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).optional(),
    planMode: planModeSchema.optional(),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.interrupt"),
    nativeActivationGeneration: z.string().min(1).nullable().optional(),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    chatId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.turn.rollback"),
    nativeCommandReceipt: nativeCommandReceiptSchema.optional(),
    session: managedSessionContextSchema.optional(),
    subagentDefaults: managedSessionSubagentDefaultsSchema
      .nullable()
      .optional(),
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).optional(),
    planMode: planModeSchema.optional(),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    chatId: z.string().min(1),
    clientMessageId: z.string().min(1).max(200),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z
    .object({
      type: z.literal("chat.queue.changed"),
      chatId: z.string().min(1),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.queue.prepare"),
      chatId: z.string().min(1),
      prompt: queuedPromptOpaqueContentSchema,
      attachments: z.array(workerChatAttachmentSchema).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.queue.execute"),
      attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
      session: managedSessionContextSchema,
      subagentDefaults: managedSessionSubagentDefaultsSchema.nullable(),
      mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200),
      planMode: planModeSchema,
      executionProfile: z.literal("ide").default("ide"),
      chatId: z.string().min(1),
      cwd: z.string().min(1),
      threadId: z.string().min(1),
      model: workerRuntimeModelSchema,
      provider: workerRuntimeProviderSchema,
      permissionProfileId: permissionProfileIdSchema,
      queueClaim: z
        .object({
          id: z.string().min(1),
          promptRevision: z.number().int().nonnegative(),
        })
        .strict(),
      queuedPromptId: z.string().min(1),
      protectedNativeInput: encryptedPayloadEnvelopeSchema.optional(),
      nativeClientUserMessageId: z.string().min(1).max(255).optional(),
      protectedPrompt: chatMessageOpaqueContentSchema,
      nativeAction: z
        .enum(["plain", "literal", "parseSlash", "runShell"])
        .optional(),
      executionMethod: z.enum([
        "thread/goal/set",
        "thread/goal/clear",
        "thread/settings/update",
        "thread/shellCommand",
      ]),
    })
    .strict(),
  z.object({
    type: z.literal("chat.automation.resume"),
    session: managedSessionContextSchema,
    subagentDefaults: managedSessionSubagentDefaultsSchema.nullable(),
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200),
    planMode: planModeSchema,
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.goal.get"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.create"),
    operationId: z.string().min(1).max(255).optional(),
    session: managedSessionContextSchema.optional(),
    subagentDefaults: managedSessionSubagentDefaultsSchema
      .nullable()
      .optional(),
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).optional(),
    planMode: planModeSchema.optional(),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    objective: z.union([
      chatGoalCreateSchema.shape.objective,
      taskOperationRelayGoalSchema,
    ]),
    tokenBudget: chatGoalCreateSchema.shape.tokenBudget,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.update"),
    session: managedSessionContextSchema.optional(),
    subagentDefaults: managedSessionSubagentDefaultsSchema
      .nullable()
      .optional(),
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).optional(),
    planMode: planModeSchema.optional(),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    status: chatGoalUpdateSchema.shape.status,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.clear"),
    session: managedSessionContextSchema.optional(),
    subagentDefaults: managedSessionSubagentDefaultsSchema
      .nullable()
      .optional(),
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).optional(),
    planMode: planModeSchema.optional(),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.thread.ensure"),
    session: managedSessionContextSchema.optional(),
    subagentDefaults: managedSessionSubagentDefaultsSchema
      .nullable()
      .optional(),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    planMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.begin"),
    chatId: z.string().min(1).max(200),
    snapshotId: z.string().uuid(),
    transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024 * 1_024),
    cwd: z.string().min(1).max(8_192),
    requiredSkillNames: z.array(z.string().min(1).max(200)).max(64).default([]),
    planMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.chunk"),
    snapshotId: z.string().uuid(),
    chunkIndex: z.number().int().nonnegative(),
    data: z.string().max(400_000),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.complete"),
    snapshotId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("chat.relocation.thread.release"),
    threadId: z.string().min(1).nullable(),
    discard: z.boolean().default(false),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.plan.get"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    fallbackMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.plan.set"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    mode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.respond"),
    nativeActivationGeneration: z.string().min(1).nullable().optional(),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    requestKey: z.string().min(1).max(200),
    response: agentInteractionResponseSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.respond.protected"),
    nativeActivationGeneration: z.string().min(1).nullable().optional(),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    requestKey: z.string().min(1).max(200),
    response: interactionResponseOpaqueContentSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.cancel"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    requestKey: z.string().min(1).max(200),
    reason: z.string().min(1).max(4_000),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z
    .object({
      type: z.literal("chat.steer"),
      nativeActivationGeneration: z.string().min(1).nullable().optional(),
      executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
      chatId: z.string().min(1),
      threadId: z.string().min(1).nullable(),
      prompt: z.string().trim().min(1).max(100_000).optional(),
      protectedPrompt: chatMessageOpaqueContentSchema.optional(),
      attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
      model: workerRuntimeModelSchema,
      provider: workerRuntimeProviderSchema,
    })
    .superRefine((command, context) => {
      if (Boolean(command.prompt) === Boolean(command.protectedPrompt)) {
        context.addIssue({
          code: "custom",
          message:
            "Chat steering requires exactly one visible or protected prompt.",
          path: ["protectedPrompt"],
        });
      }
    }),
  z.object({
    type: z.literal("chat.sync"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
] as const;
import { nativeAccountDefaultsCommandSchema } from "./native-account-defaults.js";
