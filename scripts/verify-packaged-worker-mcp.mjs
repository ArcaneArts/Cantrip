import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { nodeExecutableName } from "./package-runtime.mjs";

const EXPECTED_STARTUP_FAILURE =
  "Cantrip MCP failed to start: Usage: cantrip-worker-mcp --connection <path>";

async function requireRegularFile(filename, description) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch {
    throw new Error(`${description} is missing at ${filename}.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${description} must be a regular file at ${filename}.`);
  }
}

export async function verifyPackagedWorkerMcp(
  workerRoot,
  { platform = process.platform, smoke = true, spawn = spawnSync } = {},
) {
  const root = path.resolve(workerRoot);
  const manifestPath = path.join(root, "package.json");
  const entryPath = path.join(root, "dist", "mcp", "stdio.js");
  const nodePath = path.join(root, "runtime", nodeExecutableName(platform));
  await requireRegularFile(manifestPath, "Packaged worker manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.name !== "@cantrip/worker") {
    throw new Error(
      `Packaged worker manifest has unexpected name ${JSON.stringify(manifest?.name)}.`,
    );
  }
  await requireRegularFile(entryPath, "Packaged Cantrip MCP entry point");

  if (smoke) {
    await requireRegularFile(nodePath, "Packaged Node executable");
    const result = spawn(nodePath, [entryPath], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 1) {
      throw new Error(
        `Packaged Cantrip MCP smoke check exited with ${String(result.status)} instead of 1.`,
      );
    }
    if (!result.stderr.includes(EXPECTED_STARTUP_FAILURE)) {
      throw new Error(
        `Packaged Cantrip MCP did not reach its argument validation boundary: ${result.stderr.trim()}`,
      );
    }
  }

  return { entryPath, manifestPath, nodePath, smoke };
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const workerRoot = process.argv[2];
  if (!workerRoot || process.argv.length !== 3) {
    console.error(
      "Usage: node scripts/verify-packaged-worker-mcp.mjs <packaged-worker-root>",
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await verifyPackagedWorkerMcp(workerRoot);
      console.log(`Verified packaged Cantrip MCP: ${result.entryPath}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
