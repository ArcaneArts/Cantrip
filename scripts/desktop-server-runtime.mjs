import { renameSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { buildLegacyPostgres } from "./server-rust/postgres-assets.mjs";

export async function replaceDesktopRuntime(destination, assemble) {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, ".cantrip-desktop-runtime-"));
  const candidate = path.join(stage, "runtime");
  const previous = path.join(stage, "previous");
  let removeStage = true;
  try {
    await mkdir(candidate);
    await assemble(candidate);

    // Publish or roll back without yielding between the two renames.
    let hadPrevious = true;
    try {
      renameSync(destination, previous);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hadPrevious = false;
    }
    try {
      renameSync(candidate, destination);
    } catch (error) {
      if (hadPrevious) {
        try {
          renameSync(previous, destination);
        } catch (restoreError) {
          removeStage = false;
          throw new AggregateError(
            [error, restoreError],
            `Could not publish the desktop runtime. The previous runtime is at ${previous}.`,
          );
        }
      }
      throw error;
    }
  } finally {
    if (removeStage) await rm(stage, { force: true, recursive: true });
  }
}

// Tauri copies resources over its previous build staging tree. Homebrew ships
// some PostgreSQL assets as 0444; copying those modes makes the next real
// fs::copy fail with EACCES. Normalize the owned desktop build tree, preserving
// executable/read bits. Runtime read-only mounts/sandboxes still apply.
export async function makeDesktopServerFilesWritable(directory) {
  const metadata = await stat(directory);
  await chmod(directory, (metadata.mode & 0o7777) | 0o200);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeDesktopServerFilesWritable(file);
    else if (entry.isFile()) {
      const metadata = await stat(file);
      await chmod(file, (metadata.mode & 0o7777) | 0o200);
    }
  }
}

// This is launcher configuration, not a runtime capability probe. The desktop
// attempts the configured executable and reports the actual spawn/start error.
export async function configureDesktopServer(directory) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "native-server.json"), "utf8"),
  );
  const configuration = {
    runtime: "rust",
    postgresBin: manifest.postgres.bin,
    legacyPostgresBin:
      manifest.legacyPostgresBin ?? buildLegacyPostgres(directory),
  };
  await makeDesktopServerFilesWritable(directory);
  await writeFile(
    path.join(directory, "desktop-server.json"),
    JSON.stringify(configuration, null, 2) + "\n",
  );
  return configuration;
}
