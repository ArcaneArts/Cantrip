export type DiffLineKind = "context" | "delete" | "add";

export interface DiffWordSegment {
  changed: boolean;
  text: string;
}

export type UnifiedDiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string }
  | {
      kind: "line";
      oldNumber: number | null;
      newNumber: number | null;
      text: string;
      lineKind: DiffLineKind;
    };

export interface RichDiffLine {
  kind: "line";
  hunkIndex: number;
  lineIndex: number;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
  lineKind: DiffLineKind;
  wordSegments?: DiffWordSegment[];
}

export type RichDiffRow =
  | {
      kind: "hunk";
      hunkIndex: number;
      newCount: number;
      newStart: number;
      oldCount: number;
      oldStart: number;
      text: string;
    }
  | {
      kind: "gap";
      key: string;
      newCount: number;
      oldCount: number;
    }
  | {
      kind: "meta";
      hunkIndex: number | null;
      lineIndex: number | null;
      text: string;
    }
  | RichDiffLine;

export type SplitDiffRow =
  | Extract<RichDiffRow, { kind: "hunk" | "gap" | "meta" }>
  | { kind: "pair"; left: RichDiffLine | null; right: RichDiffLine | null };

interface ParsedHunkHeader {
  newCount: number;
  newStart: number;
  oldCount: number;
  oldStart: number;
}

function parseHunkHeader(line: string): ParsedHunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1]!, 10),
    oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3]!, 10),
    newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
  };
}

function wordTokens(value: string): string[] {
  return value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? [];
}

export function wordDiffSegments(
  before: string,
  after: string,
): { before: DiffWordSegment[]; after: DiffWordSegment[] } {
  const left = wordTokens(before);
  const right = wordTokens(after);
  if (
    left.length > 2_000 ||
    right.length > 2_000 ||
    left.length * right.length > 40_000
  ) {
    return {
      before: [{ changed: true, text: before }],
      after: [{ changed: true, text: after }],
    };
  }
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex]![rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? table[leftIndex + 1]![rightIndex + 1]! + 1
          : Math.max(
              table[leftIndex + 1]![rightIndex]!,
              table[leftIndex]![rightIndex + 1]!,
            );
    }
  }

  const leftUnchanged = new Set<number>();
  const rightUnchanged = new Set<number>();
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftUnchanged.add(leftIndex);
      rightUnchanged.add(rightIndex);
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      table[leftIndex + 1]![rightIndex]! >= table[leftIndex]![rightIndex + 1]!
    ) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }

  const segments = (tokens: string[], unchanged: ReadonlySet<number>) => {
    const result: DiffWordSegment[] = [];
    tokens.forEach((text, index) => {
      const changed = !unchanged.has(index);
      const previous = result.at(-1);
      if (previous?.changed === changed) previous.text += text;
      else result.push({ changed, text });
    });
    return result;
  };
  return {
    before: segments(left, leftUnchanged),
    after: segments(right, rightUnchanged),
  };
}

function annotateWordChanges(rows: RichDiffRow[]): RichDiffRow[] {
  const result = rows.map((row) => (row.kind === "line" ? { ...row } : row));
  for (let index = 0; index < result.length; index += 1) {
    if (result[index]?.kind !== "line") continue;
    const deleted: RichDiffLine[] = [];
    const added: RichDiffLine[] = [];
    let cursor = index;
    while (
      result[cursor]?.kind === "line" &&
      (result[cursor] as RichDiffLine).lineKind === "delete"
    ) {
      deleted.push(result[cursor] as RichDiffLine);
      cursor += 1;
    }
    while (
      result[cursor]?.kind === "line" &&
      (result[cursor] as RichDiffLine).lineKind === "add"
    ) {
      added.push(result[cursor] as RichDiffLine);
      cursor += 1;
    }
    const paired = Math.min(deleted.length, added.length);
    for (let pair = 0; pair < paired; pair += 1) {
      const words = wordDiffSegments(deleted[pair]!.text, added[pair]!.text);
      deleted[pair]!.wordSegments = words.before;
      added[pair]!.wordSegments = words.after;
    }
    if (cursor > index) index = cursor - 1;
  }
  return result;
}

export function parseRichUnifiedDiff(patch: string): RichDiffRow[] {
  const rows: RichDiffRow[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let hunkIndex = -1;
  let lineIndex = 0;
  let previousOldEnd = 0;
  let previousNewEnd = 0;

  for (const line of patch.split("\n")) {
    const hunk = parseHunkHeader(line);
    if (hunk) {
      hunkIndex += 1;
      lineIndex = 0;
      const oldGap = Math.max(0, hunk.oldStart - previousOldEnd - 1);
      const newGap = Math.max(0, hunk.newStart - previousNewEnd - 1);
      if (oldGap > 0 || newGap > 0) {
        rows.push({
          kind: "gap",
          key: `${hunkIndex}:${previousOldEnd}:${previousNewEnd}`,
          oldCount: oldGap,
          newCount: newGap,
        });
      }
      oldNumber = hunk.oldStart;
      newNumber = hunk.newStart;
      previousOldEnd = hunk.oldStart + hunk.oldCount - 1;
      previousNewEnd = hunk.newStart + hunk.newCount - 1;
      rows.push({ kind: "hunk", hunkIndex, text: line, ...hunk });
      continue;
    }
    if (hunkIndex < 0) continue;
    if (line.startsWith("-")) {
      rows.push({
        kind: "line",
        hunkIndex,
        lineIndex: lineIndex++,
        oldNumber: oldNumber++,
        newNumber: null,
        text: line.slice(1),
        lineKind: "delete",
      });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({
        kind: "line",
        hunkIndex,
        lineIndex: lineIndex++,
        oldNumber: null,
        newNumber: newNumber++,
        text: line.slice(1),
        lineKind: "add",
      });
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({
        kind: "line",
        hunkIndex,
        lineIndex: lineIndex++,
        oldNumber: oldNumber++,
        newNumber: newNumber++,
        text: line.slice(1),
        lineKind: "context",
      });
    } else {
      if (line.startsWith("\\")) {
        rows.push({ kind: "meta", hunkIndex, lineIndex, text: line });
      }
      lineIndex += 1;
    }
  }

  if (rows.length === 0 && patch.trim()) {
    return patch
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("Binary files ") ||
          line === "GIT binary patch" ||
          line.startsWith("literal ") ||
          line.startsWith("delta "),
      )
      .map((text) => ({
        kind: "meta" as const,
        hunkIndex: null,
        lineIndex: null,
        text,
      }));
  }
  return annotateWordChanges(rows);
}

function normalizedWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function hideWhitespaceOnlyChanges(rows: RichDiffRow[]): RichDiffRow[] {
  const result: RichDiffRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind !== "line" || row.lineKind !== "delete") {
      result.push(row);
      continue;
    }
    const deleted: RichDiffLine[] = [];
    const added: RichDiffLine[] = [];
    let cursor = index;
    while (
      rows[cursor]?.kind === "line" &&
      (rows[cursor] as RichDiffLine).lineKind === "delete"
    ) {
      deleted.push(rows[cursor] as RichDiffLine);
      cursor += 1;
    }
    while (
      rows[cursor]?.kind === "line" &&
      (rows[cursor] as RichDiffLine).lineKind === "add"
    ) {
      added.push(rows[cursor] as RichDiffLine);
      cursor += 1;
    }
    const paired = Math.min(deleted.length, added.length);
    for (let pair = 0; pair < paired; pair += 1) {
      const before = deleted[pair]!;
      const after = added[pair]!;
      if (
        normalizedWhitespace(before.text) === normalizedWhitespace(after.text)
      ) {
        result.push({
          ...after,
          oldNumber: before.oldNumber,
          lineKind: "context",
          wordSegments: undefined,
        });
      } else {
        result.push(before, after);
      }
    }
    result.push(...deleted.slice(paired), ...added.slice(paired));
    index = cursor - 1;
  }
  return result;
}

export function buildSplitDiffRows(rows: RichDiffRow[]): SplitDiffRow[] {
  const result: SplitDiffRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind !== "line") {
      result.push(row);
      continue;
    }
    if (row.lineKind === "context") {
      result.push({ kind: "pair", left: row, right: row });
      continue;
    }
    const deleted: RichDiffLine[] = [];
    const added: RichDiffLine[] = [];
    let cursor = index;
    while (
      rows[cursor]?.kind === "line" &&
      (rows[cursor] as RichDiffLine).lineKind === "delete"
    ) {
      deleted.push(rows[cursor] as RichDiffLine);
      cursor += 1;
    }
    while (
      rows[cursor]?.kind === "line" &&
      (rows[cursor] as RichDiffLine).lineKind === "add"
    ) {
      added.push(rows[cursor] as RichDiffLine);
      cursor += 1;
    }
    const count = Math.max(deleted.length, added.length);
    for (let pair = 0; pair < count; pair += 1) {
      result.push({
        kind: "pair",
        left: deleted[pair] ?? null,
        right: added[pair] ?? null,
      });
    }
    index = cursor - 1;
  }
  return result;
}

export function parseUnifiedDiff(patch: string): UnifiedDiffRow[] {
  return parseRichUnifiedDiff(patch)
    .filter((row) => row.kind !== "gap")
    .map((row): UnifiedDiffRow => {
      if (row.kind === "hunk") return { kind: "hunk", text: row.text };
      if (row.kind === "meta") return { kind: "meta", text: row.text };
      return {
        kind: "line",
        oldNumber: row.oldNumber,
        newNumber: row.newNumber,
        text: row.text,
        lineKind: row.lineKind,
      };
    });
}
