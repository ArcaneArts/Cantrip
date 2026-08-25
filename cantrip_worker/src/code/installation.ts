import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CodeCapabilities, CodeEditorBuild } from "@cantrip/protocol";

export interface CantripCodeManifest {
  schemaVersion: 3;
  component: "cantrip-code";
  version: string;
  target: string;
  platform: string;
  arch: string;
  fingerprint: string;
  openvscodeServerCommit: string;
  vscodeCommit: string;
  patchset: number;
  cantripWorkbenchVersion: string;
  entrypoint: string;
  files: Array<
    | {
        path: string;
        type: "file";
        size: number;
        sha256: string;
        executable: boolean;
      }
    | { path: string; type: "symlink"; target: string }
  >;
}

export interface CantripCodeInstallation {
  root: string;
  entrypoint: string;
  manifestPath: string;
  manifest: CantripCodeManifest;
  editorBuild: CodeEditorBuild;
  source: "bundle" | "workspace" | "override";
}

export interface CantripCodeDiscovery {
  capabilities: CodeCapabilities;
  installation: CantripCodeInstallation | null;
}

export interface DiscoverCantripCodeOptions {
  architecture?: string;
  platform?: NodeJS.Platform;
  rootOverride?: string;
  verifyFull?: boolean;
  workerRoot?: string;
}

const MANIFEST_NAME = "cantrip-code.manifest.json";
const WORKBENCH_PACKAGE = "extensions/cantrip-workbench/package.json";
const UNBOUNDED_CODE_SESSIONS = Number.MAX_SAFE_INTEGER;

function defaultWorkerRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function isSafeRelative(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    !path.isAbsolute(candidate) &&
    !candidate.split(/[\\/]/u).includes("..")
  );
}

function parseManifest(value: unknown): CantripCodeManifest {
  const candidate = value as Partial<CantripCodeManifest>;
  if (
    candidate.schemaVersion !== 3 ||
    candidate.component !== "cantrip-code" ||
    typeof candidate.version !== "string" ||
    candidate.version.length === 0 ||
    typeof candidate.target !== "string" ||
    typeof candidate.platform !== "string" ||
    typeof candidate.arch !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.fingerprint ?? "") ||
    !/^[0-9a-f]{40}$/u.test(candidate.openvscodeServerCommit ?? "") ||
    !/^[0-9a-f]{40}$/u.test(candidate.vscodeCommit ?? "") ||
    !Number.isInteger(candidate.patchset) ||
    (candidate.patchset ?? -1) < 0 ||
    typeof candidate.cantripWorkbenchVersion !== "string" ||
    candidate.cantripWorkbenchVersion.length === 0 ||
    !isSafeRelative(candidate.entrypoint) ||
    !Array.isArray(candidate.files) ||
    candidate.files.length === 0
  ) {
    throw new Error("Cantrip Code manifest is invalid.");
  }
  const paths = new Set<string>();
  for (const item of candidate.files) {
    if (!isSafeRelative(item?.path) || paths.has(item.path)) {
      throw new Error("Cantrip Code manifest contains an invalid file path.");
    }
    paths.add(item.path);
    if (item.type === "file") {
      if (
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        !/^[0-9a-f]{64}$/u.test(item.sha256) ||
        typeof item.executable !== "boolean"
      ) {
        throw new Error("Cantrip Code manifest contains an invalid file.");
      }
    } else if (item.type === "symlink") {
      if (typeof item.target !== "string" || item.target.length === 0) {
        throw new Error("Cantrip Code manifest contains an invalid symlink.");
      }
    } else {
      throw new Error("Cantrip Code manifest contains an unknown entry type.");
    }
  }
  if (!paths.has(candidate.entrypoint)) {
    throw new Error("Cantrip Code manifest does not contain its entrypoint.");
  }
  if (!paths.has(WORKBENCH_PACKAGE)) {
    throw new Error(
      "Cantrip Code manifest does not contain cantrip-workbench.",
    );
  }
  return candidate as CantripCodeManifest;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function listBundleEntries(
  root: string,
  current = root,
): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative === MANIFEST_NAME) continue;
    if (entry.isDirectory()) {
      entries.push(...(await listBundleEntries(root, absolute)));
    } else {
      entries.push(relative);
    }
  }
  return entries.sort();
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyCantripCodeInstallation(
  root: string,
  options: {
    architecture?: string;
    full?: boolean;
    manifestPath?: string;
    platform?: NodeJS.Platform;
    source?: CantripCodeInstallation["source"];
  } = {},
): Promise<CantripCodeInstallation> {
  const manifestPath = options.manifestPath ?? path.join(root, MANIFEST_NAME);
  let manifest: CantripCodeManifest;
  try {
    manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    throw new Error(
      `Could not validate Cantrip Code manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedTarget = `${options.platform ?? process.platform}-${options.architecture ?? process.arch}`;
  if (
    manifest.target !== expectedTarget ||
    manifest.platform !== (options.platform ?? process.platform) ||
    manifest.arch !== (options.architecture ?? process.arch)
  ) {
    throw new Error(
      `Cantrip Code targets ${manifest.target}; worker requires ${expectedTarget}.`,
    );
  }
  const entrypoint = path.resolve(root, manifest.entrypoint);
  if (!entrypoint.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error("Cantrip Code entrypoint escapes its immutable bundle.");
  }
  if (!existsSync(entrypoint)) {
    throw new Error(
      `Cantrip Code entrypoint is missing: ${manifest.entrypoint}`,
    );
  }
  const workbenchPackagePath = path.join(root, WORKBENCH_PACKAGE);
  let workbenchPackage: { name?: unknown; version?: unknown };
  try {
    workbenchPackage = JSON.parse(
      await readFile(workbenchPackagePath, "utf8"),
    ) as { name?: unknown; version?: unknown };
  } catch {
    throw new Error("Cantrip Code bundled workbench extension is missing.");
  }
  if (
    workbenchPackage.name !== "cantrip-workbench" ||
    workbenchPackage.version !== manifest.cantripWorkbenchVersion
  ) {
    throw new Error(
      "Cantrip Code bundled workbench extension is incompatible with its manifest.",
    );
  }
  const resolvedEntrypoint = await realpath(entrypoint);
  if (!resolvedEntrypoint.startsWith(`${await realpath(root)}${path.sep}`)) {
    throw new Error(
      "Cantrip Code entrypoint resolves outside its immutable bundle.",
    );
  }
  if (options.full) {
    const expectedEntries = manifest.files.map((item) => item.path).sort();
    const actualEntries = await listBundleEntries(root);
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
      throw new Error(
        "Cantrip Code bundle inventory does not match its manifest.",
      );
    }
    for (const item of manifest.files) {
      const absolute = path.resolve(root, item.path);
      if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) {
        throw new Error(`Cantrip Code file escapes its bundle: ${item.path}`);
      }
      const stat = await lstat(absolute);
      if (item.type === "symlink") {
        const resolvedTarget = path.resolve(
          path.dirname(absolute),
          item.target,
        );
        if (!resolvedTarget.startsWith(`${path.resolve(root)}${path.sep}`)) {
          throw new Error(
            `Cantrip Code symlink escapes its bundle: ${item.path}`,
          );
        }
        if (
          !stat.isSymbolicLink() ||
          (await readlink(absolute)) !== item.target ||
          !(await realpath(absolute)).startsWith(
            `${await realpath(root)}${path.sep}`,
          )
        ) {
          throw new Error(`Cantrip Code symlink does not match: ${item.path}`);
        }
        continue;
      }
      if (!stat.isFile() || stat.size !== item.size) {
        throw new Error(`Cantrip Code file does not match: ${item.path}`);
      }
      if (
        item.executable &&
        process.platform !== "win32" &&
        (stat.mode & 0o111) === 0
      ) {
        throw new Error(
          `Cantrip Code executable is not executable: ${item.path}`,
        );
      }
      const actual = await sha256File(absolute);
      if (!constantTimeEqual(actual, item.sha256)) {
        throw new Error(`Cantrip Code file hash does not match: ${item.path}`);
      }
    }
  }
  return {
    root,
    entrypoint,
    manifestPath,
    manifest,
    editorBuild: {
      version: manifest.version,
      upstreamRevision: manifest.openvscodeServerCommit,
      patchset: manifest.patchset,
      fingerprint: manifest.fingerprint,
    },
    source: options.source ?? "override",
  };
}

async function workspaceBuildRoot(
  workerRoot: string,
): Promise<{ manifestPath: string; root: string } | null> {
  const workspaceRoot = path.resolve(workerRoot, "..");
  const readyScript = path.join(
    workspaceRoot,
    "scripts",
    "cantrip-code",
    "ready.mjs",
  );
  if (!existsSync(readyScript)) return null;
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [readyScript, "--json"], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => {
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(output) as {
          distributionDirectory?: unknown;
          manifestPath?: unknown;
        };
        resolve(
          typeof parsed.distributionDirectory === "string" &&
            typeof parsed.manifestPath === "string"
            ? {
                root: parsed.distributionDirectory,
                manifestPath: parsed.manifestPath,
              }
            : null,
        );
      } catch {
        resolve(null);
      }
    });
  });
}

export async function discoverCantripCode(
  options: DiscoverCantripCodeOptions = {},
): Promise<CantripCodeDiscovery> {
  const workerRoot = options.workerRoot ?? defaultWorkerRoot();
  const override = options.rootOverride ?? process.env.CANTRIP_CODE_ROOT;
  const candidates: Array<{
    full: boolean;
    manifestPath?: string;
    root: string;
    source: CantripCodeInstallation["source"];
  }> = [];
  if (override) {
    candidates.push({
      root: path.resolve(override),
      source: "override",
      full: true,
    });
  }
  candidates.push({
    root: path.join(workerRoot, "resources", "cantrip-code"),
    source: "bundle",
    full: options.verifyFull ?? true,
  });
  const workspaceRoot = await workspaceBuildRoot(workerRoot);
  if (workspaceRoot) {
    candidates.push({
      ...workspaceRoot,
      source: "workspace",
      full: false,
    });
  }

  let lastError =
    "Cantrip Code is not bundled and no current development build is ready.";
  for (const candidate of candidates) {
    if (
      !existsSync(
        candidate.manifestPath ?? path.join(candidate.root, MANIFEST_NAME),
      )
    ) {
      continue;
    }
    try {
      const installation = await verifyCantripCodeInstallation(candidate.root, {
        architecture: options.architecture,
        full: candidate.full,
        manifestPath: candidate.manifestPath,
        platform: options.platform,
        source: candidate.source,
      });
      return {
        installation,
        capabilities: {
          available: true,
          version: installation.editorBuild.version,
          upstreamRevision: installation.editorBuild.upstreamRevision,
          patchset: installation.editorBuild.patchset,
          transport: "web-proxy",
          sharedTransportProtocolVersion: 1,
          maxSessions: UNBOUNDED_CODE_SESSIONS,
          reason: null,
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    installation: null,
    capabilities: {
      available: false,
      version: null,
      upstreamRevision: null,
      patchset: 0,
      transport: "web-proxy",
      sharedTransportProtocolVersion: 1,
      maxSessions: UNBOUNDED_CODE_SESSIONS,
      reason: lastError,
    },
  };
}
