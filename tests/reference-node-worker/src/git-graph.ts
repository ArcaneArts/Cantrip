import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  gitGraphCommitOverlaySchema,
  gitGraphMetricsSchema,
  gitGraphSnapshotSchema,
  gitRelativePathSchema,
  type GitCommitDetail,
  type GitGraphCommitOverlay,
  type GitGraphMetrics,
  type GitGraphNode,
  type GitGraphNodeMetrics,
  type GitGraphSnapshot,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const GRAPH_ANALYZER_VERSION = 1;
const GRAPH_GIT_BUFFER = 128 * 1024 * 1024;
const GRAPH_CACHE_LIMIT = 16;
const GRAPH_BLAME_FILE_LIMIT = 80;
const GRAPH_BLAME_LINE_LIMIT = 75_000;
const MILLISECONDS_PER_DAY = 86_400_000;

interface GraphContext {
  branch: string | null;
  commonDirectory: string;
  revision: string | null;
  rootObjectId: string | null;
  rootPath: string | null;
}

interface CacheEntry<T> {
  lastUsed: number;
  value: Promise<T>;
}

interface MutableMetrics {
  additions: number;
  binaryCommitTouches: number;
  binary: boolean | null;
  commitTouches: number;
  deletions: number;
  firstChangedAt: string | null;
  lastChangedAt: string | null;
  lineCount: number | null;
}

interface MutableBlame {
  authors: Map<string, { email: string; lines: number; name: string }>;
  lineCount: number;
  totalAgeDays: number;
}

interface BlameAnalysis {
  byNodeId: Map<string, MutableBlame>;
  coverage: {
    analyzedFiles: number;
    totalFiles: number;
    truncated: boolean;
  };
}

const snapshotCache = new Map<string, CacheEntry<GitGraphSnapshot>>();
const metricsCache = new Map<string, CacheEntry<GitGraphMetrics>>();
const latestMetricsCache = new Map<
  string,
  { lastUsed: number; metrics: GitGraphMetrics }
>();

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: GRAPH_GIT_BUFFER,
  });
  return stdout;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}

async function gitRawAllowNoMatches(
  cwd: string,
  args: string[],
): Promise<string> {
  try {
    return await gitRaw(cwd, args);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    throw error;
  }
}

function cacheValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  create: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.value;
  }
  const value = create().catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { lastUsed: Date.now(), value });
  if (cache.size > GRAPH_CACHE_LIMIT) {
    const oldest = [...cache.entries()]
      .filter(([candidate]) => candidate !== key)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return value;
}

export function clearGitGraphAnalysisCache(): void {
  snapshotCache.clear();
  metricsCache.clear();
  latestMetricsCache.clear();
}

function normalizeRootPath(rootPath: string | null): string | null {
  return rootPath === null ? null : gitRelativePathSchema.parse(rootPath);
}

function normalizeRevision(revision: string): string {
  const normalized = revision.trim();
  if (
    !normalized ||
    normalized.length > 1_024 ||
    normalized.startsWith("-") ||
    /[\0\r\n]/u.test(normalized)
  ) {
    throw new Error("Expected a safe Git graph revision.");
  }
  return normalized;
}

function normalizeMaxNodes(maxNodes: number): number {
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 100_000) {
    throw new Error("Git graph maxNodes must be between 1 and 100000.");
  }
  return maxNodes;
}

async function resolveGraphContext(
  cwd: string,
  requestedRevision: string,
  requestedRootPath: string | null,
): Promise<GraphContext> {
  const rootPath = normalizeRootPath(requestedRootPath);
  const revisionRequest = normalizeRevision(requestedRevision);
  const commonDirectoryText = await gitOutput(cwd, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const commonDirectory = await realpath(
    path.isAbsolute(commonDirectoryText)
      ? commonDirectoryText
      : path.resolve(cwd, commonDirectoryText),
  );
  const branch =
    (await gitOutput(cwd, ["branch", "--show-current"]).catch(() => "")) ||
    null;
  let revision: string | null;
  try {
    revision = await gitOutput(cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revisionRequest}^{commit}`,
    ]);
  } catch (error) {
    if (revisionRequest !== "HEAD") throw error;
    revision = null;
  }

  if (!revision) {
    return {
      branch,
      commonDirectory,
      revision: null,
      rootObjectId: null,
      rootPath,
    };
  }

  const rootObjectRevision = rootPath
    ? `${revision}:${rootPath}`
    : `${revision}^{tree}`;
  const rootType = await gitOutput(cwd, [
    "cat-file",
    "-t",
    rootObjectRevision,
  ]).catch(() => "");
  if (rootType !== "tree") {
    throw new Error(
      rootPath
        ? `Git graph root is not a directory: ${rootPath}`
        : "Git graph revision does not contain a tree.",
    );
  }
  return {
    branch,
    commonDirectory,
    revision,
    rootObjectId: await gitOutput(cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      rootObjectRevision,
    ]),
    rootPath,
  };
}

function graphNodeId(kind: GitGraphNode["kind"], nodePath: string | null) {
  return `${kind}:${nodePath ?? "."}`;
}

function directoryId(directoryPath: string | null) {
  return graphNodeId("directory", directoryPath);
}

function pathWithinRoot(nodePath: string, rootPath: string | null): boolean {
  return (
    rootPath === null ||
    nodePath === rootPath ||
    nodePath.startsWith(`${rootPath}/`)
  );
}

function parentPath(nodePath: string, rootPath: string | null): string | null {
  const parent = path.posix.dirname(nodePath);
  if (parent === "." || parent === rootPath) return rootPath;
  return pathWithinRoot(parent, rootPath) ? parent : rootPath;
}

function languageForPath(nodePath: string): string | null {
  const filename = path.posix.basename(nodePath).toLowerCase();
  const special: Record<string, string> = {
    dockerfile: "Dockerfile",
    gemfile: "Ruby",
    makefile: "Makefile",
    procfile: "Procfile",
  };
  if (special[filename]) return special[filename];
  const extension = path.posix.extname(filename).slice(1);
  const languages: Record<string, string> = {
    c: "C",
    cc: "C++",
    cpp: "C++",
    cs: "C#",
    css: "CSS",
    dart: "Dart",
    go: "Go",
    h: "C/C++ Header",
    html: "HTML",
    java: "Java",
    js: "JavaScript",
    json: "JSON",
    jsx: "JavaScript",
    kt: "Kotlin",
    kts: "Kotlin",
    md: "Markdown",
    php: "PHP",
    py: "Python",
    rb: "Ruby",
    rs: "Rust",
    sh: "Shell",
    sql: "SQL",
    swift: "Swift",
    toml: "TOML",
    ts: "TypeScript",
    tsx: "TypeScript",
    vue: "Vue",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
    zig: "Zig",
  };
  return languages[extension] ?? (extension ? extension.toUpperCase() : null);
}

function parseTreeEntry(record: string): {
  mode: string;
  objectId: string;
  nodePath: string;
  size: number | null;
  type: string;
} | null {
  const separator = record.indexOf("\t");
  if (separator < 0) return null;
  const [mode, type, objectId, sizeText] = record
    .slice(0, separator)
    .trim()
    .split(/\s+/u);
  const nodePath = record.slice(separator + 1);
  if (!mode || !type || !objectId || !nodePath) return null;
  const parsedSize = Number.parseInt(sizeText ?? "", 10);
  return {
    mode,
    type,
    objectId,
    nodePath,
    size: Number.isFinite(parsedSize) ? parsedSize : null,
  };
}

function nodeKind(entry: { mode: string; type: string }): GitGraphNode["kind"] {
  if (entry.type === "tree") return "directory";
  if (entry.type === "commit" || entry.mode === "160000") return "submodule";
  if (entry.mode === "120000") return "symlink";
  return "file";
}

function aggregateDirectorySizes(nodes: GitGraphNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.kind === "directory") node.byteSize = 0;
  }
  for (const node of [...nodes].reverse()) {
    if (node.parentId === null || node.byteSize === null) continue;
    const parent = byId.get(node.parentId);
    if (parent?.kind === "directory") {
      parent.byteSize = (parent.byteSize ?? 0) + node.byteSize;
    }
  }
}

async function createSnapshot(
  cwd: string,
  context: GraphContext,
  maxNodes: number,
): Promise<GitGraphSnapshot> {
  const rootId = directoryId(context.rootPath);
  const rootNode: GitGraphNode = {
    id: rootId,
    path: context.rootPath,
    parentId: null,
    name: context.rootPath
      ? path.posix.basename(context.rootPath)
      : path.basename(await realpath(cwd)) || "Repository",
    kind: "directory",
    objectId: context.rootObjectId,
    byteSize: 0,
    extension: null,
    language: null,
  };
  if (!context.revision) {
    return gitGraphSnapshotSchema.parse({
      analyzerVersion: GRAPH_ANALYZER_VERSION,
      revision: null,
      branch: context.branch,
      rootPath: context.rootPath,
      rootId,
      nodes: [rootNode],
      totalNodes: 1,
      truncated: false,
      analyzedAt: new Date().toISOString(),
      analysis: {
        structure: "ready",
        lines: "ready",
        history: "ready",
        blame: "unavailable",
      },
    });
  }

  const args = [
    "ls-tree",
    "-r",
    "-t",
    "-l",
    "-z",
    "--full-tree",
    context.revision,
  ];
  if (context.rootPath) args.push("--", context.rootPath);
  const entries = (await gitRaw(cwd, args))
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const entry = parseTreeEntry(record);
      if (!entry || !pathWithinRoot(entry.nodePath, context.rootPath))
        return [];
      if (
        context.rootPath !== null &&
        entry.nodePath === context.rootPath &&
        entry.type === "tree"
      ) {
        return [];
      }
      return [entry];
    });
  const visible = entries.slice(0, Math.max(0, maxNodes - 1));
  const nodes: GitGraphNode[] = [
    rootNode,
    ...visible.map((entry) => {
      const kind = nodeKind(entry);
      const extension =
        kind === "file"
          ? path.posix.extname(entry.nodePath).slice(1).toLowerCase() || null
          : null;
      return {
        id: graphNodeId(kind, entry.nodePath),
        path: entry.nodePath,
        parentId: directoryId(parentPath(entry.nodePath, context.rootPath)),
        name: path.posix.basename(entry.nodePath),
        kind,
        objectId: entry.objectId,
        byteSize: kind === "directory" ? 0 : entry.size,
        extension,
        language: kind === "file" ? languageForPath(entry.nodePath) : null,
      };
    }),
  ];
  aggregateDirectorySizes(nodes);
  return gitGraphSnapshotSchema.parse({
    analyzerVersion: GRAPH_ANALYZER_VERSION,
    revision: context.revision,
    branch: context.branch,
    rootPath: context.rootPath,
    rootId,
    nodes,
    totalNodes: entries.length + 1,
    truncated: entries.length + 1 > nodes.length,
    analyzedAt: new Date().toISOString(),
    analysis: {
      structure: "ready",
      lines: "pending",
      history: "pending",
      blame: "deferred",
    },
  });
}

export async function readGitGraphSnapshot(
  cwd: string,
  revision = "HEAD",
  rootPath: string | null = null,
  maxNodes = 100_000,
): Promise<GitGraphSnapshot> {
  const nodeLimit = normalizeMaxNodes(maxNodes);
  const context = await resolveGraphContext(cwd, revision, rootPath);
  const key = JSON.stringify([
    GRAPH_ANALYZER_VERSION,
    context.commonDirectory,
    context.revision,
    context.branch,
    context.rootPath,
    nodeLimit,
  ]);
  return cacheValue(snapshotCache, key, () =>
    createSnapshot(cwd, context, nodeLimit),
  );
}

function parseLineCounts(
  output: string,
  revision: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  let cursor = 0;
  while (cursor < output.length) {
    const pathEnd = output.indexOf("\0", cursor);
    if (pathEnd < 0) break;
    const qualifiedPath = output.slice(cursor, pathEnd);
    const countEnd = output.indexOf("\n", pathEnd + 1);
    if (countEnd < 0) break;
    const count = Number.parseInt(output.slice(pathEnd + 1, countEnd), 10);
    const prefix = `${revision}:`;
    const nodePath = qualifiedPath.startsWith(prefix)
      ? qualifiedPath.slice(prefix.length)
      : qualifiedPath.slice(qualifiedPath.indexOf(":") + 1);
    if (nodePath && Number.isFinite(count)) counts.set(nodePath, count);
    cursor = countEnd + 1;
  }
  return counts;
}

async function readLineCounts(
  cwd: string,
  revision: string,
  rootPath: string | null,
): Promise<Map<string, number>> {
  const args = ["grep", "-I", "--count", "-z", "-e", "^", revision];
  if (rootPath) args.push("--", rootPath);
  return parseLineCounts(await gitRawAllowNoMatches(cwd, args), revision);
}

async function isGitAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  try {
    await gitRaw(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  visit: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await visit(items[current]!);
      }
    }),
  );
  return results;
}

function emptyBlame(): MutableBlame {
  return { authors: new Map(), lineCount: 0, totalAgeDays: 0 };
}

function mergeBlame(target: MutableBlame, source: MutableBlame): void {
  target.lineCount += source.lineCount;
  target.totalAgeDays += source.totalAgeDays;
  for (const [key, author] of source.authors) {
    const current = target.authors.get(key);
    target.authors.set(key, {
      ...author,
      lines: (current?.lines ?? 0) + author.lines,
    });
  }
}

function parseBlameSummary(output: string, now: number): MutableBlame {
  const summary = emptyBlame();
  let authorName = "Unknown";
  let authorEmail = "";
  let authoredAt = 0;
  for (const line of output.split("\n")) {
    if (/^[0-9a-f^]{40,64}\s/u.test(line)) {
      authorName = "Unknown";
      authorEmail = "";
      authoredAt = 0;
    } else if (line.startsWith("author ")) {
      authorName = line.slice(7) || "Unknown";
    } else if (line.startsWith("author-mail ")) {
      authorEmail = line.slice(12).replace(/^<|>$/gu, "");
    } else if (line.startsWith("author-time ")) {
      const seconds = Number.parseInt(line.slice(12), 10);
      authoredAt = Number.isFinite(seconds) ? seconds * 1_000 : 0;
    } else if (line.startsWith("\t")) {
      const key = `${authorEmail}\0${authorName}`;
      const current = summary.authors.get(key);
      summary.authors.set(key, {
        email: authorEmail,
        lines: (current?.lines ?? 0) + 1,
        name: authorName,
      });
      summary.lineCount += 1;
      summary.totalAgeDays += authoredAt
        ? Math.max(0, (now - authoredAt) / MILLISECONDS_PER_DAY)
        : 0;
    }
  }
  return summary;
}

async function analyzeBlame(
  cwd: string,
  snapshot: GitGraphSnapshot,
  metricsById: Map<string, MutableMetrics>,
): Promise<BlameAnalysis> {
  const eligible = snapshot.nodes.filter((node) => {
    const metrics = metricsById.get(node.id);
    return (
      node.kind === "file" &&
      node.path !== null &&
      metrics?.binary === false &&
      (metrics.lineCount ?? 0) > 0
    );
  });
  const selected: GitGraphNode[] = [];
  let selectedLines = 0;
  for (const node of eligible) {
    const lines = metricsById.get(node.id)?.lineCount ?? 0;
    if (
      selected.length >= GRAPH_BLAME_FILE_LIMIT ||
      selectedLines + lines > GRAPH_BLAME_LINE_LIMIT
    ) {
      continue;
    }
    selected.push(node);
    selectedLines += lines;
  }

  const now = Date.now();
  const results = await mapConcurrent(selected, 3, async (node) => {
    try {
      return {
        node,
        summary: parseBlameSummary(
          await gitRaw(cwd, [
            "blame",
            "--line-porcelain",
            snapshot.revision!,
            "--",
            node.path!,
          ]),
          now,
        ),
      };
    } catch {
      return { node, summary: null };
    }
  });
  const byNodeId = new Map<string, MutableBlame>();
  let analyzedFiles = 0;
  for (const { node, summary } of results) {
    if (!summary) continue;
    analyzedFiles += 1;
    byNodeId.set(node.id, summary);
    for (const ancestorId of ancestorNodeIds(node.path!, snapshot.rootPath)) {
      const aggregate = byNodeId.get(ancestorId) ?? emptyBlame();
      mergeBlame(aggregate, summary);
      byNodeId.set(ancestorId, aggregate);
    }
  }
  return {
    byNodeId,
    coverage: {
      analyzedFiles,
      totalFiles: eligible.length,
      truncated:
        selected.length < eligible.length || analyzedFiles < selected.length,
    },
  };
}

function initialMetrics(
  node: GitGraphNode,
  previous?: GitGraphNodeMetrics,
): MutableMetrics {
  return {
    additions: previous?.additions ?? 0,
    binaryCommitTouches: previous?.binaryCommitTouches ?? 0,
    binary: node.kind === "file" ? false : null,
    commitTouches: previous?.commitTouches ?? 0,
    deletions: previous?.deletions ?? 0,
    firstChangedAt: previous?.firstChangedAt ?? null,
    lastChangedAt: previous?.lastChangedAt ?? null,
    lineCount: node.kind === "directory" ? 0 : null,
  };
}

function updateDateRange(metrics: MutableMetrics, changedAt: string): void {
  if (!metrics.firstChangedAt || changedAt < metrics.firstChangedAt) {
    metrics.firstChangedAt = changedAt;
  }
  if (!metrics.lastChangedAt || changedAt > metrics.lastChangedAt) {
    metrics.lastChangedAt = changedAt;
  }
}

function ancestorNodeIds(nodePath: string, rootPath: string | null): string[] {
  const ids: string[] = [directoryId(rootPath)];
  let current = path.posix.dirname(nodePath);
  while (current !== "." && current !== rootPath) {
    if (!pathWithinRoot(current, rootPath)) break;
    ids.push(directoryId(current));
    current = path.posix.dirname(current);
  }
  return ids;
}

function parseNumstatLine(line: string): {
  additions: number | null;
  deletions: number | null;
  nodePath: string;
} | null {
  const firstTab = line.indexOf("\t");
  const secondTab = line.indexOf("\t", firstTab + 1);
  if (firstTab < 0 || secondTab < 0) return null;
  const additionsText = line.slice(0, firstTab).replace(/^\n+/u, "");
  const deletionsText = line.slice(firstTab + 1, secondTab);
  const nodePath = line.slice(secondTab + 1);
  if (!nodePath) return null;
  const additions = Number.parseInt(additionsText, 10);
  const deletions = Number.parseInt(deletionsText, 10);
  return {
    additions: Number.isFinite(additions) ? additions : null,
    deletions: Number.isFinite(deletions) ? deletions : null,
    nodePath,
  };
}

function applyHistory(
  output: string,
  rootPath: string | null,
  metricsById: Map<string, MutableMetrics>,
  nodeIdByPath: Map<string, string>,
): void {
  for (const record of output.split("\x1e")) {
    if (!record) continue;
    const hashEnd = record.indexOf("\0");
    const dateEnd = record.indexOf("\0", hashEnd + 1);
    if (hashEnd < 0 || dateEnd < 0) continue;
    const changedAt = record.slice(hashEnd + 1, dateEnd);
    if (!changedAt) continue;
    const touchedNodeIds = new Set<string>();
    const touchedDirectoryIds = new Set<string>();
    const binaryTouchedDirectoryIds = new Set<string>();
    for (const rawLine of record.slice(dateEnd + 1).split("\0")) {
      const parsed = parseNumstatLine(rawLine);
      if (
        !parsed ||
        !pathWithinRoot(parsed.nodePath, rootPath) ||
        !nodeIdByPath.has(parsed.nodePath)
      ) {
        continue;
      }
      const nodeId = nodeIdByPath.get(parsed.nodePath)!;
      const nodeMetrics = metricsById.get(nodeId);
      if (!nodeMetrics) continue;
      const binary = parsed.additions === null || parsed.deletions === null;
      if (!touchedNodeIds.has(nodeId)) {
        nodeMetrics.commitTouches += 1;
        if (binary) nodeMetrics.binaryCommitTouches += 1;
        touchedNodeIds.add(nodeId);
      }
      updateDateRange(nodeMetrics, changedAt);
      for (const candidateId of ancestorNodeIds(parsed.nodePath, rootPath)) {
        const directoryMetrics = metricsById.get(candidateId);
        if (!directoryMetrics) continue;
        if (!touchedDirectoryIds.has(candidateId)) {
          directoryMetrics.commitTouches += 1;
          touchedDirectoryIds.add(candidateId);
        }
        if (binary && !binaryTouchedDirectoryIds.has(candidateId)) {
          directoryMetrics.binaryCommitTouches += 1;
          binaryTouchedDirectoryIds.add(candidateId);
        }
        updateDateRange(directoryMetrics, changedAt);
        directoryMetrics.additions += parsed.additions ?? 0;
        directoryMetrics.deletions += parsed.deletions ?? 0;
      }
      nodeMetrics.additions += parsed.additions ?? 0;
      nodeMetrics.deletions += parsed.deletions ?? 0;
    }
  }
}

function aggregateDirectoryLines(
  snapshot: GitGraphSnapshot,
  metricsById: Map<string, MutableMetrics>,
): void {
  for (const node of [...snapshot.nodes].reverse()) {
    if (!node.parentId) continue;
    const metrics = metricsById.get(node.id);
    const parent = metricsById.get(node.parentId);
    if (metrics && metrics.lineCount !== null && parent) {
      parent.lineCount = (parent.lineCount ?? 0) + metrics.lineCount;
    }
  }
}

async function createMetrics(
  cwd: string,
  snapshot: GitGraphSnapshot,
  includeBlame: boolean,
  previous: GitGraphMetrics | null,
): Promise<GitGraphMetrics> {
  const previousByPath = new Map(
    previous?.nodes.map((node) => [node.path, node]) ?? [],
  );
  const metricsById = new Map(
    snapshot.nodes.map((node) => [
      node.id,
      initialMetrics(node, previousByPath.get(node.path)),
    ]),
  );
  if (!snapshot.revision) {
    return gitGraphMetricsSchema.parse({
      analyzerVersion: GRAPH_ANALYZER_VERSION,
      revision: null,
      rootPath: snapshot.rootPath,
      historyScope: "none",
      renameAware: false,
      blameCoverage: null,
      nodes: snapshot.nodes.map((node) => ({
        nodeId: node.id,
        path: node.path,
        ...initialMetrics(node),
        churn: 0,
        dominantAuthorName: null,
        dominantAuthorEmail: null,
        dominantAuthorShare: null,
        averageBlameAgeDays: null,
      })),
      analyzedAt: new Date().toISOString(),
      analysis: {
        structure: "ready",
        lines: "ready",
        history: "ready",
        blame: "unavailable",
      },
    });
  }

  const historyRevision = previous?.revision
    ? `${previous.revision}..${snapshot.revision}`
    : snapshot.revision;
  const [lineCounts, history] = await Promise.all([
    readLineCounts(cwd, snapshot.revision, snapshot.rootPath),
    gitRawAllowNoMatches(cwd, [
      "log",
      "--date=iso-strict",
      "--format=%x1e%H%x00%aI%x00",
      "--numstat",
      "-z",
      "--no-renames",
      historyRevision,
      ...(snapshot.rootPath ? ["--", snapshot.rootPath] : []),
    ]),
  ]);
  const nodeIdByPath = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (node.path) nodeIdByPath.set(node.path, node.id);
    const metrics = metricsById.get(node.id)!;
    if (node.kind !== "file" || !node.path) continue;
    const lineCount = lineCounts.get(node.path);
    if (lineCount !== undefined) {
      metrics.lineCount = lineCount;
      metrics.binary = false;
    } else if ((node.byteSize ?? 0) === 0) {
      metrics.lineCount = 0;
      metrics.binary = false;
    } else {
      metrics.lineCount = null;
      metrics.binary = true;
    }
  }
  aggregateDirectoryLines(snapshot, metricsById);
  applyHistory(history, snapshot.rootPath, metricsById, nodeIdByPath);
  const blame = includeBlame
    ? await analyzeBlame(cwd, snapshot, metricsById)
    : null;

  const nodes: GitGraphNodeMetrics[] = snapshot.nodes.map((node) => {
    const metrics = metricsById.get(node.id)!;
    const blameMetrics = blame?.byNodeId.get(node.id);
    const dominantAuthor = blameMetrics
      ? [...blameMetrics.authors.values()].sort(
          (left, right) => right.lines - left.lines,
        )[0]
      : undefined;
    return {
      nodeId: node.id,
      path: node.path,
      lineCount: metrics.lineCount,
      binary: metrics.binary,
      commitTouches: metrics.commitTouches,
      additions: metrics.additions,
      deletions: metrics.deletions,
      churn: metrics.additions + metrics.deletions,
      binaryCommitTouches: metrics.binaryCommitTouches,
      firstChangedAt: metrics.firstChangedAt,
      lastChangedAt: metrics.lastChangedAt,
      dominantAuthorName: dominantAuthor?.name ?? null,
      dominantAuthorEmail: dominantAuthor?.email ?? null,
      dominantAuthorShare:
        dominantAuthor && blameMetrics?.lineCount
          ? dominantAuthor.lines / blameMetrics.lineCount
          : null,
      averageBlameAgeDays: blameMetrics?.lineCount
        ? blameMetrics.totalAgeDays / blameMetrics.lineCount
        : null,
    };
  });
  return gitGraphMetricsSchema.parse({
    analyzerVersion: GRAPH_ANALYZER_VERSION,
    revision: snapshot.revision,
    rootPath: snapshot.rootPath,
    historyScope: "current-branch",
    renameAware: false,
    blameCoverage: blame?.coverage ?? null,
    nodes,
    analyzedAt: new Date().toISOString(),
    analysis: {
      structure: "ready",
      lines: "ready",
      history: "ready",
      blame:
        !includeBlame || !blame
          ? "deferred"
          : blame.coverage.totalFiles > 0
            ? "ready"
            : "unavailable",
    },
  });
}

export async function readGitGraphMetrics(
  cwd: string,
  revision = "HEAD",
  rootPath: string | null = null,
  maxNodes = 100_000,
  includeBlame = false,
): Promise<GitGraphMetrics> {
  const nodeLimit = normalizeMaxNodes(maxNodes);
  const snapshot = await readGitGraphSnapshot(
    cwd,
    revision,
    rootPath,
    nodeLimit,
  );
  const commonDirectory = await gitOutput(cwd, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const scopeKey = JSON.stringify([
    GRAPH_ANALYZER_VERSION,
    await realpath(
      path.isAbsolute(commonDirectory)
        ? commonDirectory
        : path.resolve(cwd, commonDirectory),
    ),
    snapshot.rootPath,
    nodeLimit,
  ]);
  const key = JSON.stringify([scopeKey, snapshot.revision, includeBlame]);
  return cacheValue(metricsCache, key, async () => {
    const latest = latestMetricsCache.get(scopeKey)?.metrics ?? null;
    const currentPaths = new Set(snapshot.nodes.map((node) => node.path));
    const sameTree =
      latest?.revision !== null &&
      latest?.nodes.length === snapshot.nodes.length &&
      latest.nodes.every((node) => currentPaths.has(node.path));
    const previous =
      latest?.revision &&
      snapshot.revision &&
      sameTree &&
      (await isGitAncestor(cwd, latest.revision, snapshot.revision))
        ? latest
        : null;
    const metrics = await createMetrics(cwd, snapshot, includeBlame, previous);
    latestMetricsCache.set(scopeKey, { lastUsed: Date.now(), metrics });
    if (latestMetricsCache.size > GRAPH_CACHE_LIMIT) {
      const oldest = [...latestMetricsCache.entries()]
        .filter(([candidate]) => candidate !== scopeKey)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (oldest) latestMetricsCache.delete(oldest[0]);
    }
    return metrics;
  });
}

export function createGitGraphCommitOverlay(
  detail: GitCommitDetail,
  rootPath: string | null = null,
): GitGraphCommitOverlay {
  const normalizedRoot = normalizeRootPath(rootPath);
  const files = detail.files.filter(
    (file) =>
      pathWithinRoot(file.path, normalizedRoot) ||
      (file.originalPath !== null &&
        pathWithinRoot(file.originalPath, normalizedRoot)),
  );
  return gitGraphCommitOverlaySchema.parse({
    revision: detail.hash,
    baseRevision: detail.baseHash,
    rootPath: normalizedRoot,
    nodes: files.map((file) => ({
      path: file.path,
      originalPath: file.originalPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      weight: Math.max(1, (file.additions ?? 0) + (file.deletions ?? 0)),
      binary: file.binary,
      ghost: file.status === "deleted",
    })),
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    truncated: detail.filesTruncated,
  });
}
