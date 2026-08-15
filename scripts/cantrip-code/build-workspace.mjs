import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const PREPARATION_PREFIX = "cantrip-code-";
const execFileAsync = promisify(execFile);

export function resolveBuildWorkspaceRoot({
  platform = process.platform,
  configuredRoot = process.env.CANTRIP_CODE_TEMP_DIR,
  homeDirectory = os.homedir(),
  temporaryDirectory = os.tmpdir(),
} = {}) {
  if (configuredRoot) return path.resolve(configuredRoot);

  // MSBuild warns against native intermediate/output directories below the
  // Windows Temporary directory and can race with scanners over its tlog files.
  // The user profile is still short, writable, and outside that special tree.
  return platform === "win32" ? homeDirectory : temporaryDirectory;
}

export async function createBuildWorkspace(
  targetId,
  { temporaryRoot = resolveBuildWorkspaceRoot() } = {},
) {
  const parent = path.join(temporaryRoot, PREPARATION_PREFIX);
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, `${targetId}-`));
}

export async function initializeBuildWorkspaceRepository(directory) {
  // VS Code's pinned postinstall writes repository-local Git settings. The
  // prepared source is intentionally outside Cantrip's checkout to keep native
  // Windows compiler paths short, so give that disposable copy its own repo.
  await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
}

export async function removeBuildWorkspace(
  directory,
  { remove = rm, warn = console.warn } = {},
) {
  try {
    await remove(directory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(
      `Could not remove temporary Cantrip Code workspace ${directory}: ${detail}`,
    );
  }
}
