import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { codeCacheRoot, exists, run, upstreamRoot } from "./lib.mjs";

export function nodeArchive(version, target) {
  const platform = target.platform === "win32" ? "win" : target.platform;
  const arch = target.arch === "armhf" ? "armv7l" : target.arch;
  const extension = target.platform === "win32" ? "zip" : "tar.gz";
  const basename = `node-v${version}-${platform}-${arch}`;
  return { basename, filename: `${basename}.${extension}` };
}

export function checksumForArchive(checksums, filename) {
  for (const line of checksums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (match?.[2] === filename) return match[1];
  }
  throw new Error(`Node release checksums do not contain ${filename}`);
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Toolchain download failed: ${response.status} ${response.statusText} (${url})`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function ensureBuildNode(target) {
  const version = (
    await readFile(path.join(upstreamRoot, ".nvmrc"), "utf8")
  ).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid pinned Cantrip Code Node version: ${version}`);
  }
  const archive = nodeArchive(version, target);
  const destination = path.join(
    codeCacheRoot,
    "toolchains",
    `node-v${version}-${target.id}`,
  );
  const node = path.join(
    destination,
    target.platform === "win32" ? "node.exe" : "bin/node",
  );
  const npmCli = path.join(
    destination,
    target.platform === "win32" ? "node_modules" : "lib/node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if ((await exists(node)) && (await exists(npmCli))) {
    return { version, directory: destination, node, npmCli };
  }

  const baseUrl = `https://nodejs.org/dist/v${version}`;
  console.log(`Downloading pinned Node ${version} build toolchain...`);
  const [checksums, archiveContents] = await Promise.all([
    download(`${baseUrl}/SHASUMS256.txt`).then((value) =>
      value.toString("utf8"),
    ),
    download(`${baseUrl}/${archive.filename}`),
  ]);
  const expected = checksumForArchive(checksums, archive.filename);
  const actual = createHash("sha256").update(archiveContents).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Pinned Node archive checksum mismatch: expected ${expected}, received ${actual}`,
    );
  }

  const staging = `${destination}.staging-${process.pid}`;
  const archivePath = path.join(staging, archive.filename);
  const extracted = path.join(staging, archive.basename);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(archivePath, archiveContents);
  try {
    await run("tar", ["-xf", archivePath, "-C", staging]);
    if (
      !(await exists(
        path.join(
          extracted,
          target.platform === "win32" ? "node.exe" : "bin/node",
        ),
      ))
    ) {
      throw new Error(
        "Pinned Node archive did not contain the expected executable",
      );
    }
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(extracted, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (!(await exists(npmCli))) {
    throw new Error("Pinned Node archive did not contain the npm CLI");
  }
  return { version, directory: destination, node, npmCli };
}

export function environmentForBuildNode(toolchain, additions = {}) {
  const binDirectory =
    process.platform === "win32"
      ? toolchain.directory
      : path.join(toolchain.directory, "bin");
  return {
    ...process.env,
    ...additions,
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

export function npmLifecycleEnvironmentForTarget(target) {
  // Several OpenVSCode native dependencies reference the same shared
  // node-addon-api MSBuild project. npm otherwise runs their lifecycle scripts
  // concurrently, which makes Windows builds race while writing the project's
  // lastbuildstate file. Foreground scripts are deliberately serialized by
  // npm's lifecycle runner; keep that workaround Windows-only so other hosts
  // retain their existing install parallelism.
  return target.platform === "win32"
    ? { npm_config_foreground_scripts: "true" }
    : {};
}
