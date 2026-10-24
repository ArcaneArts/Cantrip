import type { IBuffer } from "@xterm/xterm";

export interface TerminalViewAnchor {
  text: string;
  offset: number;
  occurrences?: number;
  before?: { text: string; distance: number };
  after?: { text: string; distance: number };
}

interface LogicalLine {
  text: string;
  rows: { y: number; offset: number; width: number }[];
}

/** Cell widths, not JS string lengths: emoji and combining marks are not columns. */
export function terminalLogicalLines(buffer: IBuffer): LogicalLine[] {
  const result: LogicalLine[] = [];
  let cells: [number, string][] = [];
  let rows: LogicalLine["rows"] = [];
  let offset = 0;
  const finish = () => {
    if (!rows.length) return;
    // Unwritten trailing cells are screen padding, not logical line content.
    while (cells.length && cells.at(-1)![1] === "") cells.pop();
    result.push({ text: JSON.stringify(cells), rows });
    cells = [];
    rows = [];
    offset = 0;
  };
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) throw new Error("Terminal buffer changed during view capture.");
    if (!line.isWrapped) finish();
    const next = buffer.getLine(y + 1);
    let width = line.length;
    // A wide glyph moved to the next wrapped row leaves one unused cell.
    const last = line.getCell(width - 1);
    if (
      next?.isWrapped &&
      next.getCell(0)?.getWidth() === 2 &&
      last?.getWidth() === 1 &&
      last.getChars() === ""
    )
      width--;
    rows.push({ y, offset, width });
    for (let x = 0; x < width; x++) {
      const cell = line.getCell(x);
      if (!cell)
        throw new Error("Terminal cell disappeared during view capture.");
      if (cell.getWidth() > 0) cells.push([cell.getWidth(), cell.getChars()]);
    }
    offset += width;
  }
  finish();
  return result;
}

export function captureTerminalAnchor(
  lines: LogicalLine[],
  position: { x: number; y: number },
): TerminalViewAnchor {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const row = line.rows.find((row) => row.y === position.y);
    if (row) {
      // Find context outside a run of identical lines. Distance distinguishes
      // individual rows within that run without relying on physical row counts.
      const context = (direction: number) => {
        for (
          let i = index + direction;
          i >= 0 && i < lines.length;
          i += direction
        ) {
          if (lines[i]!.text !== line.text)
            return { text: lines[i]!.text, distance: Math.abs(i - index) };
        }
        return undefined;
      };
      const occurrences = lines.filter(
        (candidate) => candidate.text === line.text,
      ).length;
      const repeated = occurrences > 1;
      const before = repeated ? context(-1) : undefined;
      const after = repeated ? context(1) : undefined;
      return {
        text: line.text,
        offset: row.offset + Math.min(position.x, row.width),
        occurrences,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      };
    }
  }
  throw new Error("Terminal view position is outside its buffer.");
}

export function resolveTerminalAnchor(
  lines: LogicalLine[],
  anchor: TerminalViewAnchor,
): { x: number; y: number } {
  // Trimming an indistinguishable repeated source down to one line does not
  // establish that the surviving line was the selected one.
  if ((anchor.occurrences ?? 1) > 1 && !anchor.before && !anchor.after)
    throw new Error(
      "Terminal view text is missing or ambiguous after hydration.",
    );
  const matches = lines.filter(
    (line, index) =>
      line.text === anchor.text &&
      (!anchor.before ||
        lines[index - anchor.before.distance]?.text === anchor.before.text) &&
      (!anchor.after ||
        lines[index + anchor.after.distance]?.text === anchor.after.text),
  );
  if (matches.length !== 1)
    throw new Error(
      "Terminal view text is missing or ambiguous after hydration.",
    );
  const rows = matches[0]!.rows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const x = anchor.offset - row.offset;
    if (x >= 0 && (x < row.width || (i === rows.length - 1 && x === row.width)))
      return { x, y: row.y };
  }
  throw new Error("Terminal view position no longer fits its logical line.");
}
