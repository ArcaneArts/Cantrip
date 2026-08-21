const terminalWebUrlPattern = /https?:\/\/[^\s\u0000-\u001f\u007f<>"']+/giu;
const simpleTrailingPunctuation = new Set([".", ",", ";", ":", "!", "?"]);
const trailingPairs = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

export interface TerminalWebLinkMatch {
  end: number;
  start: number;
  url: string;
}

export interface TerminalWebLinkLine {
  row: number;
  text: string;
}

export interface TerminalWebLinkSegment extends TerminalWebLinkMatch {
  endColumn: number;
  row: number;
  startColumn: number;
}

function occurrences(value: string, character: string): number {
  let count = 0;
  for (const candidate of value) {
    if (candidate === character) count += 1;
  }
  return count;
}

function trimTerminalWebUrl(candidate: string): string {
  let result = candidate;
  while (result) {
    const trailing = result.at(-1)!;
    if (simpleTrailingPunctuation.has(trailing)) {
      result = result.slice(0, -1);
      continue;
    }
    const opening = trailingPairs.get(trailing);
    if (
      opening &&
      occurrences(result, trailing) > occurrences(result, opening)
    ) {
      result = result.slice(0, -1);
      continue;
    }
    break;
  }
  return result;
}

export function findTerminalWebLinks(text: string): TerminalWebLinkMatch[] {
  const matches: TerminalWebLinkMatch[] = [];
  terminalWebUrlPattern.lastIndex = 0;
  for (const match of text.matchAll(terminalWebUrlPattern)) {
    const candidate = trimTerminalWebUrl(match[0]);
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    } catch {
      continue;
    }
    const start = match.index;
    matches.push({ end: start + candidate.length, start, url: candidate });
  }
  return matches;
}

export function segmentTerminalWebLinks(
  lines: readonly TerminalWebLinkLine[],
): TerminalWebLinkSegment[] {
  const text = lines.map((line) => line.text).join("");
  const matches = findTerminalWebLinks(text);
  const segments: TerminalWebLinkSegment[] = [];
  let lineStart = 0;
  for (const line of lines) {
    const lineEnd = lineStart + line.text.length;
    for (const match of matches) {
      const start = Math.max(match.start, lineStart);
      const end = Math.min(match.end, lineEnd);
      if (end <= start) continue;
      segments.push({
        ...match,
        endColumn: end - lineStart,
        row: line.row,
        startColumn: start - lineStart,
      });
    }
    lineStart = lineEnd;
  }
  return segments;
}

export function terminalLinkBrowserTitle(value: string): string {
  try {
    return new URL(value).hostname || "Browser";
  } catch {
    return "Browser";
  }
}
