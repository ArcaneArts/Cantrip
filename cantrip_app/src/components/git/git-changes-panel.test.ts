import type { GitFileChange } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { buildGitChangeTree } from "./git-change-tree";
import { parseSideBySideDiff } from "./git-diff";
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
