import type { ExplorerEntry, GitStatus } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { explorerEntryChange } from "./explorer-entry-metadata";

const status = {
  files: [
    {
      path: "src/changed.ts",
      originalPath: null,
      indexStatus: " ",
      worktreeStatus: "M",
      staged: false,
      unstaged: true,
    },
    {
      path: "src/new.ts",
      originalPath: null,
      indexStatus: "?",
      worktreeStatus: "?",
      staged: false,
      unstaged: true,
    },
    {
      path: "sibling.ts",
      originalPath: null,
      indexStatus: " ",
      worktreeStatus: "M",
      staged: false,
      unstaged: true,
    },
  ],
} as GitStatus;

function entry(path: string, kind: ExplorerEntry["kind"]): ExplorerEntry {
  return { path, kind } as ExplorerEntry;
}

describe("Explorer Git change metadata", () => {
  it("uses exact file matches", () => {
    expect(
      explorerEntryChange(entry("src/changed.ts", "file"), status),
    ).toEqual({
      code: "M",
      count: 1,
      kind: "modified",
      label: "Modified locally",
    });
    expect(explorerEntryChange(entry("changed.ts", "file"), status)).toBeNull();
  });

  it("aggregates descendant changes for a directory", () => {
    expect(explorerEntryChange(entry("src", "directory"), status)).toEqual({
      code: "2",
      count: 2,
      kind: "untracked",
      label: "2 local changes",
    });
  });
});
