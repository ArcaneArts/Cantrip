import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveMacBundleVersion,
  resolveWindowsBundle,
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

test("allows a Windows build to request only the NSIS installer", () => {
  assert.equal(
    resolveWindowsBundle({
      environment: { CANTRIP_WINDOWS_BUNDLE: " NSIS " },
    }),
    "nsis",
  );
  assert.deepEqual(
    tauriBuildArguments({
      platform: "win32",
      environment: { CANTRIP_WINDOWS_BUNDLE: "nsis" },
      version,
    }),
    [
      "exec",
      "tauri",
      "build",
      "--config",
      JSON.stringify({ version: "1.1.314" }),
      "--bundles",
      "nsis",
    ],
  );
});

test("rejects an unknown Windows installer override", () => {
  assert.throws(
    () =>
      resolveWindowsBundle({
        environment: { CANTRIP_WINDOWS_BUNDLE: "portable" },
      }),
    /must be either "nsis" or "msi"/,
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

test("Windows release apps and bundled services do not open console windows", async () => {
  const [main, processEnvironment] = await Promise.all([
    readFile(
      path.join(rootDir, "cantrip_app", "src-tauri", "src", "main.rs"),
      "utf8",
    ),
    readFile(
      path.join(
        rootDir,
        "cantrip_app",
        "src-tauri",
        "src",
        "process_environment.rs",
      ),
      "utf8",
    ),
  ]);

  assert.match(
    main,
    /all\(not\(debug_assertions\), target_os = "windows"\)[\s\S]*windows_subsystem = "windows"/u,
  );
  assert.match(
    processEnvironment,
    /use std::os::windows::process::CommandExt/u,
  );
  assert.match(processEnvironment, /CREATE_NO_WINDOW: u32 = 0x0800_0000/u);
  assert.match(
    processEnvironment,
    /command\.creation_flags\(CREATE_NO_WINDOW\)/u,
  );
});
