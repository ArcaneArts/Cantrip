import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function validateMacBundleVersion(value, source) {
  if (!/^[1-9]\d*(?:\.\d+){0,2}$/.test(value)) {
    throw new Error(
      `${source} must contain one to three period-separated integers and start above zero.`,
    );
  }
  return value;
}

function gitCommitCount(repositoryRoot) {
  const result = spawnSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export function resolveMacBundleVersion({
  environment = process.env,
  repositoryRoot = root,
  readGitCommitCount = gitCommitCount,
} = {}) {
  const override = environment.CANTRIP_APP_BUILD_VERSION?.trim();
  if (override) {
    return validateMacBundleVersion(override, "CANTRIP_APP_BUILD_VERSION");
  }

  const workflowRun = environment.GITHUB_RUN_NUMBER?.trim();
  if (workflowRun) {
    return validateMacBundleVersion(workflowRun, "GITHUB_RUN_NUMBER");
  }

  const commitCount = readGitCommitCount(repositoryRoot);
  if (commitCount)
    return validateMacBundleVersion(commitCount, "Git commit count");

  throw new Error(
    "Unable to determine the macOS bundle version. Set CANTRIP_APP_BUILD_VERSION to a positive integer.",
  );
}

export function tauriBuildArguments({
  platform = process.platform,
  environment = process.env,
  repositoryRoot = root,
  readGitCommitCount = gitCommitCount,
  extraArguments = [],
} = {}) {
  const arguments_ = ["exec", "tauri", "build"];
  if (platform === "darwin") {
    const bundleVersion = resolveMacBundleVersion({
      environment,
      repositoryRoot,
      readGitCommitCount,
    });
    arguments_.push(
      "--config",
      JSON.stringify({ bundle: { macOS: { bundleVersion } } }),
    );
  }
  arguments_.push(...extraArguments);
  return arguments_;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    pnpm,
    tauriBuildArguments({ extraArguments: process.argv.slice(2) }),
    {
      cwd: path.join(root, "cantrip_app"),
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
