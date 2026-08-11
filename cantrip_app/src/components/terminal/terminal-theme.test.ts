import { describe, expect, it } from "vitest";

import {
  attenuatedTerminalBackgroundColor,
  proModeTerminalCellBackgroundFactor,
  proModeTerminalCellBackgroundOpacity,
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

describe("proModeTerminalCellBackgroundOpacity", () => {
  it("tracks Pro Mode opacity at a softer cell-background strength", () => {
    expect(proModeTerminalCellBackgroundOpacity("80%")).toBeCloseTo(0.52);
    expect(proModeTerminalCellBackgroundOpacity("100%")).toBe(
      proModeTerminalCellBackgroundFactor,
    );
    expect(proModeTerminalCellBackgroundOpacity("20%")).toBeCloseTo(0.13);
  });

  it("clamps invalid settings to a safe range", () => {
    expect(proModeTerminalCellBackgroundOpacity("invalid")).toBeCloseTo(0.52);
    expect(proModeTerminalCellBackgroundOpacity("200%")).toBe(
      proModeTerminalCellBackgroundFactor,
    );
    expect(proModeTerminalCellBackgroundOpacity("-10%")).toBe(0);
  });
});

describe("attenuatedTerminalBackgroundColor", () => {
  it("attenuates only the background alpha", () => {
    expect(attenuatedTerminalBackgroundColor("rgb(31, 31, 31)", 0.52)).toBe(
      "rgba(31, 31, 31, 0.52)",
    );
    expect(
      attenuatedTerminalBackgroundColor("rgba(20, 40, 60, 0.5)", 0.52),
    ).toBe("rgba(20, 40, 60, 0.26)");
  });

  it("ignores transparent and unsupported colors", () => {
    expect(
      attenuatedTerminalBackgroundColor("rgba(20, 40, 60, 0)", 0.52),
    ).toBeNull();
    expect(attenuatedTerminalBackgroundColor("transparent", 0.52)).toBeNull();
  });
});
