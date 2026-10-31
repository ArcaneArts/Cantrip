import {
  queuedPromptOpaqueContentSchema,
  chatAttachmentOpaqueSummarySchema,
} from "../../packages/protocol/dist/index.js";
import { settingsSnapshot } from "./native-settings-fixtures.mjs";
export const pendingId = "456789ab-1234-4234-8234-000000000001",
  promptId = "456789ab-1234-4234-8234-000000000002";
export function retainedPrompt({
  payload = settingsSnapshot.protectedContent,
  attachments = [],
  ...extra
} = {}) {
  const classification = {
      mode: "default",
      attachmentIds: attachments.map((a) => a.id),
    },
    protectedContent = {
      formatVersion: 1,
      keyRevision: payload.keyRevision,
      envelope: payload,
    };
  return queuedPromptOpaqueContentSchema.parse({
    id: promptId,
    classification,
    protectedContent,
    modelId: "queue-model",
    idempotencyKey: "retained-prompt",
    pendingMessage: {
      id: pendingId,
      classification: { role: "user", ...classification },
      protectedContent,
      idempotencyKey: "retained-message",
    },
    nativeAction: "literal",
    executionMethod: "turn/start",
    nativeClientUserMessageId: "cantrip:" + pendingId,
    protectedNativeInput: payload,
    ...extra,
  });
}
export function deferredAttachment(id = "attachment-one", chatId = "chat") {
  return chatAttachmentOpaqueSummarySchema.parse({
    id,
    chatId,
    sizeBytes: 3,
    status: "ready",
    protectedMetadata: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: settingsSnapshot.protectedContent,
    },
    createdAt: "2026-10-25T00:00:00.123Z",
  });
}
export function settlementWireFixtures(timestamp) {
  const input = {
    workerId: "alpha",
    operationId: "operation",
    operationGeneration: "generation",
    status: "applied",
    resultDigest: null,
    protectedResult: null,
    rejectionCode: null,
  };
  const prompt = retainedPrompt();
  return {
    nativeTurnRecoveryObservationSchema: [
      {
        threadId: "thread",
        runtimeGeneration: "new-runtime",
        turnId: "turn",
        status: "completed",
      },
      {
        threadId: "thread",
        runtimeGeneration: "new-runtime",
        turnId: "turn",
        status: null,
      },
    ],
    nativeCommandSettlementSchema: [
      input,
      {
        ...input,
        status: "rejected",
        executionComplete: true,
        deferred: {
          reason: "pendingSettings",
          inputConsumed: false,
          threadId: "thread",
          runtimeGeneration: "runtime",
          retainedPrompt: prompt,
          attachments: [],
        },
      },
      {
        ...input,
        executionComplete: true,
        terminalResult: {
          resultDigest: "a".repeat(64),
          protectedResult: settingsSnapshot.protectedContent,
        },
        reconciliation: { nativeTurnId: "turn", runtimeGeneration: "runtime" },
      },
    ],
    nativeCommandTerminalEvidenceSchema: [
      { nativeTurnId: "turn", runtimeGeneration: "runtime" },
    ],
    queuedPromptOpaqueContentSchema: [prompt],
    encryptedQueuedPromptSchema: [
      {
        ...prompt,
        revision: 0,
        state: "pending",
        chatId: "chat",
        attachments: [],
        position: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}
