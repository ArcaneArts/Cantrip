export type UnifiedDiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string }
  | {
      kind: "line";
      oldNumber: number | null;
      newNumber: number | null;
      text: string;
      lineKind: "context" | "delete" | "add";
    };

export function parseUnifiedDiff(patch: string): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      oldNumber = Number.parseInt(hunk[1]!, 10);
      newNumber = Number.parseInt(hunk[2]!, 10);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) {
      rows.push({
        kind: "line",
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
        oldNumber: oldNumber++,
        newNumber: newNumber++,
        text: line.slice(1),
        lineKind: "context",
      });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line });
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
      .map((text) => ({ kind: "meta" as const, text }));
  }
  return rows;
}
