import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
  const entryPath = path.join(
    root,
    "bin",
    platform === "win32" ? "cantrip-worker.exe" : "cantrip-worker",
  );
  await requireRegularFile(entryPath, "Packaged Rust worker");
  if (smoke) {
    for (const subcommand of ["mcp", "cua-mcp"]) {
      const result = spawn(entryPath, [subcommand], {
        cwd: root,
        env: { ...process.env, PATH: "" },
        encoding: "utf8",
        maxBuffer: 64 * 1_024,
        timeout: 10_000,
        windowsHide: true,
      });
      if (result.error) throw result.error;
      if (
        result.status !== 1 ||
        !result.stderr.includes(
          `Usage: cantrip-worker ${subcommand} --connection <path>`,
        )
      ) {
        throw new Error(
          `Packaged Cantrip ${subcommand} startup failed (${result.status ?? result.signal}): ${result.stderr.trim()}`,
        );
      }
    }
  }
  return { entryPath, smoke };
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
