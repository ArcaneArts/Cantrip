import { describe, expect, it } from "vitest";

import {
  terminalChangedSpans,
  terminalContentGlitchCanAnimate,
  terminalRowAlignmentOffset,
  type TerminalViewportSnapshot,
} from "./terminal-content-glitch";

function snapshot(
  lines: readonly string[],
  viewportY = 0,
): TerminalViewportSnapshot {
  const columns = Math.max(...lines.map((line) => line.length));
  return {
    bufferType: "normal",
    columns,
    rows: lines.map((line) =>
      Array.from({ length: columns }, (_, column) => line[column] ?? " "),
    ),
    viewportY,
  };
}

describe("terminal content glitch diffing", () => {
  it("keeps focused terminal output free of cosmetic animation work", () => {
    expect(terminalContentGlitchCanAnimate(true, true)).toBe(false);
    expect(terminalContentGlitchCanAnimate(true, false)).toBe(true);
    expect(terminalContentGlitchCanAnimate(false, false)).toBe(false);
  });

  it("isolates a partial edit on an existing row", () => {
    const before = snapshot(["build 40%", "ready    "]);
    const after = snapshot(["build 41%", "ready    "]);

    expect(terminalChangedSpans(before, after)).toEqual([
      { endColumn: 8, row: 0, startColumn: 7, text: "1" },
    ]);
  });

  it("aligns retained rows during viewport scrolling and glitches only new text", () => {
    const before = snapshot(["first ", "second", "third "], 20);
    const after = snapshot(["second", "third ", "fourth"], 21);

    expect(terminalRowAlignmentOffset(before, after)).toBe(1);
    expect(terminalChangedSpans(before, after)).toEqual([
      { endColumn: 6, row: 2, startColumn: 0, text: "fourth" },
    ]);
  });

  it("uses content alignment when a capped scrollback no longer advances", () => {
    const before = snapshot(["first ", "second", "third "], 10_000);
    const after = snapshot(["second", "third ", "fourth"], 10_000);

    expect(terminalRowAlignmentOffset(before, after)).toBe(1);
    expect(terminalChangedSpans(before, after)).toHaveLength(1);
  });

  it("suppresses writes that scroll farther than a full viewport", () => {
    const before = snapshot(["first", "second", "third"], 10);
    const after = snapshot(["next ", "page  ", "only  "], 13);

    expect(terminalChangedSpans(before, after)).toEqual([]);
  });
});
