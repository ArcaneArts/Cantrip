import { describe, expect, it } from "vitest";

import {
  explorerExpandedPathsForReveal,
  explorerFileEntryForGraphPath,
  explorerGraphRootForEntry,
  explorerRepositoryGraphAvailable,
} from "./explorer-graph-routing";

describe("Explorer graph routing", () => {
  it("only exposes repository graph actions for Git-capable projects", () => {
    expect(explorerRepositoryGraphAvailable({ git: true })).toBe(true);
    expect(explorerRepositoryGraphAvailable({ git: false })).toBe(false);
    expect(explorerRepositoryGraphAvailable(undefined)).toBe(false);
  });

  it("scopes directories to themselves", () => {
    expect(
      explorerGraphRootForEntry({ kind: "directory", path: "src/components" }),
    ).toBe("src/components");
  });

  it("scopes files to their containing directory", () => {
    expect(
      explorerGraphRootForEntry({ kind: "file", path: "src/index.ts" }),
    ).toBe("src");
    expect(
      explorerGraphRootForEntry({ kind: "file", path: "README.md" }),
    ).toBeNull();
  });

  it("expands every ancestor needed to reveal a nested entry", () => {
    expect(
      explorerExpandedPathsForReveal("src/components/editor/file.ts"),
    ).toEqual(["src", "src/components", "src/components/editor"]);
    expect(explorerExpandedPathsForReveal("README.md")).toEqual([]);
  });

  it("turns graph file activation into an ordinary Explorer file entry", () => {
    expect(explorerFileEntryForGraphPath("docs/GOURCE.md")).toMatchObject({
      kind: "file",
      markdown: true,
      name: "GOURCE.md",
      path: "docs/GOURCE.md",
      viewable: true,
    });
  });
});
