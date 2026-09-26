import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  bundleDirectory,
  filesManifestPath,
  patchSetSha256,
  platformKey,
  readCodexPatches,
  readUpstreamMetadata,
  sha256File,
} from "./lib.mjs";

const execute = promisify(execFile);
const protocolChecks = {
  "ClientRequest.ts": [
    '"turn/pause"',
    '"thread/settings/update"',
    '"turn/settings/update"',
    '"thread/settings/read"',
    '"thread/settings/operation/read"',
    '"thread/managedConfig/update"',
    '"thread/managedExecution/bind"',
    '"thread/managedExecution/resolve"',
    '"thread/managedExecution/invalidate"',
    '"thread/managedExecution/wake"',
    '"thread/managedExecution/queueDelete"',
    '"thread/managedContext/reset"',
    '"thread/managedHistory/export"',
    '"thread/managedHistory/import"',
    '"model/managedCatalog/update"',
    '"thread/attachment/add"',
    '"account/gatewayOAuth/read"',
    '"rollout/compress"',
  ],
  "v2/ThreadSettings.ts": [
    "settingsVersion",
    "subagentModel",
    "multiAgentEnabled",
  ],
  "v2/ThreadHistoryTurnMetadata.ts": ["initialSettings", "retention"],
};

async function expectedRuntime() {
  return {
    metadata: await readUpstreamMetadata(),
    sourceManifestSha256: await sha256File(filesManifestPath),
    patchesSha256: patchSetSha256(await readCodexPatches()),
    target: platformKey(),
  };
}

/** Exercise the packaged executable, not just the source or manifest version. */
export async function verifyBuiltRuntime(
  directory,
  { expected, run = execute } = {},
) {
  expected ??= await expectedRuntime();
  const manifest = JSON.parse(
    await readFile(path.join(directory, "codex-runtime.json"), "utf8"),
  );
  const { metadata } = expected;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.component !== "codex-cli" ||
    manifest.version !== metadata.version ||
    manifest.upstream?.repository !== metadata.repository ||
    manifest.upstream?.ref !== metadata.ref ||
    manifest.upstream?.commit !== metadata.commit ||
    manifest.sourceManifestSha256 !== expected.sourceManifestSha256 ||
    manifest.patchesSha256 !== expected.patchesSha256 ||
    manifest.target !== expected.target ||
    manifest.entrypoint !==
      (expected.target.startsWith("win32-") ? "codex.exe" : "codex") ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0
  ) {
    throw new Error(
      "Packaged Codex manifest does not match the pinned source and patches.",
    );
  }
  const artifactPaths = new Set();
  for (const artifact of manifest.artifacts) {
    if (
      typeof artifact.path !== "string" ||
      artifact.path.length === 0 ||
      path.isAbsolute(artifact.path) ||
      artifact.path.split(/[\\/]/u).includes("..") ||
      artifactPaths.has(artifact.path) ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    ) {
      throw new Error("Invalid packaged Codex artifact entry.");
    }
    artifactPaths.add(artifact.path);
    if (
      (await sha256File(path.join(directory, artifact.path))) !==
      artifact.sha256
    ) {
      throw new Error(
        `Packaged Codex artifact hash mismatch: ${artifact.path}`,
      );
    }
  }
  if (!artifactPaths.has(manifest.entrypoint)) {
    throw new Error(
      "Packaged Codex entrypoint is not covered by its artifact hashes.",
    );
  }
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-codex-release-"),
  );
  try {
    const home = path.join(temporary, "home");
    await mkdir(home);
    const binary = path.resolve(directory, manifest.entrypoint);
    const options = {
      env: { ...process.env, CODEX_HOME: home },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    };
    const version = await run(binary, ["--version"], options);
    if (version.stdout.trim() !== `codex-cli ${metadata.version}`) {
      throw new Error(
        `Packaged executable reported unexpected version: ${version.stdout.trim()}`,
      );
    }
    const out = path.join(temporary, "typescript");
    await run(
      binary,
      ["app-server", "generate-ts", "--experimental", "--out", out],
      options,
    );
    for (const [file, fields] of Object.entries(protocolChecks)) {
      const source = await readFile(path.join(out, file), "utf8");
      for (const field of fields) {
        if (!source.includes(field)) {
          throw new Error(
            `Packaged Codex protocol is missing ${field} in ${file}.`,
          );
        }
      }
    }
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = process.argv[2]
    ? path.resolve(process.argv[2])
    : bundleDirectory();
  const manifest = await verifyBuiltRuntime(directory);
  console.log(
    `Verified packaged Codex ${manifest.version}: artifact hashes, executable version, and upstream/Cantrip protocol extensions.`,
  );
}
