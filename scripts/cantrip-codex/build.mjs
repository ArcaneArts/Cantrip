import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const buildRecipeVersion = 3;

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
