import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { findMachOBinaries } from "./sign-macos-runtime.mjs";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with status ${result.status ?? "unknown"}:\n${output}`,
    );
  }
  return output;
}

async function findArtifacts(directory) {
  const apps = [];
  const dmgs = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        apps.push(absolute);
      } else if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".dmg")) {
        dmgs.push(absolute);
      }
    }
  }
  await visit(directory);
  return { apps: apps.sort(), dmgs: dmgs.sort() };
}

function assertDeveloperId(details, description) {
  if (!/Authority=Developer ID Application:/u.test(details)) {
    throw new Error(
      `${description} is not signed with a Developer ID identity.`,
    );
  }
  if (
    /Signature=adhoc/u.test(details) ||
    /TeamIdentifier=not set/u.test(details)
  ) {
    throw new Error(`${description} has only an ad-hoc signature.`);
  }
}

export async function verifyMacosDistribution({
  bundleDirectory,
  runCommand = run,
}) {
  const { apps, dmgs } = await findArtifacts(bundleDirectory);
  if (apps.length === 0) {
    throw new Error(`No macOS app bundle was found in ${bundleDirectory}.`);
  }
  if (dmgs.length === 0) {
    throw new Error(`No macOS DMG was found in ${bundleDirectory}.`);
  }

  let runtimeBinaryCount = 0;
  for (const app of apps) {
    runCommand("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      app,
    ]);
    const details = runCommand("codesign", [
      "-dvvv",
      "--entitlements",
      "-",
      app,
    ]);
    assertDeveloperId(details, app);
    if (!/Identifier=art\.cantrip(?:\s|$)/u.test(details)) {
      throw new Error(`${app} does not use the art.cantrip bundle identifier.`);
    }
    if (!/flags=.*\bruntime\b/u.test(details)) {
      throw new Error(`${app} does not enable Hardened Runtime.`);
    }
    if (/com\.apple\.security\.app-sandbox/u.test(details)) {
      throw new Error(`${app} unexpectedly enables App Sandbox.`);
    }

    const runtime = path.join(app, "Contents", "Resources", "runtime");
    for (const binary of await findMachOBinaries(runtime)) {
      runtimeBinaryCount += 1;
      runCommand("codesign", ["--verify", "--strict", "--verbose=2", binary]);
      const binaryDetails = runCommand("codesign", ["-dvvv", binary]);
      assertDeveloperId(binaryDetails, binary);
      if (
        ((await stat(binary)).mode & 0o111) !== 0 &&
        !/flags=.*\bruntime\b/u.test(binaryDetails)
      ) {
        throw new Error(`${binary} does not enable Hardened Runtime.`);
      }
      if (path.basename(binary) === "node") {
        const entitlements = runCommand("codesign", [
          "-d",
          "--entitlements",
          "-",
          binary,
        ]);
        if (!/com\.apple\.security\.cs\.allow-jit/u.test(entitlements)) {
          throw new Error(`${binary} is missing its JIT entitlement.`);
        }
        if (/com\.apple\.security\.get-task-allow/u.test(entitlements)) {
          throw new Error(
            `${binary} retains the development-only get-task-allow entitlement.`,
          );
        }
      }
    }
  }
  if (runtimeBinaryCount === 0) {
    throw new Error(
      "The packaged app did not contain any native runtime binaries.",
    );
  }

  for (const dmg of dmgs) {
    runCommand("hdiutil", ["verify", dmg]);
    runCommand("codesign", ["--verify", "--strict", "--verbose=2", dmg]);
    assertDeveloperId(runCommand("codesign", ["-dvvv", dmg]), dmg);
  }

  return { apps, dmgs, runtimeBinaryCount };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await verifyMacosDistribution({
    bundleDirectory: path.join(
      scriptRoot,
      "cantrip_app",
      "src-tauri",
      "target",
      "release",
      "bundle",
    ),
  });
  console.log(
    `Verified ${result.apps.length} Developer ID app, ${result.dmgs.length} signed DMG, and ${result.runtimeBinaryCount} embedded runtime binaries.`,
  );
}
