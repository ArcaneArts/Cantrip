import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatComposerPrimaryActions } from "./chat-composer-primary-actions";

const renderActions = ({
  active,
  paused = false,
}: {
  active: boolean;
  paused?: boolean;
}) =>
  renderToStaticMarkup(
    <ChatComposerPrimaryActions
      active={active}
      onPauseChange={vi.fn()}
      onStop={vi.fn()}
      pauseDisabled={false}
      pausePending={false}
      paused={paused}
      sendDisabled={false}
      sendPending={false}
      stopDisabled={false}
      stopPending={false}
    />,
  );

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

  it("shows resume before stop while an active agent is paused", () => {
    const markup = renderActions({ active: true, paused: true });

    expect(markup).toContain('aria-label="Resume automatic agent work"');
    expect(markup).toContain('aria-label="Stop current operation"');
    expect(markup).not.toContain('aria-label="Pause agent"');
  });

  it("shows only send while the agent is not running", () => {
    const markup = renderActions({ active: false });

    expect(markup).toContain("Send prompt");
    expect(markup).not.toContain('aria-label="Pause agent"');
    expect(markup).not.toContain('aria-label="Stop current operation"');
    expect(markup).not.toContain("Resume automatic agent work");
  });
});
