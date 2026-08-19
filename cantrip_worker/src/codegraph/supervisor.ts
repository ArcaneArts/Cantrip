import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  codeGraphActionAcknowledgementSchema,
  codeGraphProjectStatusSchema,
  type CodeGraphActionAcknowledgement,
  type CodeGraphProjectStatus as PublicCodeGraphProjectStatus,
  type WorktreeObservationTarget,
} from "@cantrip/protocol";

import { workerLogError, workerLogger } from "../logger.js";

const INDEX_DIRECTORY = ".codegraph-cantrip";
const EXCLUDE_BEGIN = "# BEGIN CANTRIP CODEGRAPH";
const EXCLUDE_END = "# END CANTRIP CODEGRAPH";
const EXCLUDE_BLOCK = `${EXCLUDE_BEGIN}\n/${INDEX_DIRECTORY}/\n${EXCLUDE_END}`;
const CHANGE_DEBOUNCE_MS = 1_000;
const RECONCILE_INTERVAL_MS = 2 * 60_000;
const MAX_CONCURRENT_OPERATIONS = 2;
const MAX_CONCURRENT_AUTHORIZATIONS = 4;
const MAX_OUTPUT_CHARACTERS = 256_000;
const STATUS_TIMEOUT_MS = 30_000;
const SYNC_TIMEOUT_MS = 5 * 60_000;
const INDEX_TIMEOUT_MS = 30 * 60_000;
const MAX_RETRY_MS = 5 * 60_000;
const AGENT_CATCH_UP_INTERVAL_MS = 30_000;
const AGENT_CATCH_UP_WAIT_MS = 1_000;

type CodeGraphPendingAction = "ensure" | "rebuild" | "sync";

export type CodeGraphProjectState =
  "degraded" | "indexing" | "queued" | "ready" | "syncing" | "unavailable";

export interface CodeGraphProjectStatus {
  edgeCount: number | null;
  error: string | null;
  fileCount: number | null;
  indexPath: string;
  lastIndexedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  nodeCount: number | null;
  pendingChanges: number | null;
  root: string;
  state: CodeGraphProjectState;
}

interface CodeGraphStatusPayload {
  edgeCount?: unknown;
  fileCount?: unknown;
  index?: { reindexRecommended?: unknown; state?: unknown };
  initialized?: unknown;
  lastIndexed?: unknown;
  nodeCount?: unknown;
  pendingChanges?: { added?: unknown; modified?: unknown; removed?: unknown };
  projectPath?: unknown;
}

interface ProcessOutcome {
  code: number;
  stderr: string;
  stdout: string;
}

interface AuthorizedTarget {
  gitCommonDir: string;
  root: string;
}

interface ManagedProject extends CodeGraphProjectStatus {
  abortController: AbortController | null;
  changeTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  failureCount: number;
  pendingAction: CodeGraphPendingAction | null;
  queued: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  projectId: string | null;
  worktreeId: string | null;
  job: PublicCodeGraphProjectStatus["job"];
  sourcePath: string;
  watcher: FSWatcher | null;
  watcherRetryTimer: ReturnType<typeof setTimeout> | null;
}

export interface CodeGraphProjectSupervisorOptions {
  authorize: (
    sourcePath: string,
    worktreePaths: string[],
  ) => Promise<AuthorizedTarget[]>;
  command: string;
  commandArguments?: string[];
  environment?: NodeJS.ProcessEnv;
  execute?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      environment: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs: number;
    },
  ) => Promise<ProcessOutcome>;
  now?: () => Date;
  onStatus?: (status: PublicCodeGraphProjectStatus) => void;
  watch?: (
    root: string,
    listener: (event: string, fileName: string | Buffer | null) => void,
  ) => FSWatcher;
}

function boundedText(value: string): string {
  return value.length <= MAX_OUTPUT_CHARACTERS
    ? value
    : value.slice(value.length - MAX_OUTPUT_CHARACTERS);
}

function processOutcome(
  command: string,
  args: string[],
  options: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.environment,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish(
        new Error(`CodeGraph command timed out after ${options.timeoutMs}ms.`),
      );
    }, options.timeoutMs);
    timeout.unref();
    const finish = (error?: Error, code = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else
        resolve({
          code,
          stderr: boundedText(stderr),
          stdout: boundedText(stdout),
        });
    };
    child.stdout?.on("data", (chunk) => {
      stdout = boundedText(stdout + String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = boundedText(stderr + String(chunk));
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(
        signal
          ? new Error(`CodeGraph command exited from ${signal}.`)
          : undefined,
        code ?? 1,
      );
    });
  });
}

function parseCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function parseStatus(
  stdout: string,
  expectedRoot: string,
): {
  edgeCount: number | null;
  fileCount: number | null;
  initialized: boolean;
  lastIndexedAt: string | null;
  nodeCount: number | null;
  pendingChanges: number | null;
  reindexRecommended: boolean;
} {
  const line = stdout
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .reverse()
    .find((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
  if (!line) throw new Error("CodeGraph status did not return JSON.");
  const payload = JSON.parse(line) as CodeGraphStatusPayload;
  if (payload.initialized !== true && payload.initialized !== false) {
    throw new Error("CodeGraph status returned an invalid initialized state.");
  }
  if (
    typeof payload.projectPath === "string" &&
    path.resolve(payload.projectPath) !== expectedRoot
  ) {
    throw new Error("CodeGraph status resolved a different project path.");
  }
  const pending = payload.pendingChanges;
  const counts = pending
    ? [pending.added, pending.modified, pending.removed].map(parseCount)
    : [];
  return {
    initialized: payload.initialized,
    fileCount: parseCount(payload.fileCount),
    nodeCount: parseCount(payload.nodeCount),
    edgeCount: parseCount(payload.edgeCount),
    lastIndexedAt: parseTimestamp(payload.lastIndexed),
    pendingChanges:
      counts.length === 3 && counts.every((count) => count !== null)
        ? counts.reduce<number>((total, count) => total + (count ?? 0), 0)
        : null,
    reindexRecommended: payload.index?.reindexRecommended === true,
  };
}

function actionPriority(action: CodeGraphPendingAction): number {
  return action === "rebuild" ? 3 : action === "ensure" ? 2 : 1;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function isSymlink(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function mapSettledConcurrent<T, R>(
  items: T[],
  limit: number,
  visit: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        const item = items[current];
        if (item === undefined) continue;
        try {
          results[current] = { status: "fulfilled", value: await visit(item) };
        } catch (reason) {
          results[current] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

export class CodeGraphProjectSupervisor {
  readonly #authorize: CodeGraphProjectSupervisorOptions["authorize"];
  readonly #command: string;
  readonly #commandArguments: string[];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #execute: NonNullable<CodeGraphProjectSupervisorOptions["execute"]>;
  readonly #now: () => Date;
  readonly #onStatus: NonNullable<
    CodeGraphProjectSupervisorOptions["onStatus"]
  >;
  readonly #projects = new Map<string, ManagedProject>();
  readonly #excludeQueues = new Map<string, Promise<void>>();
  readonly #watch: NonNullable<CodeGraphProjectSupervisorOptions["watch"]>;
  #activeOperations = 0;
  #closed = false;
  #configurationGeneration = 0;
  #reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CodeGraphProjectSupervisorOptions) {
    this.#authorize = options.authorize;
    this.#command = options.command;
    this.#commandArguments = [...(options.commandArguments ?? [])];
    this.#environment = {
      ...process.env,
      ...options.environment,
      CODEGRAPH_DIR: INDEX_DIRECTORY,
      CODEGRAPH_NO_UPDATE_CHECK: "1",
      CODEGRAPH_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1",
    };
    this.#execute = options.execute ?? processOutcome;
    this.#now = options.now ?? (() => new Date());
    this.#onStatus = options.onStatus ?? (() => undefined);
    this.#watch =
      options.watch ??
      ((root, listener) => watch(root, { recursive: true }, listener));
  }

  async configure(targets: WorktreeObservationTarget[]): Promise<void> {
    if (this.#closed) return;
    const generation = ++this.#configurationGeneration;
    const requested = new Set(
      targets.map(({ worktreePath }) => path.resolve(worktreePath)),
    );
    for (const [root, project] of this.#projects) {
      if (!requested.has(root)) this.#remove(project);
    }
    const grouped = new Map<string, WorktreeObservationTarget[]>();
    for (const target of targets) {
      const group = grouped.get(target.sourcePath) ?? [];
      group.push(target);
      grouped.set(target.sourcePath, group);
    }
    const results = await mapSettledConcurrent(
      [...grouped.entries()],
      MAX_CONCURRENT_AUTHORIZATIONS,
      async ([sourcePath, sourceTargets]) => {
        const authorized = await this.#authorize(
          sourcePath,
          sourceTargets.map(({ worktreePath }) => worktreePath),
        );
        if (authorized.length !== sourceTargets.length) {
          throw new Error(
            "CodeGraph worktree authorization returned an incomplete result.",
          );
        }
        const roots = await Promise.all(
          authorized.map(async (entry, index) => {
            const target = sourceTargets[index]!;
            const [root, requestedRoot] = await Promise.all([
              realpath(entry.root),
              realpath(target.worktreePath),
            ]);
            if (root !== requestedRoot) {
              throw new Error(
                "Authorized CodeGraph worktree path was not canonical.",
              );
            }
            return { authorized: entry, root, target };
          }),
        );
        return roots;
      },
    );
    for (const result of results) {
      if (result.status === "rejected") {
        workerLogger.event("warn", "CodeGraph worktree authorization failed", {
          event: "codegraph.project.authorization-failed",
          subsystem: "codegraph",
          operation: "authorize-worktree",
          reasonCode: "authorization-failed",
          status: "degraded",
          error: workerLogError(result.reason),
        });
        continue;
      }
      for (const { authorized, root, target } of result.value) {
        if (this.#closed || generation !== this.#configurationGeneration)
          return;
        const existing = this.#projects.get(root);
        if (existing) {
          existing.sourcePath = target.sourcePath;
          existing.projectId = target.projectId ?? existing.projectId;
          existing.worktreeId = target.worktreeId ?? existing.worktreeId;
          continue;
        }
        const project: ManagedProject = {
          abortController: null,
          changeTimer: null,
          closed: false,
          edgeCount: null,
          error: null,
          failureCount: 0,
          fileCount: null,
          indexPath: path.join(root, INDEX_DIRECTORY),
          lastIndexedAt: null,
          lastSuccessfulSyncAt: null,
          nodeCount: null,
          pendingAction: null,
          pendingChanges: null,
          projectId: target.projectId ?? null,
          worktreeId: target.worktreeId ?? null,
          job: null,
          queued: false,
          retryTimer: null,
          root,
          running: false,
          sourcePath: target.sourcePath,
          state: "queued",
          watcher: null,
          watcherRetryTimer: null,
        };
        this.#projects.set(root, project);
        try {
          await this.#installGitExclude(project, authorized.gitCommonDir);
        } catch (error) {
          this.#remove(project);
          workerLogger.event("warn", "CodeGraph worktree preparation failed", {
            event: "codegraph.project.prepare-failed",
            subsystem: "codegraph",
            operation: "prepare-worktree",
            reasonCode: "git-exclude-failed",
            status: "degraded",
            worktreePath: root,
            error: workerLogError(error),
          });
          continue;
        }
        if (project.closed || !this.#projects.has(root)) continue;
        this.#watchProject(project);
        this.#schedule(project, "ensure");
      }
    }
    if (!this.#reconcileTimer) {
      this.#reconcileTimer = setInterval(() => {
        for (const project of this.#projects.values()) {
          this.#schedule(project, "sync");
        }
      }, RECONCILE_INTERVAL_MS);
      this.#reconcileTimer.unref();
    }
    if (targets.length === 0 && this.#reconcileTimer) {
      clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = null;
    }
  }

  statuses(): CodeGraphProjectStatus[] {
    return [...this.#projects.values()].map((project) => ({
      edgeCount: project.edgeCount,
      error: project.error,
      fileCount: project.fileCount,
      indexPath: project.indexPath,
      lastIndexedAt: project.lastIndexedAt,
      lastSuccessfulSyncAt: project.lastSuccessfulSyncAt,
      nodeCount: project.nodeCount,
      pendingChanges: project.pendingChanges,
      root: project.root,
      state: project.state,
    }));
  }

  publicStatus(
    projectId: string,
    worktreeId: string,
  ): PublicCodeGraphProjectStatus | null {
    const project = [...this.#projects.values()].find(
      (candidate) =>
        candidate.projectId === projectId &&
        candidate.worktreeId === worktreeId,
    );
    return project ? this.#publicStatus(project) : null;
  }

  requestAction(
    projectId: string,
    worktreeId: string,
    action: "sync" | "rebuild",
  ): CodeGraphActionAcknowledgement {
    const project = [...this.#projects.values()].find(
      (candidate) =>
        candidate.projectId === projectId &&
        candidate.worktreeId === worktreeId,
    );
    if (!project) {
      throw new Error("CodeGraph worktree is not managed by this worker.");
    }
    const acceptedAt = this.#now().toISOString();
    project.job = {
      id: randomUUID(),
      action,
      state: "queued",
      requestedAt: acceptedAt,
      completedAt: null,
    };
    this.#schedule(project, action);
    this.#emit(project);
    return codeGraphActionAcknowledgementSchema.parse({
      jobId: project.job.id,
      action,
      acceptedAt,
      status: "queued",
    });
  }

  /**
   * Resolve an agent cwd only against the already authorized worktree
   * inventory. A bounded catch-up is requested before the turn, but a large or
   * degraded graph never blocks unrelated agent execution indefinitely.
   */
  async prepareForAgent(
    candidateRoot: string,
    timeoutMs = AGENT_CATCH_UP_WAIT_MS,
  ): Promise<string | null> {
    let root: string;
    try {
      root = await realpath(candidateRoot);
    } catch {
      return null;
    }
    const project = this.#projects.get(root);
    if (!project || project.closed) return null;

    const lastSuccessfulSyncAt = project.lastSuccessfulSyncAt
      ? Date.parse(project.lastSuccessfulSyncAt)
      : Number.NaN;
    const stale =
      !Number.isFinite(lastSuccessfulSyncAt) ||
      this.#now().getTime() - lastSuccessfulSyncAt >=
        AGENT_CATCH_UP_INTERVAL_MS;
    if (
      stale ||
      project.pendingChanges !== 0 ||
      project.state === "degraded" ||
      project.state === "unavailable"
    ) {
      this.#schedule(project, "sync");
    }

    if (project.running || project.queued) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (
        !project.closed &&
        (project.running || project.queued) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return !project.closed && this.#projects.get(root) === project
      ? root
      : null;
  }

  resync(root: string): void {
    const project = this.#projects.get(path.resolve(root));
    if (!project)
      throw new Error("CodeGraph worktree is not managed by this worker.");
    this.#schedule(project, "sync");
  }

  rebuild(root: string): void {
    const project = this.#projects.get(path.resolve(root));
    if (!project)
      throw new Error("CodeGraph worktree is not managed by this worker.");
    this.#schedule(project, "rebuild");
  }

  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const startedAt = Date.now();
    while (
      this.#activeOperations > 0 ||
      [...this.#projects.values()].some(
        (project) => project.queued || project.running,
      )
    ) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Timed out waiting for CodeGraph project operations.");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  detach(root: string): void {
    const project = this.#projects.get(path.resolve(root));
    if (project) this.#remove(project);
  }

  close(): void {
    this.#closed = true;
    this.#configurationGeneration += 1;
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = null;
    for (const project of [...this.#projects.values()]) this.#remove(project);
  }

  async #installGitExclude(
    project: ManagedProject,
    gitCommonDirectory: string,
  ): Promise<void> {
    const canonicalCommon = await realpath(gitCommonDirectory);
    const exclude = path.join(canonicalCommon, "info", "exclude");
    const previous = this.#excludeQueues.get(exclude) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(exclude), { recursive: true, mode: 0o700 });
        const canonicalParent = await realpath(path.dirname(exclude));
        if (
          !within(canonicalCommon, canonicalParent) ||
          (await isSymlink(exclude))
        ) {
          throw new Error("CodeGraph Git exclude path is unsafe.");
        }
        const existing = await readFile(exclude, "utf8").catch(
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
          },
        );
        if (existing.includes(EXCLUDE_BEGIN)) return;
        const next = `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${EXCLUDE_BLOCK}\n`;
        const temporary = `${exclude}.cantrip-${process.pid}-${Date.now()}`;
        await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
        await rename(temporary, exclude).catch(async (error) => {
          await rm(temporary, { force: true });
          throw error;
        });
      });
    this.#excludeQueues.set(exclude, current);
    try {
      await current;
    } finally {
      if (this.#excludeQueues.get(exclude) === current)
        this.#excludeQueues.delete(exclude);
    }
    workerLogger.event("debug", "CodeGraph local Git exclusion installed", {
      event: "codegraph.project.exclude-ready",
      subsystem: "codegraph",
      operation: "install-git-exclude",
      status: "completed",
      worktreePath: project.root,
    });
  }

  #watchProject(project: ManagedProject): void {
    if (project.closed || project.watcher) return;
    try {
      const watcher = this.#watch(project.root, (_event, fileName) => {
        const relative =
          fileName === null ? null : String(fileName).replace(/\\/gu, "/");
        if (
          relative &&
          (relative === INDEX_DIRECTORY ||
            relative.startsWith(`${INDEX_DIRECTORY}/`) ||
            relative === ".git" ||
            relative.startsWith(".git/"))
        ) {
          return;
        }
        if (project.changeTimer) clearTimeout(project.changeTimer);
        project.changeTimer = setTimeout(() => {
          project.changeTimer = null;
          this.#schedule(project, "sync");
        }, CHANGE_DEBOUNCE_MS);
        project.changeTimer.unref();
      });
      watcher.once("error", (error) => {
        if (project.watcher === watcher) project.watcher = null;
        watcher.close();
        this.#scheduleWatcherRetry(project, error);
      });
      project.watcher = watcher;
    } catch (error) {
      this.#scheduleWatcherRetry(project, error);
    }
  }

  #scheduleWatcherRetry(project: ManagedProject, error: unknown): void {
    if (project.closed || project.watcherRetryTimer) return;
    workerLogger.event("warn", "CodeGraph filesystem watcher is unavailable", {
      event: "codegraph.project.watcher-failed",
      subsystem: "codegraph",
      operation: "watch-worktree",
      reasonCode: "watcher-failed",
      status: "degraded",
      worktreePath: project.root,
      error: workerLogError(error),
    });
    const delay = Math.min(
      MAX_RETRY_MS,
      5_000 * 2 ** Math.min(project.failureCount, 6),
    );
    project.watcherRetryTimer = setTimeout(() => {
      project.watcherRetryTimer = null;
      this.#watchProject(project);
    }, delay);
    project.watcherRetryTimer.unref();
  }

  #schedule(project: ManagedProject, action: CodeGraphPendingAction): void {
    if (this.#closed || project.closed) return;
    if (
      !project.pendingAction ||
      actionPriority(action) > actionPriority(project.pendingAction)
    ) {
      project.pendingAction = action;
    }
    if (!project.queued) {
      project.queued = true;
      if (project.state !== "indexing" && project.state !== "syncing") {
        project.state = "queued";
      }
    }
    this.#pump();
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#activeOperations < MAX_CONCURRENT_OPERATIONS) {
      const project = [...this.#projects.values()].find(
        (candidate) =>
          candidate.queued && !candidate.running && !candidate.closed,
      );
      if (!project) break;
      const action = project.pendingAction;
      project.pendingAction = null;
      project.queued = false;
      if (!action) continue;
      this.#activeOperations += 1;
      project.running = true;
      if (project.job && project.job.action === action) {
        project.job = { ...project.job, state: "running" };
      }
      project.abortController = new AbortController();
      this.#emit(project);
      void this.#run(project, action).finally(() => {
        project.abortController = null;
        project.running = false;
        this.#activeOperations -= 1;
        this.#pump();
      });
    }
  }

  async #run(
    project: ManagedProject,
    action: CodeGraphPendingAction,
  ): Promise<void> {
    const startedAt = Date.now();
    project.state =
      action === "rebuild" || action === "ensure" ? "indexing" : "syncing";
    project.error = null;
    try {
      const before = await this.#readStatus(project);
      if (project.closed) return;
      const command =
        action === "rebuild" || before.reindexRecommended
          ? "index"
          : before.initialized
            ? "sync"
            : "init";
      const timeoutMs = command === "sync" ? SYNC_TIMEOUT_MS : INDEX_TIMEOUT_MS;
      const result = await this.#execute(
        this.#command,
        [...this.#commandArguments, command, project.root],
        {
          cwd: project.root,
          environment: this.#environment,
          signal: project.abortController?.signal,
          timeoutMs,
        },
      );
      if (result.code !== 0) {
        throw new Error(
          `codegraph ${command} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
        );
      }
      const after = await this.#readStatus(project);
      if (!after.initialized)
        throw new Error("CodeGraph did not initialize its index.");
      project.failureCount = 0;
      project.lastSuccessfulSyncAt = this.#now().toISOString();
      project.state = "ready";
      if (project.job && project.job.action === action) {
        project.job = {
          ...project.job,
          state: "completed",
          completedAt: this.#now().toISOString(),
        };
      }
      this.#emit(project);
      workerLogger.event(
        command === "sync" && before.pendingChanges === 0 ? "debug" : "info",
        "CodeGraph worktree synchronized",
        {
          event: "codegraph.project.sync-completed",
          subsystem: "codegraph",
          operation: command,
          status: "completed",
          worktreePath: project.root,
          durationMs: Date.now() - startedAt,
          fileCount: project.fileCount,
          nodeCount: project.nodeCount,
        },
      );
    } catch (error) {
      if (project.closed) return;
      project.failureCount += 1;
      project.error = workerLogError(error).message;
      project.state = "degraded";
      if (project.job && project.job.action === action) {
        project.job = {
          ...project.job,
          state: "failed",
          completedAt: this.#now().toISOString(),
        };
      }
      this.#emit(project);
      workerLogger.event("warn", "CodeGraph worktree synchronization failed", {
        event: "codegraph.project.sync-failed",
        subsystem: "codegraph",
        operation: action,
        reasonCode: "sync-failed",
        status: "degraded",
        worktreePath: project.root,
        durationMs: Date.now() - startedAt,
        error: workerLogError(error),
      });
      if (!project.retryTimer) {
        const delay = Math.min(
          MAX_RETRY_MS,
          5_000 * 2 ** Math.min(project.failureCount - 1, 6),
        );
        project.retryTimer = setTimeout(() => {
          project.retryTimer = null;
          this.#schedule(project, action);
        }, delay);
        project.retryTimer.unref();
      }
    }
  }

  async #readStatus(
    project: ManagedProject,
  ): Promise<ReturnType<typeof parseStatus>> {
    const result = await this.#execute(
      this.#command,
      [...this.#commandArguments, "status", "--json", project.root],
      {
        cwd: project.root,
        environment: this.#environment,
        signal: project.abortController?.signal,
        timeoutMs: STATUS_TIMEOUT_MS,
      },
    );
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout).trim().toLowerCase();
      if (output.includes("not initialized") || output.includes("not found")) {
        return {
          edgeCount: null,
          fileCount: null,
          initialized: false,
          lastIndexedAt: null,
          nodeCount: null,
          pendingChanges: null,
          reindexRecommended: false,
        };
      }
      throw new Error(
        `codegraph status failed: ${output || `exit ${result.code}`}`,
      );
    }
    const status = parseStatus(result.stdout, project.root);
    project.edgeCount = status.edgeCount;
    project.fileCount = status.fileCount;
    project.lastIndexedAt = status.lastIndexedAt;
    project.nodeCount = status.nodeCount;
    project.pendingChanges = status.pendingChanges;
    return status;
  }

  #remove(project: ManagedProject): void {
    project.closed = true;
    project.watcher?.close();
    project.watcher = null;
    if (project.changeTimer) clearTimeout(project.changeTimer);
    if (project.retryTimer) clearTimeout(project.retryTimer);
    if (project.watcherRetryTimer) clearTimeout(project.watcherRetryTimer);
    project.abortController?.abort();
    this.#projects.delete(project.root);
  }

  #publicStatus(project: ManagedProject): PublicCodeGraphProjectStatus {
    if (!project.projectId || !project.worktreeId) {
      throw new Error("CodeGraph project identity is unavailable.");
    }
    return codeGraphProjectStatusSchema.parse({
      projectId: project.projectId,
      worktreeId: project.worktreeId,
      state: project.state,
      lastIndexedAt: project.lastIndexedAt,
      lastSuccessfulSyncAt: project.lastSuccessfulSyncAt,
      fileCount: project.fileCount,
      nodeCount: project.nodeCount,
      edgeCount: project.edgeCount,
      pendingChanges: project.pendingChanges,
      statusMessage: project.error?.slice(0, 1_000) ?? null,
      job: project.job,
    });
  }

  #emit(project: ManagedProject): void {
    if (!project.projectId || !project.worktreeId) return;
    try {
      this.#onStatus(this.#publicStatus(project));
    } catch (error) {
      workerLogger.event("warn", "CodeGraph status observation failed", {
        event: "codegraph.project.observation-failed",
        subsystem: "codegraph",
        operation: "publish-status",
        reasonCode: "observer-failed",
        status: "degraded",
        worktreePath: project.root,
        error: workerLogError(error),
      });
    }
  }
}
