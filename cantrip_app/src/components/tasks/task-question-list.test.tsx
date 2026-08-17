import type { TaskQuestion } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TaskQuestionList } from "./task-question-list";

const question: TaskQuestion = {
  id: "delivery",
  header: "Delivery",
  question: "How should this be delivered?",
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
};

describe("TaskQuestionList", () => {
  it("renders accessible recommendations, freeform input, and validation", () => {
    const markup = renderToStaticMarkup(
      <TaskQuestionList
        answers={[]}
        disabled={false}
        onChange={vi.fn()}
        questions={[question]}
        showValidation
      />,
    );
    expect(markup).toContain("Sequential PRs");
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Freeform answer or additional context");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("Answer this question before continuing.");
  });

  it("renders a flat empty state when no questions remain", () => {
    const markup = renderToStaticMarkup(
      <TaskQuestionList
        answers={[]}
        disabled={false}
        onChange={vi.fn()}
        questions={[]}
        showValidation={false}
      />,
    );
    expect(markup).toContain("no unresolved questions");
  });
});
