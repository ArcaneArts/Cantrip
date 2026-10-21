import { describe, expect, it } from "vitest";
import { visibleFileChanges } from "./file-change-activity";

describe("visible file activity", () => {
  const visible = new Set([
    "",
    "src",
    "src/open",
    "src/open/app.ts",
    "src/closed",
    "README.md",
  ]);
  it("uses the changed file or its closest visible folder", () => {
    expect([
      ...visibleFileChanges(
        [
          { path: "src/open/app.ts", kind: "modified" },
          { path: "src/closed/deep/new.ts", kind: "added" },
        ],
        visible,
      ),
    ]).toEqual([
      ["src/open/app.ts", "modified"],
      ["src/closed", "added"],
    ]);
  });
  it("coalesces a multi-file commit into one pulse per visible folder", () => {
    expect([
      ...visibleFileChanges(
        [
          { path: "src/closed/a.ts", kind: "added" },
          { path: "src/closed/b.ts", kind: "added" },
          { path: "src/open/old.ts", kind: "deleted" },
          { path: "src/open/new.ts", kind: "added" },
        ],
        visible,
      ),
    ]).toEqual([
      ["src/closed", "added"],
      ["src/open", "modified"],
    ]);
  });
  it("shows deletion on the nearest surviving ancestor, including Files at the root", () => {
    expect([
      ...visibleFileChanges(
        [
          { path: "src/open/app.ts", kind: "deleted" },
          { path: "src/open", kind: "deleted" },
          { path: "README.md", kind: "deleted" },
        ],
        visible,
      ),
    ]).toEqual([
      ["src", "deleted"],
      ["", "deleted"],
    ]);
  });
  it("ignores metadata and traversal paths", () => {
    expect(
      visibleFileChanges(
        [
          { path: ".git/index", kind: "modified" },
          { path: "../other", kind: "added" },
        ],
        visible,
      ).size,
    ).toBe(0);
  });
});
