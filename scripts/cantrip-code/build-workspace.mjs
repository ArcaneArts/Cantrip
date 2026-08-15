import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PREPARATION_PREFIX = "cantrip-code-";

export async function createBuildWorkspace(
  targetId,
  { temporaryRoot = process.env.CANTRIP_CODE_TEMP_DIR ?? os.tmpdir() } = {},
) {
  const parent = path.join(temporaryRoot, PREPARATION_PREFIX);
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, `${targetId}-`));
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
