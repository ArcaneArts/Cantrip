import { nodeGit } from "./git-node-reference.mjs";
// Real encrypted LFS actions; all repositories/objects/locks belong to this smoke.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  readGitLfsStatus,
  readGitStatus,
} from "../../cantrip_worker/src/git.ts";
import { startLfsFixture } from "./lfs-test-server.mjs";
function normalize(value, key) {
  if (key === "generatedAt") {
    assert.ok(Number.isFinite(Date.parse(value)));
    return "<timestamp>";
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, normalize(v, key)]),
    );
  return value;
}
export async function verifyLfs({
  operation,
  checkout,
  restartWorker,
  store,
  scope,
  journal,
}) {
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-lfs-")),
    remote = path.join(root, "origin.git"),
    filename = "native-object.cantrip-lfs",
    pattern = "*.cantrip-lfs",
    bytes = Buffer.from("Owned native LFS object 🧙\n".repeat(16)),
    oid = createHash("sha256").update(bytes).digest("hex"),
    fixture = await startLfsFixture(new Map([[oid, bytes]])),
    saved = await store.get(scope),
    oldHead = git("rev-parse", "HEAD"),
    oldStatus = git("status", "--porcelain=v1");
  const keys = [
    "core.hooksPath",
    "filter.lfs.clean",
    "filter.lfs.smudge",
    "filter.lfs.process",
    "filter.lfs.required",
    "lfs.url",
    "lfs.repositoryformatversion",
    "remote.origin.url",
  ];
  const config = keys.map((key) => {
    try {
      return [key, git("config", "--local", "--get", key)];
    } catch {
      return [key, null];
    }
  });
  let held = false;
  async function status(refreshLocks = false) {
    const result = await operation({
      type: "git.lfs.status",
      arguments: { refreshLocks },
    });
    assert.deepEqual(
      normalize(result),
      normalize({
        ok: true,
        result: await readGitLfsStatus(checkout, refreshLocks),
      }),
    );
    return result.result;
  }
  async function preview(action) {
    const expected = await nodeGit(checkout, "git.lfs.action.preview", {
      action,
    });
    const result = await operation({
      type: "git.lfs.action.preview",
      arguments: { action },
    });
    assert.deepEqual(
      normalize(result),
      normalize({ ok: true, result: expected }),
      "exact Node/native LFS review token",
    );
    return expected;
  }
  async function apply(plan) {
    const result = await operation({
      type: "git.lfs.action.apply",
      arguments: { action: plan.action, token: plan.token },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result.status, await readGitStatus(checkout));
    assert.deepEqual(
      normalize(result.result.lfs),
      normalize(
        await readGitLfsStatus(checkout, plan.action.type === "refreshLocks"),
      ),
    );
    return result.result;
  }
  const objectPath = path.join(
    checkout,
    ".git",
    "lfs",
    "objects",
    oid.slice(0, 2),
    oid.slice(2, 4),
    oid,
  );
  async function missing() {
    await writeFile(
      path.join(checkout, filename),
      git("show", `HEAD:${filename}`) + "\n",
    );
    await rm(objectPath, { force: true });
  }
  try {
    git(
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "owned native LFS smoke sentinel",
    );
    held = true;
    git("config", "core.hooksPath", ".git/hooks");
    git("config", "remote.origin.url", remote);
    git("config", "lfs.url", `${fixture.origin}/smoke`);
    const before = await readFile(journal, "utf8");
    assert.equal((await status()).available, true);
    let plan = await preview({ type: "install" });
    assert.deepEqual(
      await operation({
        type: "git.lfs.action.apply",
        arguments: { action: plan.action, token: "0".repeat(64) },
      }),
      {
        ok: false,
        error:
          "Git LFS or the selected worktree changed after this preview. Review the action again.",
      },
    );
    await restartWorker();
    await apply(plan);
    await apply(await preview({ type: "track", pattern }));
    await writeFile(path.join(checkout, filename), bytes);
    git("add", ".gitattributes", filename);
    git("commit", "--quiet", "-m", "Owned native LFS fixture");
    git("clone", "--quiet", "--bare", checkout, remote);
    assert.equal(
      (await status()).files.find((file) => file.path === filename).oid,
      oid,
    );
    await missing();
    assert.equal((await status()).missingObjects, 1);
    await apply(await preview({ type: "fetch", remote: "origin", all: true }));
    assert.deepEqual(await readFile(objectPath), bytes);
    await missing();
    await apply(await preview({ type: "pull", remote: "origin" }));
    assert.deepEqual(await readFile(path.join(checkout, filename)), bytes);
    await apply(await preview({ type: "prune", verifyRemote: true }));
    await apply(await preview({ type: "lock", path: filename }));
    await status();
    assert.equal((await status(true)).locks.length, 1);
    await restartWorker();
    await status();
    assert.equal((await status(true)).locks.length, 1);
    await apply(await preview({ type: "refreshLocks" }));
    assert.equal((await status(true)).locksCached, false);
    await apply(
      await preview({ type: "unlock", path: filename, force: false }),
    );
    fixture.foreign("smoke", filename);
    await apply(await preview({ type: "refreshLocks" }));
    plan = await preview({ type: "unlock", path: filename, force: true });
    assert.equal(plan.warnings.length, 1);
    await apply(plan);
    await apply(await preview({ type: "untrack", pattern }));
    assert.equal(
      await readFile(journal, "utf8"),
      before,
      "LFS mutations preserve the managed-operation journal",
    );
    await store.put(scope, {
      ...saved,
      state: "awaiting-user-action",
      completedAt: null,
      error: null,
    });
    const active = await readFile(journal, "utf8");
    plan = await preview({ type: "track", pattern: "*.blocked-lfs" });
    assert.deepEqual(
      await operation({
        type: "git.lfs.action.apply",
        arguments: { action: plan.action, token: plan.token },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    assert.equal(await readFile(journal, "utf8"), active);
    assert.ok(
      !(await status()).patterns.some((row) => row.pattern === "*.blocked-lfs"),
    );
    assert.ok(
      fixture.requests.some((request) => request.route === "objects/batch"),
    );
    assert.ok(
      fixture.requests.some(
        (request) => request.route === "locks" && request.method === "POST",
      ),
    );
  } finally {
    await store.put(scope, saved);
    // workspace-smoke creates this checkout with mkdtemp; restore only its state.
    git("reset", "--hard", oldHead);
    for (const [key, value] of config) {
      if (value !== null) git("config", key, value);
      else {
        try {
          git("config", "--unset-all", key);
        } catch {
          /* Already absent. */
        }
      }
    }
    if (held) git("stash", "pop");
    await fixture.close();
    await rm(root, { recursive: true, force: true });
    assert.equal(
      git("status", "--porcelain=v1"),
      oldStatus,
      "owned fixture state restored",
    );
  }
}
