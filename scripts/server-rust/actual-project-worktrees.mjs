// Existing encrypted client APIs -> actual server -> unchanged full Git worker.
// A disposable local repository is classified as GitHub-backed in the catalog;
// no GitHub network operation or user repository is involved.
import { startRetirementProbe } from "./actual-run-retirement.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";

export async function actualProjectWorktrees({
  page,
  fixture,
  root,
  executable,
  projectId,
  directory,
  startWorker,
  stopWorker,
  result,
}) {
  const port = Number(new URL(fixture.server.origin).port);
  await stopWorker();
  await fixture.close();
  const repo = await repositoryFixture({
    kind: fixture.kind,
    root: path.join(root, fixture.name),
    executable,
    databaseMode: fixture.databaseMode,
    databaseUrl: fixture.environment.DATABASE_URL,
  });
  try {
    await repo.seed(
      `UPDATE projects SET origin_kind='github',folder_management=NULL,git_capability=true,github_capability=true,worktree_policy='agent-managed',github_repository_blind_index='actual-worktree-fixture' WHERE id=${literal(projectId)}`,
    );
  } finally {
    await repo.close();
  }
  await fixture.start({ port });
  await startWorker();
  const call = (operation, args = []) =>
    page.evaluate(
      async ({ operation, args }) => {
        const api = await import("/src/lib/api/worktrees.ts");
        return api[operation](...args);
      },
      { operation, args },
    );
  const initial = await eventually(
    () => call("getProjectWorktrees", [projectId]),
    (trees) => {
      assert.ok(
        trees.some((tree) => tree.isPrimary && tree.path === directory),
      );
    },
  );
  const capture = [];
  const listener = (request) => {
    if (request.url().includes("/worktrees"))
      capture.push({ url: request.url(), body: request.postData() });
  };
  page.on("request", listener);
  const name = "private-acceptance-worktree",
    branch = "private-acceptance-branch",
    reason = "private-acceptance-lock";
  let primaryFailure;
  try {
    const created = await call("createProjectWorktree", [
      projectId,
      {
        name,
        sourceWorktreeId: initial.find((tree) => tree.isPrimary).id,
        mode: { type: "newBranch", branch, startPoint: "HEAD" },
      },
    ]);
    result.actualWorktree = { created };
    assert.equal(created.lifecycleState, "ready");
    assert.equal(created.isPrimary, false);
    assert.equal(created.branch, branch);
    assert.equal((await stat(created.path)).isDirectory(), true);
    assert.equal(
      await readFile(path.join(created.path, "retained.txt"), "utf8"),
      "Existing user file remains intact.\n",
    );
    assert.equal(
      execFileSync("git", ["-C", created.path, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim(),
      branch,
    );
    result.steps.push(
      "existing browser creates an encrypted Git worktree through the full worker; real branch and checkout contents match",
    );
    await call("lockProjectWorktree", [projectId, created.id, reason]);
    // The existing client caches protected worktree status for one second.
    // Require the client read to converge and check the actual Git inventory.
    await eventually(
      () => call("getProjectWorktrees", [projectId]),
      (trees) => {
        const locked = trees.find((tree) => tree.id === created.id);
        assert.equal(locked.locked, true);
        assert.equal(locked.lockReason, reason);
      },
    );
    const inventory = () =>
      execFileSync(
        "git",
        ["-C", directory, "worktree", "list", "--porcelain"],
        { encoding: "utf8" },
      );
    assert.ok(inventory().includes("locked " + reason));
    await call("unlockProjectWorktree", [projectId, created.id]);
    await eventually(
      () => call("getProjectWorktrees", [projectId]),
      (trees) => {
        assert.equal(
          trees.find((tree) => tree.id === created.id).locked,
          false,
        );
      },
    );
    assert.equal(inventory().includes("locked " + reason), false);
    result.steps.push(
      "encrypted client lock and unlock update actual Git administration state",
    );
    await stopWorker();
    await fixture.close();
    await fixture.start({ port });
    await startWorker();
    const retained = await eventually(
      () => call("getProjectWorktrees", [projectId]),
      (trees) => {
        const tree = trees.find((tree) => tree.id === created.id);
        assert.equal(tree?.path, created.path);
        assert.equal(tree?.branch, branch);
      },
    );
    assert.equal(retained.filter((tree) => tree.id === created.id).length, 1);
    const reconciled = await call("reconcileProjectWorktrees", [projectId]);
    assert.equal(reconciled.filter((tree) => tree.id === created.id).length, 1);
    result.steps.push(
      "server and worker restart plus inventory reconciliation preserve the existing worktree identity",
    );
    const dirtyPath = path.join(created.path, "uncommitted.txt");
    await writeFile(dirtyPath, "Unsaved work must survive rejected removal.\n");
    await assert.rejects(
      call("removeProjectWorktree", [
        projectId,
        created.id,
        { allowExternal: false, force: false },
      ]),
      /Protected repository operation failed on the worker\./,
    );
    assert.equal(
      await readFile(dirtyPath, "utf8"),
      "Unsaved work must survive rejected removal.\n",
    );
    const afterRejection = await call("getProjectWorktrees", [projectId]);
    result.actualWorktree.afterRejectedRemoval = afterRejection;
    assert.equal(
      afterRejection.find((tree) => tree.id === created.id)?.lifecycleState,
      "ready",
      "rejected removal restores usable durable lifecycle",
    );
    await rm(dirtyPath);
    result.steps.push(
      "dirty checkout removal is rejected without losing files or leaving the worktree unavailable",
    );
    const verifyRetirement = await startRetirementProbe({
      page,
      root,
      projectId,
      primary: directory,
      worktree: created,
      result,
    });
    const removed = await call("removeProjectWorktree", [
      projectId,
      created.id,
      { allowExternal: false, force: false },
    ]);
    await verifyRetirement();
    assert.equal(removed.id, created.id);
    assert.equal(removed.lifecycleState, "missing");
    await assert.rejects(stat(created.path), { code: "ENOENT" });
    assert.equal(inventory().includes(created.path), false);
    assert.equal(
      await readFile(path.join(directory, "retained.txt"), "utf8"),
      "Existing user file remains intact.\n",
    );
    await call("pruneProjectWorktrees", [projectId, false]);
    result.steps.push(
      "worktree deletion removes only the actual secondary checkout, retains the primary file and permits pruning",
    );
    for (const secret of [name, branch, reason, directory, created.path])
      assert.equal(
        JSON.stringify(capture).includes(secret),
        false,
        "worktree requests preserve private metadata opacity",
      );
    result.actualWorktree.requests = capture;
    result.steps.push(
      "worktree HTTP requests contain opaque routing metadata rather than private names, branches, paths or lock reasons",
    );
  } catch (error) {
    primaryFailure = error;
    result.actualWorktreeFailure = {
      message: error.message,
      stack: error.stack,
    };
    throw error;
  } finally {
    page.off("request", listener);
    try {
      await stopWorker();
    } catch (cleanup) {
      result.actualWorktreeCleanupFailure = {
        message: cleanup.message,
        stack: cleanup.stack,
      };
      if (!primaryFailure) throw cleanup;
    }
  }
}
