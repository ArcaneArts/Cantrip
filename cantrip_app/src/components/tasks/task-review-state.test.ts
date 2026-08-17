import type { TaskQuestion } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  setTaskQuestionAnswer,
  taskAnswerForQuestion,
  taskReviewInputSignature,
  unansweredRequiredTaskQuestions,
} from "./task-review-state";

const questions: TaskQuestion[] = [
  {
    id: "delivery",
    header: "Delivery",
    question: "How should the work be delivered?",
    options: [
      {
        id: "sequential",
        label: "Sequential PRs",
        description: "Merge each milestone before starting the next.",
      },
    ],
    recommendedOptionId: "sequential",
    allowFreeform: true,
    required: true,
  },
  {
    id: "notes",
    header: "Notes",
    question: "Anything else?",
    options: [],
    recommendedOptionId: null,
    allowFreeform: true,
    required: false,
  },
];

describe("Task review state", () => {
  it("keeps one answer per stable question ID", () => {
    const first = setTaskQuestionAnswer(
      [],
      { questionId: "delivery", optionId: "sequential", freeform: null },
      "delivery",
    );
    const replaced = setTaskQuestionAnswer(
      first,
      { questionId: "delivery", optionId: null, freeform: "Custom" },
      "delivery",
    );
    expect(replaced).toHaveLength(1);
    expect(taskAnswerForQuestion(replaced, "delivery")?.freeform).toBe(
      "Custom",
    );
    expect(setTaskQuestionAnswer(replaced, null, "delivery")).toEqual([]);
  });

  it("identifies only unanswered required questions", () => {
    expect(unansweredRequiredTaskQuestions(questions, [])).toEqual([
      questions[0],
    ]);
    expect(
      unansweredRequiredTaskQuestions(questions, [
        {
          questionId: "delivery",
          optionId: "sequential",
          freeform: null,
        },
      ]),
    ).toEqual([]);
  });

  it("uses ordered answer content and direction for autosave signatures", () => {
    const answers = [
      { questionId: "delivery", optionId: "sequential", freeform: null },
    ];
    expect(taskReviewInputSignature(answers, "One")).not.toBe(
      taskReviewInputSignature(answers, "Two"),
    );
    expect(taskReviewInputSignature(answers, "One")).toBe(
      taskReviewInputSignature(answers, "One"),
    );
  });
});
