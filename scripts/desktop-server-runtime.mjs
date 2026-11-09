import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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
export async function configureDesktopServer(directory, runtime = "rust") {
  if (runtime !== "rust")
    throw new Error("The desktop server runtime is Rust.");
  const configuration = { runtime };
  const manifest = JSON.parse(
    await readFile(path.join(directory, "native-server.json"), "utf8"),
  );
  configuration.postgresBin = manifest.postgres.bin;
  configuration.profileConverter = "../profile-converter/dist/index.mjs";
  await makeDesktopServerFilesWritable(directory);
  await writeFile(
    path.join(directory, "desktop-server.json"),
    JSON.stringify(configuration, null, 2) + "\n",
  );
}
