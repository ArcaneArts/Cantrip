import { describe, expect, it } from "vitest";

import {
  encryptedTaskProtectedContentSchema,
  taskGoalObjectiveOpaqueSnapshotSchema,
  taskMessageProtectedContentSchema,
  taskOpaqueSummarySchema,
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
});
