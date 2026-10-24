import type { IBuffer } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  captureTerminalAnchor,
  resolveTerminalAnchor,
  terminalLogicalLines,
} from "./terminal-view-anchors";

function buffer(
  rows: { text: string; wrapped?: boolean }[],
  cols: number,
): IBuffer {
  return {
    length: rows.length,
    getLine: (y: number) => {
      const row = rows[y];
      if (!row) return undefined;
      const cells = [...row.text].flatMap((char) =>
        char === "界"
          ? [
              { width: 2, char },
              { width: 0, char: "" },
            ]
          : [{ width: 1, char }],
      );
      return {
        length: cols,
        isWrapped: row.wrapped ?? false,
        getCell: (x: number) => {
          const cell = cells[x] ?? { width: 1, char: "" };
          return { getWidth: () => cell.width, getChars: () => cell.char };
        },
      };
    },
  } as unknown as IBuffer;
}
describe("terminal logical anchors", () => {
  it.each(["abcdefgh", "abc界z", "ab界cd界ef", "a\u0301bcdef"])(
    "maps real xterm reflow for %s",
    async (text) => {
      const terminal = new Terminal({ cols: 8, rows: 4 });
      try {
        await new Promise<void>((resolve) =>
          terminal.write(`${text}\r\nnext`, resolve),
        );
        const before = terminalLogicalLines(terminal.buffer.active);
        const anchor = captureTerminalAnchor(before, { x: 5, y: 0 });
        const originalCell = terminal.buffer.active
          .getLine(0)!
          .getCell(5)!
          .getChars();
        terminal.resize(4, 4);
        const after = terminalLogicalLines(terminal.buffer.active);
        expect(after[0]!.text).toBe(before[0]!.text);
        const position = resolveTerminalAnchor(after, anchor);
        expect(position).toEqual({ x: text === "abc界z" ? 2 : 1, y: 1 });
        expect(
          terminal.buffer.active
            .getLine(position.y)!
            .getCell(position.x)!
            .getChars(),
        ).toBe(originalCell);
      } finally {
        terminal.dispose();
      }
    },
  );
  it("uses logical context to distinguish identical rows after scrollback trimming", () => {
    const source = terminalLogicalLines(
      buffer(
        [
          { text: "old" },
          { text: "begin" },
          { text: "repeat" },
          { text: "repeat" },
          { text: "end" },
        ],
        8,
      ),
    );
    const anchor = captureTerminalAnchor(source, { x: 2, y: 3 });
    const destination = terminalLogicalLines(
      buffer(
        [
          { text: "begin" },
          { text: "repeat" },
          { text: "repeat" },
          { text: "end" },
        ],
        8,
      ),
    );
    expect(resolveTerminalAnchor(destination, anchor)).toEqual({ x: 2, y: 2 });
    expect(() =>
      resolveTerminalAnchor(
        terminalLogicalLines(
          buffer([{ text: "begin" }, { text: "repeat" }, { text: "end" }], 8),
        ),
        anchor,
      ),
    ).toThrow(/missing or ambiguous/);
  });
  it("maps a selected position across narrower wrapped rows and trimmed scrollback", () => {
    const source = terminalLogicalLines(
      buffer([{ text: "old" }, { text: "abcdefgh" }], 8),
    );
    const anchor = captureTerminalAnchor(source, { x: 6, y: 1 });
    const destination = terminalLogicalLines(
      buffer([{ text: "abcd" }, { text: "efgh", wrapped: true }], 4),
    );
    expect(resolveTerminalAnchor(destination, anchor)).toEqual({ x: 2, y: 1 });
  });
  it("does not count wide-character wrapping padding as content", () => {
    const source = terminalLogicalLines(
      buffer([{ text: "abc" }, { text: "界z", wrapped: true }], 4),
    );
    const anchor = captureTerminalAnchor(source, { x: 2, y: 1 });
    const destination = terminalLogicalLines(buffer([{ text: "abc界z" }], 8));
    expect(resolveTerminalAnchor(destination, anchor)).toEqual({ x: 5, y: 0 });
  });
  it("rejects missing and ambiguous text rather than choosing unrelated output", () => {
    const source = terminalLogicalLines(buffer([{ text: "same" }], 4));
    const anchor = captureTerminalAnchor(source, { x: 0, y: 0 });
    expect(() =>
      resolveTerminalAnchor(
        terminalLogicalLines(buffer([{ text: "gone" }], 4)),
        anchor,
      ),
    ).toThrow(/missing or ambiguous/);
    expect(() =>
      resolveTerminalAnchor(
        terminalLogicalLines(buffer([{ text: "same" }, { text: "same" }], 4)),
        anchor,
      ),
    ).toThrow(/missing or ambiguous/);
    const repeated = terminalLogicalLines(
      buffer([{ text: "same" }, { text: "same" }], 4),
    );
    const repeatedAnchor = captureTerminalAnchor(repeated, { x: 0, y: 0 });
    expect(() => resolveTerminalAnchor(source, repeatedAnchor)).toThrow(
      /missing or ambiguous/,
    );
  });
});
