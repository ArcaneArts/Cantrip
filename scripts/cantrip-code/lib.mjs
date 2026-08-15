import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  cp,
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
export const extensionsRoot = path.join(codeRoot, "extensions");
export const codeBuildRoot = path.join(codeRoot, ".build");

export function resolveSharedCodeStateRoot() {
  if (process.env.CANTRIP_CODE_CACHE_DIR) {
    return path.resolve(process.env.CANTRIP_CODE_CACHE_DIR);
  }

  const commonDirectory = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root, encoding: "utf8" },
  );
  if (commonDirectory.status === 0) {
    const gitDirectory = commonDirectory.stdout.trim();
    if (gitDirectory) {
      return path.join(path.dirname(gitDirectory), ".cantrip-code");
    }
  }

  return path.join(root, ".cantrip-code");
}

export const sharedCodeStateRoot = resolveSharedCodeStateRoot();
export const codeCacheRoot = path.join(sharedCodeStateRoot, "cache");

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
      env: { ...process.env, ...(options.env ?? {}) },
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

export async function copyDirectory(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

export async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
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

export function normalizeGitPath(value, separator = path.sep) {
  return value.split(separator).join("/");
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
      const relativeToRepository = path.relative(root, absolute);
      if (
        relativeToRepository === ".." ||
        relativeToRepository.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToRepository)
      ) {
        throw new Error(
          `Cannot hash source outside the repository: ${absolute}`,
        );
      }
      // Git's attribute matching always uses slash-delimited repository paths.
      // Passing Windows-native backslashes to `hash-object --stdin-paths`
      // opens the files but bypasses the nested text attributes, so CRLF
      // checkout bytes produce different hashes from the pinned manifest.
      const repositoryPath = normalizeGitPath(relativeToRepository);
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
