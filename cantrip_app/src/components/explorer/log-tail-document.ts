import type {
  ExplorerLogTail,
  LogTailCursor,
} from "@cantrip/protocol/surface-stream";
import { EditorDocumentSession } from "@/components/editor/document-session";

const RETAINED_CHARACTERS = 256 * 1024;
const RETAINED_LINES = 10_000;
/** Read-only rolling output; never registered in editable document stores. */
export class LogTailDocument {
  readonly session: EditorDocumentSession;
  cursor: LogTailCursor | undefined;
  loaded = false;
  private trailingCR = false;
  constructor(readonly path: string) {
    this.session = new EditorDocumentSession(`log-tail:${path}`, "", "");
  }
  accept(result: ExplorerLogTail): boolean {
    if (
      result.path !== this.path ||
      result.startOffset > result.cursor.offset ||
      result.cursor.offset > result.size ||
      new TextEncoder().encode(result.content).length !==
        result.cursor.offset - result.startOffset ||
      (!result.reset &&
        (!this.cursor ||
          result.startOffset !== this.cursor.offset ||
          result.cursor.identity !== this.cursor.identity))
    )
      throw new Error("The log returned an unrelated tail result.");
    if (this.loaded && !result.reset && result.content.length === 0) {
      this.cursor = result.cursor;
      return false;
    }
    let content = result.content;
    if (result.startOffset === 0 && content.startsWith("\ufeff"))
      content = content.slice(1);
    if (!result.reset && this.trailingCR && content.startsWith("\n"))
      content = content.slice(1);
    if (result.content.length) this.trailingCR = result.content.endsWith("\r");
    else if (result.reset) this.trailingCR = false;
    let text =
      (result.reset ? "" : this.session.text) + content.replace(/\r\n?/g, "\n");
    let start = Math.max(0, text.length - RETAINED_CHARACTERS);
    // Bound retention without splitting the entire log into arrays each poll.
    let line = text.endsWith("\n") ? text.length - 2 : text.length - 1;
    for (let count = 0; count < RETAINED_LINES; count++) {
      line = text.lastIndexOf("\n", line);
      if (line < 0) break;
      if (count === RETAINED_LINES - 1) start = Math.max(start, line + 1);
      line--;
    }
    if (start > 0 && text[start - 1] !== "\n") {
      const newline = text.indexOf("\n", start);
      if (newline >= 0 && newline < text.length - 1) start = newline + 1;
      else if (
        text.charCodeAt(start) >= 0xdc00 &&
        text.charCodeAt(start) <= 0xdfff
      )
        start++;
    }
    text = text.slice(start);
    const changed = text !== this.session.text || !this.loaded;
    if (result.reset || start > 0)
      this.session.selection = { start: 0, end: 0, direction: "none" };
    this.session.edit(text);
    this.session.baseline = this.session.text;
    this.cursor = result.cursor;
    this.loaded = true;
    return changed;
  }
}
