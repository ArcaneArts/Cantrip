import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatComposerPrimaryActions } from "./chat-composer-primary-actions";

const actions = ({
  active,
  agentStartedAtMs = null,
  paused = false,
}: {
  active: boolean;
  agentStartedAtMs?: number | null;
  paused?: boolean;
}) => (
  <ChatComposerPrimaryActions
    active={active}
    agentStartedAtMs={agentStartedAtMs}
    onPauseChange={vi.fn()}
    onStop={vi.fn()}
    pauseDisabled={false}
    pausePending={false}
    paused={paused}
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
