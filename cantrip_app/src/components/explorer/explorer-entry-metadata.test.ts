import type {
  ExplorerEntry,
  ExplorerLastCommit,
  GitStatus,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildExplorerChangeIndex,
  explorerCommitMetadata,
  formatExplorerSize,
  formatExplorerRelativeDate,
  sortExplorerEntries,
} from "./explorer-entry-metadata";

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
  it("sorts a copy with directories first and numeric file names", () => {
    const entries = [
      { name: "file10.ts", path: "file10.ts", kind: "file" },
      { name: "folder", path: "folder", kind: "directory" },
      { name: "file2.ts", path: "file2.ts", kind: "file" },
      { name: "socket", path: "socket", kind: "other" },
    ] as ExplorerEntry[];
    expect(sortExplorerEntries(entries).map(({ name }) => name)).toEqual([
      "folder",
      "file2.ts",
      "file10.ts",
      "socket",
    ]);
    expect(entries[0]?.name).toBe("file10.ts");
  });

  it("uses exact file matches", () => {
    const changes = buildExplorerChangeIndex(status);
    expect(changes.get(entry("src/changed.ts", "file").path)).toEqual({
      code: "M",
      count: 1,
      kind: "modified",
      label: "Modified locally",
    });
    expect(changes.get(entry("changed.ts", "file").path)).toBeUndefined();
  });

  it("aggregates descendant changes for a directory", () => {
    const changes = buildExplorerChangeIndex(status);
    expect(changes.get(entry("src", "directory").path)).toEqual({
      code: "2",
      count: 2,
      kind: "untracked",
      label: "2 local changes",
    });
    expect(changes.get("src/changed.ts")).toEqual({
      code: "M",
      count: 1,
      kind: "modified",
      label: "Modified locally",
    });
  });

  it("formats file sizes across responsive rows", () => {
    expect(formatExplorerSize(12)).toBe("12 B");
    expect(formatExplorerSize(1_536)).toBe("1.5 KB");
    expect(formatExplorerSize(1_572_864)).toBe("1.5 MB");
  });

  it("prepares wide, compact, and tooltip commit metadata", () => {
    const commit = {
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      subject: "Refine Explorer tree",
      authorName: "Cantrip Test",
      authorEmail: "cantrip@example.com",
      authoredAt: "2026-08-10T12:00:00.000Z",
    } satisfies ExplorerLastCommit;
    const now = new Date("2026-08-12T12:00:00.000Z").getTime();
    const metadata = explorerCommitMetadata(commit, now);
    expect(metadata).toMatchObject({
      age: formatExplorerRelativeDate(commit.authoredAt, now),
      subject: commit.subject,
    });
    expect(metadata.compactLabel).toBe(`${metadata.subject} · ${metadata.age}`);
    expect(metadata.tooltip).toContain(commit.hash);
    expect(metadata.tooltip).toContain("Cantrip Test <cantrip@example.com>");
  });
});
