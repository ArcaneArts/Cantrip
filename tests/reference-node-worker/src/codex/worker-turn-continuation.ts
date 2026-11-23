import {
  agentActivitySchema,
  agentMessagePhaseSchema,
  agentTokenUsageSchema,
  codexEventCorrelationSchema,
  nativeInitialTurnSettingsSchema,
  nativeTurnModelAttributionSchema,
  normalizedAgentMessageSchema,
  workerCommandSchema,
} from "@cantrip/protocol";
import { z } from "zod";
import type { ActiveTurn, RunAgentTurnOptions } from "./runtime-types.js";

const id = z.string().min(1);
const time = z.number().finite().nonnegative();
const ids = z.array(id);
const times = z.array(z.tuple([id, time]));
// Use the actual admitted model schema, rather than maintaining another copy.
const model = (
  workerCommandSchema.options.find(
    (option) => option.shape.type.value === "chat.turn",
  )! as unknown as { shape: { model: z.ZodType<RunAgentTurnOptions["model"]> } }
).shape.model;
const fileChanges = (
  agentActivitySchema.options.find(
    (option) => option.shape.type.value === "fileChange",
  )! as unknown as { shape: { changes: z.ZodType<ActiveTurn["diffChanges"]> } }
).shape.changes;
const commandItem = z
  .object({
    aggregatedOutput: z.string().nullable(),
    command: z.string(),
    cwd: z.string(),
    durationMs: time.nullable().optional(),
    exitCode: z.number().nullable(),
    id,
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    type: z.literal("commandExecution"),
  })
  .strict();
const command = z
  .object({
    output: z.string().nullable(),
    truncated: z.boolean(),
    startedAtMs: time,
    updatedAtMs: time,
    correlation: codexEventCorrelationSchema,
    item: commandItem.nullable(),
  })
  .strict();
const streaming = z
  .object({
    correlation: codexEventCorrelationSchema,
    id,
    lastEmittedText: z.string(),
    phase: agentMessagePhaseSchema.nullable(),
    text: z.string(),
  })
  .strict();

/** Worker observer bookkeeping, stored only inside the protected source record.
 * Native owns conversation and continuation; callbacks, timers and authority
 * are deliberately reconstructed from the new admitted execution. */
export const workerTurnContinuationSchema = z
  .object({
    version: z.literal(1),
    threadId: id,
    turnId: id,
    chatId: id.nullable(),
    cwd: id,
    capturedAtMs: time,
    startedAtMs: time,
    providerId: id,
    providerKind: id,
    executionKind: z.enum(["chat", "operation"]),
    baseline: z.array(
      z.tuple([
        z.string(),
        z.object({ fingerprint: z.string(), status: z.string() }).strict(),
      ]),
    ),
    model,
    initialSettings: nativeInitialTurnSettingsSchema.nullable(),
    nativeModelAttribution: nativeTurnModelAttributionSchema.nullable(),
    inheritThreadSettings: z.boolean(),
    collaborationMode: z
      .object({
        mode: z.enum(["default", "plan"]),
        settings: z
          .object({
            model: z.string(),
            reasoning_effort: z.string().nullable(),
            developer_instructions: z.null(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    latestUsage: agentTokenUsageSchema.nullable(),
    contextUsage: z
      .object({
        total: agentTokenUsageSchema,
        last: agentTokenUsageSchema,
        modelContextWindow: z.number().nullable(),
      })
      .strict()
      .nullable(),
    contextUsageUpdatedAtMs: time.nullable(),
    delta: z.string(),
    finalText: z.string().nullable(),
    durationMs: time.nullable(),
    diffChanges: fileChanges,
    commandTelemetry: z.array(z.tuple([id, command])),
    completedCommandIds: ids,
    fileStartedAtMs: times,
    itemStartedAtMs: times,
    liveAgentMessageFingerprints: ids,
    observedActivityFingerprints: ids,
    pendingActivities: z.array(z.tuple([id, agentActivitySchema])),
    pendingAgentMessage: normalizedAgentMessageSchema.nullable(),
    streamingAgentMessage: streaming.nullable(),
    reasoningSummaries: z.array(z.tuple([id, z.array(z.string())])),
    structuredChat: z.boolean(),
    structuredOutputSchema: z.record(z.string(), z.json()).nullable(),
    goalCompletion: z
      .object({
        turnId: id,
        text: z.string(),
        checkpointPublished: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startedAtMs > value.capturedAtMs)
      context.addIssue({
        code: "custom",
        message: "Worker continuation begins after its capture.",
      });
    for (const key of [
      "baseline",
      "commandTelemetry",
      "fileStartedAtMs",
      "itemStartedAtMs",
      "pendingActivities",
      "reasoningSummaries",
    ] as const) {
      const keys = value[key].map(([id]) => id);
      if (new Set(keys).size !== keys.length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Worker continuation contains duplicate map identities.",
        });
    }
    for (const key of [
      "completedCommandIds",
      "liveAgentMessageFingerprints",
      "observedActivityFingerprints",
    ] as const)
      if (new Set(value[key]).size !== value[key].length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Worker continuation contains duplicate set identities.",
        });
    if (
      value.nativeModelAttribution &&
      (value.nativeModelAttribution.threadId !== value.threadId ||
        value.nativeModelAttribution.turnId !== value.turnId)
    )
      context.addIssue({
        code: "custom",
        path: ["nativeModelAttribution"],
        message: "Worker model attribution belongs to another native turn.",
      });
  });
export type WorkerTurnContinuation = z.infer<
  typeof workerTurnContinuationSchema
>;

export function captureWorkerTurn(
  active: ActiveTurn,
  turnId: string,
): WorkerTurnContinuation {
  return workerTurnContinuationSchema.parse({
    version: 1,
    threadId: active.threadId,
    turnId,
    chatId: active.chatId,
    cwd: active.cwd,
    capturedAtMs: Date.now(),
    startedAtMs: active.startedAtMs,
    providerId: active.providerId,
    providerKind: active.providerKind,
    executionKind: active.executionKind,
    baseline: [...active.baseline],
    model: active.model,
    initialSettings: active.initialSettings ?? null,
    nativeModelAttribution: active.nativeModelAttribution ?? null,
    inheritThreadSettings: active.inheritThreadSettings === true,
    collaborationMode: active.collaborationMode,
    latestUsage: active.latestUsage,
    contextUsage: active.contextUsage,
    contextUsageUpdatedAtMs: active.contextUsageUpdatedAtMs,
    delta: active.delta,
    finalText: active.finalText,
    durationMs: active.durationMs,
    diffChanges: active.diffChanges,
    commandTelemetry: [...active.commandTelemetry].map(([key, value]) => {
      const { flushTimer: _timer, ...data } = value;
      return [key, data];
    }),
    completedCommandIds: [...active.completedCommandIds],
    fileStartedAtMs: [...active.fileStartedAtMs],
    itemStartedAtMs: [...active.itemStartedAtMs],
    liveAgentMessageFingerprints: [...active.liveAgentMessageFingerprints],
    observedActivityFingerprints: [...active.observedActivityFingerprints],
    pendingActivities: [...active.pendingActivities],
    pendingAgentMessage: active.pendingAgentMessage,
    streamingAgentMessage: active.streamingAgentMessage
      ? (() => {
          const { flushTimer: _timer, ...data } = active.streamingAgentMessage;
          return data;
        })()
      : null,
    reasoningSummaries: [...active.reasoningSummaries],
    structuredChat: active.structuredChat,
    structuredOutputSchema: active.structuredOutputSchema,
    goalCompletion: active.goalCompletion ?? null,
  });
}

export function restoreWorkerTurn(
  active: ActiveTurn,
  input: WorkerTurnContinuation,
): void {
  const saved = workerTurnContinuationSchema.parse(input);
  if (
    active.threadId !== saved.threadId ||
    active.chatId !== saved.chatId ||
    active.cwd !== saved.cwd ||
    active.providerId !== saved.providerId ||
    active.providerKind !== saved.providerKind
  )
    throw new Error(
      "Worker continuation belongs to another native execution source.",
    );
  // Offline time is not execution time. Native terminal duration remains the
  // authoritative result when it arrives; observer fallbacks exclude downtime.
  const shift = Math.max(0, Date.now() - saved.capturedAtMs);
  const shifted = (entries: Array<[string, number]>) =>
    new Map(entries.map(([key, at]) => [key, at + shift]));
  Object.assign(active, {
    startedAtMs: saved.startedAtMs + shift,
    baseline: new Map(saved.baseline),
    model: saved.model,
    executionKind: saved.executionKind,
    initialSettings: saved.initialSettings ?? undefined,
    nativeModelAttribution: saved.nativeModelAttribution ?? undefined,
    inheritThreadSettings: saved.inheritThreadSettings,
    collaborationMode: saved.collaborationMode,
    latestUsage: saved.latestUsage,
    contextUsage: saved.contextUsage,
    contextUsageUpdatedAtMs:
      saved.contextUsageUpdatedAtMs === null
        ? null
        : saved.contextUsageUpdatedAtMs + shift,
    delta: saved.delta,
    finalText: saved.finalText,
    durationMs: saved.durationMs,
    diffChanges: saved.diffChanges,
    commandTelemetry: new Map(
      saved.commandTelemetry.map(([key, value]) => [
        key,
        {
          ...value,
          startedAtMs: value.startedAtMs + shift,
          updatedAtMs: value.updatedAtMs + shift,
          flushTimer: null,
        },
      ]),
    ),
    completedCommandIds: new Set(saved.completedCommandIds),
    fileStartedAtMs: shifted(saved.fileStartedAtMs),
    itemStartedAtMs: shifted(saved.itemStartedAtMs),
    liveAgentMessageFingerprints: new Set(saved.liveAgentMessageFingerprints),
    observedActivityFingerprints: new Set(saved.observedActivityFingerprints),
    pendingActivities: new Map(saved.pendingActivities),
    pendingAgentMessage: saved.pendingAgentMessage,
    streamingAgentMessage: saved.streamingAgentMessage
      ? { ...saved.streamingAgentMessage, flushTimer: null }
      : null,
    reasoningSummaries: new Map(saved.reasoningSummaries),
    structuredChat: saved.structuredChat,
    structuredOutputSchema: saved.structuredOutputSchema,
    goalCompletion: saved.goalCompletion ?? undefined,
  });
  // Reply RPC IDs belong to the current transport. A fresh native process can
  // reuse an old numeric ID for an unrelated question; native continuation
  // owns accepted input, while this observer retains its fresh reply tracking.
}
