import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "../..");
export const inputRoot = path.join(root, "managed_runtimes", "searxng");

export async function readLock() {
  const lock = JSON.parse(
    await readFile(path.join(inputRoot, "runtime.lock.json"), "utf8"),
  );
  validateLock(lock);
  return lock;
}

export function validateLock(lock) {
  if (lock?.schemaVersion !== 1 || lock?.component !== "searxng")
    throw new Error("invalid SearXNG runtime lock");
  if (!/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(lock.bundleVersion))
    throw new Error("invalid bundle version");
  if (!/^[a-f0-9]{40}$/.test(lock.searxng?.commit ?? ""))
    throw new Error("SearXNG commit must be pinned");
  const expected = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ];
  if (
    JSON.stringify(Object.keys(lock.targets).sort()) !==
    JSON.stringify(expected)
  )
    throw new Error("all six runtime targets must be pinned");
  for (const [target, value] of Object.entries(lock.targets)) {
    if (`${value.platform}-${value.architecture}` !== target)
      throw new Error(`target metadata mismatch: ${target}`);
    if (
      !/^https:\/\//.test(value.assetUrl) ||
      !/^[a-f0-9]{64}$/.test(value.assetSha256) ||
      value.assetBytes < 1
    ) {
      throw new Error(`unpinned asset: ${target}`);
    }
  }
}

export function hostTarget(
  platform = process.platform,
  architecture = process.arch,
) {
  const arch =
    architecture === "x64" || architecture === "arm64" ? architecture : null;
  const os = ["darwin", "linux", "win32"].includes(platform) ? platform : null;
  return os && arch ? `${os}-${arch}` : null;
}

export function tarArgumentPath(value, cwd) {
  const relative = path.relative(cwd, value);
  if (!relative) return ".";
  return relative.split(path.sep).join("/");
}

export async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

export async function downloadPinned({ url, destination, bytes, digest }) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = await stat(destination);
    if (existing.size === bytes && (await sha256(destination)) === digest)
      return;
  } catch {}
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`download failed (${response.status}): ${url}`);
  await pipeline(response.body, createWriteStream(partial, { mode: 0o600 }));
  const received = await stat(partial);
  if (received.size !== bytes)
    throw new Error(
      `byte count mismatch for ${url}: ${received.size} != ${bytes}`,
    );
  if ((await sha256(partial)) !== digest)
    throw new Error(`SHA-256 mismatch for ${url}`);
  await rename(partial, destination);
}

export async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
}

export function pythonExecutable(runtime) {
  return process.platform === "win32"
    ? path.join(runtime, "python", "python.exe")
    : path.join(runtime, "python", "bin", "python3");
}

export async function extractedBytes(directory) {
  let total = 0;
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await extractedBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export async function copyInputs(runtime) {
  await Promise.all([
    cp(path.join(inputRoot, "launcher"), path.join(runtime, "launcher"), {
      recursive: true,
    }),
    cp(
      path.join(inputRoot, "config-template"),
      path.join(runtime, "config-template"),
      { recursive: true },
    ),
    cp(
      path.join(inputRoot, "requirements.lock"),
      path.join(runtime, "app", "requirements.lock"),
    ),
  ]);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signArtifact(artifact, privateKeyBase64) {
  const unsigned = {
    schemaVersion: artifact.schemaVersion,
    component: artifact.component,
    version: artifact.version,
    platform: artifact.platform,
    architecture: artifact.architecture,
    archiveFormat: artifact.archiveFormat,
    downloadUrl: artifact.downloadUrl,
    sha256: artifact.sha256,
    signingKeyId: artifact.signingKeyId,
    compressedBytes: artifact.compressedBytes,
    extractedBytes: artifact.extractedBytes,
    licenseManifest: artifact.licenseManifest,
    sourceManifest: artifact.sourceManifest,
    ...(artifact.minimumOs ? { minimumOs: artifact.minimumOs } : {}),
    ...(artifact.minimumKernel
      ? { minimumKernel: artifact.minimumKernel }
      : {}),
    ...(artifact.minimumLibc ? { minimumLibc: artifact.minimumLibc } : {}),
  };
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(JSON.stringify(unsigned)), key).toString(
    "base64",
  );
}

export async function pathExists(value) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

export { cp, mkdir, path, readFile, rename, rm, stat, writeFile };
