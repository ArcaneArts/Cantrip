import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  worktreeCreateResultSchema,
  worktreeInventorySchema,
  worktreeMutationResultSchema,
  worktreePruneResultSchema,
  worktreeRemoveResultSchema,
  worktreeStatusResultSchema,
  type WorkerNotification,
  type WorkerWorktreeSummary,
  type WorktreeCreateMode,
  type WorktreeCreateResult,
  type WorktreeInventory,
  type WorktreeMutationResult,
  type WorktreeObservationTarget,
  type WorktreePruneResult,
  type WorktreeRemoveResult,
  type WorktreeStatusResult,
} from "@cantrip/protocol";

import { readGitStatus } from "./git.js";

const execFileAsync = promisify(execFile);
const GIT_BUFFER = 16 * 1024 * 1024;
const OBSERVATION_DEBOUNCE_MS = 500;
const OBSERVATION_HEAD_RECONCILE_MS = 2_000;
const OBSERVATION_RECONCILE_MS = 30_000;
const OBSERVATION_SCAN_CONCURRENCY = 4;

interface ObservedWorktree extends WorktreeObservationTarget {
  worktree: WorkerWorktreeSummary | null;
}

function observationKey(target: WorktreeObservationTarget): string {
  return `${target.sourcePath}\0${target.worktreePath}`;
}

async function forEachConcurrent<T>(
  items: T[],
  limit: number,
  visit: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        if (item !== undefined) await visit(item);
      }
    }),
  );
}

export interface ParsedWorktreeRecord {
  branch: string | null;
  detached: boolean;
  head: string | null;
  locked: boolean;
  lockReason: string | null;
  path: string;
  prunable: boolean;
  pruneReason: string | null;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_BUFFER,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    throw new Error(
      failure.stderr?.trim() ||
        failure.stdout?.trim() ||
        failure.message ||
        "Git worktree command failed.",
    );
  }
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_BUFFER,
    });
    return stdout;
  } catch (error) {
    const failure = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    throw new Error(
      failure.stderr?.trim() ||
        failure.stdout?.trim() ||
        failure.message ||
        "Git worktree command failed.",
    );
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function valueAfterPrefix(token: string, prefix: string): string | null {
  if (token === prefix) return "";
  return token.startsWith(`${prefix} `) ? token.slice(prefix.length + 1) : null;
}

export function parseGitWorktreePorcelain(
  output: string,
): ParsedWorktreeRecord[] {
  const records: ParsedWorktreeRecord[] = [];
  let current: ParsedWorktreeRecord | null = null;

  const finish = () => {
    if (!current) return;
    records.push(current);
    current = null;
  };

  for (const token of output.split("\0")) {
    if (!token) {
      finish();
      continue;
    }
    const worktreePath = valueAfterPrefix(token, "worktree");
    if (worktreePath !== null) {
      finish();
      if (!worktreePath)
        throw new Error("Git returned an empty worktree path.");
      current = {
        path: worktreePath,
        head: null,
        branch: null,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
      };
      continue;
    }
    if (!current) continue;

    const head = valueAfterPrefix(token, "HEAD");
    if (head !== null) {
      current.head = head || null;
      continue;
    }
    const branch = valueAfterPrefix(token, "branch");
    if (branch !== null) {
      current.branch = branch.replace(/^refs\/heads\//u, "") || null;
      continue;
    }
    if (token === "detached") {
      current.detached = true;
      continue;
    }
    const locked = valueAfterPrefix(token, "locked");
    if (locked !== null) {
      current.locked = true;
      current.lockReason = locked || null;
      continue;
    }
    const prunable = valueAfterPrefix(token, "prunable");
    if (prunable !== null) {
      current.prunable = true;
      current.pruneReason = prunable || null;
    }
  }
  finish();
  return records;
}

export class WorktreeManager {
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly observationFingerprints = new Map<string, string>();
  private readonly observationHeads = new Map<string, string | null>();
  private readonly observationInventoryFingerprints = new Map<string, string>();
  private readonly observationTargets = new Map<string, ObservedWorktree>();
  private readonly observationTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly observationWatchers = new Map<string, FSWatcher[]>();
  private observationEmitter: (notification: WorkerNotification) => boolean =
    () => false;
  private observationHeadSweep: ReturnType<typeof setInterval> | null = null;
  private observationHeadSweepRunning = false;
  private observationSweep: ReturnType<typeof setInterval> | null = null;
  private observationSweepRunning = false;

  constructor(private readonly dataDirectory: string) {}

  setObservationEmitter(
    emitter: (notification: WorkerNotification) => boolean,
  ): void {
    this.observationEmitter = emitter;
  }

  configureObservation(targets: WorktreeObservationTarget[]): void {
    const next = new Map(
      targets.map((target) => [
        observationKey(target),
        { ...target, worktree: null } satisfies ObservedWorktree,
      ]),
    );
    if (
      next.size === this.observationTargets.size &&
      [...next.keys()].every((key) => this.observationTargets.has(key))
    ) {
      void this.refreshObservedSources(false);
      return;
    }
    for (const [key, watchers] of this.observationWatchers) {
      if (next.has(key)) continue;
      for (const watcher of watchers) watcher.close();
      this.observationWatchers.delete(key);
    }
    for (const [key, timer] of this.observationTimers) {
      if (next.has(key)) continue;
      clearTimeout(timer);
      this.observationTimers.delete(key);
    }
    for (const key of this.observationTargets.keys()) {
      if (next.has(key)) continue;
      this.observationFingerprints.delete(key);
      this.observationHeads.delete(key);
    }
    this.observationTargets.clear();
    for (const [key, target] of next) {
      this.observationTargets.set(key, target);
    }
    if (this.observationTargets.size > 0 && !this.observationSweep) {
      this.observationSweep = setInterval(
        () => void this.refreshObservedSources(false),
        OBSERVATION_RECONCILE_MS,
      );
      this.observationSweep.unref();
    } else if (this.observationTargets.size === 0 && this.observationSweep) {
      clearInterval(this.observationSweep);
      this.observationSweep = null;
    }
    if (this.observationTargets.size > 0 && !this.observationHeadSweep) {
      this.observationHeadSweep = setInterval(
        () => void this.refreshObservedHeads(),
        OBSERVATION_HEAD_RECONCILE_MS,
      );
      this.observationHeadSweep.unref();
    } else if (
      this.observationTargets.size === 0 &&
      this.observationHeadSweep
    ) {
      clearInterval(this.observationHeadSweep);
      this.observationHeadSweep = null;
    }
    void this.refreshObservedSources(true);
  }

  close(): void {
    if (this.observationSweep) clearInterval(this.observationSweep);
    this.observationSweep = null;
    if (this.observationHeadSweep) clearInterval(this.observationHeadSweep);
    this.observationHeadSweep = null;
    for (const timer of this.observationTimers.values()) clearTimeout(timer);
    this.observationTimers.clear();
    for (const watchers of this.observationWatchers.values()) {
      for (const watcher of watchers) watcher.close();
    }
    this.observationWatchers.clear();
    this.observationTargets.clear();
    this.observationHeads.clear();
  }

  private async watchTarget(
    key: string,
    target: ObservedWorktree,
  ): Promise<void> {
    const watchers: FSWatcher[] = [];
    const install = (watchedPath: string): void => {
      if (this.observationWatchers.get(key) !== watchers) return;
      const watcher = watch(watchedPath, { recursive: true }, () =>
        this.scheduleObservedTarget(key),
      );
      watcher.on("error", () => {
        const current = this.observationWatchers.get(key);
        if (current !== watchers) return;
        const index = watchers.indexOf(watcher);
        if (index >= 0) watchers.splice(index, 1);
        if (watchers.length === 0) this.observationWatchers.delete(key);
        watcher.close();
      });
      watchers.push(watcher);
    };
    this.observationWatchers.set(key, watchers);
    try {
      install(target.worktreePath);
    } catch {
      // Git metadata watching below may still be available.
    }
    try {
      const gitDirectories = await Promise.all(
        ["--git-dir", "--git-common-dir"].map((argument) =>
          gitOutput(target.worktreePath, [
            "rev-parse",
            "--path-format=absolute",
            argument,
          ]),
        ),
      );
      for (const gitDirectory of new Set(
        gitDirectories.map((gitDirectory) => path.resolve(gitDirectory)),
      )) {
        if (gitDirectory !== path.resolve(target.worktreePath)) {
          install(gitDirectory);
        }
      }
    } catch {
      if (watchers.length === 0) this.observationWatchers.delete(key);
    }
  }

  private scheduleObservedTarget(key: string): void {
    const existing = this.observationTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.observationTimers.delete(key);
      void this.refreshObservedTarget(key);
    }, OBSERVATION_DEBOUNCE_MS);
    timer.unref();
    this.observationTimers.set(key, timer);
  }

  private async refreshObservedTarget(key: string): Promise<void> {
    const target = this.observationTargets.get(key);
    if (!target?.worktree || target.worktree.missing) {
      await this.refreshObservedSource(target?.sourcePath ?? "", false);
      return;
    }
    try {
      await this.emitObservedStatus(key, target, false);
    } catch {
      // A later source reconciliation handles deleted, moved, or temporarily
      // inaccessible worktrees without trusting watcher paths.
    }
  }

  private async refreshObservedSources(force: boolean): Promise<void> {
    if (this.observationSweepRunning) return;
    this.observationSweepRunning = true;
    try {
      const sources = [
        ...new Set(
          [...this.observationTargets.values()].map(
            ({ sourcePath }) => sourcePath,
          ),
        ),
      ];
      await forEachConcurrent(sources, 2, (sourcePath) =>
        this.refreshObservedSource(sourcePath, force),
      );
    } finally {
      this.observationSweepRunning = false;
    }
  }

  private async refreshObservedHeads(): Promise<void> {
    if (this.observationHeadSweepRunning) return;
    this.observationHeadSweepRunning = true;
    try {
      await forEachConcurrent(
        [...this.observationTargets.entries()],
        OBSERVATION_SCAN_CONCURRENCY,
        async ([key, target]) => {
          if (!target.worktree || target.worktree.missing) return;
          const head = await gitOutput(target.worktreePath, [
            "rev-parse",
            "--verify",
            "HEAD",
          ]).catch(() => null);
          const previous = this.observationHeads.get(key);
          this.observationHeads.set(key, head);
          if (previous !== undefined && previous !== head) {
            this.scheduleObservedTarget(key);
          }
        },
      );
    } finally {
      this.observationHeadSweepRunning = false;
    }
  }

  private async refreshObservedSource(
    sourcePath: string,
    force: boolean,
  ): Promise<void> {
    if (!sourcePath) return;
    try {
      const inventory = await this.list(sourcePath);
      const inventoryFingerprint = JSON.stringify(inventory);
      if (
        (force ||
          inventoryFingerprint !==
            this.observationInventoryFingerprints.get(sourcePath)) &&
        this.observationEmitter({
          type: "worktree.inventory.observed",
          sourcePath,
          inventory,
        })
      ) {
        this.observationInventoryFingerprints.set(
          sourcePath,
          inventoryFingerprint,
        );
      }
      const targets = [...this.observationTargets.entries()].filter(
        ([, target]) => target.sourcePath === sourcePath,
      );
      for (const [key, target] of targets) {
        target.worktree =
          inventory.worktrees.find(
            ({ path: candidate }) => candidate === target.worktreePath,
          ) ?? null;
        if (
          target.worktree &&
          !target.worktree.missing &&
          !this.observationWatchers.has(key)
        ) {
          await this.watchTarget(key, target);
        }
      }
      await forEachConcurrent(
        targets,
        OBSERVATION_SCAN_CONCURRENCY,
        async ([key, target]) => {
          if (!target.worktree || target.worktree.missing) return;
          await this.emitObservedStatus(key, target, force);
        },
      );
    } catch {
      // Watch events and future reconciliation sweeps retry transient Git and
      // filesystem failures without producing an incorrect empty snapshot.
    }
  }

  private async emitObservedStatus(
    key: string,
    target: ObservedWorktree,
    force: boolean,
  ): Promise<void> {
    if (!target.worktree) return;
    const result = worktreeStatusResultSchema.parse({
      worktree: target.worktree,
      status: await readGitStatus(target.worktree.path),
    });
    this.observationHeads.set(key, result.status.head);
    const fingerprint = JSON.stringify(result);
    if (
      (force || fingerprint !== this.observationFingerprints.get(key)) &&
      this.observationEmitter({
        type: "worktree.status.observed",
        sourcePath: target.sourcePath,
        worktreePath: target.worktreePath,
        result,
      })
    ) {
      this.observationFingerprints.set(key, fingerprint);
    }
  }

  private managedRoot(): string {
    return path.resolve(this.dataDirectory, "worktrees");
  }

  private async gitCommonDir(sourcePath: string): Promise<string> {
    const absolute = await gitOutput(sourcePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return realpath(absolute);
  }

  private async serialize<T>(
    sourcePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = await this.gitCommonDir(sourcePath);
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.mutationQueues.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationQueues.get(key) === queued) {
        this.mutationQueues.delete(key);
      }
    }
  }

  async list(sourcePath: string): Promise<WorktreeInventory> {
    const sourceRoot = await realpath(
      await gitOutput(sourcePath, ["rev-parse", "--show-toplevel"]),
    );
    const gitCommonDir = await this.gitCommonDir(sourceRoot);
    const parsed = parseGitWorktreePorcelain(
      await gitRaw(sourceRoot, ["worktree", "list", "--porcelain", "-z"]),
    );
    if (parsed.length === 0) {
      throw new Error("Git did not report a Primary worktree.");
    }

    const configuredManagedRoot = this.managedRoot();
    const managedRoot = (await exists(configuredManagedRoot))
      ? await realpath(configuredManagedRoot)
      : configuredManagedRoot;
    const canonicalRecords = await Promise.all(
      parsed.map(async (record, index): Promise<WorkerWorktreeSummary> => {
        const missing = !(await exists(record.path));
        const canonicalPath = missing
          ? path.resolve(record.path)
          : await realpath(record.path);
        return {
          path: canonicalPath,
          head: record.head,
          branch: record.branch,
          detached: record.detached,
          isPrimary: index === 0,
          managed: isWithin(managedRoot, canonicalPath),
          locked: record.locked,
          lockReason: record.lockReason,
          prunable: record.prunable,
          pruneReason: record.pruneReason,
          missing,
        };
      }),
    );
    if (!canonicalRecords.some((record) => record.path === sourceRoot)) {
      throw new Error(
        "Project source is not registered in its Git worktree list.",
      );
    }

    return worktreeInventorySchema.parse({
      sourcePath: sourceRoot,
      primaryPath: canonicalRecords[0]!.path,
      gitCommonDir,
      managedRoot,
      repositoryFingerprint: createHash("sha256")
        .update(gitCommonDir)
        .digest("hex"),
      worktrees: canonicalRecords,
    });
  }

  async reconcile(sourcePath: string): Promise<WorktreeInventory> {
    return this.list(sourcePath);
  }

  private async resolveTarget(
    sourcePath: string,
    requestedPath: string,
  ): Promise<{
    inventory: WorktreeInventory;
    worktree: WorkerWorktreeSummary;
  }> {
    const inventory = await this.list(sourcePath);
    const requested = (await exists(requestedPath))
      ? await realpath(requestedPath)
      : path.resolve(requestedPath);
    const worktree = inventory.worktrees.find(
      ({ path: candidate }) => candidate === requested,
    );
    if (!worktree) {
      throw new Error(
        "The requested path is not a worktree of this project source.",
      );
    }

    if (!worktree.missing) {
      const targetCommonDir = await this.gitCommonDir(worktree.path);
      if (targetCommonDir !== inventory.gitCommonDir) {
        throw new Error(
          "The requested worktree belongs to a different repository.",
        );
      }
    }
    return { inventory, worktree };
  }

  async authorizeTargets(
    sourcePath: string,
    worktreePaths: string[],
  ): Promise<
    Array<{
      inventory: WorktreeInventory;
      worktree: WorkerWorktreeSummary;
    }>
  > {
    const inventory = await this.list(sourcePath);
    const requested = await Promise.all(
      worktreePaths.map(async (worktreePath) =>
        (await exists(worktreePath))
          ? realpath(worktreePath)
          : path.resolve(worktreePath),
      ),
    );
    return requested.map((canonicalPath) => {
      const worktree = inventory.worktrees.find(
        ({ path: candidate }) => candidate === canonicalPath,
      );
      if (!worktree) {
        throw new Error(
          "The requested path is not a worktree of this project source.",
        );
      }
      if (worktree.missing) {
        throw new Error("Cannot authorize a missing worktree.");
      }
      return { inventory, worktree };
    });
  }

  private async managedTarget(
    inventory: WorktreeInventory,
    worktreeId: string,
    name: string,
  ): Promise<string> {
    await mkdir(inventory.managedRoot, { recursive: true, mode: 0o700 });
    const canonicalManagedRoot = await realpath(inventory.managedRoot);
    const repositoryRoot = path.join(
      canonicalManagedRoot,
      inventory.repositoryFingerprint.slice(0, 20),
    );
    await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    if (!isWithin(canonicalManagedRoot, canonicalRepositoryRoot)) {
      throw new Error(
        "Managed worktree root escaped the worker data directory.",
      );
    }

    const slug =
      name
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 48) || "worktree";
    const identity = createHash("sha256")
      .update(worktreeId)
      .digest("hex")
      .slice(0, 12);
    const target = path.join(canonicalRepositoryRoot, `${slug}-${identity}`);
    if (!isWithin(canonicalManagedRoot, target)) {
      throw new Error(
        "Managed worktree path escaped the worker data directory.",
      );
    }
    return target;
  }

  async create(
    sourcePath: string,
    worktreeId: string,
    name: string,
    mode: WorktreeCreateMode,
  ): Promise<WorktreeCreateResult> {
    return this.serialize(sourcePath, async () => {
      const inventory = await this.list(sourcePath);
      const target = await this.managedTarget(inventory, worktreeId, name);
      const args = ["worktree", "add"];
      let detachedRevision: string | null = null;
      switch (mode.type) {
        case "newBranch":
          await gitOutput(inventory.sourcePath, [
            "check-ref-format",
            "--branch",
            mode.branch,
          ]);
          if (mode.startPoint) {
            await gitOutput(inventory.sourcePath, [
              "rev-parse",
              "--verify",
              "--end-of-options",
              `${mode.startPoint}^{commit}`,
            ]);
          }
          args.push("-b", mode.branch, "--", target);
          if (mode.startPoint) args.push(mode.startPoint);
          break;
        case "existingBranch":
          await gitOutput(inventory.sourcePath, [
            "check-ref-format",
            "--branch",
            mode.branch,
          ]);
          await gitOutput(inventory.sourcePath, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `refs/heads/${mode.branch}^{commit}`,
          ]);
          args.push("--", target, mode.branch);
          break;
        case "detached":
          detachedRevision = await gitOutput(inventory.sourcePath, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${mode.revision}^{commit}`,
          ]);
          args.push("--detach", "--", target, mode.revision);
          break;
      }
      const existing = inventory.worktrees.find(
        ({ path: candidate }) => candidate === target,
      );
      if (existing) {
        const matches =
          !existing.isPrimary &&
          existing.managed &&
          !existing.missing &&
          !existing.prunable &&
          (mode.type === "detached"
            ? existing.detached && existing.head === detachedRevision
            : !existing.detached && existing.branch === mode.branch);
        if (!matches) {
          throw new Error(
            "The managed worktree identity belongs to a different create request.",
          );
        }
        return worktreeCreateResultSchema.parse({
          worktree: existing,
          inventory,
        });
      }
      if (await exists(target)) {
        throw new Error("The managed worktree destination already exists.");
      }
      await gitOutput(inventory.sourcePath, args);

      const next = await this.list(inventory.sourcePath);
      const created = next.worktrees.find(
        ({ path: candidate }) => candidate === target,
      );
      if (!created || !created.managed) {
        throw new Error("Git created a worktree outside the managed root.");
      }
      return worktreeCreateResultSchema.parse({
        worktree: created,
        inventory: next,
      });
    });
  }

  async remove(
    sourcePath: string,
    worktreePath: string,
    options: { allowExternal: boolean; force: boolean },
  ): Promise<WorktreeRemoveResult> {
    return this.serialize(sourcePath, async () => {
      const { inventory, worktree } = await this.resolveTarget(
        sourcePath,
        worktreePath,
      );
      if (worktree.isPrimary) {
        throw new Error("Primary cannot be removed as an individual worktree.");
      }
      if (!worktree.managed && !options.allowExternal) {
        throw new Error(
          "Removing an external worktree requires explicit user authorization.",
        );
      }
      if (worktree.locked) {
        throw new Error("Unlock the worktree before removing it.");
      }
      if (worktree.missing) {
        throw new Error(
          "The worktree is missing; prune its stale metadata instead.",
        );
      }
      const dirty = Boolean(
        await gitOutput(worktree.path, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ]),
      );
      if (dirty && !options.force) {
        throw new Error("The worktree has uncommitted changes.");
      }
      await gitOutput(inventory.sourcePath, [
        "worktree",
        "remove",
        ...(options.force ? ["--force"] : []),
        worktree.path,
      ]);
      return worktreeRemoveResultSchema.parse({
        removedPath: worktree.path,
        inventory: await this.list(inventory.sourcePath),
      });
    });
  }

  async lock(
    sourcePath: string,
    worktreePath: string,
    reason: string | null,
  ): Promise<WorktreeMutationResult> {
    return this.serialize(sourcePath, async () => {
      const { inventory, worktree } = await this.resolveTarget(
        sourcePath,
        worktreePath,
      );
      if (worktree.isPrimary) throw new Error("Primary cannot be locked.");
      if (worktree.missing)
        throw new Error("A missing worktree cannot be locked.");
      if (!worktree.locked) {
        await gitOutput(inventory.sourcePath, [
          "worktree",
          "lock",
          ...(reason ? ["--reason", reason] : []),
          worktree.path,
        ]);
      }
      const next = await this.list(inventory.sourcePath);
      return worktreeMutationResultSchema.parse({
        worktree: next.worktrees.find(
          ({ path: candidate }) => candidate === worktree.path,
        ),
        inventory: next,
      });
    });
  }

  async unlock(
    sourcePath: string,
    worktreePath: string,
  ): Promise<WorktreeMutationResult> {
    return this.serialize(sourcePath, async () => {
      const { inventory, worktree } = await this.resolveTarget(
        sourcePath,
        worktreePath,
      );
      if (worktree.isPrimary) throw new Error("Primary cannot be unlocked.");
      if (!worktree.locked) throw new Error("The worktree is not locked.");
      await gitOutput(inventory.sourcePath, [
        "worktree",
        "unlock",
        worktree.path,
      ]);
      const next = await this.list(inventory.sourcePath);
      return worktreeMutationResultSchema.parse({
        worktree: next.worktrees.find(
          ({ path: candidate }) => candidate === worktree.path,
        ),
        inventory: next,
      });
    });
  }

  async prune(
    sourcePath: string,
    allowExternal: boolean,
  ): Promise<WorktreePruneResult> {
    return this.serialize(sourcePath, async () => {
      const before = await this.list(sourcePath);
      if (
        !allowExternal &&
        before.worktrees.some(({ managed, prunable }) => prunable && !managed)
      ) {
        throw new Error(
          "Pruning stale external worktrees requires explicit user authorization.",
        );
      }
      await gitOutput(before.sourcePath, [
        "worktree",
        "prune",
        "--expire",
        "now",
      ]);
      const inventory = await this.list(before.sourcePath);
      const remaining = new Set(
        inventory.worktrees.map(({ path: item }) => item),
      );
      return worktreePruneResultSchema.parse({
        prunedPaths: before.worktrees
          .filter(
            ({ path: item, prunable }) => prunable && !remaining.has(item),
          )
          .map(({ path: item }) => item),
        inventory,
      });
    });
  }

  async status(
    sourcePath: string,
    worktreePath: string,
  ): Promise<WorktreeStatusResult> {
    const { worktree } = await this.resolveTarget(sourcePath, worktreePath);
    if (worktree.missing) {
      throw new Error("Cannot read status from a missing worktree.");
    }
    return worktreeStatusResultSchema.parse({
      worktree,
      status: await readGitStatus(worktree.path),
    });
  }
}
