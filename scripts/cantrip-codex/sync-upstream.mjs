import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cantripCodexDirectory,
  collectSourceFiles,
  filesManifestPath,
  prettyJson,
  readUpstreamMetadata,
  sourceManifest,
  upstreamDirectory,
} from "./lib.mjs";

function git(cwd, args, capture = false) {
  return execFileSync("git", args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

function cargoWorkspaceVersion(cargoToml) {
  const match = cargoToml.match(
    /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
  );
  if (!match) throw new Error("Could not read the upstream Cargo version.");
  return match[1];
}

const metadata = await readUpstreamMetadata();
await mkdir(cantripCodexDirectory, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "cantrip-codex-sync-"));
const checkout = path.join(temporary, "repository");
const staged = path.join(temporary, "upstream");
const backup = path.join(
  cantripCodexDirectory,
  `.upstream-backup-${process.pid}`,
);

try {
  await mkdir(checkout, { recursive: true });
  git(checkout, ["init", "--quiet"]);
  git(checkout, ["config", "core.autocrlf", "false"]);
  git(checkout, ["remote", "add", "origin", metadata.repository]);
  git(checkout, ["fetch", "--depth", "1", "origin", metadata.ref]);
  const resolved = git(
    checkout,
    ["rev-parse", "FETCH_HEAD^{commit}"],
    true,
  ).trim();
  if (resolved !== metadata.commit) {
    throw new Error(
      `Codex ref ${metadata.ref} resolved to ${resolved}; expected ${metadata.commit}.`,
    );
  }
  git(checkout, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);

  await mkdir(staged, { recursive: true });
  for (const entry of ["LICENSE", "NOTICE", "README.md", "codex-rs"]) {
    await cp(path.join(checkout, entry), path.join(staged, entry), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  const cargoVersion = cargoWorkspaceVersion(
    await readFile(path.join(staged, "codex-rs", "Cargo.toml"), "utf8"),
  );
  if (cargoVersion !== metadata.version) {
    throw new Error(
      `Codex source reports ${cargoVersion}; upstream.json expects ${metadata.version}.`,
    );
  }

  const files = await collectSourceFiles(staged);
  const manifest = sourceManifest(metadata, files);
  await rm(backup, { force: true, recursive: true });
  let movedExisting = false;
  try {
    await rename(upstreamDirectory, backup);
    movedExisting = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(staged, upstreamDirectory);
    await writeFile(filesManifestPath, prettyJson(manifest));
    if (movedExisting) await rm(backup, { force: true, recursive: true });
  } catch (error) {
    await rm(upstreamDirectory, { force: true, recursive: true });
    if (movedExisting) await rename(backup, upstreamDirectory);
    throw error;
  }
  console.log(
    `Imported Codex ${metadata.version} (${metadata.commit}) with ${files.length} files.`,
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}
