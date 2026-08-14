import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSpecUrl = new URL("../.do/app.yaml", import.meta.url);

test("App Platform static sites use browser-only build commands", async () => {
  const spec = await readFile(appSpecUrl, "utf8");

  assert.match(
    spec,
    /^\s{4}build_command: pnpm --filter @cantrip\/protocol build && pnpm --filter @cantrip\/app build$/mu,
  );
  assert.match(
    spec,
    /^\s{4}build_command: pnpm --filter @cantrip\/site build$/mu,
  );
  assert.doesNotMatch(spec, /^\s{4}build_command: pnpm (?:run )?build$/mu);
});
