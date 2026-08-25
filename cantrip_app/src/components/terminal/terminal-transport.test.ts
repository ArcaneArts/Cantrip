import { describe, expect, it } from "vitest";

import { shouldStartDirectTerminalTransport } from "./terminal-transport";

describe("terminal transport selection", () => {
  it("keeps reconnects on relay after direct transport fails", () => {
    expect(shouldStartDirectTerminalTransport("terminal-1", null)).toBe(true);
    expect(shouldStartDirectTerminalTransport("terminal-1", "terminal-1")).toBe(
      false,
    );
  });

  it("tries direct transport for a different terminal", () => {
    expect(shouldStartDirectTerminalTransport("terminal-2", "terminal-1")).toBe(
      true,
    );
  });
});
