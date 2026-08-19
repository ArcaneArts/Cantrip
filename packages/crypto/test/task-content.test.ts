import { describe, expect, it } from "vitest";

import {
  CantripDecryptionError,
  decryptTaskGoalObjective,
  decryptTaskMessageProtectedContent,
  decryptTaskPlanningRoundProtectedContent,
  decryptTaskProtectedContent,
  encryptTaskGoalObjective,
  encryptTaskMessageProtectedContent,
  encryptTaskPlanningRoundProtectedContent,
  encryptTaskProtectedContent,
  randomBytes,
  taskContentAssociatedData,
  taskGoalObjectiveAssociatedData,
  taskMessageContentAssociatedData,
  taskPlanningRoundContentAssociatedData,
} from "../src/index.js";
import { TASK_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT } from "@cantrip/protocol/tasks";

const ownerId = "owner-1";
const keyRevision = 3;

const taskClassification = {
  state: "review" as const,
  stableStateBeforeFailure: null,
  activeOperationKind: null,
  planAuthorship: "mixed" as const,
  planningRound: 2,
  hasPlan: true,
  hasQuestions: true,
  hasFinalPlan: false,
  hasGoalPrompt: false,
  lastError: null,
};

const taskContent = {
  version: 1 as const,
  classification: taskClassification,
  briefMarkdown: "Sentinel private brief",
  planMarkdown: "# Sentinel plan",
  currentQuestions: [
    {
      id: "scope",
      header: "Scope",
      question: "Encrypt which prose?",
      options: [
        {
          id: "all",
          label: "All Task prose",
          description: "Protect the complete Task closure.",
        },
      ],
      recommendedOptionId: "all",
      allowFreeform: true,
      required: true,
    },
  ],
  currentAnswers: [
    { questionId: "scope", optionId: "all", freeform: "Include errors." },
  ],
  additionalDirection: "Keep the server opaque.",
  finalPlanMarkdown: null,
  goalPrompt: null,
  lastError: null,
};

const roundClassification = {
  ordinal: 2,
  kind: "continue-plan" as const,
  status: "completed" as const,
  hasOutputPlan: true,
  hasOutputQuestions: false,
  hasOutputGoalPrompt: false,
  error: null,
};

const roundContent = {
  version: 1 as const,
  classification: roundClassification,
  inputBriefMarkdown: taskContent.briefMarkdown,
  inputPlanMarkdown: taskContent.planMarkdown,
  inputQuestions: taskContent.currentQuestions,
  inputAnswers: taskContent.currentAnswers,
  additionalDirection: taskContent.additionalDirection,
  outputPlanMarkdown: "# Revised sentinel plan",
  outputQuestions: [],
  outputGoalPrompt: null,
  error: null,
};

const messageClassification = {
  role: "assistant" as const,
  mode: "default" as const,
  attachmentIds: [] as string[],
};

const messageContent = {
  version: 1 as const,
  classification: messageClassification,
  content: [
    {
      type: "text",
      text: "Sentinel private Task message",
      phase: "final_answer",
    },
  ],
};

const goalClassification = {
  chatId: "chat-1",
  threadId: "thread-1",
  status: "active" as const,
};

const goalContent = {
  version: 1 as const,
  classification: goalClassification,
  objective: "Sentinel private Goal objective",
};

function tampered(ciphertext: string): string {
  return `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
}

describe("Task trusted-endpoint encryption codecs", () => {
  it("round-trips every protected bundle across client and worker callers", async () => {
    const componentKey = randomBytes(32);
    const task = await encryptTaskProtectedContent({
      ownerId,
      chatId: "chat-1",
      keyRevision,
      componentKey,
      content: taskContent,
    });
    const round = await encryptTaskPlanningRoundProtectedContent({
      ownerId,
      roundId: "round-1",
      keyRevision,
      componentKey,
      content: roundContent,
    });
    const message = await encryptTaskMessageProtectedContent({
      ownerId,
      messageId: "message-1",
      keyRevision,
      componentKey,
      content: messageContent,
    });
    const goal = await encryptTaskGoalObjective({
      ownerId,
      chatId: goalClassification.chatId,
      threadId: goalClassification.threadId,
      keyRevision,
      componentKey,
      content: goalContent,
    });

    await expect(
      decryptTaskProtectedContent({
        ownerId,
        chatId: "chat-1",
        keyRevision,
        componentKey,
        encrypted: task,
        publicClassification: taskClassification,
      }),
    ).resolves.toEqual(taskContent);
    await expect(
      decryptTaskPlanningRoundProtectedContent({
        ownerId,
        roundId: "round-1",
        keyRevision,
        componentKey,
        encrypted: round,
        publicClassification: roundClassification,
      }),
    ).resolves.toEqual(roundContent);
    await expect(
      decryptTaskMessageProtectedContent({
        ownerId,
        messageId: "message-1",
        keyRevision,
        componentKey,
        encrypted: message,
        publicClassification: messageClassification,
      }),
    ).resolves.toEqual(messageContent);
    await expect(
      decryptTaskGoalObjective({
        ownerId,
        chatId: goalClassification.chatId,
        threadId: goalClassification.threadId,
        keyRevision,
        componentKey,
        encrypted: goal,
        publicClassification: goalClassification,
      }),
    ).resolves.toEqual(goalContent);
  });

  it("binds owners, rows, tables, fields, and key revisions", async () => {
    const componentKey = randomBytes(32);
    const encrypted = await encryptTaskProtectedContent({
      ownerId,
      chatId: "chat-1",
      keyRevision,
      componentKey,
      content: taskContent,
    });
    const base = {
      ownerId,
      chatId: "chat-1",
      keyRevision,
      componentKey,
      encrypted,
      publicClassification: taskClassification,
    };
    await expect(
      decryptTaskProtectedContent({ ...base, ownerId: "owner-2" }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptTaskProtectedContent({ ...base, chatId: "chat-2" }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptTaskProtectedContent({ ...base, keyRevision: keyRevision + 1 }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptTaskPlanningRoundProtectedContent({
        ownerId,
        roundId: "chat-1",
        keyRevision,
        componentKey,
        encrypted,
        publicClassification: roundClassification,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);

    const encryptedGoal = await encryptTaskGoalObjective({
      ownerId,
      chatId: goalClassification.chatId,
      threadId: goalClassification.threadId,
      keyRevision,
      componentKey,
      content: goalContent,
    });
    await expect(
      decryptTaskMessageProtectedContent({
        ownerId,
        messageId: JSON.stringify([
          goalClassification.chatId,
          goalClassification.threadId,
        ]),
        keyRevision,
        componentKey,
        encrypted: encryptedGoal,
        publicClassification: messageClassification,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });

  it("rejects tampering and encrypted/public classification mismatches", async () => {
    const componentKey = randomBytes(32);
    const encrypted = await encryptTaskMessageProtectedContent({
      ownerId,
      messageId: "message-1",
      keyRevision,
      componentKey,
      content: messageContent,
    });
    await expect(
      decryptTaskMessageProtectedContent({
        ownerId,
        messageId: "message-1",
        keyRevision,
        componentKey,
        encrypted: {
          ...encrypted,
          envelope: {
            ...encrypted.envelope,
            ciphertext: tampered(encrypted.envelope.ciphertext),
          },
        },
        publicClassification: messageClassification,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptTaskMessageProtectedContent({
        ownerId,
        messageId: "message-1",
        keyRevision,
        componentKey,
        encrypted,
        publicClassification: {
          ...messageClassification,
          role: "user",
        },
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });

  it("rejects oversized plaintext and unknown envelope versions", async () => {
    const componentKey = randomBytes(32);
    await expect(
      encryptTaskMessageProtectedContent({
        ownerId,
        messageId: "message-1",
        keyRevision,
        componentKey,
        content: {
          version: 1,
          classification: messageClassification,
          content: ["x".repeat(TASK_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT + 1)],
        },
      }),
    ).rejects.toThrow(/byte limit/iu);

    const encrypted = await encryptTaskGoalObjective({
      ownerId,
      chatId: goalClassification.chatId,
      threadId: goalClassification.threadId,
      keyRevision,
      componentKey,
      content: goalContent,
    });
    await expect(
      decryptTaskGoalObjective({
        ownerId,
        chatId: goalClassification.chatId,
        threadId: goalClassification.threadId,
        keyRevision,
        componentKey,
        encrypted: { ...encrypted, formatVersion: 2 } as never,
        publicClassification: goalClassification,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });

  it("publishes canonical associated-data layouts for every bundle", () => {
    expect(
      taskContentAssociatedData({ ownerId, chatId: "chat-1", keyRevision }),
    ).toMatchObject({ table: "tasks", field: "protected_content" });
    expect(
      taskPlanningRoundContentAssociatedData({
        ownerId,
        roundId: "round-1",
        keyRevision,
      }),
    ).toMatchObject({
      table: "task_planning_rounds",
      field: "protected_content",
    });
    expect(
      taskMessageContentAssociatedData({
        ownerId,
        messageId: "message-1",
        keyRevision,
      }),
    ).toMatchObject({
      table: "chat_messages",
      field: "task_protected_content",
    });
    expect(
      taskGoalObjectiveAssociatedData({
        ownerId,
        chatId: "chat-1",
        threadId: "thread-1",
        keyRevision,
      }),
    ).toMatchObject({ table: "task_goal_snapshots", field: "objective" });
  });
});
