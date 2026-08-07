import { describe, expect, it } from "vitest";

import { changedFiles } from "../src/codex/app-server.js";

describe("changedFiles", () => {
  it("summarizes added, updated, and deleted files from a turn diff", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
    ].join("\n");

    expect(changedFiles(diff)).toEqual([
      { path: "README.md", kind: "update" },
      { path: "src/new.ts", kind: "add" },
      { path: "old.ts", kind: "delete" },
    ]);
  });
});
