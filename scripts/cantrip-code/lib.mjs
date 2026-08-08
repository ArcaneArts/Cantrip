import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const codeRoot = path.join(root, "cantrip_code");
export const upstreamRoot = path.join(codeRoot, "upstream");
export const upstreamConfigPath = path.join(codeRoot, "upstream.json");
export const upstreamFilesPath = path.join(codeRoot, "upstream.files.json");
export const patchesRoot = path.join(codeRoot, "patches");

export function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const name = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) flags.add(name);
    else {
      values.set(name, next);
      index += 1;
    }
  }
  return {
    flag: (name) => flags.has(name),
    optional: (name) => values.get(name),
    required: (name) => {
      const value = values.get(name);
      if (!value) throw new Error(`Missing required --${name}`);
      return value;
    },
  };
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: process.env,
      stdio: options.quiet ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (status === 0) resolve();
      else
        reject(
          new Error(
            `${command} exited with ${status ?? `signal ${String(signal)}`}`,
          ),
        );
    });
  });
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function walkFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await walkFiles(absolute, relative)));
    else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relative.split(path.sep).join("/"));
    } else throw new Error(`Unsupported upstream entry: ${relative}`);
  }
  return files;
}

export async function createSourceManifest(directory = upstreamRoot) {
  const files = [];
  const regularFiles = [];
  for (const relative of await walkFiles(directory)) {
    const absolute = path.join(directory, relative);
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) {
      const target = await readlink(absolute);
      files.push({
        path: relative,
        type: "symlink",
        sha256: sha256Text(target),
      });
    } else {
      const repositoryPath = path.relative(root, absolute);
      if (repositoryPath.startsWith("..")) {
        throw new Error(
          `Cannot hash source outside the repository: ${absolute}`,
        );
      }
      regularFiles.push({ path: relative, repositoryPath });
    }
  }
  const hashed = spawnSync("git", ["hash-object", "--stdin-paths"], {
    cwd: root,
    encoding: "utf8",
    input: `${regularFiles.map((file) => file.repositoryPath).join("\n")}\n`,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (hashed.status !== 0) {
    throw new Error(
      `git hash-object failed: ${hashed.stderr || `status ${hashed.status}`}`,
    );
  }
  const hashes = hashed.stdout.trim().split("\n");
  if (hashes.length !== regularFiles.length) {
    throw new Error(
      `git hash-object returned ${hashes.length} hashes for ${regularFiles.length} files`,
    );
  }
  regularFiles.forEach((file, index) => {
    files.push({ path: file.path, type: "file", gitHash: hashes[index] });
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { schemaVersion: 2, files };
}

export async function downloadUpstream({ sha, output }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Invalid OpenVSCode commit SHA: ${sha}`);
  }
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-code-fetch-"),
  );
  const archive = path.join(temporary, `${sha}.tar.gz`);
  const extracted = path.join(temporary, "source");
  await mkdir(extracted);
  try {
    const url = `https://github.com/gitpod-io/openvscode-server/archive/${sha}.tar.gz`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(
        `Upstream download failed: ${response.status} ${response.statusText}`,
      );
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    await run("tar", [
      "-xzf",
      archive,
      "--strip-components=1",
      "-C",
      extracted,
    ]);
    if (!(await exists(path.join(extracted, "LICENSE.txt")))) {
      throw new Error("Downloaded source is missing LICENSE.txt");
    }
    if (!(await exists(path.join(extracted, "package.json")))) {
      throw new Error("Downloaded source is missing package.json");
    }
    await mkdir(path.dirname(output), { recursive: true });
    await rename(extracted, output);
    return output;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
