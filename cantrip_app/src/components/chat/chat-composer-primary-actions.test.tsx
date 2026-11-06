import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatNativeSuspension } from "@cantrip/protocol";

import { ChatComposerPrimaryActions } from "./chat-composer-primary-actions";

const actions = ({
  active,
  agentStartedAtMs = null,
  paused = false,
  nativeSuspension,
}: {
  active: boolean;
  agentStartedAtMs?: number | null;
  paused?: boolean;
  nativeSuspension?: ChatNativeSuspension;
}) => (
  <ChatComposerPrimaryActions
    active={active}
    agentStartedAtMs={agentStartedAtMs}
    onPauseChange={vi.fn()}
    onStop={vi.fn()}
    pauseDisabled={false}
    pausePending={false}
    paused={paused}
    nativeSuspension={nativeSuspension}
    sendDisabled={false}
    sendPending={false}
    stopDisabled={false}
    stopPending={false}
  />
);

const renderActions = (input: Parameters<typeof actions>[0]) =>
  renderToStaticMarkup(actions(input));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ChatComposerPrimaryActions", () => {
  const native = (
    phase: ChatNativeSuspension["phase"],
  ): ChatNativeSuspension => ({
    controlId: "14c06d7e-8f9d-46ef-bd4f-0ae3b78862a0",
    action: phase === "resuming" || phase === "error" ? "resume" : "pause",
    phase,
    resumable: phase === "paused" || phase === "error",
    active: { threadId: "thread", turnId: "turn" },
    updatedAt: "2026-08-23T12:00:20.000Z",
    pausedAt: phase === "pausing" ? null : "2026-08-23T12:00:20.000Z",
    pausedMilliseconds: 10000,
    error:
      phase === "error"
        ? { code: "checkpoint-missing", protectedDetails: null }
        : null,
  });

  it("keeps Pausing distinct from Paused and leaves Stop usable", () => {
    const markup = renderActions({
      active: true,
      paused: true,
      nativeSuspension: native("pausing"),
    });
    expect(markup).toContain("Pausing at the next safe boundary");
    expect(markup).toContain('aria-label="Pausing"');
    expect(markup).not.toContain('aria-label="Resume turn"');
    expect(markup.match(/<button[^>]*aria-label="Pausing"[^>]*>/)?.[0]).toMatch(
      /\sdisabled=""/,
    );
    expect(
      markup.match(
        /<button[^>]*aria-label="Stop current operation"[^>]*>/,
      )?.[0],
    ).not.toMatch(/\sdisabled=""/);
  });

  it("offers same-turn Resume after reopening without a live running status", () => {
    const markup = renderActions({
      active: false,
      paused: true,
      nativeSuspension: native("paused"),
    });
    expect(markup).toContain('aria-label="Resume turn"');
    expect(markup).toMatch(/role="status"[^>]*>Paused/);
    expect(markup).not.toContain("Send prompt");
  });

  it("shows a retained restoration error with an explicit retry", () => {
    const markup = renderActions({
      active: false,
      paused: true,
      nativeSuspension: native("error"),
    });
    expect(markup).toContain('aria-label="Retry resume"');
    expect(markup).toContain("Saved turn data is missing");
    expect(markup).toContain('aria-label="Stop current operation"');
  });
  it("keeps Stop usable while a restored turn is Resuming", () => {
    const markup = renderActions({
      active: false,
      paused: true,
      nativeSuspension: native("resuming"),
    });
    expect(
      markup.match(/<button[^>]*aria-label="Resuming"[^>]*>/)?.[0],
    ).toMatch(/\sdisabled=""/);
    expect(
      markup.match(
        /<button[^>]*aria-label="Stop current operation"[^>]*>/,
      )?.[0],
    ).not.toMatch(/\sdisabled=""/);
  });
  it("never offers Resume from an unsuccessful explicit Stop", () => {
    const markup = renderActions({
      active: false,
      paused: true,
      nativeSuspension: {
        ...native("error"),
        action: "stop",
        resumable: false,
        error: { code: "stop-failed", protectedDetails: null },
      },
    });
    expect(markup).toContain("Retry Stop");
    expect(
      markup.match(/<button[^>]*aria-label="Resume unavailable"[^>]*>/)?.[0],
    ).toMatch(/\sdisabled=""/);
    expect(markup).not.toContain('aria-label="Retry resume"');
  });

  it("uses persisted pause timing after a cold reopen", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:05:00.000Z"));
    const markup = renderActions({
      active: true,
      paused: true,
      agentStartedAtMs: Date.parse("2026-08-23T12:00:00.000Z"),
      nativeSuspension: native("paused"),
    });
    expect(markup).toContain('aria-label="Agent working for 10s"');
  });
  it("does not subtract an earlier completed turn's paused time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:05:00.000Z"));
    const markup = renderActions({
      active: true,
      paused: false,
      agentStartedAtMs: Date.parse("2026-08-23T12:04:59.000Z"),
      nativeSuspension: native("completed"),
    });
    expect(markup).toContain('aria-label="Agent working for 1s"');
  });
  it("shows pause immediately before stop while the agent is running", () => {
    const markup = renderActions({ active: true });

    expect(markup).toContain('aria-label="Pause agent"');
    expect(markup).toContain('aria-label="Stop current operation"');
    expect(markup).not.toContain("Send prompt");
    expect(markup.indexOf('aria-label="Pause agent"')).toBeLessThan(
      markup.indexOf('aria-label="Stop current operation"'),
    );
  });

  it("shows elapsed work time immediately before pause", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:01:09.000Z"));
    const markup = renderActions({
      active: true,
      agentStartedAtMs: Date.parse("2026-08-23T12:00:00.000Z"),
    });
    vi.useRealTimers();

    expect(markup).toContain('aria-label="Agent working for 1m 9s"');
    expect(markup.indexOf("Agent working for 1m 9s")).toBeLessThan(
      markup.indexOf('aria-label="Pause agent"'),
    );
  });

  it("shows resume before stop while an active agent is paused", () => {
    const markup = renderActions({ active: true, paused: true });

    expect(markup).toContain('aria-label="Resume automatic agent work"');
    expect(markup).toContain('aria-label="Stop current operation"');
    expect(markup).not.toContain('aria-label="Pause agent"');
  });

  it("freezes elapsed work time while paused and resumes without a jump", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { clearInterval, setInterval });
    vi.setSystemTime(new Date("2026-08-23T12:00:10.000Z"));
    const startedAtMs = Date.parse("2026-08-23T12:00:00.000Z");
    let renderer!: TestRenderer.ReactTestRenderer;
    const elapsedLabel = () =>
      renderer.root.find(
        (node) =>
          typeof node.props["aria-label"] === "string" &&
          node.props["aria-label"].startsWith("Agent working for"),
      ).props["aria-label"] as string;

    await act(async () => {
      renderer = TestRenderer.create(
        actions({ active: true, agentStartedAtMs: startedAtMs }),
      );
    });
    expect(elapsedLabel()).toBe("Agent working for 10s");

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(elapsedLabel()).toBe("Agent working for 15s");

    await act(async () => {
      renderer.update(
        actions({ active: true, agentStartedAtMs: startedAtMs, paused: true }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(elapsedLabel()).toBe("Agent working for 15s");

    await act(async () => {
      renderer.update(actions({ active: true, agentStartedAtMs: startedAtMs }));
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(elapsedLabel()).toBe("Agent working for 20s");

    await act(async () => renderer.unmount());
  });

  it("shows only send while the agent is not running", () => {
    const markup = renderActions({ active: false });

    expect(markup).toContain("Send prompt");
    expect(markup).not.toContain('aria-label="Pause agent"');
    expect(markup).not.toContain('aria-label="Stop current operation"');
    expect(markup).not.toContain("Resume automatic agent work");
  });
});
