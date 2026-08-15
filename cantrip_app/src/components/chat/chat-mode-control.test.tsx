import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatModeControl } from "./chat-mode-control";

describe("chat mode control", () => {
  it.each([
    ["default", "Default"],
    ["plan", "Plan"],
    ["goal", "Goal"],
  ] as const)("renders %s as an icon-only accessible button", (mode, label) => {
    const markup = renderToStaticMarkup(
      <ChatModeControl disabled={false} mode={mode} onChange={() => {}} />,
    );

    expect(markup).toContain(`aria-label="Message mode: ${label}"`);
    expect(markup).toContain(`title="Message mode: ${label}"`);
    expect(markup).not.toContain(`>${label}<`);
  });

  it("disables the trigger while the composer is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ChatModeControl disabled mode="default" onChange={() => {}} />,
    );

    expect(markup).toContain("disabled");
  });
});
