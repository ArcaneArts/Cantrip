import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir as systemHomeDirectory } from "node:os";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

import {
  externalChatDiscoveryWorkerResultSchema,
  externalChatReadWorkerResultSchema,
  externalChatSourceSchema,
  type ExternalChatDiscoveryTarget,
  type ExternalChatDiscoveryWorkerResult,
  type ExternalChatReadWorkerResult,
  type ExternalChatSource,
  type ExternalChatAttachment,
  type ExternalChatThreadMatch,
  type ExternalChatThreadMetadata,
} from "@cantrip/protocol";

import {
  ExternalChatAttachmentStagingStore,
  MAX_EXTERNAL_CHAT_ATTACHMENT_BYTES,
  type ExternalChatAttachmentCandidate,
} from "./external-chat-attachments.js";

import {
  normalizeCodexThreadReadResponse,
  type CodexThreadReadResponse,
} from "./codex/app-server.js";
import {
  discoverCodexVersion,
  isTestedCodexVersion,
  parseCodexSemanticVersion,
} from "./codex/discovery.js";
import {
  initializeCodexRpcClient,
  spawnCodexRpcClient,
  type CodexRpcClient,
  type CodexRpcResponse,
} from "./codex/rpc-client.js";

const execFileAsync = promisify(execFile);
const SOURCE_THREAD_LIMIT = 5_000;
const SOURCE_PAGE_LIMIT = 100;
const SOURCE_PAGE_COUNT_LIMIT = 50;
const SOURCE_REQUEST_TIMEOUT_MS = 20_000;

interface SourceThread {
  id: string;
  parentThreadId: string | null;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: "notLoaded" | "idle" | "systemError" | "active";
  cwd: string;
  cliVersion: string;
  source: "cli" | "vscode";
  gitInfo: {
    sha: string | null;
    branch: string | null;
    originUrl: string | null;
  } | null;
  name: string | null;
}

interface SourcePage {
  data: SourceThread[];
  nextCursor: string | null;
}

interface CandidateHome {
  label: string;
  path: string;
}

interface MatchedTarget {
  canonicalPath: string;
  gitOrigin: string | null;
  projectReplicaId: string;
  worktrees: Array<{
    canonicalPath: string;
    isPrimary: boolean;
    worktreeId: string;
  }>;
}

export interface ExternalChatHistorySource {
  discover(input: {
    includeArchived: boolean;
    targets: ExternalChatDiscoveryTarget[];
  }): Promise<ExternalChatSource[]>;
  read(input: {
    sourceId: string;
    sourceThreadId: string;
    targets: ExternalChatDiscoveryTarget[];
  }): Promise<ExternalChatReadWorkerResult>;
}

interface CodexExternalChatHistoryOptions {
  binary: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  managedDataDirectory: string;
  platform?: NodeJS.Platform;
  createClient?: (
    codexHome: string,
  ) => Pick<CodexRpcClient, "request" | "notify" | "close">;
  readRuntimeVersion?: (binary: string) => Promise<string | null>;
  resolvePath?: (candidate: string) => Promise<string>;
  resolveGitOrigin?: (candidate: string) => Promise<string | null>;
  pathExists?: (candidate: string) => Promise<boolean>;
  attachmentStore?: ExternalChatAttachmentStagingStore;
}

function attachmentId(
  sourceId: string,
  threadId: string,
  itemId: string,
  contentIndex: number,
): string {
  return createHash("sha256")
    .update(`${sourceId}\0${threadId}\0${itemId}\0${contentIndex}`)
    .digest("hex");
}

function externalAttachmentCandidates(
  rawThread: Record<string, unknown>,
  sourceId: string,
  sourceThreadId: string,
  cwd: string,
  platform: NodeJS.Platform,
): ExternalChatAttachmentCandidate[] {
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const candidates: ExternalChatAttachmentCandidate[] = [];
  for (const rawTurn of turns) {
    const turn = objectValue(rawTurn);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = objectValue(rawItem);
      if (item?.type !== "userMessage" || typeof item.id !== "string") {
        continue;
      }
      const content = Array.isArray(item.content) ? item.content : [];
      for (const [contentIndex, rawContent] of content.entries()) {
        if (candidates.length >= 20) return candidates;
        const entry = objectValue(rawContent);
        if (!entry) continue;
        const kind =
          entry.type === "localImage" || entry.type === "image"
            ? "image"
            : entry.type === "localAudio" || entry.type === "audio"
              ? "audio"
              : null;
        if (!kind) continue;
        const local =
          entry.type === "localImage" || entry.type === "localAudio";
        const referencedPath =
          local && typeof entry.path === "string" ? entry.path : null;
        const api = pathApi(platform);
        const candidatePath = referencedPath
          ? api.isAbsolute(referencedPath)
            ? referencedPath
            : api.resolve(cwd, referencedPath)
          : null;
        const remoteUrl =
          !local && typeof entry.url === "string" ? entry.url : null;
        candidates.push({
          id: attachmentId(sourceId, sourceThreadId, item.id, contentIndex),
          itemId: item.id.slice(0, 500),
          kind,
          path: candidatePath,
          remoteUrl,
        });
      }
    }
  }
  return candidates;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function parseStatus(value: unknown): SourceThread["status"] | null {
  const status = objectValue(value)?.type;
  return status === "notLoaded" ||
    status === "idle" ||
    status === "systemError" ||
    status === "active"
    ? status
    : null;
}

function parseSourceThread(value: unknown): SourceThread | null {
  const thread = objectValue(value);
  const status = parseStatus(thread?.status);
  if (
    !thread ||
    typeof thread.id !== "string" ||
    thread.id.length === 0 ||
    !(
      thread.parentThreadId === null ||
      typeof thread.parentThreadId === "string"
    ) ||
    typeof thread.preview !== "string" ||
    typeof thread.ephemeral !== "boolean" ||
    typeof thread.modelProvider !== "string" ||
    typeof thread.createdAt !== "number" ||
    !Number.isFinite(thread.createdAt) ||
    typeof thread.updatedAt !== "number" ||
    !Number.isFinite(thread.updatedAt) ||
    !status ||
    typeof thread.cwd !== "string" ||
    thread.cwd.length === 0 ||
    typeof thread.cliVersion !== "string" ||
    !(thread.source === "cli" || thread.source === "vscode") ||
    !(thread.name === null || typeof thread.name === "string")
  ) {
    return null;
  }
  const rawGit = objectValue(thread.gitInfo);
  const gitInfo = rawGit
    ? {
        sha: boundedText(rawGit.sha, 200),
        branch: boundedText(rawGit.branch, 1_000),
        originUrl: boundedText(rawGit.originUrl, 4_000),
      }
    : null;
  return {
    id: thread.id.slice(0, 200),
    parentThreadId: thread.parentThreadId,
    preview: thread.preview.slice(0, 2_000),
    ephemeral: thread.ephemeral,
    modelProvider: thread.modelProvider.slice(0, 200),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status,
    cwd: thread.cwd.slice(0, 8_192),
    cliVersion: thread.cliVersion.slice(0, 100),
    source: thread.source,
    gitInfo,
    name: thread.name?.slice(0, 500) ?? null,
  };
}

function parseSourcePage(value: unknown): SourcePage | null {
  const page = objectValue(value);
  if (
    !page ||
    !Array.isArray(page.data) ||
    !(page.nextCursor === null || typeof page.nextCursor === "string")
  ) {
    return null;
  }
  const data: SourceThread[] = [];
  for (const item of page.data) {
    const thread = parseSourceThread(item);
    if (!thread) return null;
    data.push(thread);
  }
  return { data, nextCursor: page.nextCursor };
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function normalizeExternalPath(
  candidate: string,
  platform: NodeJS.Platform,
): string {
  const normalized = pathApi(platform).resolve(candidate);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathContains(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  const api = pathApi(platform);
  const relative = api.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${api.sep}`) &&
      relative !== ".." &&
      !api.isAbsolute(relative))
  );
}

export function normalizeGitOrigin(origin: string | null): string | null {
  const value = origin?.trim();
  if (!value) return null;
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(value);
  if (scp && !value.includes("://")) {
    return `${scp[1]}/${scp[2]}`
      .replace(/\.git$/iu, "")
      .replace(/\/+$/u, "")
      .toLowerCase();
  }
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`
      .replace(/\.git$/iu, "")
      .replace(/\/+$/u, "")
      .toLowerCase();
  } catch {
    return value
      .replace(/\.git$/iu, "")
      .replace(/\/+$/u, "")
      .toLowerCase();
  }
}

function sourceFingerprint(
  candidate: string,
  platform: NodeJS.Platform,
): string {
  return createHash("sha256")
    .update(`chatgpt-codex\0${normalizeExternalPath(candidate, platform)}`)
    .digest("hex");
}

function isoFromSeconds(seconds: number): string {
  return new Date(Math.max(0, seconds) * 1_000).toISOString();
}

async function defaultPathExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function defaultResolvePath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

async function defaultResolveGitOrigin(
  candidate: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", candidate, "config", "--get", "remote.origin.url"],
      { timeout: 5_000 },
    );
    return normalizeGitOrigin(stdout);
  } catch {
    return null;
  }
}

function sourceHomes(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  managedDataDirectory: string,
  platform: NodeJS.Platform,
): CandidateHome[] {
  const api = pathApi(platform);
  const candidates: CandidateHome[] = [];
  if (environment.CODEX_HOME?.trim()) {
    candidates.push({ label: "$CODEX_HOME", path: environment.CODEX_HOME });
  }
  candidates.push({
    label: "~/.codex",
    path: api.join(homeDirectory, ".codex"),
  });
  const managed = normalizeExternalPath(managedDataDirectory, platform);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = normalizeExternalPath(candidate.path, platform);
    if (seen.has(normalized) || pathContains(managed, normalized, platform)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

async function matchedTargets(
  targets: ExternalChatDiscoveryTarget[],
  platform: NodeJS.Platform,
  resolvePath: (candidate: string) => Promise<string>,
  resolveGitOrigin: (candidate: string) => Promise<string | null>,
): Promise<MatchedTarget[]> {
  return Promise.all(
    targets.map(async (target) => ({
      canonicalPath: normalizeExternalPath(
        await resolvePath(target.path),
        platform,
      ),
      gitOrigin: await resolveGitOrigin(target.path),
      projectReplicaId: target.projectReplicaId,
      worktrees: await Promise.all(
        target.worktrees.map(async (worktree) => ({
          canonicalPath: normalizeExternalPath(
            await resolvePath(worktree.path),
            platform,
          ),
          isPrimary: worktree.isPrimary,
          worktreeId: worktree.worktreeId,
        })),
      ),
    })),
  );
}

function matchThread(
  thread: SourceThread,
  targets: MatchedTarget[],
  platform: NodeJS.Platform,
): ExternalChatThreadMatch | null {
  const cwd = normalizeExternalPath(thread.cwd, platform);
  const worktrees = targets
    .flatMap((target) =>
      target.worktrees.map((worktree) => ({ target, worktree })),
    )
    .filter(({ worktree }) =>
      pathContains(worktree.canonicalPath, cwd, platform),
    )
    .sort(
      (left, right) =>
        right.worktree.canonicalPath.length -
        left.worktree.canonicalPath.length,
    );
  if (worktrees[0]) {
    return {
      kind: "worktree-path",
      projectReplicaId: worktrees[0].target.projectReplicaId,
      worktreeId: worktrees[0].worktree.worktreeId,
    };
  }
  const replica = targets.find((target) =>
    pathContains(target.canonicalPath, cwd, platform),
  );
  if (replica) {
    return {
      kind: "replica-path",
      projectReplicaId: replica.projectReplicaId,
      worktreeId: null,
    };
  }
  const origin = normalizeGitOrigin(thread.gitInfo?.originUrl ?? null);
  if (!origin) return null;
  const originMatches = targets.filter((target) => target.gitOrigin === origin);
  if (originMatches.length !== 1) return null;
  return {
    kind: "git-origin",
    projectReplicaId: originMatches[0]!.projectReplicaId,
    worktreeId: null,
  };
}

function toMetadata(
  thread: SourceThread,
  archived: boolean,
  match: ExternalChatThreadMatch,
): ExternalChatThreadMetadata | null {
  if (
    thread.ephemeral ||
    thread.parentThreadId !== null ||
    thread.status === "active"
  ) {
    return null;
  }
  const title = (
    thread.name?.trim() ||
    thread.preview.trim() ||
    "Imported Codex chat"
  ).slice(0, 500);
  return {
    sourceThreadId: thread.id,
    title,
    preview: thread.preview,
    cwd: thread.cwd,
    createdAt: isoFromSeconds(thread.createdAt),
    updatedAt: isoFromSeconds(thread.updatedAt),
    archived,
    source: thread.source,
    status:
      thread.status === "notLoaded"
        ? "not-loaded"
        : thread.status === "systemError"
          ? "system-error"
          : "idle",
    modelProvider: thread.modelProvider,
    cliVersion: thread.cliVersion || null,
    git: thread.gitInfo,
    match,
  };
}

async function listSourceThreads(
  client: Pick<CodexRpcClient, "request">,
  archived: boolean,
  remaining: number,
): Promise<{ threads: SourceThread[]; truncated: boolean }> {
  const threads: SourceThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SOURCE_PAGE_COUNT_LIMIT; page += 1) {
    const response: CodexRpcResponse = await client.request("thread/list", {
      cursor,
      limit: Math.min(SOURCE_PAGE_LIMIT, remaining - threads.length),
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode"],
      archived,
      useStateDbOnly: true,
    });
    if (response.error) throw new Error(response.error.message);
    const parsed = parseSourcePage(response.result);
    if (!parsed) {
      throw new Error("Codex returned an invalid thread/list response.");
    }
    threads.push(...parsed.data);
    cursor = parsed.nextCursor;
    if (!cursor) return { threads, truncated: false };
    if (threads.length >= remaining) {
      return { threads: threads.slice(0, remaining), truncated: true };
    }
  }
  return { threads, truncated: cursor !== null };
}

export class CodexExternalChatHistorySource implements ExternalChatHistorySource {
  readonly #attachments: ExternalChatAttachmentStagingStore;
  readonly #binary: string;
  readonly #createClient: NonNullable<
    CodexExternalChatHistoryOptions["createClient"]
  >;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #homeDirectory: string;
  readonly #managedDataDirectory: string;
  readonly #pathExists: NonNullable<
    CodexExternalChatHistoryOptions["pathExists"]
  >;
  readonly #platform: NodeJS.Platform;
  readonly #readRuntimeVersion: NonNullable<
    CodexExternalChatHistoryOptions["readRuntimeVersion"]
  >;
  readonly #resolveGitOrigin: NonNullable<
    CodexExternalChatHistoryOptions["resolveGitOrigin"]
  >;
  readonly #resolvePath: NonNullable<
    CodexExternalChatHistoryOptions["resolvePath"]
  >;

  constructor(options: CodexExternalChatHistoryOptions) {
    this.#binary = options.binary;
    this.#environment = options.environment ?? process.env;
    this.#homeDirectory = options.homeDirectory ?? systemHomeDirectory();
    this.#managedDataDirectory = options.managedDataDirectory;
    this.#platform = options.platform ?? process.platform;
    this.#createClient =
      options.createClient ??
      ((codexHome) =>
        spawnCodexRpcClient(this.#binary, codexHome, {
          requestTimeoutMs: SOURCE_REQUEST_TIMEOUT_MS,
        }));
    this.#readRuntimeVersion =
      options.readRuntimeVersion ?? discoverCodexVersion;
    this.#resolvePath = options.resolvePath ?? defaultResolvePath;
    this.#resolveGitOrigin =
      options.resolveGitOrigin ?? defaultResolveGitOrigin;
    this.#pathExists = options.pathExists ?? defaultPathExists;
    this.#attachments =
      options.attachmentStore ??
      new ExternalChatAttachmentStagingStore(options.managedDataDirectory);
  }

  async discover(input: {
    includeArchived: boolean;
    targets: ExternalChatDiscoveryTarget[];
  }): Promise<ExternalChatSource[]> {
    if (this.#platform !== "darwin" && this.#platform !== "win32") return [];
    const runtimeVersion = await this.#readRuntimeVersion(this.#binary);
    const semantic = runtimeVersion
      ? parseCodexSemanticVersion(runtimeVersion)
      : null;
    const targets = await matchedTargets(
      input.targets,
      this.#platform,
      this.#resolvePath,
      this.#resolveGitOrigin,
    );
    const homes = sourceHomes(
      this.#environment,
      this.#homeDirectory,
      this.#managedDataDirectory,
      this.#platform,
    );
    return Promise.all(
      homes.map((home) =>
        this.discoverHome(
          home,
          targets,
          input.includeArchived,
          runtimeVersion,
          semantic,
        ),
      ),
    );
  }

  async read(input: {
    sourceId: string;
    sourceThreadId: string;
    targets: ExternalChatDiscoveryTarget[];
  }): Promise<ExternalChatReadWorkerResult> {
    if (this.#platform !== "darwin" && this.#platform !== "win32") {
      throw new Error(
        "External Codex history is not supported on this platform.",
      );
    }
    const runtimeVersion = await this.#readRuntimeVersion(this.#binary);
    const semantic = runtimeVersion
      ? parseCodexSemanticVersion(runtimeVersion)
      : null;
    if (!semantic || !isTestedCodexVersion(semantic)) {
      throw new Error(
        "The bundled Codex reader is outside Cantrip's tested range.",
      );
    }
    const homes = sourceHomes(
      this.#environment,
      this.#homeDirectory,
      this.#managedDataDirectory,
      this.#platform,
    );
    let selected: CandidateHome | null = null;
    for (const home of homes) {
      const canonicalHome = await this.#resolvePath(home.path);
      if (sourceFingerprint(canonicalHome, this.#platform) === input.sourceId) {
        selected = home;
        break;
      }
    }
    if (!selected || !(await this.#pathExists(selected.path))) {
      throw new Error("The selected Codex history source was not found.");
    }
    const targets = await matchedTargets(
      input.targets,
      this.#platform,
      this.#resolvePath,
      this.#resolveGitOrigin,
    );
    const client = this.#createClient(selected.path);
    try {
      await initializeCodexRpcClient(client, {
        name: "cantrip_external_history_reader",
        title: "Cantrip External History Reader",
        version: "1.0.0",
        experimentalApi: true,
      });
      const response = await client.request("thread/read", {
        threadId: input.sourceThreadId,
        includeTurns: true,
      });
      if (response.error) throw new Error(response.error.message);
      const result = objectValue(response.result);
      const rawThread = objectValue(result?.thread);
      const sourceThread = parseSourceThread(rawThread);
      if (
        !sourceThread ||
        sourceThread.id !== input.sourceThreadId ||
        !Array.isArray(rawThread?.turns)
      ) {
        throw new Error("Codex returned an invalid thread/read response.");
      }
      const match = matchThread(sourceThread, targets, this.#platform);
      const metadata = match ? toMetadata(sourceThread, false, match) : null;
      if (!metadata) {
        throw new Error(
          "The selected Codex chat no longer belongs to this project or is not safe to import.",
        );
      }
      const canonicalHome = await this.#resolvePath(selected.path);
      const resolvedSourceId = sourceFingerprint(canonicalHome, this.#platform);
      await this.#attachments.cleanupExpired();
      await this.#attachments.release(resolvedSourceId, sourceThread.id);
      const descriptors: ExternalChatAttachment[] = [];
      let remainingAttachmentBytes = MAX_EXTERNAL_CHAT_ATTACHMENT_BYTES;
      const allowedRoots = input.targets.flatMap((target) => [
        target.path,
        ...target.worktrees.map((worktree) => worktree.path),
      ]);
      for (const candidate of externalAttachmentCandidates(
        rawThread,
        resolvedSourceId,
        sourceThread.id,
        sourceThread.cwd,
        this.#platform,
      )) {
        const descriptor = await this.#attachments.stage(
          resolvedSourceId,
          sourceThread.id,
          candidate,
          allowedRoots,
          remainingAttachmentBytes,
        );
        descriptors.push(descriptor);
        if (descriptor.status === "available") {
          remainingAttachmentBytes -= descriptor.sizeBytes;
        }
      }
      const attachmentIdsByItemId = new Map<string, string[]>();
      for (const descriptor of descriptors) {
        const ids = attachmentIdsByItemId.get(descriptor.itemId) ?? [];
        ids.push(descriptor.id);
        attachmentIdsByItemId.set(descriptor.itemId, ids);
      }
      const sync = normalizeCodexThreadReadResponse(
        { thread: rawThread } as unknown as CodexThreadReadResponse,
        sourceThread.cwd,
        attachmentIdsByItemId,
      );
      const { archived: _archived, ...transcriptMetadata } = metadata;
      return externalChatReadWorkerResultSchema.parse({
        transcript: {
          sourceId: resolvedSourceId,
          sourceThreadId: sourceThread.id,
          metadata: transcriptMetadata,
          sync,
          attachments: descriptors,
        },
      });
    } finally {
      client.close();
    }
  }

  private async discoverHome(
    home: CandidateHome,
    targets: MatchedTarget[],
    includeArchived: boolean,
    runtimeVersion: string | null,
    semantic: string | null,
  ): Promise<ExternalChatSource> {
    const canonicalHome = await this.#resolvePath(home.path);
    const base = {
      kind: "chatgpt-codex" as const,
      sourceId: sourceFingerprint(canonicalHome, this.#platform),
      name: "ChatGPT Codex",
      platform: this.#platform as "darwin" | "win32",
      homeLabel: home.label,
      runtimeVersion: runtimeVersion?.slice(0, 100) ?? null,
    };
    if (!(await this.#pathExists(home.path))) {
      return externalChatSourceSchema.parse({
        ...base,
        availability: "unavailable",
        message: "No local Codex history store was found.",
        threads: [],
        truncated: false,
      });
    }
    if (!semantic || !isTestedCodexVersion(semantic)) {
      return externalChatSourceSchema.parse({
        ...base,
        availability: "incompatible",
        message: "The bundled Codex reader is outside Cantrip's tested range.",
        threads: [],
        truncated: false,
      });
    }

    const client = this.#createClient(home.path);
    try {
      await initializeCodexRpcClient(client, {
        name: "cantrip_external_history_reader",
        title: "Cantrip External History Reader",
        version: "1.0.0",
        experimentalApi: true,
      });
      const active = await listSourceThreads(
        client,
        false,
        SOURCE_THREAD_LIMIT,
      );
      const archived =
        includeArchived &&
        !active.truncated &&
        active.threads.length < SOURCE_THREAD_LIMIT
          ? await listSourceThreads(
              client,
              true,
              SOURCE_THREAD_LIMIT - active.threads.length,
            )
          : { threads: [], truncated: false };
      const matched = new Map<string, ExternalChatThreadMetadata>();
      for (const [isArchived, sourceThreads] of [
        [false, active.threads],
        [true, archived.threads],
      ] as const) {
        for (const thread of sourceThreads) {
          const match = matchThread(thread, targets, this.#platform);
          if (!match) continue;
          const metadata = toMetadata(thread, isArchived, match);
          if (metadata) matched.set(metadata.sourceThreadId, metadata);
        }
      }
      const threads = [...matched.values()]
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.sourceThreadId.localeCompare(right.sourceThreadId),
        )
        .slice(0, SOURCE_THREAD_LIMIT);
      return externalChatSourceSchema.parse({
        ...base,
        availability: "available",
        message: null,
        threads,
        truncated:
          active.truncated ||
          archived.truncated ||
          matched.size > threads.length,
      });
    } catch {
      return externalChatSourceSchema.parse({
        ...base,
        availability: "incompatible",
        message: "Cantrip could not safely read this Codex history store.",
        threads: [],
        truncated: false,
      });
    } finally {
      client.close();
    }
  }
}

export async function discoverExternalChatHistory(
  options: CodexExternalChatHistoryOptions,
  input: {
    includeArchived: boolean;
    targets: ExternalChatDiscoveryTarget[];
  },
): Promise<ExternalChatDiscoveryWorkerResult> {
  const source = new CodexExternalChatHistorySource(options);
  const sources = await source.discover(input);
  return externalChatDiscoveryWorkerResultSchema.parse({
    sources,
    truncated: sources.some((candidate) => candidate.truncated),
  });
}

export async function readExternalChatHistory(
  options: CodexExternalChatHistoryOptions,
  input: {
    sourceId: string;
    sourceThreadId: string;
    targets: ExternalChatDiscoveryTarget[];
  },
): Promise<ExternalChatReadWorkerResult> {
  const source = new CodexExternalChatHistorySource(options);
  return source.read(input);
}
