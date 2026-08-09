export type SideBySideDiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string }
  | {
      kind: "line";
      oldNumber: number | null;
      newNumber: number | null;
      oldText: string | null;
      newText: string | null;
      oldKind: "context" | "delete" | "empty";
      newKind: "context" | "add" | "empty";
    };

export function parseSideBySideDiff(patch: string): SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  let deletes: string[] = [];
  let additions: string[] = [];

  const flushChanges = () => {
    const count = Math.max(deletes.length, additions.length);
    for (let index = 0; index < count; index += 1) {
      const oldText = deletes[index] ?? null;
      const newText = additions[index] ?? null;
      rows.push({
        kind: "line",
        oldNumber: oldText === null ? null : oldNumber++,
        newNumber: newText === null ? null : newNumber++,
        oldText,
        newText,
        oldKind: oldText === null ? "empty" : "delete",
        newKind: newText === null ? "empty" : "add",
      });
    }
    deletes = [];
    additions = [];
  };

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      flushChanges();
      oldNumber = Number.parseInt(hunk[1]!, 10);
      newNumber = Number.parseInt(hunk[2]!, 10);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) {
      deletes.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      additions.push(line.slice(1));
      continue;
    }
    flushChanges();
    if (line.startsWith(" ")) {
      rows.push({
        kind: "line",
        oldNumber: oldNumber++,
        newNumber: newNumber++,
        oldText: line.slice(1),
        newText: line.slice(1),
        oldKind: "context",
        newKind: "context",
      });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line });
    }
  }
  flushChanges();

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
