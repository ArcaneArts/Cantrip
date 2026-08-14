import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  buildDirectory,
  buildManifestPath,
  bundleDirectory,
  executableName,
  filesManifestPath,
  patchSetSha256,
  platformKey,
  prettyJson,
  readCodexPatches,
  readUpstreamMetadata,
  root,
  sha256File,
  upstreamDirectory,
} from "./lib.mjs";

const verify = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "cantrip-codex", "verify-upstream.mjs")],
  { cwd: root, encoding: "utf8", stdio: "inherit" },
);
if (verify.status !== 0) process.exit(verify.status ?? 1);

const executableSuffix = process.platform === "win32" ? ".exe" : "";
const runtimeBinaries = [
  "codex",
  "codex-code-mode-host",
  "codex-responses-api-proxy",
  ...(process.platform === "win32"
    ? ["codex-windows-sandbox-setup", "codex-command-runner"]
    : []),
];
const expectedCompiledArtifacts = [
  ...runtimeBinaries.map((name) => `${name}${executableSuffix}`),
  ...(process.platform === "linux" ? ["codex-resources/bwrap"] : []),
].sort();
const metadata = await readUpstreamMetadata();
const patches = await readCodexPatches();
const sourceManifestSha256 = await sha256File(filesManifestPath);
const patchesSha256 = patchSetSha256(patches);
const buildRecipeVersion = 4;

async function fetchRequired(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Could not download ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

async function ensureDownloadedAsset(url, destination, expectedSha256) {
  try {
    if ((await sha256File(destination)) === expectedSha256) return;
  } catch {
    // Download absent or invalid cached assets below.
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  const response = await fetchRequired(url);
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  const actualSha256 = await sha256File(temporary);
  if (actualSha256 !== expectedSha256) {
    await rm(temporary, { force: true });
    throw new Error(
      `Downloaded ${url} with SHA-256 ${actualSha256}; expected ${expectedSha256}.`,
    );
  }
  await rm(destination, { force: true });
  await rename(temporary, destination);
}

async function configureRustyV8(
  buildEnvironment,
  lockPackages,
  cargoDirectory,
) {
  const v8Package = lockPackages
    .slice(1)
    .find((pkg) => /^\s*name = "v8"/m.test(pkg));
  const version = v8Package?.match(/^\s*version = "([^"]+)"/m)?.[1];
  if (!version)
    throw new Error("Could not resolve the pinned v8 crate version.");

  const rustc = process.platform === "win32" ? "rustc.exe" : "rustc";
  const rustcVersion = spawnSync(rustc, ["-vV"], {
    cwd: cargoDirectory,
    encoding: "utf8",
    env: buildEnvironment,
  });
  if (rustcVersion.status !== 0) {
    process.stderr.write(rustcVersion.stderr ?? "");
    throw new Error("Could not resolve the Rust host target for rusty_v8.");
  }
  const target = rustcVersion.stdout.match(/^host: (\S+)$/m)?.[1];
  if (!target) throw new Error("rustc -vV did not report a host target.");

  const profile = "ptrcomp_sandbox_release";
  const releaseTag = `rusty-v8-v${version}`;
  const baseUrl = `https://github.com/openai/codex/releases/download/${releaseTag}`;
  const archiveName = target.endsWith("-pc-windows-msvc")
    ? `rusty_v8_${profile}_${target}.lib.gz`
    : `librusty_v8_${profile}_${target}.a.gz`;
  const bindingName = `src_binding_${profile}_${target}.rs`;
  const checksumsName = `rusty_v8_${profile}_${target}.sha256`;
  const cacheDirectory = path.join(
    outputDirectory,
    "rusty-v8",
    version,
    target,
  );
  const checksumsResponse = await fetchRequired(`${baseUrl}/${checksumsName}`);
  const checksumLines = (await checksumsResponse.text())
    .replaceAll("\r", "")
    .split("\n")
    .filter(Boolean);
  if (checksumLines.length !== 2) {
    throw new Error(
      `Expected exactly two rusty_v8 checksums for ${target}; found ${checksumLines.length}.`,
    );
  }
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?([^/\\]+)$/);
    if (!match) throw new Error(`Invalid rusty_v8 checksum line: ${line}`);
    checksums.set(match[2], match[1]);
  }
  if (!checksums.has(archiveName) || !checksums.has(bindingName)) {
    throw new Error(
      `The rusty_v8 checksum manifest for ${target} does not cover the expected artifacts.`,
    );
  }

  const archivePath = path.join(cacheDirectory, archiveName);
  const bindingPath = path.join(cacheDirectory, bindingName);
  await ensureDownloadedAsset(
    `${baseUrl}/${archiveName}`,
    archivePath,
    checksums.get(archiveName),
  );
  await ensureDownloadedAsset(
    `${baseUrl}/${bindingName}`,
    bindingPath,
    checksums.get(bindingName),
  );
  buildEnvironment.RUSTY_V8_ARCHIVE = archivePath;
  buildEnvironment.RUSTY_V8_SRC_BINDING_PATH = bindingPath;
  console.log(
    `Verified Codex-built rusty_v8 ${version} artifacts for ${target}.`,
  );
}

async function reusableBundle() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(buildManifestPath(), "utf8"));
  } catch {
    return null;
  }
  const compiledArtifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.filter((artifact) =>
        expectedCompiledArtifacts.includes(artifact?.path),
      )
    : [];
  const compiledArtifactPaths = compiledArtifacts
    .map((artifact) => artifact.path)
    .sort();
  if (
    manifest.schemaVersion !== 1 ||
    manifest.component !== "codex-cli" ||
    manifest.version !== metadata.version ||
    manifest.upstream?.repository !== metadata.repository ||
    manifest.upstream?.ref !== metadata.ref ||
    manifest.upstream?.commit !== metadata.commit ||
    manifest.entrypoint !== executableName() ||
    manifest.target !== platformKey() ||
    manifest.profile !== "release" ||
    JSON.stringify(compiledArtifactPaths) !==
      JSON.stringify(expectedCompiledArtifacts) ||
    !compiledArtifacts.every((artifact) =>
      /^[0-9a-f]{64}$/.test(artifact.sha256 ?? ""),
    )
  ) {
    return null;
  }
  if (
    manifest.buildRecipeVersion !== buildRecipeVersion ||
    manifest.sourceManifestSha256 !== sourceManifestSha256 ||
    manifest.patchesSha256 !== patchesSha256
  ) {
    return null;
  }
  for (const artifact of compiledArtifacts) {
    try {
      if (
        (await sha256File(path.join(bundleDirectory(), artifact.path))) !==
        artifact.sha256
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return compiledArtifacts;
}

async function withDistributionNotices(compiledArtifacts) {
  const artifacts = [...compiledArtifacts];
  for (const name of ["LICENSE", "NOTICE"]) {
    const relative = path.posix.join("licenses", "codex", name);
    const destination = path.join(bundleDirectory(), relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(upstreamDirectory, name), destination);
    artifacts.push({ path: relative, sha256: await sha256File(destination) });
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return artifacts;
}

function runtimeManifest(artifacts) {
  return {
    schemaVersion: 1,
    component: "codex-cli",
    version: metadata.version,
    upstream: {
      repository: metadata.repository,
      ref: metadata.ref,
      commit: metadata.commit,
    },
    sourceManifestSha256,
    patchesSha256,
    buildRecipeVersion,
    entrypoint: executableName(),
    artifacts,
    target: platformKey(),
    profile: "release",
  };
}

const cachedArtifacts = await reusableBundle();
if (cachedArtifacts) {
  const artifacts = await withDistributionNotices(cachedArtifacts);
  await writeFile(buildManifestPath(), prettyJson(runtimeManifest(artifacts)));
  console.log(
    `Reused verified Codex ${metadata.version} build: ${path.relative(root, bundleDirectory())}`,
  );
  process.exit(0);
}

const outputDirectory = buildDirectory();
await mkdir(outputDirectory, { recursive: true });
const preparedRoot = path.join(outputDirectory, "source");
await rm(preparedRoot, { force: true, recursive: true });
await cp(upstreamDirectory, preparedRoot, {
  preserveTimestamps: true,
  recursive: true,
  verbatimSymlinks: true,
});
const preparedRootFromRepository = path
  .relative(root, preparedRoot)
  .split(path.sep)
  .join(path.posix.sep);
for (const patch of patches) {
  const applied = spawnSync(
    "git",
    [
      "apply",
      "--ignore-space-change",
      `--directory=${preparedRootFromRepository}`,
      patch.path,
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (applied.status !== 0) {
    process.stderr.write(applied.stderr ?? "");
    process.exit(applied.status ?? 1);
  }
  const reverseCheck = spawnSync(
    "git",
    [
      "apply",
      "--check",
      "--reverse",
      "--ignore-space-change",
      `--directory=${preparedRootFromRepository}`,
      patch.path,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (reverseCheck.status !== 0) {
    process.stderr.write(reverseCheck.stderr ?? "");
    console.error(
      `Codex patch did not modify the prepared source: ${patch.name}`,
    );
    process.exit(reverseCheck.status ?? 1);
  }
}
console.log(
  `Applied ${patches.length} reviewed Cantrip Codex patch${patches.length === 1 ? "" : "es"}.`,
);
const cargoDirectory = path.join(preparedRoot, "codex-rs");
const cargoTargetDirectory = path.join(outputDirectory, "target");
const releaseDirectory = path.join(cargoTargetDirectory, "release");
const buildEnvironment = {
  ...process.env,
  CARGO_TARGET_DIR: cargoTargetDirectory,
  CARGO_PROFILE_RELEASE_STRIP: "symbols",
  ...(process.platform === "win32"
    ? { LIBSQLITE3_FLAGS: "SQLITE_DISABLE_INTRINSIC" }
    : {}),
};

const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const metadataResult = spawnSync(
  cargo,
  ["metadata", "--format-version", "1", "--no-deps"],
  {
    cwd: cargoDirectory,
    encoding: "utf8",
    env: buildEnvironment,
    maxBuffer: 20 * 1024 * 1024,
  },
);
if (metadataResult.status !== 0) {
  process.stderr.write(metadataResult.stderr ?? "");
  process.exit(metadataResult.status ?? 1);
}
const cargoMetadata = JSON.parse(metadataResult.stdout);
const workspaceVersions = new Map(
  cargoMetadata.packages
    .filter(
      (pkg) =>
        pkg.source === null &&
        path
          .resolve(pkg.manifest_path)
          .startsWith(`${path.resolve(cargoDirectory)}${path.sep}`),
    )
    .map((pkg) => [pkg.name, pkg.version]),
);
const lockPath = path.join(cargoDirectory, "Cargo.lock");
const lockPackages = (await readFile(lockPath, "utf8")).split("[[package]]");
let normalizedPackages = 0;
for (let index = 1; index < lockPackages.length; index += 1) {
  const name = lockPackages[index].match(/^\s*name = "([^"]+)"/m)?.[1];
  const expectedVersion = name ? workspaceVersions.get(name) : undefined;
  if (!expectedVersion || /^\s*source = /m.test(lockPackages[index])) continue;
  lockPackages[index] = lockPackages[index].replace(
    /^(\s*version = ")([^"]+)(")/m,
    (line, prefix, currentVersion, suffix) => {
      if (currentVersion === expectedVersion) return line;
      normalizedPackages += 1;
      return `${prefix}${expectedVersion}${suffix}`;
    },
  );
}
await writeFile(lockPath, lockPackages.join("[[package]]"));
if (normalizedPackages > 0) {
  console.log(
    `Normalized ${normalizedPackages} workspace package versions in the prepared Cargo.lock.`,
  );
} else {
  console.log("Prepared Cargo.lock already matches the workspace manifests.");
}

await configureRustyV8(buildEnvironment, lockPackages, cargoDirectory);

if (process.platform === "linux") {
  const bwrapBuild = spawnSync(
    cargo,
    ["build", "--locked", "--release", "--bin", "bwrap"],
    { cwd: cargoDirectory, env: buildEnvironment, stdio: "inherit" },
  );
  if (bwrapBuild.status !== 0) process.exit(bwrapBuild.status ?? 1);
  const bwrap = path.join(releaseDirectory, "bwrap");
  const strip = spawnSync(
    "strip",
    ["--strip-debug", "--strip-unneeded", bwrap],
    {
      cwd: cargoDirectory,
      stdio: "inherit",
    },
  );
  if (strip.status !== 0) process.exit(strip.status ?? 1);
  buildEnvironment.CODEX_BWRAP_SHA256 = await sha256File(bwrap);
}

const build = spawnSync(
  cargo,
  [
    "build",
    "--locked",
    "--release",
    ...runtimeBinaries.flatMap((binary) => ["--bin", binary]),
  ],
  {
    cwd: cargoDirectory,
    env: buildEnvironment,
    stdio: "inherit",
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const bundle = bundleDirectory();
await rm(bundle, { force: true, recursive: true });
await mkdir(bundle, { recursive: true });
const artifacts = [];
for (const name of runtimeBinaries) {
  const fileName = `${name}${executableSuffix}`;
  const source = path.join(releaseDirectory, fileName);
  const destination = path.join(bundle, fileName);
  await cp(source, destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
  artifacts.push({
    path: fileName,
    sha256: await sha256File(destination),
  });
}
if (process.platform === "linux") {
  const relative = path.join("codex-resources", "bwrap");
  const destination = path.join(bundle, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(releaseDirectory, "bwrap"), destination);
  await chmod(destination, 0o755);
  artifacts.push({ path: relative, sha256: await sha256File(destination) });
}
const manifest = runtimeManifest(await withDistributionNotices(artifacts));
await writeFile(buildManifestPath(), prettyJson(manifest));
console.log(
  `Built Codex ${metadata.version}: ${path.relative(root, bundle)} (${artifacts.length} artifacts)`,
);
