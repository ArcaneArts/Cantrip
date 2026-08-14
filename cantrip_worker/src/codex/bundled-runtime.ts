import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CodexInstallation {
  binary: string;
  manifestPath: string | null;
  source: "override" | "bundle" | "workspace" | "path";
}

export interface BundledCodexManifest {
  schemaVersion: 1;
  component: "codex-cli";
  version: string;
  upstream: {
    repository: string;
    ref: string;
    commit: string;
  };
  sourceManifestSha256: string;
  patchesSha256?: string;
  buildRecipeVersion: 1 | 2 | 3 | 4;
  entrypoint: string;
  artifacts: Array<{ path: string; sha256: string }>;
  target: string;
  profile: "release";
}

interface ResolveCodexInstallationOptions {
  architecture?: string;
  exists?: (file: string) => boolean;
  override?: string;
  platform?: NodeJS.Platform;
  workerRoot?: string;
}

function defaultWorkerRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function resolveCodexInstallation(
  options: ResolveCodexInstallationOptions = {},
): CodexInstallation {
  if (options.override) {
    return {
      binary: options.override,
      manifestPath: null,
      source: "override",
    };
  }
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const executable = platform === "win32" ? "codex.exe" : "codex";
  const target = `${platform}-${architecture}`;
  const workerRoot = options.workerRoot ?? defaultWorkerRoot();
  const fileExists = options.exists ?? existsSync;
  const candidates = [
    {
      binary: path.join(workerRoot, "bin", executable),
      manifestPath: path.join(workerRoot, "bin", "codex-runtime.json"),
      source: "bundle" as const,
    },
    {
      binary: path.join(
        workerRoot,
        "..",
        "cantrip_codex",
        ".build",
        target,
        "bundle",
        executable,
      ),
      manifestPath: path.join(
        workerRoot,
        "..",
        "cantrip_codex",
        ".build",
        target,
        "bundle",
        "codex-runtime.json",
      ),
      source: "workspace" as const,
    },
  ];
  const managed = candidates.find(
    (candidate) =>
      fileExists(candidate.binary) || fileExists(candidate.manifestPath),
  );
  if (managed) return managed;
  return { binary: "codex", manifestPath: null, source: "path" };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function parseManifest(value: unknown): BundledCodexManifest {
  const candidate = value as Partial<BundledCodexManifest>;
  const artifactPaths = Array.isArray(candidate?.artifacts)
    ? candidate.artifacts.map((artifact) => artifact?.path)
    : [];
  if (
    candidate?.schemaVersion !== 1 ||
    candidate.component !== "codex-cli" ||
    candidate.profile !== "release" ||
    typeof candidate.version !== "string" ||
    typeof candidate.target !== "string" ||
    typeof candidate.entrypoint !== "string" ||
    candidate.entrypoint.length === 0 ||
    path.isAbsolute(candidate.entrypoint) ||
    candidate.entrypoint.split(/[\\/]/).includes("..") ||
    !Array.isArray(candidate.artifacts) ||
    candidate.artifacts.length === 0 ||
    !artifactPaths.includes(candidate.entrypoint) ||
    new Set(artifactPaths).size !== artifactPaths.length ||
    candidate.artifacts.some(
      (artifact) =>
        typeof artifact?.path !== "string" ||
        artifact.path.length === 0 ||
        path.isAbsolute(artifact.path) ||
        artifact.path.split(/[\\/]/).includes("..") ||
        !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? ""),
    ) ||
    !/^[0-9a-f]{64}$/.test(candidate.sourceManifestSha256 ?? "") ||
    ![1, 2, 3, 4].includes(candidate.buildRecipeVersion ?? 0) ||
    (candidate.patchesSha256 !== undefined &&
      !/^[0-9a-f]{64}$/.test(candidate.patchesSha256)) ||
    ((candidate.buildRecipeVersion ?? 0) >= 2 &&
      !/^[0-9a-f]{64}$/.test(candidate.patchesSha256 ?? "")) ||
    typeof candidate.upstream?.repository !== "string" ||
    typeof candidate.upstream.ref !== "string" ||
    !/^[0-9a-f]{40}$/.test(candidate.upstream.commit ?? "")
  ) {
    throw new Error("Bundled Codex manifest is invalid.");
  }
  return candidate as BundledCodexManifest;
}

export async function verifyCodexInstallation(
  installation: CodexInstallation,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): Promise<BundledCodexManifest | null> {
  if (!installation.manifestPath) return null;
  let manifest: BundledCodexManifest;
  try {
    manifest = parseManifest(
      JSON.parse(await readFile(installation.manifestPath, "utf8")),
    );
  } catch (error) {
    throw new Error(
      `Could not validate bundled Codex manifest ${installation.manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedTarget = `${platform}-${architecture}`;
  if (manifest.target !== expectedTarget) {
    throw new Error(
      `Bundled Codex targets ${manifest.target}; worker requires ${expectedTarget}.`,
    );
  }
  const bundleDirectory = path.dirname(installation.manifestPath);
  const entrypoint = path.resolve(bundleDirectory, manifest.entrypoint);
  if (path.resolve(installation.binary) !== entrypoint) {
    throw new Error(
      `Bundled Codex entrypoint ${entrypoint} does not match ${installation.binary}.`,
    );
  }
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.resolve(bundleDirectory, artifact.path);
    let actualHash: string;
    try {
      actualHash = await hashFile(artifactPath);
    } catch (error) {
      throw new Error(
        `Could not read bundled Codex artifact ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (actualHash !== artifact.sha256) {
      throw new Error(
        `Bundled Codex artifact ${artifact.path} hash ${actualHash} does not match manifest ${artifact.sha256}.`,
      );
    }
  }
  return manifest;
}
