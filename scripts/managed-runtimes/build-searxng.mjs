#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, lstat, readdir, realpath } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import {
  copyInputs,
  downloadPinned,
  extractedBytes,
  hostTarget,
  inputRoot,
  mkdir,
  path,
  pythonExecutable,
  readFile,
  readLock,
  rename,
  rm,
  root,
  run,
  sha256,
  stat,
  tarArgumentPath,
  writeFile,
} from "./searxng-lib.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const lock = await readLock();
const target = option("--target", hostTarget());
if (!target || !lock.targets[target])
  throw new Error(`unsupported target: ${target ?? "unknown"}`);
if (target !== hostTarget() && !process.argv.includes("--allow-cross")) {
  throw new Error(
    `runtime artifacts must be built natively (${target} requested on ${hostTarget()})`,
  );
}

const outputRoot = path.resolve(
  option("--output", path.join(root, "dist", "managed-runtimes", "searxng")),
);
const cache = path.resolve(
  option("--cache", path.join(root, ".cache", "managed-runtimes")),
);
const work = path.join(outputRoot, `.work-${target}`);
const runtime = path.join(work, "runtime");
await rm(work, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });

const pythonArchive = path.join(
  cache,
  path.basename(new URL(lock.targets[target].assetUrl).pathname),
);
const searxArchive = path.join(cache, `searxng-${lock.searxng.commit}.tar.gz`);
await downloadPinned({
  url: lock.targets[target].assetUrl,
  destination: pythonArchive,
  bytes: lock.targets[target].assetBytes,
  digest: lock.targets[target].assetSha256,
});
await downloadPinned({
  url: lock.searxng.sourceUrl,
  destination: searxArchive,
  bytes: lock.searxng.sourceBytes,
  digest: lock.searxng.sourceSha256,
});

const pythonStage = path.join(work, "python-stage");
const searxStage = path.join(work, "searx-stage");
await mkdir(pythonStage, { recursive: true });
await mkdir(searxStage, { recursive: true });
await run(
  "tar",
  [
    "-xzf",
    tarArgumentPath(pythonArchive, work),
    "-C",
    tarArgumentPath(pythonStage, work),
  ],
  { cwd: work },
);
await run(
  "tar",
  [
    "-xzf",
    tarArgumentPath(searxArchive, work),
    "-C",
    tarArgumentPath(searxStage, work),
  ],
  { cwd: work },
);
const pythonRoots = await readdir(pythonStage, { withFileTypes: true });
const pythonContainer =
  pythonRoots.length === 1 && pythonRoots[0].isDirectory()
    ? path.join(pythonStage, pythonRoots[0].name)
    : pythonStage;
const nestedInstall = path.join(pythonContainer, "install");
const install = await stat(nestedInstall)
  .then((value) => (value.isDirectory() ? nestedInstall : pythonContainer))
  .catch(() => pythonContainer);
await rename(install, path.join(runtime, "python"));
const searxRoots = (await readdir(searxStage, { withFileTypes: true })).filter(
  (entry) => entry.isDirectory(),
);
if (searxRoots.length !== 1)
  throw new Error("SearXNG archive must contain one root directory");
await mkdir(path.join(runtime, "app"), { recursive: true });
await rename(
  path.join(searxStage, searxRoots[0].name),
  path.join(runtime, "app", "searxng"),
);
const frozenVersion = `# SPDX-License-Identifier: AGPL-3.0-or-later
# Generated from runtime.lock.json; avoids invoking host git at runtime.
VERSION_STRING = "${lock.bundleVersion}"
VERSION_TAG = "${lock.bundleVersion}"
DOCKER_TAG = "${lock.bundleVersion}"
GIT_URL = "${lock.searxng.repository}"
GIT_BRANCH = "${lock.searxng.commit}"
`;
await writeFile(
  path.join(runtime, "app", "searxng", "searx", "version_frozen.py"),
  frozenVersion,
);
await copyInputs(runtime);

const python = pythonExecutable(runtime);
const requirements = path.join(inputRoot, "requirements.lock");
await run(python, [
  "-I",
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "--require-hashes",
  "--only-binary=:all:",
  "--no-deps",
  "-r",
  requirements,
]);

await mkdir(path.join(runtime, "licenses", "searxng"), { recursive: true });
await run(process.execPath, [
  path.join(import.meta.dirname, "copy-license-files.mjs"),
  path.join(runtime, "python"),
  path.join(runtime, "licenses", "python-runtime"),
]);
await run(process.execPath, [
  path.join(import.meta.dirname, "copy-license-files.mjs"),
  path.join(runtime, "app", "searxng"),
  path.join(runtime, "licenses", "searxng"),
]);
await run(python, [
  "-I",
  path.join(inputRoot, "tools", "inventory.py"),
  runtime,
]);

const buildInfo = {
  schemaVersion: 1,
  component: "searxng",
  version: lock.bundleVersion,
  target,
  searxngCommit: lock.searxng.commit,
  pythonVersion: lock.python.version,
  inputs: {
    python: lock.targets[target].assetSha256,
    searxng: lock.searxng.sourceSha256,
    requirements: await sha256(requirements),
  },
};
await writeFile(
  path.join(runtime, "build-info.json"),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
);
await mkdir(path.join(runtime, "source"), { recursive: true });
await writeFile(
  path.join(runtime, "source", "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      correspondingSourceRelease: `cantrip-searxng-${lock.bundleVersion}-sources.tar.gz`,
      searxng: {
        url: lock.searxng.sourceUrl,
        sha256: lock.searxng.sourceSha256,
      },
      python: {
        repository: lock.python.repository,
        release: lock.python.distributionRelease,
        artifactSha256: lock.targets[target].assetSha256,
      },
      requirementsLockSha256: await sha256(requirements),
    },
    null,
    2,
  )}\n`,
);
await smoke(runtime, process.argv.includes("--external-smoke"));
await materializeSymlinks(runtime);

const artifactName = `cantrip-searxng-${lock.bundleVersion}-${target}.zip`;
const artifactPath = path.join(outputRoot, artifactName);
await rm(artifactPath, { force: true });
await run(python, [
  "-I",
  path.join(inputRoot, "tools", "archive_runtime.py"),
  runtime,
  artifactPath,
]);
const descriptor = {
  schemaVersion: 1,
  component: "searxng",
  version: lock.bundleVersion,
  platform: lock.targets[target].platform,
  architecture: lock.targets[target].architecture,
  archiveFormat: "zip",
  compressedBytes: (await stat(artifactPath)).size,
  extractedBytes: await extractedBytes(runtime),
  sha256: await sha256(artifactPath),
  licenseManifest: "licenses/manifest.json",
  sourceManifest: "source/manifest.json",
  fileName: artifactName,
  minimumOs: lock.targets[target].minimumOs,
  minimumKernel: lock.targets[target].minimumKernel,
  minimumLibc: lock.targets[target].minimumLibc,
};
for (const key of Object.keys(descriptor))
  if (descriptor[key] === undefined) delete descriptor[key];
await writeFile(
  path.join(outputRoot, `${artifactName}.descriptor.json`),
  `${JSON.stringify(descriptor, null, 2)}\n`,
);

if (process.argv.includes("--with-sources"))
  await buildSources(lock, outputRoot, searxArchive);
await rm(work, { recursive: true, force: true });
console.log(JSON.stringify(descriptor, null, 2));

async function smoke(runtimeRoot, external) {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const templateName = external ? "settings.yml" : "smoke-settings.yml";
  const template = await readFile(
    path.join(runtimeRoot, "config-template", templateName),
    "utf8",
  );
  const settings = path.join(runtimeRoot, "smoke-settings.yml");
  const smokeHome = path.join(runtimeRoot, ".home");
  const smokeTemp = path.join(runtimeRoot, ".tmp");
  await mkdir(smokeHome, { recursive: true });
  await mkdir(smokeTemp, { recursive: true });
  await writeFile(
    settings,
    template
      .replace("__CANTRIP_PORT__", String(port))
      .replace("__CANTRIP_SECRET__", randomBytes(32).toString("hex")),
    { mode: 0o600 },
  );
  const child = spawn(
    pythonExecutable(runtimeRoot),
    [
      "-I",
      path.join(runtimeRoot, "launcher", "serve.py"),
      "--port",
      String(port),
      "--settings",
      settings,
    ],
    {
      cwd: runtimeRoot,
      env: {
        PATH: "",
        HOME: smokeHome,
        TMPDIR: smokeTemp,
        TEMP: smokeTemp,
        TMP: smokeTemp,
        ...(process.platform === "win32" && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let diagnostics = "";
  child.stdout.on("data", (chunk) => {
    diagnostics += chunk;
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        ready = response.ok;
      } catch {}
      if (ready) break;
      if (child.exitCode !== null)
        throw new Error(`launcher exited early:\n${diagnostics.slice(-4000)}`);
    }
    if (!ready)
      throw new Error(
        `SearXNG readiness timed out:\n${diagnostics.slice(-4000)}`,
      );
    const engine = external ? "duckduckgo,wikipedia,brave" : "cantrip offline";
    const queries = external
      ? ["Python programming language", "World Wide Web", "OpenAI"]
      : ["deterministic fixture"];
    let lastStatus = 0;
    let lastBody;
    for (const query of queries) {
      const response = await fetch(
        `http://127.0.0.1:${port}/search?q=${encodeURIComponent(query)}&format=json&engines=${encodeURIComponent(engine)}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      lastStatus = response.status;
      lastBody = await response.json();
      if (
        response.ok &&
        Array.isArray(lastBody.results) &&
        lastBody.results.length > 0
      )
        break;
    }
    if (
      lastStatus < 200 ||
      lastStatus >= 300 ||
      !Array.isArray(lastBody?.results) ||
      lastBody.results.length < 1
    )
      throw new Error(
        `search smoke failed (${lastStatus}): ${JSON.stringify(lastBody).slice(0, 2_000)}`,
      );
  } finally {
    if (child.exitCode === null) terminate(child, "SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) terminate(child, "SIGKILL");
    await rm(settings, { force: true });
    await rm(smokeHome, { recursive: true, force: true });
    await rm(smokeTemp, { recursive: true, force: true });
  }
}

function terminate(child, signal) {
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function buildSources(runtimeLock, destination, searxSource) {
  const sourceRoot = path.join(destination, ".sources");
  await rm(sourceRoot, { recursive: true, force: true });
  await mkdir(path.join(sourceRoot, "python-packages"), { recursive: true });
  await pipeline(
    (await import("node:fs")).createReadStream(searxSource),
    createWriteStream(path.join(sourceRoot, path.basename(searxSource))),
  );
  const locked = parseLockedRequirements(
    await readFile(path.join(inputRoot, "requirements.lock"), "utf8"),
  );
  for (const dependency of locked) {
    const response = await fetch(
      `https://pypi.org/pypi/${encodeURIComponent(dependency.name)}/${encodeURIComponent(dependency.version)}/json`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok)
      throw new Error(
        `PyPI metadata unavailable for ${dependency.name} ${dependency.version}`,
      );
    const metadata = await response.json();
    const candidate = metadata.urls.find(
      (item) =>
        item.packagetype === "sdist" &&
        dependency.hashes.has(item.digests.sha256),
    );
    if (!candidate)
      throw new Error(
        `no lock-verified source distribution for ${dependency.name} ${dependency.version}`,
      );
    await downloadPinned({
      url: candidate.url,
      destination: path.join(sourceRoot, "python-packages", candidate.filename),
      bytes: candidate.size,
      digest: candidate.digests.sha256,
    });
  }
  await writeFile(
    path.join(sourceRoot, "SOURCE-OFFER.json"),
    `${JSON.stringify({ schemaVersion: 1, component: "searxng", version: runtimeLock.bundleVersion, searxngCommit: runtimeLock.searxng.commit, packages: locked.map(({ name, version }) => ({ name, version })) }, null, 2)}\n`,
  );
  const sourceName = `cantrip-searxng-${runtimeLock.bundleVersion}-sources.tar.gz`;
  await run("tar", [
    "-czf",
    path.join(destination, sourceName),
    "-C",
    sourceRoot,
    ".",
  ]);
  await rm(sourceRoot, { recursive: true, force: true });
}

export function parseLockedRequirements(contents) {
  const records = [];
  let current = null;
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(
      /^([A-Za-z0-9_.-]+)==([^ ;\\]+)(?:\s*;.*)?(?:\s*\\)?$/,
    );
    if (match) {
      current = { name: match[1], version: match[2], hashes: new Set() };
      records.push(current);
    }
    const hash = line.match(/--hash=sha256:([a-f0-9]{64})/);
    if (hash && current) current.hashes.add(hash[1]);
  }
  return records;
}

async function materializeSymlinks(rootDirectory) {
  const resolvedRoot = await realpath(rootDirectory);
  const inodes = new Set();
  await visit(rootDirectory);

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        const resolved = await realpath(candidate);
        const relation = path.relative(resolvedRoot, resolved);
        if (relation.startsWith("..") || path.isAbsolute(relation)) {
          throw new Error(`runtime symlink escapes the artifact: ${candidate}`);
        }
        const target = await stat(resolved);
        await rm(candidate, { recursive: true, force: true });
        await cp(resolved, candidate, {
          dereference: true,
          recursive: target.isDirectory(),
        });
      } else if (metadata.isDirectory()) {
        await visit(candidate);
      } else if (metadata.isFile() && metadata.nlink > 1) {
        const key = `${metadata.dev}:${metadata.ino}`;
        if (inodes.has(key)) {
          const replacement = `${candidate}.materialized-${randomBytes(6).toString("hex")}`;
          await cp(candidate, replacement);
          await rm(candidate, { force: true });
          await rename(replacement, candidate);
        } else {
          inodes.add(key);
        }
      }
    }
  }
}

export { smoke };
