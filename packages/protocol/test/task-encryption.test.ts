import { describe, expect, it } from "vitest";

import { agentTurnResultModeSchema } from "../src/index.js";

import {
  encryptedTaskProtectedContentSchema,
  taskGoalObjectiveOpaqueSnapshotSchema,
  taskMessageProtectedContentSchema,
  taskOpaqueSummarySchema,
  taskOperationRelayRequestSchema,
  taskOperationRelayResultSchema,
  taskPlanningRoundProtectedContentSchema,
  taskProtectedContentSchema,
} from "../src/tasks.js";

const timestamp = "2026-08-19T12:00:00.000Z";
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

const taskClassification = {
  state: "review" as const,
  stableStateBeforeFailure: null,
  activeOperationKind: null,
  planAuthorship: "agent" as const,
  planningRound: 1,
  hasPlan: true,
  hasQuestions: false,
  hasFinalPlan: false,
  hasGoalPrompt: false,
  lastError: null,
};

describe("Task encryption contracts", () => {
  it("requires protected content and public classifications to agree", () => {
    const content = {
      version: 1 as const,
      classification: taskClassification,
      briefMarkdown: "Encrypt Task prose.",
      planMarkdown: "# Plan",
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    };
    expect(taskProtectedContentSchema.parse(content)).toEqual(content);
    expect(
      taskProtectedContentSchema.safeParse({
        ...content,
        classification: { ...taskClassification, hasPlan: false },
      }).success,
    ).toBe(false);
    expect(
      taskProtectedContentSchema.safeParse({
        ...content,
        classification: { ...taskClassification, unexpected: true },
      }).success,
    ).toBe(false);
  });

  it("validates planning-round, message, and Goal protected bundles", () => {
    expect(
      taskPlanningRoundProtectedContentSchema.parse({
        version: 1,
        classification: {
          ordinal: 1,
          kind: "initial-plan",
          status: "completed",
          hasOutputPlan: true,
          hasOutputQuestions: false,
          hasOutputGoalPrompt: false,
          error: null,
        },
        inputBriefMarkdown: "Brief",
        inputPlanMarkdown: null,
        inputQuestions: [],
        inputAnswers: [],
        additionalDirection: "",
        outputPlanMarkdown: "Plan",
        outputQuestions: [],
        outputGoalPrompt: null,
        error: null,
      }).classification.status,
    ).toBe("completed");
    expect(
      taskMessageProtectedContentSchema.safeParse({
        version: 1,
        classification: {
          role: "user",
          mode: "default",
          attachmentIds: ["attachment-2"],
        },
        content: [
          {
            type: "attachment",
            attachment: { id: "attachment-1" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      taskGoalObjectiveOpaqueSnapshotSchema.parse({
        chatId: "chat-1",
        threadId: "thread-1",
        status: "active",
        protectedObjective: encrypted,
        tokenBudget: null,
        tokensUsed: 1,
        timeUsedSeconds: 2,
        createdAt: 3,
        updatedAt: 4,
      }).status,
    ).toBe("active");
  });

  it("keeps opaque summaries distinct from decrypted Task details", () => {
    const opaque = taskOpaqueSummarySchema.parse({
      ...taskClassification,
      chatId: "chat-1",
      activeOperationId: null,
      draftAttachmentIds: [],
      protectedContent: encrypted,
      implementationStartedAt: null,
      rowVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(opaque).not.toHaveProperty("briefMarkdown");
    expect(opaque.protectedContent.envelope.ciphertext).toBe(
      encrypted.envelope.ciphertext,
    );
  });

  it("rejects unknown versions, revision disagreement, and oversized envelopes", () => {
    expect(
      encryptedTaskProtectedContentSchema.safeParse({
        ...encrypted,
        formatVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      encryptedTaskProtectedContentSchema.safeParse({
        ...encrypted,
        keyRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      encryptedTaskProtectedContentSchema.safeParse({
        ...encrypted,
        envelope: {
          ...encrypted.envelope,
          ciphertext: "A".repeat(5_600_000),
        },
      }).success,
    ).toBe(false);
  });

  it("keeps encrypted Task operation relay contracts opaque and classified", () => {
    const request = taskOperationRelayRequestSchema.parse({
      chatId: "chat-1",
      operationId: "11111111-1111-4111-8111-111111111111",
      fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      classification: {
        ordinal: 2,
        kind: "continue-plan",
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
          stableStateBeforeFailure: "review",
          activeOperationKind: "continue-plan",
          planAuthorship: "agent",
          planningRound: 2,
          hasPlan: true,
          hasQuestions: false,
          hasFinalPlan: false,
          hasGoalPrompt: false,
          lastError: null,
        },
        protectedContent: encrypted,
      },
      userMessage: {
        id: "22222222-2222-4222-8222-222222222222",
        classification: {
          role: "user",
          mode: "plan",
          attachmentIds: [],
        },
        protectedContent: encrypted,
        reasoningEffort: null,
        idempotencyKey: "task-operation:user",
      },
    });
    expect(request).not.toHaveProperty("prompt");
    expect(
      agentTurnResultModeSchema.parse({
        kind: "task-encrypted",
        operation: request,
      }).kind,
    ).toBe("task-encrypted");
    expect(
      taskOperationRelayRequestSchema.safeParse({
        ...request,
        plaintextPrompt: "must not cross the server",
      }).success,
    ).toBe(false);
    expect(
      taskOperationRelayResultSchema.parse({
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
            planningRound: 2,
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
          classification: {
            role: "assistant",
            mode: "plan",
            attachmentIds: [],
          },
          protectedContent: encrypted,
          reasoningEffort: null,
          idempotencyKey: "task-operation:assistant",
        },
        goal: null,
      }).classification.status,
    ).toBe("completed");
  });
});
