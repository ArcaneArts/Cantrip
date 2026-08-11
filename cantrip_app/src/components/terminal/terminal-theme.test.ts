import { describe, expect, it } from "vitest";

import {
  terminalBackground,
  transparentTerminalBackground,
} from "./terminal-theme";

describe("terminalBackground", () => {
  it("keeps the resolved theme background outside Pro Mode", () => {
    expect(terminalBackground("oklch(0.985 0.002 264)", false)).toBe(
      "oklch(0.985 0.002 264)",
    );
  });

  it("uses a transparent canvas in light or dark Pro Mode", () => {
    expect(terminalBackground("oklch(0.985 0.002 264 / 80%)", true)).toBe(
      transparentTerminalBackground,
    );
    expect(terminalBackground("oklch(0 0 0 / 80%)", true)).toBe(
      transparentTerminalBackground,
    );
  });
});
