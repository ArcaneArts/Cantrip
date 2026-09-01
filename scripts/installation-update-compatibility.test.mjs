import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  runBrowserStorageLossRecoveryHarness,
  runUpdateCompatibilityHarness,
  updateCompatibilityPlatforms,
  validateCompatibilityManifest,
  verifyRepositoryCompatibilityContracts,
} from "./installation-update-compatibility.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(
  root,
  "scripts",
  "installation-compatibility.v1.json",
);

async function manifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

test("repository implementations match the immutable installation compatibility contract", async () => {
  const result = await verifyRepositoryCompatibilityContracts({ root });
  assert.deepEqual(result.changes, []);
});

test("browser storage loss recovers server identity and encrypted domain data", async () => {
  const { contract } = validateCompatibilityManifest(await manifest(), {
    root,
  });
  await assert.doesNotReject(
    runBrowserStorageLossRecoveryHarness({ contract }),
  );
});

test("contract changes require an explicit migration and deterministic fixture", async () => {
  const changed = await manifest();
  changed.current.application.bundleIdentifier = "art.cantrip.next";
  assert.throws(
    () => validateCompatibilityManifest(changed, { root }),
    /changed without an explicit compatibility migration/u,
  );
});

test("the version-one baseline cannot be rewritten", async () => {
  const changed = await manifest();
  changed.baseline.installationCatalog.relativePath =
    "installation/v2/catalog.sqlite3";
  changed.current.installationCatalog.relativePath =
    "installation/v2/catalog.sqlite3";
  assert.throws(
    () => validateCompatibilityManifest(changed, { root }),
    /version-one baseline is immutable/u,
  );
});

test("version N state opens in place after every supported version N+1 harness", async () => {
  const { contract } = validateCompatibilityManifest(await manifest(), {
    root,
  });
  const results = [];
  for (const platform of updateCompatibilityPlatforms) {
    results.push(await runUpdateCompatibilityHarness({ contract, platform }));
  }
  assert.deepEqual(
    results,
    updateCompatibilityPlatforms.map((platform) => ({
      platform,
      status: "passed",
    })),
  );
});
