import type { GitFileChange } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { buildGitChangeTree } from "./git-change-tree";
import { parseSideBySideDiff } from "./git-diff";

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

  it("aligns replacement, addition, and context lines side by side", () => {
    const rows = parseSideBySideDiff(
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
        oldText: "context",
        newText: "context",
        oldKind: "context",
        newKind: "context",
      },
      {
        kind: "line",
        oldNumber: 11,
        newNumber: 11,
        oldText: "old value",
        newText: "new value",
        oldKind: "delete",
        newKind: "add",
      },
      {
        kind: "line",
        oldNumber: null,
        newNumber: 12,
        oldText: null,
        newText: "another value",
        oldKind: "empty",
        newKind: "add",
      },
      {
        kind: "line",
        oldNumber: 12,
        newNumber: 13,
        oldText: "unchanged",
        newText: "unchanged",
        oldKind: "context",
        newKind: "context",
      },
    ]);
  });

  it("surfaces binary diff metadata", () => {
    expect(
      parseSideBySideDiff("Binary files a/image.png and b/image.png differ\n"),
    ).toEqual([
      {
        kind: "meta",
        text: "Binary files a/image.png and b/image.png differ",
      },
    ]);
  });
});
