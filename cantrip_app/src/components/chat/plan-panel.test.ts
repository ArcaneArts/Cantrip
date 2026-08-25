import type { ChatPlanState, PendingPlanQuestion } from "@cantrip/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

  it("bounds long plans inside an opaque scrolling surface", async () => {
    const { PlanPanel } = await import("./plan-panel");
    const state: ChatPlanState = {
      mode: "plan",
      explanation: "Choose how the work should proceed.",
      steps: [],
      question,
    };
    const markup = renderToStaticMarkup(
      createElement(PlanPanel, {
        active: true,
        error: null,
        implementDisabled: false,
        implementPending: false,
        onAnswer: () => undefined,
        onImplement: () => undefined,
        onRevise: () => undefined,
        pending: false,
        ready: false,
        state,
      }),
    );

    expect(markup).toContain('data-slot="plan-panel"');
    expect(markup).toContain("max-h-[min(32rem,calc(100svh-12rem))]");
    expect(markup).toContain("bg-[var(--popover-solid)]");
    expect(markup).toContain('data-slot="plan-panel-scroll"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("shrink-0");
  });

  it("offers implementation or continued planning after the turn completes", async () => {
    const { PlanPanel } = await import("./plan-panel");
    const markup = renderToStaticMarkup(
      createElement(PlanPanel, {
        active: false,
        error: null,
        implementDisabled: false,
        implementPending: false,
        onAnswer: () => undefined,
        onImplement: () => undefined,
        onRevise: () => undefined,
        pending: false,
        ready: true,
        state: {
          mode: "plan",
          explanation: null,
          steps: [],
          question: null,
        },
      }),
    );

    expect(markup).toContain("Plan ready");
    expect(markup).toContain("Implement plan");
    expect(markup).toContain("Tell Codex something else");
  });

  it("stays hidden outside Plan Mode", async () => {
    const { PlanPanel } = await import("./plan-panel");
    const markup = renderToStaticMarkup(
      createElement(PlanPanel, {
        active: false,
        error: null,
        implementDisabled: false,
        implementPending: false,
        onAnswer: () => undefined,
        onImplement: () => undefined,
        onRevise: () => undefined,
        pending: false,
        ready: true,
        state: {
          mode: "default",
          explanation: null,
          steps: [],
          question: null,
        },
      }),
    );

    expect(markup).toBe("");
  });

  it("stays hidden while the user prepares more planning input", async () => {
    const { PlanPanel } = await import("./plan-panel");
    const markup = renderToStaticMarkup(
      createElement(PlanPanel, {
        active: false,
        error: null,
        implementDisabled: false,
        implementPending: false,
        onAnswer: () => undefined,
        onImplement: () => undefined,
        onRevise: () => undefined,
        pending: false,
        ready: false,
        state: {
          mode: "plan",
          explanation: null,
          steps: [],
          question: null,
        },
      }),
    );

    expect(markup).toBe("");
  });

  it("keeps an unanswered plan question visible while the turn waits", async () => {
    const { PlanPanel } = await import("./plan-panel");
    const markup = renderToStaticMarkup(
      createElement(PlanPanel, {
        active: false,
        error: null,
        implementDisabled: false,
        implementPending: false,
        onAnswer: () => undefined,
        onImplement: () => undefined,
        onRevise: () => undefined,
        pending: false,
        ready: false,
        state: {
          mode: "plan",
          explanation: null,
          steps: [],
          question,
        },
      }),
    );

    expect(markup).toContain('data-slot="plan-panel"');
    expect(markup).toContain("Codex needs your input");
  });
});
