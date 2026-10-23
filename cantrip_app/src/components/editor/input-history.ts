import { applyTextChange } from "./document-session";
import { textChange, type TextChange } from "./syntax/document";
import type { EditorSelection } from "./document-session";

interface HistoryEntry {
  change: TextChange;
  inverse: TextChange;
  before: EditorSelection;
  after: EditorSelection;
}

/** Browser-independent history also survives a document's input DOM being retired. */
export class EditorInputHistory {
  private undoEntries: HistoryEntry[] = [];
  private redoEntries: HistoryEntry[] = [];
  record(
    beforeText: string,
    afterText: string,
    before: EditorSelection,
    after: EditorSelection,
  ): void {
    if (beforeText === afterText) return;
    const change = textChange(beforeText, afterText);
    this.undoEntries.push({
      change,
      inverse: {
        from: change.from,
        to: change.from + change.insert.length,
        insert: beforeText.slice(change.from, change.to),
      },
      before,
      after,
    });
    this.redoEntries = [];
  }
  undo(text: string): { text: string; selection: EditorSelection } | null {
    const entry = this.undoEntries.pop();
    if (!entry) return null;
    this.redoEntries.push(entry);
    return {
      text: applyTextChange(text, entry.inverse),
      selection: entry.before,
    };
  }
  redo(text: string): { text: string; selection: EditorSelection } | null {
    const entry = this.redoEntries.pop();
    if (!entry) return null;
    this.undoEntries.push(entry);
    return {
      text: applyTextChange(text, entry.change),
      selection: entry.after,
    };
  }
  clear(): void {
    this.undoEntries = [];
    this.redoEntries = [];
  }
}

export function indentationChange(
  text: string,
  start: number,
  end: number,
  outdent: boolean,
): { change: TextChange; selection: EditorSelection } {
  if (start === end && !outdent)
    return {
      change: { from: start, to: end, insert: "  " },
      selection: { start: start + 2, end: start + 2, direction: "none" },
    };
  const from = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  const selectedEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nextLine = text.indexOf("\n", selectedEnd);
  const to = nextLine < 0 ? text.length : nextLine;
  const lines = text.slice(from, to).split("\n");
  let startDelta = 0,
    endDelta = 0;
  const insert = lines
    .map((line, index) => {
      const removed = outdent
        ? (/^(?:\t| {1,2})/u.exec(line)?.[0].length ?? 0)
        : 0;
      const delta = outdent ? -removed : 2;
      if (index === 0)
        startDelta = outdent ? -Math.min(removed, start - from) : 2;
      endDelta += delta;
      return outdent ? line.slice(removed) : `  ${line}`;
    })
    .join("\n");
  return {
    change: { from, to, insert },
    selection: {
      start: Math.max(from, start + startDelta),
      end: Math.max(from, end + endDelta),
      direction: "none",
    },
  };
}
