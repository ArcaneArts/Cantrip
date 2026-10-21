import { spliceLines, textChange } from "./syntax/document";

export const EDITOR_LINE_HEIGHT = 24;
export const EDITOR_VERTICAL_PADDING = 12;
export const EDITOR_OVERSCAN = 8;

/** Maintain line starts without splitting every line again for each keystroke. */
export class EditorLineIndex {
  text: string;
  lines: string[];
  offsets: number[] = [];
  constructor(text: string) {
    this.text = text;
    this.lines = text.split("\n");
    this.reindex(0);
  }
  private reindex(from: number): void {
    this.offsets.length = this.lines.length;
    for (let i = from; i < this.lines.length; i++)
      this.offsets[i] =
        i === 0 ? 0 : this.offsets[i - 1]! + this.lines[i - 1]!.length + 1;
  }
  private lineAt(offset: number): number {
    let low = 0,
      high = this.offsets.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.offsets[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }
  update(text: string): void {
    if (this.text === text) return;
    const change = textChange(this.text, text);
    const first = this.lineAt(change.from),
      last = this.lineAt(change.to);
    const insert =
      this.lines[first]!.slice(0, change.from - this.offsets[first]!) +
      change.insert +
      this.lines[last]!.slice(change.to - this.offsets[last]!);
    spliceLines(this.lines, first, last - first + 1, insert.split("\n"));
    this.text = text;
    this.reindex(first);
  }
}

export function editorViewport(
  scrollTop: number,
  height: number,
  lineCount: number,
): { first: number; last: number } {
  const first = Math.max(
    0,
    Math.floor((scrollTop - EDITOR_VERTICAL_PADDING) / EDITOR_LINE_HEIGHT) -
      EDITOR_OVERSCAN,
  );
  return {
    first,
    last: Math.min(
      lineCount,
      first +
        Math.ceil(Math.max(0, height) / EDITOR_LINE_HEIGHT) +
        EDITOR_OVERSCAN * 2 +
        1,
    ),
  };
}
