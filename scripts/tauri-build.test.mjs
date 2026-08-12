import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveMacBundleVersion,
  tauriBuildArguments,
} from "./tauri-build.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("prefers explicit and CI macOS build versions", () => {
  assert.equal(
    resolveMacBundleVersion({
      environment: {
        CANTRIP_APP_BUILD_VERSION: "42.3",
        GITHUB_RUN_NUMBER: "17",
      },
    }),
    "42.3",
  );
  assert.equal(
    resolveMacBundleVersion({ environment: { GITHUB_RUN_NUMBER: "17" } }),
    "17",
  );
});

test("uses the Git commit count for local macOS builds", () => {
  assert.equal(
    resolveMacBundleVersion({
      environment: {},
      readGitCommitCount: () => "314",
    }),
    "314",
  );
});

test("rejects invalid macOS bundle versions", () => {
  assert.throws(
    () =>
      resolveMacBundleVersion({
        environment: { CANTRIP_APP_BUILD_VERSION: "0.0.0-dev" },
      }),
    /one to three period-separated integers/,
  );
});

test("adds the macOS bundle version without changing other platforms", () => {
  assert.deepEqual(
    tauriBuildArguments({
      platform: "darwin",
      environment: { GITHUB_RUN_NUMBER: "29" },
      extraArguments: ["--debug"],
    }),
    [
      "exec",
      "tauri",
      "build",
      "--config",
      JSON.stringify({ bundle: { macOS: { bundleVersion: "29" } } }),
      "--debug",
    ],
  );
  assert.deepEqual(tauriBuildArguments({ platform: "linux" }), [
    "exec",
    "tauri",
    "build",
  ]);
});

test("the app build command uses the version-stamping wrapper", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(rootDir, "cantrip_app", "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["tauri:build"],
    "node ../scripts/tauri-build.mjs",
  );
});
