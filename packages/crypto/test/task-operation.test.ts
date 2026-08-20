import { describe, expect, it } from "vitest";

import {
  createTaskOperationRelayRequest,
  createTaskOperationRelayResult,
  openTaskOperationRelayRequest,
  openTaskOperationRelayResult,
  randomBytes,
  taskOperationRunningClassification,
} from "../src/index.js";

const ownerId = "owner-task-relay";
const chatId = "chat-task-relay";
const operationId = "11111111-1111-4111-8111-111111111111";
const keyRevision = 4;

const inputContent = {
  version: 1 as const,
  classification: taskOperationRunningClassification({
    kind: "initial-plan",
    ordinal: 1,
  }),
  inputBriefMarkdown: "SENTINEL private Task brief",
  inputPlanMarkdown: null,
  inputQuestions: [],
  inputAnswers: [],
  additionalDirection: "SENTINEL private direction",
  outputPlanMarkdown: null,
  outputQuestions: [],
  outputGoalPrompt: null,
  error: null,
};

const inputTaskContent = {
  version: 1 as const,
  classification: {
    state: "planning" as const,
    stableStateBeforeFailure: "draft" as const,
    activeOperationKind: "initial-plan" as const,
    planAuthorship: "agent" as const,
    planningRound: 1,
    hasPlan: false,
    hasQuestions: false,
    hasFinalPlan: false,
    hasGoalPrompt: false,
    lastError: null,
  },
  briefMarkdown: "SENTINEL private Task brief",
  planMarkdown: null,
  currentQuestions: [],
  currentAnswers: [],
  additionalDirection: "SENTINEL private direction",
  finalPlanMarkdown: null,
  goalPrompt: null,
  lastError: null,
};

describe("encrypted Task operation relay codecs", () => {
  it("binds an opaque keyed fingerprint to encrypted operation input", async () => {
    const componentKey = randomBytes(32);
    const first = await createTaskOperationRelayRequest({
      ownerId,
      chatId,
      operationId,
      keyRevision,
      componentKey,
      content: inputContent,
      taskContent: inputTaskContent,
    });
    const retry = await createTaskOperationRelayRequest({
      ownerId,
      chatId,
      operationId,
      keyRevision,
      componentKey,
      content: inputContent,
      taskContent: inputTaskContent,
    });
    expect(first.fingerprint).toBe(retry.fingerprint);
    expect(first.protectedInput.envelope.nonce).not.toBe(
      retry.protectedInput.envelope.nonce,
    );
    expect(JSON.stringify(first)).not.toContain("SENTINEL");
    await expect(
      openTaskOperationRelayRequest({
        ownerId,
        keyRevision,
        componentKey,
        request: first,
      }),
    ).resolves.toEqual({ round: inputContent, task: inputTaskContent });
    await expect(
      openTaskOperationRelayRequest({
        ownerId,
        keyRevision,
        componentKey,
        request: {
          ...first,
          operationId: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ).rejects.toThrow();
  });

  it("authenticates opaque results against the original operation", async () => {
    const componentKey = randomBytes(32);
    const request = await createTaskOperationRelayRequest({
      ownerId,
      chatId,
      operationId,
      keyRevision,
      componentKey,
      content: inputContent,
      taskContent: inputTaskContent,
    });
    const content = {
      ...inputContent,
      classification: {
        ...inputContent.classification,
        status: "completed" as const,
        hasOutputPlan: true,
      },
      outputPlanMarkdown: "SENTINEL private generated plan",
    };
    const result = await createTaskOperationRelayResult({
      ownerId,
      keyRevision,
      componentKey,
      request,
      content,
      taskContent: {
        ...inputTaskContent,
        classification: {
          ...inputTaskContent.classification,
          state: "review",
          stableStateBeforeFailure: null,
          activeOperationKind: null,
          hasPlan: true,
        },
        planMarkdown: "SENTINEL private generated plan",
      },
      goal: null,
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    await expect(
      openTaskOperationRelayResult({
        ownerId,
        keyRevision,
        componentKey,
        request,
        result,
      }),
    ).resolves.toEqual({
      round: content,
      task: {
        ...inputTaskContent,
        classification: {
          ...inputTaskContent.classification,
          state: "review",
          stableStateBeforeFailure: null,
          activeOperationKind: null,
          hasPlan: true,
        },
        planMarkdown: "SENTINEL private generated plan",
      },
    });
    await expect(
      openTaskOperationRelayResult({
        ownerId,
        keyRevision,
        componentKey,
        request,
        result: {
          ...result,
          classification: {
            ...result.classification,
            ordinal: result.classification.ordinal + 1,
          },
        },
      }),
    ).rejects.toThrow();
  });
});
