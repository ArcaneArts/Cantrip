import { describe, expect, it } from "vitest";

import {
  TASK_MARKDOWN_LIMIT,
  taskDetailSchema,
  taskDraftUpdateSchema,
  taskFinalizerResultSchema,
  taskOperationStartSchema,
  taskPlannerResultSchema,
  taskQuestionAnswerListSchema,
  taskQuestionListSchema,
  taskQuestionSchema,
} from "../src/tasks.js";

const question = {
  id: "delivery",
  header: "Delivery",
  question: "How should this be delivered?",
  options: [
    {
      id: "sequential",
      label: "Sequential PRs",
      description: "Merge one independently reviewable milestone at a time.",
    },
  ],
  recommendedOptionId: "sequential",
  allowFreeform: true,
  required: true,
};

describe("Task protocol", () => {
  it("validates bounded structured questions and recommendations", () => {
    expect(taskQuestionSchema.parse(question)).toEqual(question);
    expect(
      taskQuestionSchema.safeParse({
        ...question,
        recommendedOptionId: "missing",
      }).success,
    ).toBe(false);
    expect(
      taskQuestionSchema.safeParse({
        ...question,
        options: [],
        recommendedOptionId: null,
        allowFreeform: false,
      }).success,
    ).toBe(false);
    expect(taskQuestionListSchema.safeParse([question, question]).success).toBe(
      false,
    );
  });

  it("deduplicates bounded answer drafts", () => {
    const answer = {
      questionId: question.id,
      optionId: "sequential",
      freeform: null,
    };
    expect(taskQuestionAnswerListSchema.parse([answer])).toEqual([answer]);
    expect(
      taskQuestionAnswerListSchema.safeParse([answer, answer]).success,
    ).toBe(false);
    expect(
      taskQuestionAnswerListSchema.safeParse([
        { questionId: "empty", optionId: null, freeform: "   " },
      ]).success,
    ).toBe(false);
  });

  it("validates planner, finalizer, and idempotent operation contracts", () => {
    expect(
      taskPlannerResultSchema.parse({
        planMarkdown: "# Complete plan",
        questions: [question],
      }).questions,
    ).toHaveLength(1);
    expect(
      taskFinalizerResultSchema.parse({
        finalPlanMarkdown: "# Final plan",
        goalPrompt: "Implement every milestone in the final plan.",
      }).goalPrompt,
    ).toContain("every milestone");
    expect(
      taskOperationStartSchema.safeParse({
        operationId: "not-an-idempotency-uuid",
        rowVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("requires optimistic draft revisions and at least one change", () => {
    expect(taskDraftUpdateSchema.safeParse({ rowVersion: 1 }).success).toBe(
      false,
    );
    expect(
      taskDraftUpdateSchema.parse({ rowVersion: 2, briefMarkdown: "Idea" }),
    ).toEqual({ rowVersion: 2, briefMarkdown: "Idea" });
    expect(
      taskDraftUpdateSchema.safeParse({
        rowVersion: 1,
        draftAttachmentIds: ["one", "one"],
      }).success,
    ).toBe(false);
  });

  it("bounds durable Task documents", () => {
    const base = {
      chatId: "chat-1",
      state: "draft" as const,
      stableStateBeforeFailure: null,
      activeOperationId: null,
      activeOperationKind: null,
      briefMarkdown: "Initial idea",
      draftAttachmentIds: [],
      planMarkdown: null,
      planAuthorship: "agent" as const,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      planningRound: 0,
      implementationStartedAt: null,
      lastError: null,
      rowVersion: 1,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
    expect(taskDetailSchema.parse(base)).toMatchObject({ state: "draft" });
    expect(
      taskDetailSchema.safeParse({
        ...base,
        briefMarkdown: "x".repeat(TASK_MARKDOWN_LIMIT + 1),
      }).success,
    ).toBe(false);
  });
});
