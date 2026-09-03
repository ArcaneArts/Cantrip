import type { GitFileChange } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { buildGitChangeTree } from "./git-change-tree";
import {
  buildSplitDiffRows,
  hideWhitespaceOnlyChanges,
  parseRichUnifiedDiff,
  parseUnifiedDiff,
  wordDiffSegments,
} from "./git-diff";
import {
  buildPartialPatchRequest,
  partialPatchUnavailableReason,
  parseSelectablePatchHunks,
} from "./git-partial-patch-view";
import { gitChangesPanelContentClassName } from "./git-changes-panel";

function change(path: string): GitFileChange {
  return {
    path,
    originalPath: null,
    indexStatus: " ",
    worktreeStatus: "M",
    staged: false,
    unstaged: true,
  };
}

describe("Git changes panel helpers", () => {
  it("fills the drawer until a selected diff needs a fixed changes column", () => {
    const fullWidth = gitChangesPanelContentClassName(false).split(" ");
    const besideDiff = gitChangesPanelContentClassName(true).split(" ");

    expect(fullWidth).toContain("w-full");
    expect(fullWidth).not.toContain("md:w-96");
    expect(besideDiff).toContain("md:w-96");
    expect(besideDiff).toContain("md:shrink-0");
  });

  it("groups changed files into sorted nested folders", () => {
    expect(
      buildGitChangeTree([
        change("README.md"),
        change("src/lib/zeta.ts"),
        change("src/app.ts"),
        change("src/lib/alpha.ts"),
      ]),
    ).toMatchObject([
      {
        type: "directory",
        name: "src",
        children: [
          {
            type: "directory",
            name: "lib",
            children: [
              { type: "file", name: "alpha.ts" },
              { type: "file", name: "zeta.ts" },
            ],
          },
          { type: "file", name: "app.ts" },
        ],
      },
      { type: "file", name: "README.md" },
    ]);
  });

  it("collapses directory-only chains until files or branches appear", () => {
    expect(
      buildGitChangeTree([
        change("a/b/c/d/e/file1.ts"),
        change("a/b/c/d/ee/file2.ts"),
        change("standalone/path/file3.ts"),
      ]),
    ).toMatchObject([
      {
        type: "directory",
        name: "a/b/c/d",
        path: "a/b/c/d",
        children: [
          {
            type: "directory",
            name: "e",
            children: [{ type: "file", name: "file1.ts" }],
          },
          {
            type: "directory",
            name: "ee",
            children: [{ type: "file", name: "file2.ts" }],
          },
        ],
      },
      {
        type: "directory",
        name: "standalone/path",
        path: "standalone/path",
        children: [{ type: "file", name: "file3.ts" }],
      },
    ]);
  });

  it("renders replacement, addition, and context as unified diff lines", () => {
    const rows = parseUnifiedDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -10,3 +10,4 @@",
        " context",
        "-old value",
        "+new value",
        "+another value",
        " unchanged",
      ].join("\n"),
    );

    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,4 @@" },
      {
        kind: "line",
        oldNumber: 10,
        newNumber: 10,
        text: "context",
        lineKind: "context",
      },
      {
        kind: "line",
        oldNumber: 11,
        newNumber: null,
        text: "old value",
        lineKind: "delete",
      },
      {
        kind: "line",
        oldNumber: null,
        newNumber: 11,
        text: "new value",
        lineKind: "add",
      },
      {
        kind: "line",
        oldNumber: null,
        newNumber: 12,
        text: "another value",
        lineKind: "add",
      },
      {
        kind: "line",
        oldNumber: 12,
        newNumber: 13,
        text: "unchanged",
        lineKind: "context",
      },
    ]);
  });

  it("surfaces binary diff metadata", () => {
    expect(
      parseUnifiedDiff("Binary files a/image.png and b/image.png differ\n"),
    ).toEqual([
      {
        kind: "meta",
        text: "Binary files a/image.png and b/image.png differ",
      },
    ]);
  });

  it("builds rich split rows with expandable gaps and word highlights", () => {
    const rows = parseRichUnifiedDiff(
      [
        "@@ -10,2 +10,2 @@",
        "-const color = 'red';",
        "+const color = 'blue';",
        " unchanged",
      ].join("\n"),
    );

    expect(rows[0]).toMatchObject({ kind: "gap", oldCount: 9, newCount: 9 });
    expect(rows[1]).toMatchObject({ kind: "hunk", hunkIndex: 0 });
    expect(rows[2]).toMatchObject({
      kind: "line",
      lineKind: "delete",
      oldNumber: 10,
    });
    expect(rows[2]).toHaveProperty(
      "wordSegments",
      expect.arrayContaining([{ changed: true, text: "red" }]),
    );
    expect(buildSplitDiffRows(rows)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "pair",
          left: expect.objectContaining({ lineKind: "delete" }),
          right: expect.objectContaining({ lineKind: "add" }),
        }),
      ]),
    );
  });

  it("folds whitespace-only replacements into shared context", () => {
    const rows = parseRichUnifiedDiff(
      ["@@ -1 +1 @@", "-const value = 1;", "+  const   value = 1;  "].join(
        "\n",
      ),
    );
    const filtered = hideWhitespaceOnlyChanges(rows);

    expect(filtered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "line",
          lineKind: "context",
          oldNumber: 1,
          newNumber: 1,
        }),
      ]),
    );
  });

  it("falls back to bounded whole-line word changes for pathological input", () => {
    const before = Array.from({ length: 250 }, () => "before").join(" ");
    const after = Array.from({ length: 250 }, () => "after").join(" ");

    expect(wordDiffSegments(before, after)).toEqual({
      before: [{ changed: true, text: before }],
      after: [{ changed: true, text: after }],
    });
  });

  it("builds bounded whole-hunk and selected-line patch requests", () => {
    const hunks = parseSelectablePatchHunks(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,3 @@",
        " context",
        "-old value",
        "+new value",
        "@@ -8 +8 @@",
        "-second old",
        "+second new",
      ].join("\n"),
    );

    expect(hunks).toHaveLength(2);
    expect(
      buildPartialPatchRequest(
        "stage",
        "src/app.ts",
        hunks,
        new Set(["0:1", "0:2", "1:1"]),
      ),
    ).toEqual({
      operation: "stage",
      path: "src/app.ts",
      hunks: [
        { hunkIndex: 0, lineIndexes: null },
        { hunkIndex: 1, lineIndexes: [1] },
      ],
    });
    expect(
      buildPartialPatchRequest("discard", "src/app.ts", hunks, new Set()),
    ).toBeNull();
    expect(
      partialPatchUnavailableReason({
        truncated: false,
        patch:
          "diff --git a/old b/new\nrename from old\nrename to new\n@@ -1 +1 @@\n-old\n+new\n",
      }),
    ).toMatch(/file-level action/u);
    expect(
      partialPatchUnavailableReason({ patch: "", truncated: true }),
    ).toMatch(/truncated/iu);
  });
});
