import { initialSyntaxState, syntaxStateKey, tokenizeLine } from "./tokenizer";
import type {
  LanguageCatalog,
  LanguageId,
  SyntaxLine,
  SyntaxToken,
  SyntaxState,
} from "./types";

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export function spliceLines<T>(
  lines: T[],
  from: number,
  count: number,
  replacement: T[],
): void {
  lines.splice(from, count);
  for (let offset = 0; offset < replacement.length; offset += 8192)
    lines.splice(from + offset, 0, ...replacement.slice(offset, offset + 8192));
}
export interface HighlightedLine {
  number: number;
  text: string;
  tokens: SyntaxToken[];
  /** Worker checkpoint for immediate, bounded recoloring of a visible edit. */
  from?: number;
  state?: SyntaxState;
}

export function textChange(previous: string, next: string): TextChange {
  let from = 0;
  // Let the engine compare unchanged runs in native code. Walking a megabyte
  // one JS character at a time for history, indexing and highlighting made
  // every keystroke expensive even though only a few characters changed.
  const chunk = 4096;
  const commonLength = Math.min(previous.length, next.length);
  while (
    from + chunk <= commonLength &&
    previous.slice(from, from + chunk) === next.slice(from, from + chunk)
  )
    from += chunk;
  while (
    from < previous.length &&
    from < next.length &&
    previous[from] === next[from]
  )
    from++;
  let oldEnd = previous.length,
    newEnd = next.length;
  while (
    oldEnd - from >= chunk &&
    newEnd - from >= chunk &&
    previous.slice(oldEnd - chunk, oldEnd) ===
      next.slice(newEnd - chunk, newEnd)
  ) {
    oldEnd -= chunk;
    newEnd -= chunk;
  }
  while (
    oldEnd > from &&
    newEnd > from &&
    previous[oldEnd - 1] === next[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return { from, to: oldEnd, insert: next.slice(from, newEnd) };
}

/** Incremental line cache. Unchanged suffixes retain their lexical checkpoints. */
export class SyntaxDocument {
  readonly lines: string[];
  private offsets: number[] = [];
  private results: (SyntaxLine | undefined)[] = [];
  private dirtyFrom: number | null = 0;
  private dirtyThrough = 0;
  scannedLines = 0;

  constructor(
    text: string,
    readonly language: LanguageId,
    private readonly catalog: LanguageCatalog,
  ) {
    this.lines = text.split("\n");
    this.reindex(0);
  }

  private reindex(from: number): void {
    this.offsets.length = this.lines.length;
    for (let line = from; line < this.lines.length; line++)
      this.offsets[line] =
        line === 0
          ? 0
          : this.offsets[line - 1]! + this.lines[line - 1]!.length + 1;
  }

  private lineAt(offset: number): number {
    let low = 0,
      high = this.offsets.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.offsets[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  apply(change: TextChange): void {
    const first = this.lineAt(change.from),
      last = this.lineAt(change.to);
    const before = this.lines[first]!.slice(
      0,
      change.from - this.offsets[first]!,
    );
    const after = this.lines[last]!.slice(change.to - this.offsets[last]!);
    const replacement = `${before}${change.insert}${after}`.split("\n");
    const removed = last - first + 1;
    spliceLines(this.lines, first, removed, replacement);
    spliceLines(
      this.results,
      first,
      removed,
      Array<SyntaxLine | undefined>(replacement.length).fill(undefined),
    );
    this.dirtyFrom = Math.min(this.dirtyFrom ?? first, first);
    this.dirtyThrough = Math.max(
      first + replacement.length - 1,
      this.dirtyThrough + replacement.length - removed,
    );
    this.reindex(first);
  }

  highlight(first: number, last: number): HighlightedLine[] {
    const end = Math.min(this.lines.length, last);
    if (this.dirtyFrom !== null) {
      let state =
        this.dirtyFrom === 0
          ? initialSyntaxState(this.language)
          : this.results[this.dirtyFrom - 1]!.state;
      for (let index = this.dirtyFrom; index < end; index++) {
        const old = this.results[index];
        const next = tokenizeLine(this.lines[index]!, state, this.catalog);
        this.scannedLines++;
        this.results[index] = next;
        state = next.state;
        this.dirtyFrom = index + 1;
        if (
          index >= this.dirtyThrough &&
          old &&
          syntaxStateKey(old.state) === syntaxStateKey(next.state)
        ) {
          this.dirtyFrom = null;
          break;
        }
      }
      if (this.dirtyFrom === this.lines.length) this.dirtyFrom = null;
    }
    return this.lines.slice(first, end).map((text, offset) => ({
      number: first + offset + 1,
      text,
      tokens: this.results[first + offset]?.tokens ?? [],
      from: this.offsets[first + offset],
      state:
        first + offset === 0
          ? initialSyntaxState(this.language)
          : this.results[first + offset - 1]?.state,
    }));
  }
}
