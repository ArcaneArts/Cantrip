import { nodeGit } from "./git-node-reference.mjs";
// Production encrypted remote management with real Git and owned local remotes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readGitRemotes, readGitStatus } from "../../cantrip_worker/src/git.ts";

function normalize(value, key) {
  if (key === "generatedAt") {
    assert.ok(Number.isFinite(Date.parse(value)));
    return "<timestamp>";
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item, key)]),
    );
  return value;
}
export async function verifyRemotes({
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
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-remotes-")),
    first = path.join(root, "first.git"),
    second = path.join(root, "second.git"),
    name = "native-reviewed-remotes",
    saved = await store.get(scope),
    before = await readFile(journal, "utf8");
  const defaults = ["cantrip.defaultFetchRemote", "remote.pushDefault"].map(
    (key) => {
      try {
        return [key, git("config", "--get", key)];
      } catch {
        return [key, null];
      }
    },
  );
  async function list() {
    const result = await operation({ type: "git.remote.list", arguments: {} });
    assert.deepEqual(
      normalize(result),
      normalize({
        ok: true,
        result: await readGitRemotes(checkout),
      }),
    );
    return result.result;
  }
  async function preview(action) {
    const expected = await nodeGit(checkout, "git.remote.action.preview", {
      action,
    });
    const result = await operation({
      type: "git.remote.action.preview",
      arguments: { action },
    });
    assert.deepEqual(
      result,
      { ok: true, result: expected },
      "exact Node/native remote preview and raw-configuration token",
    );
    return expected;
  }
  async function apply(plan) {
    const result = await operation({
      type: "git.remote.action.apply",
      arguments: { action: plan.action, token: plan.token },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      normalize(result.result.remotes),
      normalize(await readGitRemotes(checkout)),
    );
    assert.deepEqual(result.result.status, await readGitStatus(checkout));
    return result.result;
  }
  try {
    git("clone", "--quiet", "--bare", checkout, first);
    git("clone", "--quiet", "--bare", checkout, second);
    let plan = await preview({
      type: "add",
      name,
      fetchUrl:
        "https://user:first-password@host.invalid/repo?token=first-hidden",
      pushUrl: null,
    });
    assert.ok(!plan.summary.includes("first-password"));
    assert.ok(!plan.summary.includes("first-hidden"));
    await restartWorker();
    await apply(plan);
    let inventory = await list();
    const remote = inventory.remotes.find((item) => item.name === name);
    assert.equal(remote.fetchUrlRedacted, true);
    assert.equal(remote.pushUrlRedacted, true);
    assert.ok(!JSON.stringify(inventory).includes("first-password"));
    assert.ok(!JSON.stringify(inventory).includes("first-hidden"));
    plan = await preview({
      type: "edit",
      name,
      fetchUrl: first,
      pushUrl: second,
    });
    assert.equal(plan.warnings.length, 1);
    git(
      "remote",
      "set-url",
      name,
      "https://user:second-password@host.invalid/repo?token=second-hidden",
    );
    assert.deepEqual(
      await operation({
        type: "git.remote.action.apply",
        arguments: { action: plan.action, token: plan.token },
      }),
      {
        ok: false,
        error:
          "The remotes or worktree changed after this preview. Review the action again.",
      },
      "hidden credentials invalidate the original review token",
    );
    assert.equal(await readFile(journal, "utf8"), before);
    await apply(await preview(plan.action));
    assert.equal(git("remote", "get-url", name), first);
    assert.equal(git("remote", "get-url", "--push", name), second);
    await apply(
      await preview({
        type: "setDefaults",
        fetchRemote: name,
        pushRemote: name,
      }),
    );
    await restartWorker();
    inventory = await list();
    assert.equal(
      inventory.remotes.find((item) => item.name === name).defaultFetch,
      true,
    );
    assert.equal(
      inventory.remotes.find((item) => item.name === name).defaultPush,
      true,
    );
    const ref = "refs/heads/native-remote-fetched";
    git("--git-dir", first, "update-ref", ref, git("rev-parse", "HEAD"));
    await apply(await preview({ type: "fetch", remote: name, prune: false }));
    assert.equal(
      git("rev-parse", `refs/remotes/${name}/native-remote-fetched`),
      git("rev-parse", "HEAD"),
    );
    git("--git-dir", first, "update-ref", "-d", ref);
    await apply(await preview({ type: "fetch", remote: name, prune: true }));
    assert.throws(() =>
      git("show-ref", "--verify", `refs/remotes/${name}/native-remote-fetched`),
    );
    await apply(
      await preview({
        type: "setDefaults",
        fetchRemote: null,
        pushRemote: null,
      }),
    );
    await apply(await preview({ type: "remove", name }));
    assert.ok(!(await list()).remotes.some((item) => item.name === name));
    assert.equal(
      await readFile(journal, "utf8"),
      before,
      "remote mutations preserve the managed-operation journal",
    );
    await store.put(scope, {
      ...saved,
      state: "awaiting-user-action",
      completedAt: null,
      error: null,
    });
    const active = await readFile(journal, "utf8");
    plan = await preview({ type: "add", name, fetchUrl: first, pushUrl: null });
    assert.deepEqual(
      await operation({
        type: "git.remote.action.apply",
        arguments: { action: plan.action, token: plan.token },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    assert.ok(!(await list()).remotes.some((item) => item.name === name));
    assert.equal(await readFile(journal, "utf8"), active);
  } finally {
    await store.put(scope, saved);
    if (git("remote").split("\n").includes(name)) git("remote", "remove", name);
    for (const [key, value] of defaults) {
      if (value !== null) git("config", key, value);
      else {
        try {
          git("config", "--unset", key);
        } catch {
          /* Git returns 5 when already absent. */
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}
