import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  explorerDirectoryCommitsSchema,
  explorerDirectorySchema,
  explorerFileSchema,
  explorerMediaFileChunkSchema,
  explorerMediaFileSchema,
  explorerMediaTypeForPath,
  type ExplorerDirectoryCommits,
  type ExplorerDirectory,
  type ExplorerFile,
  type ExplorerLastCommit,
  type ExplorerMediaFile,
  type ExplorerMediaFileChunk,
} from "@cantrip/protocol";

const DIRECTORY_LIMIT = 1_000;
const FILE_SIZE_LIMIT = 2 * 1024 * 1024;
const GIT_STDERR_LIMIT = 64 * 1024;
const execFileAsync = promisify(execFile);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const TEXT_EXTENSIONS = new Set([
  ".c",
  ".bat",
  ".cc",
  ".conf",
  ".config",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".dart",
  ".env",
  ".go",
  ".gradle",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".ignore",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".log",
  ".lua",
  ".mjs",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sol",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ...MARKDOWN_EXTENSIONS,
]);
const TEXT_FILENAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  "dockerfile",
  "gradlew",
  "license",
  "makefile",
  "readme",
]);

function markdownFile(name: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function textFile(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_FILENAMES.has(lower) || TEXT_EXTENSIONS.has(path.extname(lower));
}

function viewableFile(name: string): boolean {
  return textFile(name) || explorerMediaTypeForPath(name) !== null;
}

function fileVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathSegments(relativePath: string): string[] {
  if (
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new Error("Explorer paths must be relative to the project.");
  }
  const segments = relativePath.split("/").filter((segment) => segment !== "");
  if (
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || segment.includes("\\"),
    )
  ) {
    throw new Error("Explorer path traversal is not allowed.");
  }
  return segments;
}

async function resolveEntry(root: string, relativePath: string) {
  const rootPath = await realpath(root);
  const targetPath = path.resolve(rootPath, ...pathSegments(relativePath));
  if (
    targetPath !== rootPath &&
    !targetPath.startsWith(`${rootPath}${path.sep}`)
  ) {
    throw new Error("Explorer path is outside the project.");
  }
  const metadata = await lstat(targetPath);
  if (metadata.isSymbolicLink()) {
    throw new Error("Explorer does not follow symbolic links.");
  }
  const resolvedTarget = await realpath(targetPath);
  if (
    resolvedTarget !== rootPath &&
    !resolvedTarget.startsWith(`${rootPath}${path.sep}`)
  ) {
    throw new Error("Explorer path is outside the project.");
  }
  return { metadata, targetPath: resolvedTarget };
}

export async function listExplorerDirectory(
  root: string,
  relativePath: string,
): Promise<ExplorerDirectory> {
  const { metadata, targetPath } = await resolveEntry(root, relativePath);
  if (!metadata.isDirectory())
    throw new Error("Explorer path is not a directory.");
  const entries = (await readdir(targetPath, { withFileTypes: true })).filter(
    (entry) => entry.name !== ".git",
  );
  entries.sort((left, right) => {
    const leftRank = left.isDirectory() ? 0 : left.isFile() ? 1 : 2;
    const rightRank = right.isDirectory() ? 0 : right.isFile() ? 1 : 2;
    return (
      leftRank - rightRank ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
  });
  const visible = entries.slice(0, DIRECTORY_LIMIT);
  const result = await Promise.all(
    visible.map(async (entry) => {
      const entryPath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
      const entryMetadata = await lstat(path.join(targetPath, entry.name));
      const kind = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";
      return {
        name: entry.name,
        path: entryPath,
        kind,
        size: kind === "file" ? entryMetadata.size : null,
        modifiedAt: entryMetadata.mtime.toISOString(),
        viewable: kind === "file" && viewableFile(entry.name),
        markdown: kind === "file" && markdownFile(entry.name),
      } as const;
    }),
  );
  return explorerDirectorySchema.parse({
    path: relativePath,
    entries: result,
    truncated: entries.length > DIRECTORY_LIMIT,
  });
}

function immediateEntryPath(
  directoryPath: string,
  filePath: string,
  visiblePaths: ReadonlySet<string>,
): string | null {
  const prefix = directoryPath ? `${directoryPath}/` : "";
  if (prefix && !filePath.startsWith(prefix)) return null;
  const relative = prefix ? filePath.slice(prefix.length) : filePath;
  const name = relative.split("/", 1)[0];
  if (!name) return null;
  const candidate = prefix ? `${directoryPath}/${name}` : name;
  return visiblePaths.has(candidate) ? candidate : null;
}

async function gitHeadAvailable(root: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"],
      { encoding: "utf8" },
    );
    return true;
  } catch {
    return false;
  }
}

function appendStderr(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-GIT_STDERR_LIMIT);
}

async function trackedImmediateEntries(
  root: string,
  directoryPath: string,
  visiblePaths: ReadonlySet<string>,
): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", root, "ls-files", "--cached", "-z", "--", directoryPath || "."],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const tracked = new Set<string>();
    let buffer = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const paths = buffer.split("\0");
      buffer = paths.pop() ?? "";
      for (const filePath of paths) {
        const entryPath = immediateEntryPath(
          directoryPath,
          filePath,
          visiblePaths,
        );
        if (entryPath) tracked.add(entryPath);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendStderr(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(tracked);
      else
        reject(new Error(stderr.trim() || "Git tracked-file lookup failed."));
    });
  });
}

function parseCommitRecord(
  record: string,
): { commit: ExplorerLastCommit; paths: string[] } | null {
  const fields = record.split("\0");
  const [hash, shortHash, authorName, authorEmail, authoredAt, subject] =
    fields;
  if (!hash || !shortHash || !authoredAt) return null;
  const rawPaths = fields.slice(6).filter(Boolean);
  const paths = rawPaths.map((filePath, index) =>
    index === 0 && filePath.startsWith("\n") ? filePath.slice(1) : filePath,
  );
  return {
    commit: {
      hash,
      shortHash,
      subject: (subject ?? "").slice(0, 10_000),
      authorName: (authorName || "Unknown").slice(0, 1_000),
      authorEmail: (authorEmail ?? "").slice(0, 1_000),
      authoredAt,
    },
    paths,
  };
}

async function lastCommitsForEntries(
  root: string,
  directoryPath: string,
  visiblePaths: ReadonlySet<string>,
  trackedPaths: ReadonlySet<string>,
): Promise<Map<string, ExplorerLastCommit>> {
  if (trackedPaths.size === 0) return new Map();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-C",
        root,
        "log",
        "--date=iso-strict",
        "--find-renames",
        "--format=%x1e%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        directoryPath || ".",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const commits = new Map<string, ExplorerLastCommit>();
    const unresolved = new Set(trackedPaths);
    let buffer = "";
    let stderr = "";
    let stoppedEarly = false;
    let settled = false;

    const consumeRecord = (record: string) => {
      const parsed = parseCommitRecord(record);
      if (!parsed) return;
      for (const filePath of parsed.paths) {
        const entryPath = immediateEntryPath(
          directoryPath,
          filePath,
          visiblePaths,
        );
        if (!entryPath || !unresolved.delete(entryPath)) continue;
        commits.set(entryPath, parsed.commit);
      }
      if (unresolved.size === 0 && !stoppedEarly) {
        stoppedEarly = true;
        child.kill();
      }
    };

    const drain = (final: boolean) => {
      const firstRecord = buffer.indexOf("\x1e");
      if (firstRecord < 0) {
        if (final) buffer = "";
        return;
      }
      if (firstRecord > 0) buffer = buffer.slice(firstRecord);
      for (;;) {
        const nextRecord = buffer.indexOf("\x1e", 1);
        if (nextRecord < 0) break;
        consumeRecord(buffer.slice(1, nextRecord));
        buffer = buffer.slice(nextRecord);
      }
      if (final && buffer.startsWith("\x1e")) {
        consumeRecord(buffer.slice(1));
        buffer = "";
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      drain(false);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendStderr(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      drain(true);
      if (code === 0 || stoppedEarly) resolve(commits);
      else reject(new Error(stderr.trim() || "Git history lookup failed."));
    });
  });
}

export async function listExplorerDirectoryCommits(
  root: string,
  relativePath: string,
): Promise<ExplorerDirectoryCommits> {
  const directory = await listExplorerDirectory(root, relativePath);
  const unavailable = () =>
    explorerDirectoryCommitsSchema.parse({
      path: relativePath,
      available: false,
      entries: [],
    });
  if (!(await gitHeadAvailable(root))) return unavailable();

  const visiblePaths = new Set(directory.entries.map(({ path }) => path));
  try {
    const trackedPaths = await trackedImmediateEntries(
      root,
      relativePath,
      visiblePaths,
    );
    const commits = await lastCommitsForEntries(
      root,
      relativePath,
      visiblePaths,
      trackedPaths,
    );
    return explorerDirectoryCommitsSchema.parse({
      path: relativePath,
      available: true,
      entries: directory.entries.map((entry) => ({
        path: entry.path,
        tracked: trackedPaths.has(entry.path),
        lastCommit: commits.get(entry.path) ?? null,
      })),
    });
  } catch {
    return unavailable();
  }
}

export async function readExplorerFile(
  root: string,
  relativePath: string,
): Promise<ExplorerFile> {
  const { metadata, targetPath } = await resolveEntry(root, relativePath);
  if (!metadata.isFile() || !textFile(path.basename(targetPath))) {
    throw new Error("This file type is not available for preview.");
  }
  if (metadata.size > FILE_SIZE_LIMIT) {
    throw new Error("Text previews are limited to 2 MB.");
  }
  const bytes = await readFile(targetPath);
  if (bytes.includes(0)) throw new Error("Binary files cannot be previewed.");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Only UTF-8 text files can be previewed.");
  }
  return explorerFileSchema.parse({
    path: relativePath,
    content,
    size: metadata.size,
    markdown: markdownFile(targetPath),
    version: fileVersion(bytes),
  });
}

export async function statExplorerMediaFile(
  root: string,
  relativePath: string,
): Promise<ExplorerMediaFile> {
  const { metadata, targetPath } = await resolveEntry(root, relativePath);
  const mediaType = explorerMediaTypeForPath(targetPath);
  if (!metadata.isFile() || !mediaType) {
    throw new Error("This file type is not available as media.");
  }
  return explorerMediaFileSchema.parse({
    path: relativePath,
    ...mediaType,
    size: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
  });
}

export async function readExplorerMediaFile(
  root: string,
  relativePath: string,
  offset: number,
  limit: number,
): Promise<ExplorerMediaFileChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("The media read offset is invalid.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 * 1_024) {
    throw new Error("The media read limit is invalid.");
  }
  const { targetPath } = await resolveEntry(root, relativePath);
  const mediaType = explorerMediaTypeForPath(targetPath);
  if (!mediaType) throw new Error("This file type is not available as media.");
  const handle = await open(
    targetPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("This file type is not available as media.");
    }
    if (offset > metadata.size) {
      throw new Error("The media read offset is outside the file.");
    }
    const requestedBytes = Math.min(limit, metadata.size - offset);
    const bytes = Buffer.alloc(requestedBytes);
    let bytesRead = 0;
    while (bytesRead < requestedBytes) {
      const result = await handle.read(
        bytes,
        bytesRead,
        requestedBytes - bytesRead,
        offset + bytesRead,
      );
      if (result.bytesRead === 0) {
        throw new Error("The media file changed while it was being read.");
      }
      bytesRead += result.bytesRead;
    }
    const verifiedMetadata = await handle.stat();
    if (
      verifiedMetadata.size !== metadata.size ||
      verifiedMetadata.mtimeMs !== metadata.mtimeMs
    ) {
      throw new Error("The media file changed while it was being read.");
    }
    return explorerMediaFileChunkSchema.parse({
      path: relativePath,
      ...mediaType,
      size: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      offset,
      data: bytes.toString("base64"),
      eof: offset + bytesRead >= metadata.size,
    });
  } finally {
    await handle.close();
  }
}

export async function writeExplorerFile(
  root: string,
  relativePath: string,
  content: string,
  version: string,
): Promise<ExplorerFile> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > FILE_SIZE_LIMIT) {
    throw new Error("Text files are limited to 2 MB.");
  }
  const { targetPath } = await resolveEntry(root, relativePath);
  const handle = await open(
    targetPath,
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !textFile(path.basename(targetPath))) {
      throw new Error("This file type is not available for editing.");
    }
    if (metadata.size > FILE_SIZE_LIMIT) {
      throw new Error("Text files are limited to 2 MB.");
    }
    const currentBytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < currentBytes.byteLength) {
      const { bytesRead } = await handle.read(
        currentBytes,
        offset,
        currentBytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const verifiedMetadata = await handle.stat();
    if (
      offset !== currentBytes.byteLength ||
      verifiedMetadata.size !== metadata.size ||
      fileVersion(currentBytes) !== version
    ) {
      throw new Error(
        "This file changed on disk. Reload it before saving your edits.",
      );
    }
    await handle.truncate(0);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return readExplorerFile(root, relativePath);
}
