import type { PendingPlanQuestion } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { buildPlanAnswers } from "./plan-panel";

const question: PendingPlanQuestion = {
  id: "request-1",
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  createdAt: "2026-08-08T12:00:00.000Z",
  questions: [
    {
      id: "topology",
      header: "Topology",
      question: "Which topology?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Four nodes", description: "Load balanced." }],
    },
    {
      id: "notes",
      header: "Notes",
      question: "Any constraints?",
      isOther: false,
      isSecret: false,
      options: null,
    },
  ],
};

describe("PlanPanel answers", () => {
  it("requires every question and preserves selected answers", () => {
    expect(
      buildPlanAnswers(question, { topology: "Four nodes" }, {}),
    ).toBeNull();
    expect(
      buildPlanAnswers(
        question,
        { topology: "Four nodes", notes: "No downtime" },
        {},
      ),
    ).toEqual({ topology: ["Four nodes"], notes: ["No downtime"] });
  });

  it("substitutes a non-empty custom answer for Other", () => {
    expect(
      buildPlanAnswers(
        question,
        { topology: "__other__", notes: "None" },
        { topology: "Two regional pairs" },
      ),
    ).toEqual({ topology: ["Two regional pairs"], notes: ["None"] });
  });
});
