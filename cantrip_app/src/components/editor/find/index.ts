export interface FindMatch {
  from: number;
  to: number;
}
export interface FindResult {
  requestId: number;
  count: number;
  index: number;
  match: FindMatch | null;
}
export interface FindResponse extends FindResult {
  action: "search" | "move";
}
export type FindRequest =
  | {
      type: "search";
      requestId: number;
      text: string;
      query: string;
      anchor: number;
    }
  | { type: "move"; requestId: number; direction: number };

const STRIDE = 256;
/** Literal, Unicode-aware case-insensitive matching with sparse checkpoints.
 * Even a file with millions of matches retains only one offset per 256 hits. */
export class FindIndex {
  readonly count: number;
  index: number;
  private readonly expression: RegExp | null;
  private readonly checkpoints: number[] = [];
  constructor(
    private readonly text: string,
    query: string,
    anchor = 0,
  ) {
    this.expression = query
      ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
      : null;
    let count = 0,
      nearest = -1,
      match: RegExpExecArray | null;
    while (this.expression && (match = this.expression.exec(text))) {
      if (count % STRIDE === 0) this.checkpoints.push(match.index);
      if (nearest < 0 && match.index >= anchor) nearest = count;
      count++;
    }
    this.count = count;
    this.index = count ? Math.max(0, nearest) : -1;
  }
  current(): FindMatch | null {
    if (!this.expression || this.index < 0) return null;
    const block = Math.floor(this.index / STRIDE);
    this.expression.lastIndex = this.checkpoints[block]!;
    let match: RegExpExecArray | null = null;
    for (let i = block * STRIDE; i <= this.index; i++)
      match = this.expression.exec(this.text);
    return match
      ? { from: match.index, to: match.index + match[0].length }
      : null;
  }
  move(direction: number): void {
    if (this.count)
      this.index =
        (((this.index + direction) % this.count) + this.count) % this.count;
  }
  result(requestId: number): FindResult {
    return {
      requestId,
      count: this.count,
      index: this.index,
      match: this.current(),
    };
  }
}
