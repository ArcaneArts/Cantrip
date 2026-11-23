import { nodeGit } from "./git-node-reference.mjs";
// Actual encrypted branch management against an owned local bare remote.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readGitBranches } from "../../tests/reference-node-worker/src/git.ts";
function normalize(v, key) {
  if (key === "generatedAt") {
    assert.ok(Number.isFinite(Date.parse(v)));
    return "<timestamp>";
  }
  if (Array.isArray(v)) return v.map((item) => normalize(item));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, v]) => [k, normalize(v, k)]),
    );
  return v;
}
export async function verifyBranches({
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
  const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-native-branch-remote-"),
    ),
    remote = path.join(root, "remote.git"),
    remoteName = "native-reviewed";
  const oldBranch = git("branch", "--show-current"),
    saved = await store.get(scope);
  let added = false,
    held = false;
  async function list() {
    const result = await operation({ type: "git.branch.list", arguments: {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      normalize(result.result),
      normalize(await readGitBranches(checkout)),
    );
    return result.result;
  }
  async function preview(action) {
    const expected = await nodeGit(checkout, "git.branch.action.preview", {
      action,
    });
    const result = await operation({
      type: "git.branch.action.preview",
      arguments: { action },
    });
    assert.deepEqual(
      normalize(result),
      normalize({ ok: true, result: expected }),
      "exact Node/native branch token and summary",
    );
    return expected;
  }
  async function apply(plan) {
    const result = await operation({
      type: "git.branch.action.apply",
      arguments: { action: plan.action, token: plan.token },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  }
  try {
    git(
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "native branch smoke dirty sentinel",
    );
    held = true;
    git("clone", "--quiet", "--bare", checkout, remote);
    git("remote", "add", remoteName, remote);
    added = true;
    git("fetch", "--quiet", remoteName);
    const before = await readFile(journal, "utf8"),
      name = "native-reviewed-branch",
      renamed = "native-reviewed-renamed";
    let plan = await preview({
      type: "create",
      name,
      startPoint: "HEAD",
      checkout: true,
    });
    assert.deepEqual(
      await operation({
        type: "git.branch.action.apply",
        arguments: { action: plan.action, token: "0".repeat(64) },
      }),
      {
        ok: false,
        error:
          "The branches or worktree changed after this preview. Review the action again.",
      },
    );
    assert.equal(git("branch", "--show-current"), oldBranch);
    assert.equal(await readFile(journal, "utf8"), before);
    await restartWorker();
    await apply(plan);
    assert.equal(git("branch", "--show-current"), name);
    await apply(await preview({ type: "publish", name, remote: remoteName }));
    assert.equal(
      git("--git-dir", remote, "rev-parse", `refs/heads/${name}`),
      git("rev-parse", "HEAD"),
    );
    assert.equal(
      (await list()).branches.find((b) => b.name === name).upstream,
      `${remoteName}/${name}`,
    );
    plan = await preview({ type: "rename", name, newName: renamed });
    assert.equal(plan.warnings.length, 1);
    await apply(plan);
    assert.equal(git("branch", "--show-current"), renamed);
    await apply(
      await preview({ type: "setUpstream", name: renamed, upstream: null }),
    );
    assert.equal(
      (await list()).branches.find((b) => b.name === renamed).upstream,
      null,
    );
    await apply(
      await preview({ type: "switch", name: oldBranch, kind: "local" }),
    );
    await apply(
      await preview({ type: "deleteLocal", name: renamed, force: false }),
    );
    await apply(
      await preview({ type: "deleteRemote", name, remote: remoteName }),
    );
    assert.throws(() =>
      git("--git-dir", remote, "rev-parse", "--verify", `refs/heads/${name}`),
    );
    const fetched = "native-fetched";
    git(
      "--git-dir",
      remote,
      "update-ref",
      `refs/heads/${fetched}`,
      git("rev-parse", "HEAD"),
    );
    await apply(
      await preview({ type: "fetch", remote: remoteName, prune: true }),
    );
    assert.ok(
      (await list()).branches.some(
        (b) => b.name === `${remoteName}/${fetched}`,
      ),
    );
    await apply(
      await preview({
        type: "switch",
        name: `${remoteName}/${fetched}`,
        kind: "remote",
      }),
    );
    assert.equal(git("branch", "--show-current"), fetched);
    await restartWorker();
    assert.equal((await list()).currentBranch, fetched);
    await apply(
      await preview({ type: "switch", name: oldBranch, kind: "local" }),
    );
    await apply(
      await preview({ type: "deleteLocal", name: fetched, force: false }),
    );
    assert.equal(
      await readFile(journal, "utf8"),
      before,
      "branch mutations preserve the managed-operation journal",
    );
    await store.put(scope, {
      ...saved,
      state: "awaiting-user-action",
      completedAt: null,
      error: null,
    });
    const active = await readFile(journal, "utf8");
    plan = await preview({
      type: "create",
      name: "blocked-native-branch",
      checkout: false,
      startPoint: null,
    });
    assert.deepEqual(
      await operation({
        type: "git.branch.action.apply",
        arguments: { action: plan.action, token: plan.token },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    assert.equal(await readFile(journal, "utf8"), active);
  } finally {
    await store.put(scope, saved);
    if (git("branch", "--show-current") !== oldBranch) git("switch", oldBranch);
    if (added) git("remote", "remove", remoteName);
    if (held) git("stash", "pop");
    await rm(root, { recursive: true, force: true });
  }
}
