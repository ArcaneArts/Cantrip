import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import {
  codeCacheRoot,
  codeRoot,
  exists,
  extensionsRoot,
  patchesRoot,
  readJson,
  sha256File,
  upstreamConfigPath,
  upstreamFilesPath,
  walkFiles,
} from "./lib.mjs";

export const CODE_BUILD_SCHEMA_VERSION = 3;
export const CODE_MANIFEST_NAME = "cantrip-code.manifest.json";
export const CANTRIP_WORKBENCH_PACKAGE =
  "extensions/cantrip-workbench/package.json";

const platformAliases = new Map([
  ["darwin", "darwin"],
  ["macos", "darwin"],
  ["linux", "linux"],
  ["win32", "win32"],
  ["windows", "win32"],
]);
const supportedArchitectures = new Set(["x64", "arm64", "armhf"]);

export function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

export function normalizeTarget(value = hostTarget()) {
  const separator = value.lastIndexOf("-");
  if (separator <= 0) throw new Error(`Invalid Cantrip Code target: ${value}`);
  const platform = platformAliases.get(value.slice(0, separator).toLowerCase());
  const arch = value.slice(separator + 1).toLowerCase();
  if (!platform || !supportedArchitectures.has(arch)) {
    throw new Error(
      `Unsupported Cantrip Code target ${value}. Expected darwin-{x64,arm64}, ` +
        "linux-{x64,arm64,armhf}, or win32-{x64,arm64}.",
    );
  }
  if (platform === "darwin" && arch === "armhf") {
    throw new Error(`Unsupported Cantrip Code target ${value}`);
  }
  if (platform === "win32" && arch === "armhf") {
    throw new Error(`Unsupported Cantrip Code target ${value}`);
  }
  return { platform, arch, id: `${platform}-${arch}` };
}

export function assertHostTarget(target) {
  const host = normalizeTarget();
  if (target.id !== host.id) {
    throw new Error(
      `Cantrip Code contains native modules and must be built on its target host. ` +
        `Requested ${target.id}, running on ${host.id}.`,
    );
  }
}

async function hashTree(hash, directory, label) {
  if (!(await exists(directory))) {
    hash.update(`${label}:missing\0`);
    return;
  }
  for (const relative of await walkFiles(directory)) {
    const absolute = path.join(directory, relative);
    const details = await lstat(absolute);
    hash.update(`${label}:${relative}:${details.mode & 0o777}\0`);
    if (details.isSymbolicLink()) hash.update(await readlink(absolute));
    else hash.update(await readFile(absolute));
    hash.update("\0");
  }
}

export async function calculateBuildFingerprint(targetInput = hostTarget()) {
  const target =
    typeof targetInput === "string"
      ? normalizeTarget(targetInput)
      : targetInput;
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      schemaVersion: CODE_BUILD_SCHEMA_VERSION,
      target: target.id,
      buildMode: "reh-web-min-no-mangle-v1",
    }),
  );
  for (const file of [
    upstreamConfigPath,
    upstreamFilesPath,
    path.join(codeRoot, "resources", "product.overrides.json"),
  ]) {
    hash.update(path.relative(codeRoot, file));
    hash.update(await readFile(file));
  }
  await hashTree(hash, patchesRoot, "patches");
  await hashTree(hash, extensionsRoot, "extensions");
  return hash.digest("hex");
}

export async function getBuildIdentity(targetInput = hostTarget()) {
  const target =
    typeof targetInput === "string"
      ? normalizeTarget(targetInput)
      : targetInput;
  const fingerprint = await calculateBuildFingerprint(target);
  const cacheDirectory = path.join(
    codeCacheRoot,
    "builds",
    target.id,
    fingerprint,
  );
  return {
    target,
    fingerprint,
    cacheDirectory,
    distributionDirectory: path.join(cacheDirectory, "distribution"),
    manifestPath: path.join(cacheDirectory, CODE_MANIFEST_NAME),
  };
}

export function codeEntrypoint(target, distributionDirectory) {
  return path.join(
    distributionDirectory,
    "bin",
    target.platform === "win32" ? "cantrip-code.cmd" : "cantrip-code",
  );
}

export async function createDistributionFileInventory(
  directory,
  { exclude = [] } = {},
) {
  const excludedPaths = new Set(exclude);
  const files = [];
  for (const relative of await walkFiles(directory)) {
    if (excludedPaths.has(relative)) continue;
    const absolute = path.join(directory, relative);
    const details = await lstat(absolute);
    files.push(
      details.isSymbolicLink()
        ? {
            path: relative,
            type: "symlink",
            target: await readlink(absolute),
          }
        : {
            path: relative,
            type: "file",
            size: details.size,
            sha256: await sha256File(absolute),
            executable: (details.mode & 0o111) !== 0,
          },
    );
  }
  return files;
}

export async function createBuildManifest(identity) {
  const upstream = await readJson(upstreamConfigPath);
  const workbench = await readJson(
    path.join(extensionsRoot, "cantrip-workbench", "package.json"),
  );
  const files = await createDistributionFileInventory(
    identity.distributionDirectory,
  );
  return {
    schemaVersion: CODE_BUILD_SCHEMA_VERSION,
    component: "cantrip-code",
    version: upstream.version,
    target: identity.target.id,
    platform: identity.target.platform,
    arch: identity.target.arch,
    fingerprint: identity.fingerprint,
    openvscodeServerCommit: upstream.openvscodeServerCommit,
    vscodeCommit: upstream.vscodeCommit,
    patchset: upstream.patchset,
    cantripWorkbenchVersion: workbench.version,
    entrypoint: path
      .relative(
        identity.distributionDirectory,
        codeEntrypoint(identity.target, identity.distributionDirectory),
      )
      .split(path.sep)
      .join("/"),
    files,
  };
}

export async function verifyBuild(identity, options = {}) {
  if (!(await exists(identity.manifestPath))) {
    throw new Error(
      `Cantrip Code ${identity.target.id} build is missing or stale. Run pnpm code:build.`,
    );
  }
  const manifest = await readJson(identity.manifestPath);
  const workbench = await readJson(
    path.join(extensionsRoot, "cantrip-workbench", "package.json"),
  );
  for (const [field, expected] of Object.entries({
    schemaVersion: CODE_BUILD_SCHEMA_VERSION,
    component: "cantrip-code",
    target: identity.target.id,
    fingerprint: identity.fingerprint,
    cantripWorkbenchVersion: workbench.version,
  })) {
    if (manifest[field] !== expected) {
      throw new Error(
        `Cantrip Code manifest ${field} is ${String(manifest[field])}; expected ${String(expected)}. Run pnpm code:build.`,
      );
    }
  }
  const entrypoint = path.join(
    identity.distributionDirectory,
    manifest.entrypoint,
  );
  if (!(await exists(entrypoint))) {
    throw new Error(`Cantrip Code build is missing ${manifest.entrypoint}`);
  }
  const bundledWorkbench = path.join(
    identity.distributionDirectory,
    CANTRIP_WORKBENCH_PACKAGE,
  );
  if (!(await exists(bundledWorkbench))) {
    throw new Error(
      `Cantrip Code build is missing ${CANTRIP_WORKBENCH_PACKAGE}. Run pnpm code:build.`,
    );
  }
  const bundledWorkbenchPackage = await readJson(bundledWorkbench);
  if (
    bundledWorkbenchPackage.name !== "cantrip-workbench" ||
    bundledWorkbenchPackage.version !== manifest.cantripWorkbenchVersion
  ) {
    throw new Error(
      "Cantrip Code contains an incompatible cantrip-workbench extension. Run pnpm code:build.",
    );
  }
  if (options.full) {
    const actual = await createDistributionFileInventory(
      identity.distributionDirectory,
    );
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
      throw new Error(
        `Cantrip Code ${identity.target.id} build contents do not match its manifest. Run pnpm code:build.`,
      );
    }
  }
  return manifest;
}
