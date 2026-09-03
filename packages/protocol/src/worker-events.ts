import { z } from "zod";
import {
  chatPlanOpaqueStateSchema,
  chatMessageOpaqueContentSchema,
} from "./communication-content.js";
import {
  surfaceStreamOpaqueSchema,
  surfaceStreamWireRequestSchema,
} from "./surface-stream.js";
import { runConfigurationDefinitionChangeNotificationSchema } from "./run-configuration-operations.js";
import { runConfigurationRuntimeWorkerNotificationSchema } from "./run-configuration-runtime.js";
import {
  workerLinkPeerCandidateNotificationSchema,
  workerLinkPeerSignalNotificationSchema,
} from "./worker-link.js";
import { taskMessageOpaqueContentSchema } from "./tasks.js";
import { taskDispatchWorkerLeaseSchema } from "./task-scheduling.js";
import { codeGraphProjectStatusSchema } from "./worker-capabilities.js";
import { providerAuthStatusObservationSchema } from "./providers.js";
import { projectReplicaJobProgressEventSchema } from "./projects.js";
import { chatContextKindSchema } from "./chats.js";
import {
  agentMessagePhaseSchema,
  agentActivityTimestampSchema,
  agentTokenUsageSchema,
  agentActivitySchema,
} from "./agent-activity.js";
import {
  agentInteractionRuntimeRequestSchema,
  encryptedAgentInteractionRuntimeRequestSchema,
} from "./agent-interactions.js";
import { planStepSchema, pendingPlanQuestionSchema } from "./chat-runtime.js";
import {
  gitOperationObservationStateSchema,
  gitConflictSummarySchema,
} from "./git-actions.js";
import {
  worktreeInventorySchema,
  worktreeStatusResultSchema,
  worktreeObservationTargetSchema,
} from "./worker-worktrees.js";
import {
  agentTurnResultSchema,
  normalizedAgentMessageSchema,
} from "./agent-thread-sync.js";
import {
  workerLogStreamSubscriptionIdSchema,
  workerLogStreamBatchSchema,
} from "./worker-runtime-support.js";
import { workspaceRepositoryDiscoveryProgressSchema } from "./workspace-repository-discovery.js";

const protectedAgentEventTelemetrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    phase: agentMessagePhaseSchema.nullable(),
    streaming: z.boolean().optional(),
    turnId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("activity"),
    activityType: z.string().min(1).max(100),
    reasonCode: z.string().min(1).max(100).nullable().optional(),
    turnId: z.string().min(1).nullable(),
    agentRuntime: z
      .object({
        agentThreadId: z.string().min(1).max(200),
        isRoot: z.boolean(),
        startedAtMs: agentActivityTimestampSchema.nullable(),
        completedAtMs: agentActivityTimestampSchema.nullable(),
        status: z.enum(["running", "completed", "failed"]),
      })
      .strict()
      .nullable()
      .optional(),
  }),
  z.object({
    kind: z.literal("usage"),
    usage: agentTokenUsageSchema,
    modelContextWindow: z.number().int().positive().nullable(),
    contextUsedPercent: z.number().min(0).nullable(),
    turnId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("checkpoint"),
    turnId: z.string().min(1),
  }),
]);

export const inferenceProgressPhaseSchema = z.enum([
  "queued",
  "loading",
  "prefill",
  "generating",
]);

export const inferenceProgressPrecisionSchema = z.enum([
  "exact",
  "estimated",
  "indeterminate",
]);

export const inferenceProgressSourceSchema = z.enum([
  "provider-stream",
  "provider-observer",
  "provider-metrics",
  "worker-estimate",
]);

export const inferenceProgressSnapshotSchema = z
  .object({
    kind: z.literal("progress"),
    requestId: z.string().trim().min(1).max(200),
    cycle: z.number().int().positive().safe(),
    sequence: z.number().int().nonnegative().safe(),
    phase: inferenceProgressPhaseSchema,
    fractionComplete: z.number().min(0).max(1).nullable(),
    completedTokens: z.number().int().nonnegative().safe().nullable(),
    totalTokens: z.number().int().positive().safe().nullable(),
    precision: inferenceProgressPrecisionSchema,
    source: inferenceProgressSourceSchema,
    startedAt: z.iso.datetime(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (
      progress.precision === "indeterminate" &&
      progress.fractionComplete !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Indeterminate progress cannot include a completed fraction.",
        path: ["precision"],
      });
    }
    if (
      progress.precision !== "indeterminate" &&
      progress.fractionComplete === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Determinate progress requires a completed fraction.",
        path: ["precision"],
      });
    }
    if (progress.totalTokens !== null && progress.completedTokens === null) {
      context.addIssue({
        code: "custom",
        message: "A total token count requires a completed token count.",
        path: ["totalTokens"],
      });
    }
    if (
      progress.completedTokens !== null &&
      progress.totalTokens !== null &&
      progress.completedTokens > progress.totalTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "Completed tokens cannot exceed total tokens.",
        path: ["completedTokens"],
      });
    }
    if (Date.parse(progress.startedAt) > Date.parse(progress.observedAt)) {
      context.addIssue({
        code: "custom",
        message: "Inference progress cannot be observed before it starts.",
        path: ["startedAt"],
      });
    }
  });

export const inferenceProgressUpdateSchema = z.discriminatedUnion("kind", [
  inferenceProgressSnapshotSchema,
  z
    .object({
      kind: z.literal("clear"),
      requestId: z.string().trim().min(1).max(200),
      cycle: z.number().int().positive().safe(),
      sequence: z.number().int().nonnegative().safe(),
      observedAt: z.iso.datetime(),
    })
    .strict(),
]);

export const workerEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("workspace.repositories.discovery-progress"),
      jobId: z.string().uuid(),
      attempt: z.number().int().positive(),
      progress: workspaceRepositoryDiscoveryProgressSchema,
    })
    .strict(),
  z.object({
    type: z.literal("project.replica.progress"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    progress: projectReplicaJobProgressEventSchema,
  }),
  z.object({
    type: z.literal("agent.activity"),
    activity: agentActivitySchema,
  }),
  z.object({
    type: z.literal("agent.message"),
    message: normalizedAgentMessageSchema,
  }),
  z
    .object({
      type: z.literal("agent.inference-progress"),
      progress: inferenceProgressUpdateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("agent.protected-message"),
      message: chatMessageOpaqueContentSchema,
      telemetry: protectedAgentEventTelemetrySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("agent.protected-task-message"),
      message: taskMessageOpaqueContentSchema,
      telemetry: protectedAgentEventTelemetrySchema,
    })
    .strict(),
  z.object({ type: z.literal("terminal.ready") }),
  z.object({
    type: z.literal("agent.checkpoint"),
    turnId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent.plan.updated"),
    turnId: z.string().min(1),
    explanation: z.string().nullable(),
    steps: z.array(planStepSchema),
  }),
  z.object({
    type: z.literal("agent.plan.question"),
    question: pendingPlanQuestionSchema,
  }),
  z.object({
    type: z.literal("agent.plan.question-resolved"),
    questionId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("agent.plan.protected"),
      turnId: z.string().min(1).nullable(),
      state: chatPlanOpaqueStateSchema,
    })
    .strict(),
  z.object({
    type: z.literal("agent.interaction.requested"),
    request: agentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.requested.protected"),
    request: encryptedAgentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.cleared"),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("agent.interaction.expired"),
    requestKey: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("terminal.output"),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      sequence: surfaceStreamWireRequestSchema.shape.sequence,
      protectedData: surfaceStreamOpaqueSchema,
    })
    .strict(),
]);

export const workerEventEnvelopeSchema = z.object({
  kind: z.literal("event"),
  requestId: z.string().min(1),
  event: workerEventSchema,
});

export const workerNotificationSchema = z.discriminatedUnion("type", [
  workerLinkPeerSignalNotificationSchema,
  workerLinkPeerCandidateNotificationSchema,
  z
    .object({
      type: z.literal("chat.turn.outcome"),
      chatId: z.string().min(1),
      clientMessageId: z.string().min(1),
      executionLaneId: z.string().min(1),
      contextKind: chatContextKindSchema.default("project"),
      worktreeId: z.string().min(1).nullable(),
      scratchRootId: z.string().min(1).nullable().default(null),
      taskDispatchFence: taskDispatchWorkerLeaseSchema
        .omit({ leaseExpiresAt: true })
        .optional(),
      outcome: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          result: agentTurnResultSchema,
        }),
        z.object({
          ok: z.literal(false),
          error: z.string().min(1),
        }),
      ]),
    })
    .superRefine((notification, context) => {
      if (
        (notification.contextKind === "project" &&
          notification.worktreeId !== null &&
          notification.scratchRootId === null) ||
        (notification.contextKind === "standalone" &&
          notification.worktreeId === null &&
          notification.scratchRootId !== null)
      ) {
        return;
      }
      context.addIssue({
        code: "custom",
        message: "Chat turn outcome execution root is invalid.",
        path: ["contextKind"],
      });
    }),
  z
    .object({
      type: z.literal("chat.thread.changed"),
      threadId: z.string().min(1).max(200),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      changes: z
        .array(z.enum(["turn", "goal", "queue", "plan"]))
        .min(1)
        .max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal.runtime.observed"),
      terminalId: z.string().min(1).max(200),
      workerProcessGeneration: z.string().min(1).max(200),
      status: z.literal("exited"),
      exitCode: z.number().int(),
      signal: z.number().int().nullable(),
    })
    .strict(),
  workerLogStreamBatchSchema
    .extend({
      type: z.literal("diagnostics.logs.observed"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
    })
    .strict(),
  z.object({
    type: z.literal("worktree.inventory.observed"),
    projectId: worktreeObservationTargetSchema.shape.projectId,
    sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
    inventory: worktreeInventorySchema,
  }),
  z.object({
    type: z.literal("worktree.status.observed"),
    projectId: worktreeObservationTargetSchema.shape.projectId,
    worktreeId: worktreeObservationTargetSchema.shape.worktreeId,
    sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
    worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
    result: worktreeStatusResultSchema,
  }),
  z
    .object({
      type: z.literal("worktree.filesystem.changed"),
      projectId: worktreeObservationTargetSchema.shape.projectId,
      worktreeId: worktreeObservationTargetSchema.shape.worktreeId,
      sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
      worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
    })
    .strict(),
  z
    .object({
      type: z.literal("git.operation.observed"),
      projectId: z.string().uuid(),
      worktreeId: z.string().min(1).max(200),
      operationId: z.string().uuid(),
      sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
      worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
      observedAt: z.string().datetime({ offset: true }),
      state: gitOperationObservationStateSchema,
      conflicts: z
        .object({
          files: z.array(gitConflictSummarySchema).max(2_000),
          truncated: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("codegraph.status.observed"),
      status: codeGraphProjectStatusSchema,
    })
    .strict(),
  runConfigurationRuntimeWorkerNotificationSchema,
  runConfigurationDefinitionChangeNotificationSchema,
  providerAuthStatusObservationSchema,
]);

const directWorkerEventTypes = new Set<WorkerEvent["type"]>([
  "agent.activity",
  "agent.inference-progress",
  "agent.message",
  "agent.protected-message",
  "agent.protected-task-message",
]);

export const directWorkerNotificationTopics = new Map<
  WorkerNotification["type"],
  "filesystem" | "runtime" | "worktree"
>([
  ["worktree.filesystem.changed", "filesystem"],
  ["worktree.inventory.observed", "worktree"],
  ["worktree.status.observed", "worktree"],
  ["git.operation.observed", "worktree"],
  ["terminal.runtime.observed", "runtime"],
  ["codegraph.status.observed", "runtime"],
  ["project.run-configuration-runtime.observed", "runtime"],
  ["project.run-configuration-definitions.changed", "runtime"],
]);

export function workerEventIsProvisional(event: WorkerEvent): boolean {
  if (!directWorkerEventTypes.has(event.type)) return false;
  if (event.type === "agent.message") {
    return (
      event.message.streaming === true || event.message.phase === "commentary"
    );
  }
  if (
    event.type === "agent.protected-message" ||
    event.type === "agent.protected-task-message"
  ) {
    return (
      event.telemetry.kind === "activity" ||
      event.telemetry.kind === "usage" ||
      (event.telemetry.kind === "message" &&
        (event.telemetry.streaming === true ||
          event.telemetry.phase === "commentary"))
    );
  }
  return true;
}

export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type InferenceProgressPhase = z.infer<
  typeof inferenceProgressPhaseSchema
>;
export type InferenceProgressPrecision = z.infer<
  typeof inferenceProgressPrecisionSchema
>;
export type InferenceProgressSource = z.infer<
  typeof inferenceProgressSourceSchema
>;
export type InferenceProgressSnapshot = z.infer<
  typeof inferenceProgressSnapshotSchema
>;
export type InferenceProgressUpdate = z.infer<
  typeof inferenceProgressUpdateSchema
>;
export type WorkerEventEnvelope = z.infer<typeof workerEventEnvelopeSchema>;
export type WorkerNotification = z.infer<typeof workerNotificationSchema>;
