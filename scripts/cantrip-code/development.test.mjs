import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("development preparation repairs a missing or stale Code build", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const command = packageJson.scripts?.["dev:prepare"];

  assert.equal(typeof command, "string");
  assert.match(command, /(?:^|&&\s*)pnpm code:build(?:\s*&&|$)/u);
  assert.doesNotMatch(command, /pnpm code:ready/u);
});
