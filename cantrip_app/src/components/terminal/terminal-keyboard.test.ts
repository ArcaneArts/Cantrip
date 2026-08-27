import { describe, expect, it } from "vitest";

import { isTerminalClearShortcut } from "./terminal-keyboard";

const commandK = {
  altKey: false,
  ctrlKey: false,
  key: "k",
  metaKey: true,
  shiftKey: false,
  type: "keydown",
};

describe("terminal keyboard shortcuts", () => {
  it("clears an ordinary terminal with Command-K", () => {
    expect(isTerminalClearShortcut(commandK, null)).toBe(true);
  });

  it("leaves Command-K untouched in a chat-linked Codex console", () => {
    expect(isTerminalClearShortcut(commandK, "chat-1")).toBe(false);
  });

  it("does not claim modified, control, or keyup variants", () => {
    expect(isTerminalClearShortcut({ ...commandK, shiftKey: true }, null)).toBe(
      false,
    );
    expect(
      isTerminalClearShortcut(
        { ...commandK, ctrlKey: true, metaKey: false },
        null,
      ),
    ).toBe(false);
    expect(isTerminalClearShortcut({ ...commandK, type: "keyup" }, null)).toBe(
      false,
    );
  });
});
