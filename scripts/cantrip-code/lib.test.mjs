import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { normalizeGitPath } from "./lib.mjs";

test("normalizes Windows repository paths for Git attribute matching", () => {
  assert.equal(
    normalizeGitPath(
      String.raw`cantrip_code\upstream\src\vs\base\common\arrays.ts`,
      path.win32.sep,
    ),
    "cantrip_code/upstream/src/vs/base/common/arrays.ts",
  );
});

test("preserves slash-delimited repository paths", () => {
  assert.equal(
    normalizeGitPath(
      "cantrip_code/upstream/src/vs/base/common/arrays.ts",
      path.posix.sep,
    ),
    "cantrip_code/upstream/src/vs/base/common/arrays.ts",
  );
});
