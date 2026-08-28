import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CodeCapabilities, CodeEditorBuild } from "@cantrip/protocol";

export interface CantripCodeManifest {
  schemaVersion: number;
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
    candidate.component !== "cantrip-code" ||
    typeof candidate.target !== "string" ||
    candidate.target.length === 0 ||
    typeof candidate.platform !== "string" ||
    candidate.platform.length === 0 ||
    typeof candidate.arch !== "string" ||
    candidate.arch.length === 0 ||
    typeof candidate.cantripWorkbenchVersion !== "string" ||
    candidate.cantripWorkbenchVersion.length === 0 ||
    !isSafeRelative(candidate.entrypoint)
  ) {
    throw new Error("Cantrip Code manifest is invalid.");
  }
  return {
    schemaVersion: Number.isSafeInteger(candidate.schemaVersion)
      ? candidate.schemaVersion!
      : 0,
    component: "cantrip-code",
    version:
      typeof candidate.version === "string" && candidate.version.length > 0
        ? candidate.version
        : "unknown",
    target: candidate.target,
    platform: candidate.platform,
    arch: candidate.arch,
    fingerprint:
      typeof candidate.fingerprint === "string" ? candidate.fingerprint : "",
    openvscodeServerCommit:
      typeof candidate.openvscodeServerCommit === "string"
        ? candidate.openvscodeServerCommit
        : "",
    vscodeCommit:
      typeof candidate.vscodeCommit === "string" ? candidate.vscodeCommit : "",
    patchset:
      Number.isSafeInteger(candidate.patchset) &&
      (candidate.patchset ?? -1) >= 0
        ? candidate.patchset!
        : 0,
    cantripWorkbenchVersion: candidate.cantripWorkbenchVersion,
    entrypoint: candidate.entrypoint,
  };
}

export async function verifyCantripCodeInstallation(
  root: string,
  options: {
    architecture?: string;
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
    throw new Error("Cantrip Code entrypoint escapes its bundle.");
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
    throw new Error("Cantrip Code entrypoint resolves outside its bundle.");
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
    manifestPath?: string;
    root: string;
    source: CantripCodeInstallation["source"];
  }> = [];
  if (override) {
    candidates.push({
      root: path.resolve(override),
      source: "override",
    });
  }
  candidates.push({
    root: path.join(workerRoot, "resources", "cantrip-code"),
    source: "bundle",
  });
  const workspaceRoot = await workspaceBuildRoot(workerRoot);
  if (workspaceRoot) {
    candidates.push({
      ...workspaceRoot,
      source: "workspace",
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
          sharedTransportProtocolVersion: 2,
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
      sharedTransportProtocolVersion: 2,
      maxSessions: UNBOUNDED_CODE_SESSIONS,
      reason: lastError,
    },
  };
}
