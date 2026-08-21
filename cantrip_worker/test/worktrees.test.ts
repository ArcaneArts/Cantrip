import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkerNotification } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGitOperationObservation,
  parseGitWorktreePorcelain,
  WorktreeManager,
} from "../src/worktrees.js";
import {
  controlGitManagedOperation,
  previewGitManagedOperation,
  startGitManagedOperation,
} from "../src/git.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRepository(prefix = "cantrip-worktrees-test-") {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(temporaryRoot);
  const root = await realpath(temporaryRoot);
  const repository = path.join(root, "repository");
  const workerData = path.join(root, "worker-data");
  await mkdir(repository);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.name",
    "Cantrip Test",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "test@cantrip.art",
  ]);
  await writeFile(path.join(repository, "README.md"), "Cantrip\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", ["-C", repository, "commit", "-m", "Initial"]);
  return {
    manager: new WorktreeManager(workerData),
    repository,
    root,
    workerData,
  };
}

describe("worker Git worktrees", () => {
  it("builds bounded, stable Git operation observations", () => {
    const head = "a".repeat(40);
    const context = {
      type: "rebase" as const,
      originalHead: head,
      sourceRef: "origin/main",
      sourceRevision: "b".repeat(40),
      targetRef: "refs/heads/feature",
      targetRevision: head,
      pendingCommits: [head],
      totalSteps: 1,
      checkpointRef: null,
    };
    const target = {
      projectId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f3",
      worktreeId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f4",
      sourcePath: "/repo",
      worktreePath: "/repo",
      operation: {
        id: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
        context,
      },
    };
    const state = {
      ...context,
      state: "conflicted" as const,
      currentHead: head,
      currentStep: 1,
      pendingCommits: [head],
      conflictedPaths: ["src/app.ts"],
      output: "CONFLICT",
      pausedAction: null,
      status: {
        branch: "feature",
        head,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        branches: [],
      },
    };
    const files = Array.from({ length: 2_001 }, (_, index) => ({
      path: `src/conflict-${index}.ts`,
      code: "UU",
      kind: "both-modified" as const,
      baseAvailable: true,
      oursAvailable: true,
      theirsAvailable: true,
    }));
    const first = buildGitOperationObservation({
      conflicts: { files, truncated: false },
      observedAt: "2026-08-21T12:00:00.000Z",
      state,
      target,
    });
    const duplicate = buildGitOperationObservation({
      conflicts: { files, truncated: false },
      observedAt: "2026-08-21T12:01:00.000Z",
      state,
      target,
    });
    const completed = buildGitOperationObservation({
      conflicts: { files: [], truncated: false },
      state: {
        ...state,
        state: "completed",
        pendingCommits: [],
        conflictedPaths: [],
      },
      target,
    });

    expect(first.conflicts).toMatchObject({
      truncated: true,
      files: expect.any(Array),
    });
    expect(first.conflicts.files.length).toBeGreaterThan(0);
    expect(first.conflicts.files.length).toBeLessThanOrEqual(2_000);
    expect(
      Buffer.byteLength(JSON.stringify(first.conflicts.files)),
    ).toBeLessThan(256 * 1_024);
    expect(duplicate.fingerprint).toBe(first.fingerprint);
    expect(completed.fingerprint).not.toBe(first.fingerprint);
  });

  it("emits conflicted and completed managed-operation transitions", async () => {
    const { manager, repository } = await createRepository(
      "cantrip-worktrees-operation-observation-",
    );
    await execFileAsync("git", ["-C", repository, "switch", "-c", "feature"]);
    await writeFile(path.join(repository, "README.md"), "Feature\n");
    await execFileAsync("git", ["-C", repository, "commit", "-am", "Feature"]);
    await execFileAsync("git", ["-C", repository, "switch", "main"]);
    await writeFile(path.join(repository, "README.md"), "Main\n");
    await execFileAsync("git", ["-C", repository, "commit", "-am", "Main"]);
    await execFileAsync("git", ["-C", repository, "switch", "feature"]);

    const preview = await previewGitManagedOperation(repository, {
      type: "rebase",
      sourceRef: "main",
    });
    const conflicted = await startGitManagedOperation(
      repository,
      preview.action,
      preview.token,
    );
    expect(conflicted.state).toBe("conflicted");

    const notifications: WorkerNotification[] = [];
    manager.setObservationEmitter((notification) => {
      notifications.push(notification);
      return true;
    });
    const operationId = "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2";
    const observationTarget = {
      projectId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f3",
      worktreeId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f4",
      sourcePath: repository,
      worktreePath: repository,
      operation: { id: operationId, context: preview.context },
    };
    manager.configureObservation([observationTarget]);
    await vi.waitFor(
      () => {
        expect(
          notifications.findLast(
            (notification) => notification.type === "git.operation.observed",
          ),
        ).toMatchObject({
          type: "git.operation.observed",
          operationId,
          state: { state: "conflicted", conflictedPathCount: 1 },
          conflicts: {
            files: [expect.objectContaining({ path: "README.md" })],
          },
        });
      },
      { timeout: 10_000 },
    );
    const initialOperationNotifications = notifications.filter(
      (notification) => notification.type === "git.operation.observed",
    );
    manager.configureObservation([observationTarget]);
    await vi.waitFor(
      () =>
        expect(
          notifications.filter(
            (notification) => notification.type === "git.operation.observed",
          ).length,
        ).toBeGreaterThan(initialOperationNotifications.length),
      { timeout: 10_000 },
    );
    expect(
      notifications.findLast(
        (notification) => notification.type === "git.operation.observed",
      ),
    ).toMatchObject({
      fingerprint: initialOperationNotifications.at(-1)?.fingerprint,
    });

    await writeFile(path.join(repository, "README.md"), "Resolved\n");
    await execFileAsync("git", ["-C", repository, "add", "README.md"]);
    const completed = await controlGitManagedOperation(
      repository,
      preview.context,
      "continue",
    );
    expect(completed.state).toBe("completed");
    await vi.waitFor(
      () => {
        const latest = notifications.findLast(
          (notification) => notification.type === "git.operation.observed",
        );
        expect(latest).toMatchObject({
          type: "git.operation.observed",
          operationId,
          state: { state: "completed", conflictedPathCount: 0 },
          conflicts: { files: [], truncated: false },
        });
      },
      { timeout: 10_000 },
    );
    manager.close();
  });

  it("parses NUL-delimited porcelain records without losing lock reasons", () => {
    expect(
      parseGitWorktreePorcelain(
        [
          "worktree /repo with spaces",
          "HEAD 0123456789abcdef",
          "branch refs/heads/main",
          "",
          "worktree /missing",
          "HEAD fedcba9876543210",
          "detached",
          "locked retained by user",
          "prunable gitdir file points to non-existent location",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      {
        path: "/repo with spaces",
        head: "0123456789abcdef",
        branch: "main",
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
      },
      {
        path: "/missing",
        head: "fedcba9876543210",
        branch: null,
        detached: true,
        locked: true,
        lockReason: "retained by user",
        prunable: true,
        pruneReason: "gitdir file points to non-existent location",
      },
    ]);
  });

  it("creates, serializes, locks, inspects, and safely removes managed lanes", async () => {
    const { manager, repository, workerData, root } = await createRepository();
    await execFileAsync("git", ["-C", repository, "branch", "existing"]);

    const initial = await manager.list(repository);
    expect(initial).toMatchObject({
      sourcePath: repository,
      primaryPath: repository,
      worktrees: [
        expect.objectContaining({
          branch: "main",
          isPrimary: true,
          managed: false,
        }),
      ],
    });

    const created = await manager.create(
      repository,
      "managed-one",
      "Feature lane",
      {
        type: "newBranch",
        branch: "agent/feature-lane",
        startPoint: null,
      },
    );
    expect(created.worktree).toMatchObject({
      branch: "agent/feature-lane",
      isPrimary: false,
      managed: true,
    });
    expect(
      created.worktree.path.startsWith(path.join(workerData, "worktrees")),
    ).toBe(true);
    await expect(
      manager.create(repository, "managed-one", "Feature lane", {
        type: "newBranch",
        branch: "agent/feature-lane",
        startPoint: null,
      }),
    ).resolves.toMatchObject({
      worktree: {
        branch: "agent/feature-lane",
        path: created.worktree.path,
      },
    });
    await expect(
      manager.create(repository, "managed-one", "Feature lane", {
        type: "newBranch",
        branch: "agent/different-lane",
        startPoint: null,
      }),
    ).rejects.toThrow("different create request");

    const [existing, detached] = await Promise.all([
      manager.create(repository, "managed-two", "Existing lane", {
        type: "existingBranch",
        branch: "existing",
      }),
      manager.create(repository, "managed-three", "Detached lane", {
        type: "detached",
        revision: "HEAD",
      }),
    ]);
    expect(existing.worktree.branch).toBe("existing");
    expect(detached.worktree).toMatchObject({ detached: true, branch: null });

    const locked = await manager.lock(
      repository,
      created.worktree.path,
      "Retain for review",
    );
    expect(locked.worktree).toMatchObject({
      locked: true,
      lockReason: "Retain for review",
    });
    await expect(
      manager.remove(repository, created.worktree.path, {
        allowExternal: false,
        force: true,
      }),
    ).rejects.toThrow("Unlock");
    expect(
      (await manager.unlock(repository, created.worktree.path)).worktree.locked,
    ).toBe(false);

    await writeFile(path.join(created.worktree.path, "dirty.txt"), "dirty\n");
    expect(
      (await manager.status(repository, created.worktree.path)).status.files,
    ).toEqual([expect.objectContaining({ path: "dirty.txt", unstaged: true })]);
    await expect(
      manager.remove(repository, created.worktree.path, {
        allowExternal: false,
        force: false,
      }),
    ).rejects.toThrow("uncommitted changes");
    await manager.remove(repository, created.worktree.path, {
      allowExternal: false,
      force: true,
    });
    await expect(
      execFileAsync("git", [
        "-C",
        repository,
        "show-ref",
        "--verify",
        "refs/heads/agent/feature-lane",
      ]),
    ).resolves.toBeDefined();

    await manager.remove(repository, existing.worktree.path, {
      allowExternal: false,
      force: false,
    });
    await manager.remove(repository, detached.worktree.path, {
      allowExternal: false,
      force: false,
    });
    await expect(
      manager.remove(repository, repository, {
        allowExternal: true,
        force: true,
      }),
    ).rejects.toThrow("Primary cannot be removed");

    const externalPath = path.join(root, "external-worktree");
    await execFileAsync("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "-b",
      "external-branch",
      externalPath,
    ]);
    expect(
      (await manager.reconcile(repository)).worktrees.find(
        ({ path: item }) => item === externalPath,
      ),
    ).toMatchObject({ managed: false, isPrimary: false });
    await expect(
      manager.remove(repository, externalPath, {
        allowExternal: false,
        force: false,
      }),
    ).rejects.toThrow("explicit user authorization");
    await manager.remove(repository, externalPath, {
      allowExternal: true,
      force: false,
    });
  });

  it("rejects arbitrary or cross-repository targets by Git common-dir identity", async () => {
    const first = await createRepository("cantrip-worktrees-first-");
    const second = await createRepository("cantrip-worktrees-second-");
    await expect(
      first.manager.status(first.repository, second.repository),
    ).rejects.toThrow("not a worktree of this project source");
    await expect(
      first.manager.status(
        first.repository,
        path.join(first.root, "arbitrary"),
      ),
    ).rejects.toThrow("not a worktree of this project source");
    const crossRepositoryLink = path.join(first.root, "linked-second-repo");
    await symlink(second.repository, crossRepositoryLink, "dir");
    await expect(
      first.manager.status(first.repository, crossRepositoryLink),
    ).rejects.toThrow("not a worktree of this project source");
  });

  it("authorizes a batch of physical worktrees from one source inventory", async () => {
    const { manager, repository, root } = await createRepository(
      "cantrip-worktrees-authorize-batch-",
    );
    const secondary = path.join(root, "secondary-worktree");
    await execFileAsync("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "-b",
      "codegraph-secondary",
      secondary,
    ]);

    const authorized = await manager.authorizeTargets(repository, [
      repository,
      secondary,
    ]);
    expect(authorized.map(({ worktree }) => worktree.path)).toEqual([
      repository,
      secondary,
    ]);
    expect(
      new Set(authorized.map(({ inventory }) => inventory.gitCommonDir)).size,
    ).toBe(1);
    await expect(
      manager.authorizeTargets(repository, [
        repository,
        path.join(root, "arbitrary"),
      ]),
    ).rejects.toThrow("not a worktree of this project source");
  });

  it("serializes colliding creates and surfaces branches checked out elsewhere", async () => {
    const { manager, repository } = await createRepository();
    await expect(
      manager.create(repository, "primary-collision", "Primary collision", {
        type: "existingBranch",
        branch: "main",
      }),
    ).rejects.toThrow(/already (?:checked out|used by worktree)/iu);

    const results = await Promise.allSettled([
      manager.create(repository, "collision-one", "Collision one", {
        type: "newBranch",
        branch: "agent/collision",
        startPoint: null,
      }),
      manager.create(repository, "collision-two", "Collision two", {
        type: "newBranch",
        branch: "agent/collision",
        startPoint: null,
      }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(String(rejection?.reason)).toMatch(/already exists/iu);
    expect(
      (await manager.list(repository)).worktrees.filter(
        ({ branch }) => branch === "agent/collision",
      ),
    ).toHaveLength(1);
  });

  it("reports and prunes stale missing worktree metadata", async () => {
    const { manager, repository, root } = await createRepository();
    const created = await manager.create(
      repository,
      "prunable-one",
      "Prunable lane",
      {
        type: "newBranch",
        branch: "agent/prunable",
        startPoint: null,
      },
    );
    await rm(created.worktree.path, { recursive: true, force: true });

    const missing = (await manager.list(repository)).worktrees.find(
      ({ path: item }) => item === created.worktree.path,
    );
    expect(missing).toMatchObject({ missing: true, prunable: true });
    expect((await manager.prune(repository, false)).prunedPaths).toEqual([
      created.worktree.path,
    ]);
    expect(
      (await manager.list(repository)).worktrees.some(
        ({ path: item }) => item === created.worktree.path,
      ),
    ).toBe(false);

    const externalPath = path.join(root, "external-prunable");
    await execFileAsync("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "-b",
      "external-prunable",
      externalPath,
    ]);
    await rm(externalPath, { recursive: true, force: true });
    await expect(manager.prune(repository, false)).rejects.toThrow(
      "explicit user authorization",
    );
    expect((await manager.prune(repository, true)).prunedPaths).toEqual([
      externalPath,
    ]);
  });

  it("debounces filesystem changes into bounded status notifications", async () => {
    const { manager, repository } = await createRepository();
    const notifications: WorkerNotification[] = [];
    manager.setObservationEmitter((notification) => {
      notifications.push(notification);
      return true;
    });
    manager.configureObservation([
      { sourcePath: repository, worktreePath: repository },
    ]);

    await vi.waitFor(() => {
      expect(
        notifications.some(
          ({ type }) => type === "worktree.inventory.observed",
        ),
      ).toBe(true);
      expect(
        notifications.some(({ type }) => type === "worktree.status.observed"),
      ).toBe(true);
    });
    const initialCount = notifications.length;
    manager.configureObservation([
      { sourcePath: repository, worktreePath: repository },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(notifications).toHaveLength(initialCount);

    await writeFile(path.join(repository, "observed.txt"), "external edit\n");
    await vi.waitFor(
      () => {
        const latest = notifications.findLast(
          (notification) => notification.type === "worktree.status.observed",
        );
        expect(latest).toMatchObject({
          type: "worktree.status.observed",
          result: {
            status: {
              files: [expect.objectContaining({ path: "observed.txt" })],
            },
          },
        });
      },
      // Recursive filesystem notifications can be delayed while the full
      // worker suite is exercising several process and watcher integrations.
      { timeout: 10_000 },
    );

    await execFileAsync("git", ["-C", repository, "add", "observed.txt"]);
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "-m",
      "Observe file",
    ]);
    await vi.waitFor(
      () => {
        const latest = notifications.findLast(
          (notification) => notification.type === "worktree.status.observed",
        );
        expect(latest?.type).toBe("worktree.status.observed");
        if (latest?.type === "worktree.status.observed") {
          expect(latest.result.status.files).toEqual([]);
        }
      },
      { timeout: 10_000 },
    );
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "--allow-empty",
      "-m",
      "Metadata-only head change",
    ]);
    const emptyCommit = (
      await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])
    ).stdout.trim();
    await vi.waitFor(
      () => {
        const latest = notifications.findLast(
          (notification) => notification.type === "worktree.status.observed",
        );
        expect(latest?.type).toBe("worktree.status.observed");
        if (latest?.type === "worktree.status.observed") {
          expect(latest.result.status.head).toBe(emptyCommit);
        }
      },
      { timeout: 10_000 },
    );
    manager.close();
  });

  it("observes metadata-only commits in linked worktrees", async () => {
    const { manager, repository } = await createRepository();
    const created = await manager.create(
      repository,
      "observed-linked",
      "Observed linked worktree",
      {
        type: "newBranch",
        branch: "agent/observed-linked",
        startPoint: null,
      },
    );
    const notifications: WorkerNotification[] = [];
    manager.setObservationEmitter((notification) => {
      notifications.push(notification);
      return true;
    });
    manager.configureObservation([
      { sourcePath: repository, worktreePath: created.worktree.path },
    ]);
    await vi.waitFor(() =>
      expect(
        notifications.some(
          (notification) => notification.type === "worktree.status.observed",
        ),
      ).toBe(true),
    );

    await execFileAsync("git", [
      "-C",
      created.worktree.path,
      "commit",
      "--allow-empty",
      "-m",
      "Linked metadata-only head change",
    ]);
    const revision = (
      await execFileAsync("git", [
        "-C",
        created.worktree.path,
        "rev-parse",
        "HEAD",
      ])
    ).stdout.trim();
    await vi.waitFor(
      () => {
        const latest = notifications.findLast(
          (notification) => notification.type === "worktree.status.observed",
        );
        expect(latest?.type).toBe("worktree.status.observed");
        if (latest?.type === "worktree.status.observed") {
          expect(latest.result.status.head).toBe(revision);
        }
      },
      { timeout: 10_000 },
    );
    manager.close();
  });
});
