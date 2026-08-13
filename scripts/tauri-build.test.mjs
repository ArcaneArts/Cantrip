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

const version = { major: 1, minor: 1, patch: 314, version: "1.1.314" };

test("prefers an explicit macOS build number", () => {
  assert.equal(
    resolveMacBundleVersion({
      environment: {
        CANTRIP_APP_BUILD_VERSION: "42.3",
      },
      version,
    }),
    "42.3",
  );
});

test("uses the Git commit count for local macOS builds", () => {
  assert.equal(
    resolveMacBundleVersion({
      environment: {},
      version,
    }),
    "314",
  );
});

test("rejects invalid macOS bundle versions", () => {
  assert.throws(
    () =>
      resolveMacBundleVersion({
        environment: { CANTRIP_APP_BUILD_VERSION: "0.0.0-dev" },
        version,
      }),
    /one to three period-separated integers/,
  );
});

test("embeds the official version in every Tauri build", () => {
  assert.deepEqual(
    tauriBuildArguments({
      platform: "darwin",
      environment: {},
      version,
      extraArguments: ["--debug"],
    }),
    [
      "exec",
      "tauri",
      "build",
      "--config",
      JSON.stringify({
        version: "1.1.314",
        bundle: { macOS: { bundleVersion: "314" } },
      }),
      "--debug",
    ],
  );
  assert.deepEqual(tauriBuildArguments({ platform: "linux", version }), [
    "exec",
    "tauri",
    "build",
    "--config",
    JSON.stringify({ version: "1.1.314" }),
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
