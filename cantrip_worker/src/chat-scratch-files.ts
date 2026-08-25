import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  explorerDirectorySchema,
  explorerEntryMutationResultSchema,
  explorerFileSchema,
  explorerMediaFileChunkSchema,
  explorerMediaTypeForPath,
  standaloneChatFileDownloadChunkSchema,
  standaloneChatFileDownloadPreparedSchema,
  type ExplorerDirectory,
  type ExplorerEntryMutationResult,
  type ExplorerFile,
  type ExplorerMediaFileChunk,
  type StandaloneChatFileDownloadChunk,
  type StandaloneChatFileDownloadKind,
  type StandaloneChatFileDownloadPrepared,
} from "@cantrip/protocol";

const DIRECTORY_ENTRY_LIMIT = 1_000;
const FILE_PREVIEW_LIMIT = 2 * 1024 * 1024;
const MEDIA_PREVIEW_LIMIT = 32 * 1024 * 1024;
const DOWNLOAD_ENTRY_LIMIT = 2_000;
const DOWNLOAD_FILE_LIMIT = 128 * 1024 * 1024;
const DOWNLOAD_TOTAL_LIMIT = 128 * 1024 * 1024;
const DOWNLOAD_OUTPUT_LIMIT = 160 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY_LIMIT = 4;
const DOWNLOAD_TTL_MS = 5 * 60_000;
const PATH_DEPTH_LIMIT = 32;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const TEXT_EXTENSIONS = new Set([
  ".bat",
  ".c",
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
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".log",
  ".lua",
  ".md",
  ".mdx",
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

interface PreparedDownload {
  createdAt: number;
  fileName: string;
  mimeType: string;
  nextOffset: number;
  path: string;
  root: string;
  size: number;
}

interface DownloadFile {
  absolutePath: string;
  archivePath: string;
  modifiedAt: Date;
  size: number;
}

function scratchPathSegments(relativePath: string): string[] {
  if (
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/u.test(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw new Error("Chat file paths must be relative to the scratch folder.");
  }
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Chat file path traversal is not allowed.");
  }
  if (segments.length > PATH_DEPTH_LIMIT) {
    throw new Error("Chat file paths are too deeply nested.");
  }
  return segments;
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function markdownFile(fileName: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function textFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return TEXT_FILENAMES.has(lower) || TEXT_EXTENSIONS.has(path.extname(lower));
}

function fileVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeDownloadName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-")
    .trim();
  return (normalized || "chat-files").slice(0, 240);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date: Date): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  };
}

async function verifiedScratchRoot(root: string): Promise<string> {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("The Chat scratch root is not a safe directory.");
  }
  return realpath(root);
}

async function resolveScratchEntry(
  root: string,
  relativePath: string,
  allowRoot = false,
): Promise<{
  absolutePath: string;
  metadata: Stats;
  root: string;
}> {
  const canonicalRoot = await verifiedScratchRoot(root);
  const segments = scratchPathSegments(relativePath);
  if (!allowRoot && segments.length === 0) {
    throw new Error("A Chat file path is required.");
  }
  let candidate = canonicalRoot;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    if (!pathInside(canonicalRoot, candidate)) {
      throw new Error("Chat file path escaped the scratch folder.");
    }
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error("Chat file operations do not follow symbolic links.");
    }
  }
  return {
    absolutePath: candidate,
    metadata: await lstat(candidate),
    root: canonicalRoot,
  };
}

async function writeZip(
  target: string,
  files: DownloadFile[],
): Promise<number> {
  const handle = await open(target, "wx", 0o600);
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (const file of files) {
      const bytes = await readFile(file.absolutePath);
      if (bytes.byteLength !== file.size) {
        throw new Error("A Chat file changed while its archive was prepared.");
      }
      const name = Buffer.from(file.archivePath.replaceAll(path.sep, "/"));
      const checksum = crc32(bytes);
      const timestamp = dosTimestamp(file.modifiedAt);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(timestamp.time, 10);
      local.writeUInt16LE(timestamp.date, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(bytes.byteLength, 18);
      local.writeUInt32LE(bytes.byteLength, 22);
      local.writeUInt16LE(name.byteLength, 26);
      local.writeUInt16LE(0, 28);
      await handle.write(local);
      await handle.write(name);
      await handle.write(bytes);

      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50, 0);
      directory.writeUInt16LE(20, 4);
      directory.writeUInt16LE(20, 6);
      directory.writeUInt16LE(0x0800, 8);
      directory.writeUInt16LE(0, 10);
      directory.writeUInt16LE(timestamp.time, 12);
      directory.writeUInt16LE(timestamp.date, 14);
      directory.writeUInt32LE(checksum, 16);
      directory.writeUInt32LE(bytes.byteLength, 20);
      directory.writeUInt32LE(bytes.byteLength, 24);
      directory.writeUInt16LE(name.byteLength, 28);
      directory.writeUInt16LE(0, 30);
      directory.writeUInt16LE(0, 32);
      directory.writeUInt16LE(0, 34);
      directory.writeUInt16LE(0, 36);
      directory.writeUInt32LE(0, 38);
      directory.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([directory, name]));
      offset += local.byteLength + name.byteLength + bytes.byteLength;
      if (offset > DOWNLOAD_OUTPUT_LIMIT) {
        throw new Error("The Chat files archive is too large.");
      }
    }

    const centralOffset = offset;
    for (const entry of central) {
      await handle.write(entry);
      offset += entry.byteLength;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await handle.write(end);
    offset += end.byteLength;
    if (offset > DOWNLOAD_OUTPUT_LIMIT) {
      throw new Error("The Chat files archive is too large.");
    }
    return offset;
  } finally {
    await handle.close();
  }
}

export class ChatScratchFileManager {
  readonly #downloads = new Map<string, PreparedDownload>();
  readonly #stagingRoot: string;

  constructor(dataDirectory: string) {
    this.#stagingRoot = path.resolve(dataDirectory, "chat-file-downloads");
  }

  async resolveReference(root: string, rawReference: string): Promise<string> {
    const canonicalRoot = await verifiedScratchRoot(root);
    let reference = rawReference
      .trim()
      .replace(/#L\d+(?:C\d+)?$/iu, "")
      .replace(/:\d+(?::\d+)?$/u, "");
    if (/^file:/iu.test(reference)) {
      const url = new URL(reference);
      if (url.protocol !== "file:") {
        throw new Error("Chat file reference is not a local file URL.");
      }
      reference = decodeURIComponent(url.pathname);
      if (process.platform === "win32" && /^\/[A-Za-z]:\//u.test(reference)) {
        reference = reference.slice(1);
      }
    }
    let relativePath: string;
    if (path.isAbsolute(reference)) {
      if (!pathInside(canonicalRoot, reference)) {
        throw new Error("Chat file reference is outside the scratch folder.");
      }
      relativePath = path.relative(canonicalRoot, reference);
    } else {
      const normalized = reference.replaceAll("\\", "/");
      const displayPrefix = `chat-scratch/${path.basename(canonicalRoot)}/`;
      relativePath = normalized.startsWith(displayPrefix)
        ? normalized.slice(displayPrefix.length)
        : normalized;
    }
    const normalizedPath = scratchPathSegments(relativePath).join("/");
    await resolveScratchEntry(canonicalRoot, normalizedPath);
    return normalizedPath;
  }

  async list(root: string, relativePath: string): Promise<ExplorerDirectory> {
    const resolved = await resolveScratchEntry(root, relativePath, true);
    if (!resolved.metadata.isDirectory()) {
      throw new Error("Chat file path is not a directory.");
    }
    const entries = await readdir(resolved.absolutePath, {
      withFileTypes: true,
    });
    entries.sort((left, right) => {
      const leftRank = left.isDirectory() ? 0 : left.isFile() ? 1 : 2;
      const rightRank = right.isDirectory() ? 0 : right.isFile() ? 1 : 2;
      return (
        leftRank - rightRank ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      );
    });
    const visible = entries.slice(0, DIRECTORY_ENTRY_LIMIT);
    const summaries = await Promise.all(
      visible.map(async (entry) => {
        const absolutePath = path.join(resolved.absolutePath, entry.name);
        const metadata = await lstat(absolutePath);
        const symbolicLink = metadata.isSymbolicLink();
        const kind = symbolicLink
          ? "other"
          : metadata.isDirectory()
            ? "directory"
            : metadata.isFile()
              ? "file"
              : "other";
        const entryPath = relativePath
          ? `${relativePath}/${entry.name}`
          : entry.name;
        return {
          kind,
          markdown: kind === "file" && markdownFile(entry.name),
          modifiedAt: metadata.mtime.toISOString(),
          name: entry.name,
          path: entryPath,
          size: kind === "file" ? metadata.size : null,
          symbolicLink,
          viewable:
            kind === "file" &&
            (textFile(entry.name) ||
              explorerMediaTypeForPath(entry.name) !== null),
        } as const;
      }),
    );
    return explorerDirectorySchema.parse({
      path: relativePath,
      entries: summaries,
      truncated: entries.length > DIRECTORY_ENTRY_LIMIT,
    });
  }

  async read(root: string, relativePath: string): Promise<ExplorerFile> {
    const resolved = await resolveScratchEntry(root, relativePath);
    if (!resolved.metadata.isFile()) {
      throw new Error("Chat file path is not a file.");
    }
    if (resolved.metadata.size > FILE_PREVIEW_LIMIT) {
      throw new Error("Chat file is too large to preview as text.");
    }
    const bytes = await readFile(resolved.absolutePath);
    return explorerFileSchema.parse({
      path: relativePath,
      content: bytes.toString("utf8"),
      size: bytes.byteLength,
      markdown: markdownFile(relativePath),
      version: fileVersion(bytes),
    });
  }

  async readMedia(
    root: string,
    relativePath: string,
    offset: number,
    limit: number,
  ): Promise<ExplorerMediaFileChunk> {
    const media = explorerMediaTypeForPath(relativePath);
    if (!media) throw new Error("Chat file is not supported media.");
    const resolved = await resolveScratchEntry(root, relativePath);
    if (!resolved.metadata.isFile()) {
      throw new Error("Chat media path is not a file.");
    }
    if (resolved.metadata.size > MEDIA_PREVIEW_LIMIT) {
      throw new Error("Chat media file is too large to preview.");
    }
    if (offset > resolved.metadata.size) {
      throw new Error("Chat media offset is outside the file.");
    }
    const handle = await open(resolved.absolutePath, "r");
    try {
      const bytes = Buffer.alloc(
        Math.min(limit, resolved.metadata.size - offset),
      );
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      return explorerMediaFileChunkSchema.parse({
        path: relativePath,
        ...media,
        size: resolved.metadata.size,
        modifiedAt: resolved.metadata.mtime.toISOString(),
        offset,
        data: bytes.subarray(0, bytesRead).toString("base64"),
        eof: offset + bytesRead === resolved.metadata.size,
      });
    } finally {
      await handle.close();
    }
  }

  async write(
    root: string,
    relativePath: string,
    content: string,
    version: string,
  ): Promise<ExplorerFile> {
    const resolved = await resolveScratchEntry(root, relativePath);
    if (!resolved.metadata.isFile()) {
      throw new Error("Chat file path is not a file.");
    }
    const current = await readFile(resolved.absolutePath);
    if (fileVersion(current) !== version) {
      throw new Error(
        "Chat file changed since it was opened. Reload it first.",
      );
    }
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > FILE_PREVIEW_LIMIT) {
      throw new Error("Chat file content exceeds the write limit.");
    }
    const temporary = path.join(
      path.dirname(resolved.absolutePath),
      `.${path.basename(resolved.absolutePath)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, resolved.absolutePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return explorerFileSchema.parse({
      path: relativePath,
      content,
      size: bytes.byteLength,
      markdown: markdownFile(relativePath),
      version: fileVersion(bytes),
    });
  }

  async delete(
    root: string,
    relativePath: string,
    recursive: boolean,
  ): Promise<ExplorerEntryMutationResult> {
    const resolved = await resolveScratchEntry(root, relativePath);
    if (resolved.metadata.isDirectory() && !recursive) {
      const children = await readdir(resolved.absolutePath);
      if (children.length > 0) {
        throw new Error("Recursive confirmation is required for this folder.");
      }
    }
    await rm(resolved.absolutePath, {
      recursive: resolved.metadata.isDirectory(),
      force: false,
    });
    return explorerEntryMutationResultSchema.parse({
      path: relativePath,
      newPath: null,
    });
  }

  async prepareDownload(input: {
    root: string;
    kind: StandaloneChatFileDownloadKind;
    path: string;
  }): Promise<StandaloneChatFileDownloadPrepared> {
    await this.#expireDownloads();
    if (this.#downloads.size >= DOWNLOAD_CONCURRENCY_LIMIT) {
      throw new Error(
        "Too many Chat file downloads are already being prepared.",
      );
    }
    await mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 });
    const downloadId = randomUUID();
    const temporary = path.join(this.#stagingRoot, downloadId);
    const canonicalRoot = await verifiedScratchRoot(input.root);
    let fileName: string;
    let mimeType: string;
    let size: number;
    try {
      if (input.kind === "file") {
        const resolved = await resolveScratchEntry(canonicalRoot, input.path);
        if (!resolved.metadata.isFile()) {
          throw new Error("Chat download path is not a file.");
        }
        if (resolved.metadata.size > DOWNLOAD_FILE_LIMIT) {
          throw new Error("Chat file exceeds the download limit.");
        }
        await copyFile(resolved.absolutePath, temporary);
        await chmod(temporary, 0o600).catch((error: unknown) => {
          if (process.platform !== "win32") throw error;
        });
        size = resolved.metadata.size;
        fileName = safeDownloadName(path.basename(input.path));
        mimeType =
          explorerMediaTypeForPath(input.path)?.mimeType ??
          (textFile(input.path)
            ? "text/plain;charset=utf-8"
            : "application/octet-stream");
      } else {
        const resolved = await resolveScratchEntry(
          canonicalRoot,
          input.path,
          input.kind === "all",
        );
        if (!resolved.metadata.isDirectory()) {
          throw new Error("Chat archive path is not a folder.");
        }
        const archivePrefix =
          input.kind === "folder" ? path.basename(resolved.absolutePath) : "";
        const files = await this.#collectDownloadFiles(
          resolved.root,
          resolved.absolutePath,
          archivePrefix,
        );
        size = await writeZip(temporary, files);
        fileName = `${safeDownloadName(
          input.kind === "all" ? "chat-files" : path.basename(input.path),
        )}.zip`;
        mimeType = "application/zip";
      }
      const prepared = {
        createdAt: Date.now(),
        fileName,
        mimeType,
        nextOffset: 0,
        path: temporary,
        root: canonicalRoot,
        size,
      };
      this.#downloads.set(downloadId, prepared);
      return standaloneChatFileDownloadPreparedSchema.parse({
        downloadId,
        fileName,
        mimeType,
        size,
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readDownload(
    root: string,
    downloadId: string,
    offset: number,
    limit: number,
  ): Promise<StandaloneChatFileDownloadChunk> {
    await this.#expireDownloads();
    const download = this.#downloads.get(downloadId);
    if (!download)
      throw new Error("Chat file download is no longer available.");
    if (download.root !== (await verifiedScratchRoot(root))) {
      throw new Error("Chat file download belongs to another scratch folder.");
    }
    if (offset !== download.nextOffset || offset > download.size) {
      throw new Error("Chat file download offset is stale.");
    }
    const handle = await open(download.path, "r");
    let result: StandaloneChatFileDownloadChunk;
    let eof = false;
    try {
      const bytes = Buffer.alloc(Math.min(limit, download.size - offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      download.nextOffset += bytesRead;
      eof = download.nextOffset === download.size;
      result = standaloneChatFileDownloadChunkSchema.parse({
        downloadId,
        offset,
        data: bytes.subarray(0, bytesRead).toString("base64"),
        eof,
      });
    } finally {
      await handle.close();
    }
    if (eof) await this.cancelDownload(downloadId);
    return result;
  }

  async cancelDownload(downloadId: string, root?: string): Promise<void> {
    const download = this.#downloads.get(downloadId);
    if (
      download &&
      root &&
      download.root !== (await verifiedScratchRoot(root))
    ) {
      throw new Error("Chat file download belongs to another scratch folder.");
    }
    this.#downloads.delete(downloadId);
    if (download)
      await rm(download.path, { force: true }).catch(() => undefined);
  }

  async #collectDownloadFiles(
    canonicalRoot: string,
    directory: string,
    prefix: string,
  ): Promise<DownloadFile[]> {
    const files: DownloadFile[] = [];
    let totalBytes = 0;
    const visit = async (current: string, relative: string, depth: number) => {
      if (depth > PATH_DEPTH_LIMIT) {
        throw new Error(
          "Chat archive contains paths that are too deeply nested.",
        );
      }
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);
        if (!pathInside(canonicalRoot, absolutePath)) {
          throw new Error("Chat archive path escaped its scratch folder.");
        }
        const metadata = await lstat(absolutePath);
        if (metadata.isSymbolicLink()) {
          throw new Error("Chat archives cannot contain symbolic links.");
        }
        const archivePath = relative ? `${relative}/${entry.name}` : entry.name;
        if (metadata.isDirectory()) {
          await visit(absolutePath, archivePath, depth + 1);
          continue;
        }
        if (!metadata.isFile()) {
          throw new Error("Chat archives can contain only files and folders.");
        }
        if (metadata.size > DOWNLOAD_FILE_LIMIT) {
          throw new Error("A Chat file exceeds the archive limit.");
        }
        totalBytes += metadata.size;
        if (totalBytes > DOWNLOAD_TOTAL_LIMIT) {
          throw new Error("Chat files exceed the archive size limit.");
        }
        files.push({
          absolutePath,
          archivePath: prefix ? `${prefix}/${archivePath}` : archivePath,
          modifiedAt: metadata.mtime,
          size: metadata.size,
        });
        if (files.length > DOWNLOAD_ENTRY_LIMIT) {
          throw new Error("Chat files exceed the archive entry limit.");
        }
      }
    };
    await visit(directory, "", 0);
    return files;
  }

  async #expireDownloads(): Promise<void> {
    const cutoff = Date.now() - DOWNLOAD_TTL_MS;
    await Promise.all(
      [...this.#downloads]
        .filter(([, download]) => download.createdAt < cutoff)
        .map(([downloadId]) => this.cancelDownload(downloadId)),
    );
  }
}
