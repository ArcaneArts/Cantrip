import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  explorerDirectorySchema,
  explorerFileSchema,
  type ExplorerDirectory,
  type ExplorerFile,
} from "@cantrip/protocol";

const DIRECTORY_LIMIT = 1_000;
const FILE_SIZE_LIMIT = 2 * 1024 * 1024;
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
  ".svg",
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

function viewableFile(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_FILENAMES.has(lower) || TEXT_EXTENSIONS.has(path.extname(lower));
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

export async function readExplorerFile(
  root: string,
  relativePath: string,
): Promise<ExplorerFile> {
  const { metadata, targetPath } = await resolveEntry(root, relativePath);
  if (!metadata.isFile() || !viewableFile(path.basename(targetPath))) {
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
  });
}
