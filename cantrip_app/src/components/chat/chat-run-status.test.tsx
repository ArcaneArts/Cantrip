import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatRunStatus } from "./chat-run-status";

describe("ChatRunStatus", () => {
  it("renders active work as a spinner-free shimmering label", () => {
    const markup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        status="running"
        waitingForPlanAnswer={false}
      />,
    );

    expect(markup).toContain("Working...");
    expect(markup).toContain("chat-working-shimmer");
    expect(markup).not.toContain("working through Codex");
    expect(markup).not.toContain("animate-spin");
    expect(markup).not.toContain("<svg");
  });

  it("keeps actionable waiting states explicit", () => {
    const approvalMarkup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        status="waiting-for-approval"
        waitingForPlanAnswer={false}
      />,
    );
    const pausedMarkup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused
        status="running"
        waitingForPlanAnswer={false}
      />,
    );

    expect(approvalMarkup).toContain("waiting for your approval");
    expect(pausedMarkup).toContain("Pause requested");
  });

  it("does not render for an idle agent", () => {
    expect(
      renderToStaticMarkup(
        <ChatRunStatus
          automationPaused={false}
          status="idle"
          waitingForPlanAnswer={false}
        />,
      ),
    ).toBe("");
  });
});
