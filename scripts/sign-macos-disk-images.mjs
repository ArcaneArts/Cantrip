import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { findMacosArtifacts } from "./verify-macos-distribution.mjs";

function runCommand(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? "unknown"}.`,
    );
  }
}

export async function signMacosDiskImages({
  bundleDirectory,
  identity,
  run = runCommand,
}) {
  if (!identity?.trim()) {
    throw new Error("A macOS signing identity is required.");
  }
  const { dmgs } = await findMacosArtifacts(bundleDirectory);
  if (dmgs.length === 0) {
    throw new Error(`No macOS DMG was found in ${bundleDirectory}.`);
  }
  if (identity === "-") return dmgs;
  for (const dmg of dmgs) {
    run("xattr", ["-c", dmg]);
    const arguments_ = ["--force", "--sign", identity];
    if (identity !== "-") arguments_.push("--timestamp");
    arguments_.push(dmg);
    run("codesign", arguments_);
  }
  return dmgs;
}

function parseArguments(arguments_) {
  let bundleDirectory;
  let identity;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--directory") {
      bundleDirectory = arguments_[index + 1];
      index += 1;
    } else if (argument === "--identity") {
      identity = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown disk-image signing argument: ${argument}`);
    }
  }
  if (!bundleDirectory) throw new Error("--directory is required.");
  if (!identity) throw new Error("--identity is required.");
  return { bundleDirectory: path.resolve(bundleDirectory), identity };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = parseArguments(process.argv.slice(2));
  const dmgs = await signMacosDiskImages(input);
  console.log(
    input.identity === "-"
      ? `Left ${dmgs.length} macOS disk image${dmgs.length === 1 ? "" : "s"} unsigned so Gatekeeper can mount the ad-hoc fallback.`
      : `Signed ${dmgs.length} macOS disk image${dmgs.length === 1 ? "" : "s"}.`,
  );
}
