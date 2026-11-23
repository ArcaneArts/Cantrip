import type {
  TaskOperationRelayRequest,
  TaskOperationRelayResult,
} from "@cantrip/protocol/tasks";
import { describe, expect, it } from "vitest";

import {
  ENCRYPTED_TASK_OPERATION_PROMPT,
  parseTaskOperationRelayResult,
  taskOperationRelayTurnFields,
} from "../src/tasks/encrypted-relay.js";

const encrypted = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

const request: TaskOperationRelayRequest = {
  chatId: "chat-opaque",
  operationId: "11111111-1111-4111-8111-111111111111",
  fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  classification: {
    ordinal: 1,
    kind: "initial-plan",
    status: "running",
    hasOutputPlan: false,
    hasOutputQuestions: false,
    hasOutputGoalPrompt: false,
    error: null,
  },
  protectedInput: encrypted,
  task: {
    classification: {
      state: "planning",
      stableStateBeforeFailure: "draft",
      activeOperationKind: "initial-plan",
      planAuthorship: "agent",
      planningRound: 1,
      hasPlan: false,
      hasQuestions: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError: null,
    },
    protectedContent: encrypted,
  },
  userMessage: {
    id: "22222222-2222-4222-8222-222222222222",
    classification: { role: "user", mode: "plan", attachmentIds: [] },
    protectedContent: encrypted,
    reasoningEffort: null,
    idempotencyKey: "task-operation:user",
  },
};

const result: TaskOperationRelayResult = {
  chatId: request.chatId,
  operationId: request.operationId,
  fingerprint: request.fingerprint,
  classification: {
    ...request.classification,
    status: "completed",
    hasOutputPlan: true,
  },
  protectedResult: encrypted,
  task: {
    classification: {
      state: "review",
      stableStateBeforeFailure: null,
      activeOperationKind: null,
      planAuthorship: "agent",
      planningRound: 1,
      hasPlan: true,
      hasQuestions: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError: null,
    },
    protectedContent: encrypted,
  },
  assistantMessage: {
    id: "33333333-3333-4333-8333-333333333333",
    classification: { role: "assistant", mode: "plan", attachmentIds: [] },
    protectedContent: encrypted,
    reasoningEffort: null,
    idempotencyKey: "task-operation:assistant",
  },
  goal: null,
};

describe("opaque Task operation server relay", () => {
  it("relays only a generic label, ciphertext, and public classification", () => {
    const observed = taskOperationRelayTurnFields(request);
    expect(observed.prompt).toBe(ENCRYPTED_TASK_OPERATION_PROMPT);
    expect(observed.resultMode.kind).toBe("task-encrypted");
    expect(JSON.stringify(observed)).not.toContain(
      "SENTINEL private Task prose",
    );
    expect(observed).not.toHaveProperty("outputSchema");
  });

  it("accepts matching opaque retries and rejects changed result metadata", () => {
    expect(parseTaskOperationRelayResult(result, request)).toEqual(result);
    expect(parseTaskOperationRelayResult(result, request)).toEqual(result);
    expect(() =>
      parseTaskOperationRelayResult(
        {
          ...result,
          fingerprint: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
        },
        request,
      ),
    ).toThrow();
    expect(() =>
      parseTaskOperationRelayResult(
        {
          ...result,
          classification: { ...result.classification, ordinal: 2 },
        },
        request,
      ),
    ).toThrow();
  });
});
