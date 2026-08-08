import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseGitWorktreePorcelain,
  WorktreeManager,
} from "../src/worktrees.js";

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
});
