import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { pnpmCommand } from "./pnpm-command.mjs";
import { resolveCantripVersion } from "./version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function validateMacBundleVersion(value, source) {
  if (!/^[1-9]\d*(?:\.\d+){0,2}$/.test(value)) {
    throw new Error(
      `${source} must contain one to three period-separated integers and start above zero.`,
    );
  }
  return value;
}

export function resolveMacBundleVersion({
  environment = process.env,
  version = resolveCantripVersion(),
} = {}) {
  const override = environment.CANTRIP_APP_BUILD_VERSION?.trim();
  if (override) {
    return validateMacBundleVersion(override, "CANTRIP_APP_BUILD_VERSION");
  }

  return validateMacBundleVersion(String(version.patch), "Git commit count");
}

export function resolveWindowsBundle({ environment = process.env } = {}) {
  const override = environment.CANTRIP_WINDOWS_BUNDLE?.trim().toLowerCase();
  if (!override) return undefined;
  if (override !== "nsis" && override !== "msi") {
    throw new Error('CANTRIP_WINDOWS_BUNDLE must be either "nsis" or "msi".');
  }
  return override;
}

export function tauriBuildArguments({
  platform = process.platform,
  environment = process.env,
  repositoryRoot = root,
  version = resolveCantripVersion({ root: repositoryRoot }),
  extraArguments = [],
} = {}) {
  const arguments_ = ["exec", "tauri", "build"];
  const config = { version: version.version };
  if (version.synthetic) {
    config.bundle = { createUpdaterArtifacts: false };
  }
  if (platform === "darwin") {
    const bundleVersion = resolveMacBundleVersion({
      environment,
      version,
    });
    config.bundle = {
      ...config.bundle,
      macOS: {
        bundleVersion,
        ...(version.synthetic ? { signingIdentity: "-" } : {}),
      },
    };
  }
  arguments_.push("--config", JSON.stringify(config));
  if (platform === "win32") {
    const windowsBundle = resolveWindowsBundle({ environment });
    if (windowsBundle) arguments_.push("--bundles", windowsBundle);
  }
  arguments_.push(...extraArguments);
  return arguments_;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const invocation = pnpmCommand(
    tauriBuildArguments({ extraArguments: process.argv.slice(2) }),
  );
  const result = spawnSync(invocation.command, invocation.arguments, {
    cwd: path.join(root, "cantrip_app"),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
