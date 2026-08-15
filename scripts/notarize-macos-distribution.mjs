import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { findMacosArtifacts } from "./verify-macos-distribution.mjs";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with status ${result.status ?? "unknown"}.`,
    );
  }
  return result.stdout ?? "";
}

function requireValue(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for notarization.`);
  return normalized;
}

export async function notarizeMacosDistribution({
  bundleDirectory,
  issuer,
  keyId,
  keyPath,
  runCommand = run,
}) {
  const credentials = [
    "--key",
    requireValue(keyPath, "APPLE_API_KEY_PATH"),
    "--key-id",
    requireValue(keyId, "APPLE_API_KEY"),
    "--issuer",
    requireValue(issuer, "APPLE_API_ISSUER"),
  ];
  const { apps, dmgs } = await findMacosArtifacts(bundleDirectory);
  if (apps.length === 0) {
    throw new Error(`No macOS app bundle was found in ${bundleDirectory}.`);
  }
  if (dmgs.length === 0) {
    throw new Error(`No macOS DMG was found in ${bundleDirectory}.`);
  }

  // Tauri submits and staples the app before it creates the disk image. Refuse
  // to publish if that inner ticket is absent, then notarize the final DMG too.
  for (const app of apps) {
    runCommand("xcrun", ["stapler", "validate", "-v", app]);
  }

  for (const dmg of dmgs) {
    const output = runCommand("xcrun", [
      "notarytool",
      "submit",
      dmg,
      ...credentials,
      "--wait",
      "--output-format",
      "json",
    ]);
    let submission;
    try {
      submission = JSON.parse(output);
    } catch (error) {
      throw new Error(
        `Apple notarization returned invalid JSON for ${dmg}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (submission.status !== "Accepted") {
      if (submission.id) {
        runCommand("xcrun", [
          "notarytool",
          "log",
          submission.id,
          ...credentials,
        ]);
      }
      throw new Error(
        `Apple rejected notarization for ${dmg} with status ${submission.status ?? "unknown"}.`,
      );
    }
    runCommand("xcrun", ["stapler", "staple", "-v", dmg]);
    runCommand("xcrun", ["stapler", "validate", "-v", dmg]);
  }

  return { apps, dmgs };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await notarizeMacosDistribution({
    bundleDirectory: path.join(
      scriptRoot,
      "cantrip_app",
      "src-tauri",
      "target",
      "release",
      "bundle",
    ),
    issuer: process.env.APPLE_API_ISSUER,
    keyId: process.env.APPLE_API_KEY,
    keyPath: process.env.APPLE_API_KEY_PATH,
  });
  console.log(
    `Validated ${result.apps.length} stapled app and notarized ${result.dmgs.length} DMG with Apple.`,
  );
}
