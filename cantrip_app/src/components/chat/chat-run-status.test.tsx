import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { ChatRunStatus } from "./chat-run-status";

describe("ChatRunStatus", () => {
  it.each([
    { automationPaused: false, staleActivity: false },
    { automationPaused: true, staleActivity: false },
    { automationPaused: false, staleActivity: true },
    { automationPaused: true, staleActivity: true },
  ])(
    "shows failure with safe guidance for %j",
    ({ automationPaused, staleActivity }) => {
      const markup = renderToStaticMarkup(
        <ChatRunStatus
          automationPaused={automationPaused}
          hasLiveActivity={staleActivity}
          hasStreamingResponse={staleActivity}
          inferenceProgress={null}
          syncingCodeGraph={staleActivity}
          status="failed"
          waitingForPlanAnswer={staleActivity}
        />,
      );
      expect(markup).toContain('role="alert"');
      expect(markup).toContain("Last turn failed");
      expect(markup).toContain("Review the conversation");
      expect(markup).toContain("before sending a follow-up");
      expect(markup).not.toContain("Working...");
      expect(markup).not.toContain("Responding...");
      expect(markup).not.toContain("<button");
    },
  );

  it("tracks canonical status across recovery and remount without resending", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    const view = (status: "failed" | "idle" | "running") => (
      <ChatRunStatus
        automationPaused={false}
        hasLiveActivity={false}
        hasStreamingResponse={false}
        inferenceProgress={null}
        syncingCodeGraph={false}
        status={status}
        waitingForPlanAnswer={false}
      />
    );
    try {
      await act(async () => {
        renderer = TestRenderer.create(view("failed"));
      });
      expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
      await act(async () => {
        renderer!.update(view("running"));
      });
      expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      expect(JSON.stringify(renderer!.toJSON())).toContain("Working...");
      await act(async () => {
        renderer!.update(view("idle"));
      });
      expect(renderer!.toJSON()).toBeNull();
      await act(async () => {
        renderer!.unmount();
      });
      await act(async () => {
        renderer = TestRenderer.create(view("failed"));
      });
      expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it("renders active work as a spinner-free shimmering label", () => {
    const markup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        hasLiveActivity={false}
        hasStreamingResponse={false}
        inferenceProgress={null}
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
        hasLiveActivity={false}
        hasStreamingResponse={false}
        inferenceProgress={null}
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
        hasLiveActivity={false}
        hasStreamingResponse={false}
        inferenceProgress={null}
        syncingCodeGraph={false}
        status="waiting-for-approval"
        waitingForPlanAnswer={false}
      />,
    );
    const pausedMarkup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused
        hasLiveActivity={false}
        hasStreamingResponse={false}
        inferenceProgress={null}
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
          hasLiveActivity={false}
          hasStreamingResponse={false}
          inferenceProgress={null}
          syncingCodeGraph={false}
          status="idle"
          waitingForPlanAnswer={false}
        />,
      ),
    ).toBe("");
  });

  it("leaves the shimmer to the latest live activity group", () => {
    expect(
      renderToStaticMarkup(
        <ChatRunStatus
          automationPaused={false}
          hasLiveActivity
          hasStreamingResponse={false}
          inferenceProgress={null}
          syncingCodeGraph={false}
          status="running"
          waitingForPlanAnswer={false}
        />,
      ),
    ).toBe("");
  });

  it("shows responding while assistant text is still streaming", () => {
    const markup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        hasLiveActivity
        hasStreamingResponse
        inferenceProgress={null}
        syncingCodeGraph={false}
        status="running"
        waitingForPlanAnswer={false}
      />,
    );

    expect(markup).toContain("Responding...");
    expect(markup).toContain("chat-working-shimmer");
    expect(markup).not.toContain("Working...");
    expect(markup).not.toContain("Finishing...");
  });

  it("shows determinate Ollama prefill progress over generic activity", () => {
    const markup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        hasLiveActivity
        hasStreamingResponse={false}
        inferenceProgress={{
          kind: "progress",
          requestId: "message-one",
          cycle: 1,
          sequence: 2,
          phase: "prefill",
          fractionComplete: 10_240 / 46_492,
          completedTokens: 10_240,
          totalTokens: 46_492,
          precision: "estimated",
          source: "provider-observer",
          startedAt: "2026-08-24T11:59:00.000Z",
          observedAt: "2026-08-24T12:00:00.000Z",
        }}
        syncingCodeGraph={false}
        status="running"
        waitingForPlanAnswer={false}
      />,
    );

    expect(markup).toContain("Prefilling 22%");
    expect(markup).not.toContain("Prefilling 22%...");
    expect(markup).toContain("10k of 46k prompt tokens");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('stroke-dasharray="22 100"');
    expect(markup).toContain("chat-working-shimmer");
  });

  it("does not invent a percentage for indeterminate prefill", () => {
    const markup = renderToStaticMarkup(
      <ChatRunStatus
        automationPaused={false}
        hasLiveActivity={false}
        hasStreamingResponse={false}
        inferenceProgress={{
          kind: "progress",
          requestId: "message-one",
          cycle: 1,
          sequence: 0,
          phase: "prefill",
          fractionComplete: null,
          completedTokens: null,
          totalTokens: null,
          precision: "indeterminate",
          source: "provider-observer",
          startedAt: "2026-08-24T12:00:00.000Z",
          observedAt: "2026-08-24T12:00:00.000Z",
        }}
        syncingCodeGraph={false}
        status="running"
        waitingForPlanAnswer={false}
      />,
    );

    expect(markup).toContain("Prefilling");
    expect(markup).not.toContain("Prefilling...");
    expect(markup).not.toContain("%");
  });
});
