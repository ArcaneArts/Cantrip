import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const cantripCodexDirectory = path.join(root, "cantrip_codex");
export const upstreamDirectory = path.join(cantripCodexDirectory, "upstream");
export const metadataPath = path.join(cantripCodexDirectory, "upstream.json");
export const filesManifestPath = path.join(
  cantripCodexDirectory,
  "upstream.files.json",
);

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export async function sha256File(file) {
  return sha256(await readFile(file));
}

export async function readUpstreamMetadata() {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  for (const key of ["repository", "ref", "commit", "version"]) {
    if (typeof metadata[key] !== "string" || metadata[key].length === 0) {
      throw new Error(`cantrip_codex/upstream.json requires ${key}.`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.commit)) {
    throw new Error("Codex upstream commit must be a full lowercase Git SHA.");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error("Codex upstream version must be semantic.");
  }
  return metadata;
}

async function collect(directory, relativeDirectory, records) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolute, relative, records);
      continue;
    }
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      const contents = Buffer.from(target);
      records.push({
        path: relative,
        sha256: sha256(contents),
        size: contents.length,
      });
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported upstream file type: ${relative}`);
    }
    records.push({
      path: relative,
      sha256: await sha256File(absolute),
      size: stat.size,
    });
  }
}

export async function collectSourceFiles(directory = upstreamDirectory) {
  const records = [];
  await collect(directory, "", records);
  return records;
}

export function sourceManifest(metadata, files) {
  return {
    schemaVersion: 1,
    upstream: metadata,
    files,
  };
}

export async function readSourceManifest() {
  return JSON.parse(await readFile(filesManifestPath, "utf8"));
}

export function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function platformKey() {
  return `${process.platform}-${process.arch}`;
}

export function executableName() {
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export function buildDirectory() {
  return path.join(cantripCodexDirectory, ".build", platformKey());
}

export function builtBinaryPath() {
  return path.join(buildDirectory(), "bundle", executableName());
}

export function buildManifestPath() {
  return path.join(buildDirectory(), "bundle", "codex-runtime.json");
}

export function bundleDirectory() {
  return path.join(buildDirectory(), "bundle");
}
