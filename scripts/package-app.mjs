import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertHostTarget,
  normalizeTarget,
} from "./cantrip-code/build-lib.mjs";
import { pnpmCommand } from "./pnpm-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let requestedTarget;
let fromArtifacts = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--target") {
    requestedTarget = process.argv[index + 1];
    if (!requestedTarget || requestedTarget.startsWith("--")) {
      throw new Error(
        "--target requires an operating-system-architecture value",
      );
    }
    index += 1;
  } else if (argument.startsWith("--target=")) {
    requestedTarget = argument.slice("--target=".length);
  } else if (argument === "--from-artifacts") {
    fromArtifacts = true;
  } else throw new Error(`Unknown app packaging argument: ${argument}`);
}

const target = normalizeTarget(requestedTarget);
assertHostTarget(target);

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const runtimeArguments = [
  path.join(root, "scripts", "package-distributions.mjs"),
  "desktop-runtime",
  "--target",
  target.id,
];
if (fromArtifacts) runtimeArguments.push("--from-artifacts");
run(process.execPath, runtimeArguments);
if (target.platform === "darwin") {
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  const signingRequired = process.env.CANTRIP_REQUIRE_MACOS_SIGNING === "1";
  const notarizationRequired =
    process.env.CANTRIP_REQUIRE_MACOS_NOTARIZATION === "1";
  if (notarizationRequired && !signingRequired) {
    throw new Error(
      "CANTRIP_REQUIRE_MACOS_NOTARIZATION=1 also requires CANTRIP_REQUIRE_MACOS_SIGNING=1.",
    );
  }
  if (notarizationRequired) {
    for (const variable of [
      "APPLE_API_ISSUER",
      "APPLE_API_KEY",
      "APPLE_API_KEY_PATH",
    ]) {
      if (!process.env[variable]?.trim()) {
        throw new Error(
          `CANTRIP_REQUIRE_MACOS_NOTARIZATION=1 requires ${variable}.`,
        );
      }
    }
  }
  if (signingRequired && !identity) {
    throw new Error(
      "CANTRIP_REQUIRE_MACOS_SIGNING=1 requires APPLE_SIGNING_IDENTITY.",
    );
  }
  if (identity) {
    run(process.execPath, [
      path.join(root, "scripts", "sign-macos-runtime.mjs"),
      "--directory",
      path.join(root, "cantrip_app", "src-tauri", "resources", "runtime"),
      "--identity",
      identity,
    ]);
  }
}
const appBuild = pnpmCommand(["--filter", "@cantrip/app", "tauri:build"]);
run(appBuild.command, appBuild.arguments);
if (target.platform === "darwin") {
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (identity) {
    run(process.execPath, [
      path.join(root, "scripts", "sign-macos-disk-images.mjs"),
      "--directory",
      path.join(
        root,
        "cantrip_app",
        "src-tauri",
        "target",
        "release",
        "bundle",
      ),
      "--identity",
      identity,
    ]);
  }
}
if (
  target.platform === "darwin" &&
  process.env.CANTRIP_REQUIRE_MACOS_NOTARIZATION === "1"
) {
  run(process.execPath, [
    path.join(root, "scripts", "notarize-macos-distribution.mjs"),
  ]);
}
if (
  target.platform === "darwin" &&
  process.env.CANTRIP_REQUIRE_MACOS_SIGNING === "1"
) {
  run(process.execPath, [
    path.join(root, "scripts", "verify-macos-distribution.mjs"),
  ]);
}
