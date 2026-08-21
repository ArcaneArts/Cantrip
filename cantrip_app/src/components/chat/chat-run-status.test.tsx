import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatRunStatus } from "./chat-run-status";

describe("ChatRunStatus", () => {
  it("renders active work as a spinner-free shimmering label", () => {
    const markup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        syncingCodeGraph={false}
        status="running"
        waitingForPlanAnswer={false}
      />,
    );

    expect(markup).toContain("Working...");
    expect(markup).toContain("chat-working-shimmer");
    expect(markup).toContain('data-elite-ignore=""');
    expect(markup).not.toContain("working through Codex");
    expect(markup).not.toContain("animate-spin");
    expect(markup).not.toContain("<svg");
  });

  it("identifies CodeGraph synchronization before agent work begins", () => {
    const markup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        syncingCodeGraph
        status="running"
        waitingForPlanAnswer={false}
      />,
    );

    expect(markup).toContain("Syncing CodeGraph...");
    expect(markup).toContain("chat-working-shimmer");
    expect(markup).not.toContain("Working...");
  });

  it("keeps actionable waiting states explicit", () => {
    const approvalMarkup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        syncingCodeGraph={false}
        status="waiting-for-approval"
        waitingForPlanAnswer={false}
      />,
    );
    const pausedMarkup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused
        syncingCodeGraph={false}
        status="running"
        waitingForPlanAnswer={false}
      />,
    );

    expect(approvalMarkup).toContain("waiting for your approval");
    expect(pausedMarkup).toContain("Pause requested");
    expect(approvalMarkup).toContain('data-elite-ignore=""');
    expect(pausedMarkup).toContain('data-elite-ignore=""');
  });

  it("does not render for an idle agent", () => {
    expect(
      renderToStaticMarkup(
        <ChatRunStatus
          automationPaused={false}
          syncingCodeGraph={false}
          status="idle"
          waitingForPlanAnswer={false}
        />,
      ),
    ).toBe("");
  });
});
