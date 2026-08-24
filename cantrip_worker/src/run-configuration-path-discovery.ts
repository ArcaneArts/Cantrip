import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  runConfigurationPathSuggestionSchema,
  type RunConfigurationPathPurpose,
  type RunConfigurationPathSuggestion,
} from "@cantrip/protocol/run-configuration-definitions";

const MAX_SCANNED_ENTRIES = 20_000;
const MAX_RESULTS = 100;
const MAX_DEPTH = 16;

const GENERATED_DIRECTORIES = new Set([
  ".dart_tool",
  ".git",
  ".gradle",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const SHELL_SCRIPT_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".cmd",
  ".fish",
  ".ps1",
  ".sh",
  ".zsh",
]);

interface SearchDirectory {
  absolutePath: string;
  depth: number;
  relativePath: string;
}

export interface RunConfigurationPathDiscoveryResult {
  suggestions: RunConfigurationPathSuggestion[];
  truncated: boolean;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function matchesQuery(relativePath: string, query: string): boolean {
  return relativePath.toLowerCase().includes(query);
}

function isEnvironmentFile(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.endsWith(".env")
  );
}

function resultRank(
  suggestion: RunConfigurationPathSuggestion,
  query: string,
): [number, number, string] {
  const normalized = suggestion.path.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  const depth = suggestion.path === "." ? 0 : suggestion.path.split("/").length;
  if (!query)
    return [depth, suggestion.kind === "directory" ? 0 : 1, normalized];
  if (normalized === query) return [0, depth, normalized];
  if (basename === query) return [1, depth, normalized];
  if (basename.startsWith(query)) return [2, depth, normalized];
  if (normalized.startsWith(query)) return [3, depth, normalized];
  return [4, depth, normalized];
}

function addSuggestion(
  suggestions: RunConfigurationPathSuggestion[],
  candidate: RunConfigurationPathSuggestion,
): void {
  const parsed = runConfigurationPathSuggestionSchema.safeParse(candidate);
  if (parsed.success) suggestions.push(parsed.data);
}

function compareResults(
  left: RunConfigurationPathSuggestion,
  right: RunConfigurationPathSuggestion,
  query: string,
): number {
  const leftRank = resultRank(left, query);
  const rightRank = resultRank(right, query);
  return (
    leftRank[0] - rightRank[0] ||
    leftRank[1] - rightRank[1] ||
    leftRank[2].localeCompare(rightRank[2])
  );
}

export async function discoverRunConfigurationPaths(input: {
  purpose: RunConfigurationPathPurpose;
  query: string;
  sourceRoot: string;
}): Promise<RunConfigurationPathDiscoveryResult> {
  const root = await realpath(input.sourceRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) {
    throw new Error("The Run configuration source root is not a directory.");
  }

  const query = portablePath(
    input.query.trim().replaceAll("\\", "/"),
  ).toLowerCase();
  const suggestions: RunConfigurationPathSuggestion[] = [];
  const queue: SearchDirectory[] = [
    { absolutePath: root, depth: 0, relativePath: "." },
  ];
  let scannedEntries = 0;
  let truncated = false;
  let queueIndex = 0;

  if (input.purpose === "directory" && matchesQuery(".", query)) {
    addSuggestion(suggestions, { kind: "directory", path: "." });
  }

  scan: while (queueIndex < queue.length) {
    const directory = queue[queueIndex++]!;
    let entries;
    try {
      entries = await readdir(directory.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCANNED_ENTRIES) {
        truncated = true;
        break scan;
      }
      if (entry.isSymbolicLink()) continue;

      const relativePath =
        directory.relativePath === "."
          ? entry.name
          : `${directory.relativePath}/${entry.name}`;
      const absolutePath = path.join(directory.absolutePath, entry.name);
      let metadata;
      let canonicalPath;
      try {
        metadata = await lstat(absolutePath);
        if (metadata.isSymbolicLink()) continue;
        canonicalPath = await realpath(absolutePath);
      } catch {
        continue;
      }
      if (!isInside(root, canonicalPath)) continue;

      if (metadata.isDirectory()) {
        if (GENERATED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        if (
          input.purpose === "directory" &&
          matchesQuery(relativePath, query)
        ) {
          addSuggestion(suggestions, {
            kind: "directory",
            path: relativePath,
          });
          if (!query && suggestions.length > MAX_RESULTS) {
            truncated = true;
            break scan;
          }
        }
        if (directory.depth >= MAX_DEPTH) {
          truncated = true;
        } else {
          queue.push({
            absolutePath: canonicalPath,
            depth: directory.depth + 1,
            relativePath,
          });
        }
        continue;
      }

      if (!metadata.isFile() || input.purpose === "directory") continue;
      const purposeMatches =
        input.purpose === "file" ||
        (input.purpose === "environment-file" &&
          isEnvironmentFile(entry.name)) ||
        (input.purpose === "shell-script" &&
          (SHELL_SCRIPT_EXTENSIONS.has(
            path.extname(entry.name).toLowerCase(),
          ) ||
            (metadata.mode & 0o111) !== 0));
      if (purposeMatches && matchesQuery(relativePath, query)) {
        addSuggestion(suggestions, { kind: "file", path: relativePath });
        if (!query && suggestions.length > MAX_RESULTS) {
          truncated = true;
          break scan;
        }
      }
    }
  }

  suggestions.sort((left, right) => compareResults(left, right, query));
  return {
    suggestions: suggestions.slice(0, MAX_RESULTS),
    truncated: truncated || suggestions.length > MAX_RESULTS,
  };
}
