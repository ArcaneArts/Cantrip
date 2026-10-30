import { textChange, type HighlightedLine, type TextChange } from "./document";
import { syntaxStateKey, tokenizeLine } from "./tokenizer";
import type { LanguageCatalog, SyntaxLine, SyntaxToken } from "./types";

const MAX_EDIT_CHARACTERS = 32_768;
const MAX_EDIT_LINES = 128;

/** Retain token positions while a pathological line or cold grammar is handled
 * by the worker. Text is always the current input, never buffered for coloring. */
function projectTokens(line: HighlightedLine, text: string): SyntaxToken[] {
  const change = textChange(line.text, text);
  const delta = change.insert.length - (change.to - change.from);
  const tokens: SyntaxToken[] = [];
  const append = (token: SyntaxToken) => {
    const previous = tokens.at(-1);
    if (previous?.kind === token.kind && previous.to === token.from)
      previous.to = token.to;
    else tokens.push(token);
  };
  for (const token of line.tokens) {
    const to = Math.min(token.to, change.from);
    if (to > token.from) append({ ...token, to });
  }
  if (change.insert.length)
    append({
      from: change.from,
      to: change.from + change.insert.length,
      kind:
        line.tokens.find(
          (token) => token.from <= change.from && token.to >= change.from,
        )?.kind ?? "text",
    });
  for (const token of line.tokens) {
    const from = Math.max(token.from, change.to);
    if (token.to > from)
      append({ ...token, from: from + delta, to: token.to + delta });
  }
  return tokens;
}

export function sameTokens(left: SyntaxToken[], right: SyntaxToken[]): boolean {
  return (
    left.length === right.length &&
    left.every((token, i) => {
      const other = right[i]!;
      return (
        token.from === other.from &&
        token.to === other.to &&
        token.kind === other.kind
      );
    })
  );
}

/** The worker owns full-document lexing. Its checkpoints let a keystroke recolor
 * only the edited lines until lexical state converges, without a round trip or
 * scanning an unseen prefix on the UI thread. */
export class SyntaxPaintCache {
  lines = new Map<number, HighlightedLine>();
  change: TextChange | null = null;
  previousText: string;
  constructor(
    public text: string,
    public revision: number,
  ) {
    this.previousText = text;
  }

  edit(text: string, revision: number, catalog: LanguageCatalog | null): void {
    if (text === this.text) {
      this.revision = revision;
      return;
    }
    this.previousText = this.text;
    const change = textChange(this.text, text);
    this.change = change;
    const delta = change.insert.length - (change.to - change.from);
    const lineDelta =
      change.insert.split("\n").length -
      this.text.slice(change.from, change.to).split("\n").length;
    const old = this.lines;
    this.lines = new Map();
    let anchor: HighlightedLine | undefined;
    for (const line of old.values()) {
      if (line.from === undefined) continue;
      if (
        line.from <= change.from &&
        line.from + line.text.length >= change.from
      )
        anchor = line;
      if (line.from + line.text.length < change.from)
        this.lines.set(line.number, line);
      else if (line.from > change.to) {
        const shifted =
          delta === 0 && lineDelta === 0
            ? line
            : {
                ...line,
                number: line.number + lineDelta,
                from: line.from + delta,
              };
        this.lines.set(shifted.number, shifted);
      }
    }
    this.text = text;
    this.revision = revision;
    if (!anchor?.state || anchor.from === undefined) return;
    let from = anchor.from;
    let number = anchor.number;
    let state = anchor.state;
    let characters = 0;
    for (
      let count = 0;
      count < MAX_EDIT_LINES && from <= text.length;
      count++
    ) {
      const newline = text.indexOf("\n", from);
      const lineText = text.slice(from, newline < 0 ? text.length : newline);
      const cached = this.lines.get(number);
      if (
        cached?.text === lineText &&
        cached.state &&
        syntaxStateKey(cached.state) === syntaxStateKey(state)
      )
        break;
      characters += lineText.length;
      let result: SyntaxLine | undefined;
      if (catalog && characters <= MAX_EDIT_CHARACTERS) {
        try {
          result = tokenizeLine(lineText, state, catalog);
        } catch {
          // Tokenization must never prevent a native edit from being painted.
        }
      }
      if (!result) {
        // Preserve the edited line's paint even when the background task is slow.
        if (count === 0)
          this.lines.set(number, {
            number,
            from,
            text: lineText,
            state,
            tokens: projectTokens(anchor, lineText),
          });
        break;
      }
      this.lines.set(number, {
        number,
        from,
        text: lineText,
        state,
        tokens: result.tokens,
      });
      state = result.state;
      if (newline < 0) break;
      from = newline + 1;
      number++;
      // Do not tokenize arbitrary offscreen text merely because no checkpoint
      // is cached there. The next viewport is the worker's responsibility.
      if (
        from > change.from + change.insert.length &&
        !this.lines.has(number) &&
        !old.has(number - lineDelta)
      )
        break;
    }
  }
}
