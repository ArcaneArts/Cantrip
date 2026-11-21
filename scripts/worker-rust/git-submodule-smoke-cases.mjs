import { nodeGit } from "./git-node-reference.mjs";
// Encrypted submodule actions against only the smoke's disposable checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readGitSubmodules,
  readGitStatus,
} from "../../tests/reference-node-worker/src/git.ts";
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
export async function verifySubmodules({
  operation,
  checkout,
  restartWorker,
  store,
  scope,
  journal,
}) {
  const gitAt = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (...args) => gitAt(checkout, ...args);
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-submodules-")),
    library = path.join(root, "library"),
    leaf = path.join(root, "leaf"),
    modulePath = "native-submodule",
    nestedPath = `${modulePath}/nested/leaf`,
    saved = await store.get(scope),
    oldHead = git("rev-parse", "HEAD"),
    oldStatus = git("status", "--porcelain=v1");
  let oldProtocol = null,
    held = false;
  try {
    oldProtocol = git("config", "--local", "--get", "protocol.file.allow");
  } catch {
    /* Absent is the normal fixture configuration. */
  }
  async function initialize(cwd, file) {
    await mkdir(cwd);
    gitAt(cwd, "init", "--quiet", "-b", "main");
    for (const [key, value] of Object.entries({
      "user.name": "Fixture",
      "user.email": "fixture@example.invalid",
      "commit.gpgsign": "false",
      "core.hooksPath": "/dev/null",
      "protocol.file.allow": "always",
    }))
      gitAt(cwd, "config", key, value);
    await writeFile(path.join(cwd, file), "base\n");
    gitAt(cwd, "add", "-A");
    gitAt(cwd, "commit", "--quiet", "-m", "Base");
  }
  async function list() {
    const result = await operation({
      type: "git.submodule.list",
      arguments: {},
    });
    assert.deepEqual(
      normalize(result),
      normalize({ ok: true, result: await readGitSubmodules(checkout) }),
    );
    return result.result;
  }
  async function preview(action) {
    const expected = await nodeGit(checkout, "git.submodule.action.preview", {
      action,
    });
    const result = await operation({
      type: "git.submodule.action.preview",
      arguments: { action },
    });
    assert.deepEqual(
      result,
      { ok: true, result: expected },
      "exact Node/native submodule review and token",
    );
    return expected;
  }
  async function apply(plan) {
    const result = await operation({
      type: "git.submodule.action.apply",
      arguments: { action: plan.action, token: plan.token },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result.status, await readGitStatus(checkout));
    assert.deepEqual(
      normalize(result.result.submodules),
      normalize(await readGitSubmodules(checkout)),
    );
    return result.result;
  }
  try {
    git(
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "owned submodule smoke sentinel",
    );
    held = true;
    await initialize(leaf, "leaf.txt");
    await initialize(library, "library.txt");
    gitAt(
      library,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      "--name",
      "leaf",
      "-b",
      "main",
      leaf,
      "nested/leaf",
    );
    gitAt(library, "commit", "--quiet", "-am", "Nested module");
    git("config", "protocol.file.allow", "always");
    git(
      "submodule",
      "add",
      "--quiet",
      "--name",
      modulePath,
      "-b",
      "main",
      library,
      modulePath,
    );
    git(
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--",
      modulePath,
    );
    git("commit", "--quiet", "-am", "Owned native submodule fixture");
    gitAt(
      path.join(checkout, modulePath),
      "config",
      "protocol.file.allow",
      "always",
    );
    const before = await readFile(journal, "utf8"),
      inventory = await list();
    assert.equal(inventory.submodules.length, 2);
    assert.ok(inventory.submodules.every((row) => row.initialized));
    let plan = await preview({
      type: "deinitialize",
      path: nestedPath,
      force: false,
    });
    assert.deepEqual(
      await operation({
        type: "git.submodule.action.apply",
        arguments: { action: plan.action, token: "0".repeat(64) },
      }),
      {
        ok: false,
        error:
          "The submodules or selected worktree changed after this preview. Review the action again.",
      },
    );
    await restartWorker();
    await apply(plan);
    assert.equal((await list()).submodules[1].state, "uninitialized");
    await apply(
      await preview({ type: "initialize", path: nestedPath, recursive: true }),
    );
    await apply(
      await preview({ type: "sync", path: nestedPath, recursive: true }),
    );
    await writeFile(
      path.join(checkout, nestedPath, "leaf.txt"),
      "dirty nested file\n",
    );
    const dirty = await operation({
      type: "git.submodule.action.preview",
      arguments: {
        action: { type: "deinitialize", path: nestedPath, force: false },
      },
    });
    assert.deepEqual(dirty, {
      ok: false,
      error: `Submodule ${nestedPath} has local changes. Review again with force only if those changes may be discarded.`,
    });
    plan = await preview({
      type: "deinitialize",
      path: nestedPath,
      force: true,
    });
    assert.equal(plan.warnings.length, 2);
    await apply(plan);
    await apply(
      await preview({ type: "initialize", path: nestedPath, recursive: true }),
    );
    await writeFile(path.join(leaf, "leaf.txt"), "remote advance\n");
    gitAt(leaf, "commit", "--quiet", "-am", "Advance");
    await apply(
      await preview({
        type: "update",
        path: nestedPath,
        recursive: true,
        remote: true,
      }),
    );
    assert.equal(
      (await list()).submodules[1].currentHash,
      gitAt(leaf, "rev-parse", "HEAD"),
    );
    await apply(
      await preview({
        type: "update",
        path: nestedPath,
        recursive: false,
        remote: false,
      }),
    );
    await apply(
      await preview({ type: "deinitialize", path: modulePath, force: false }),
    );
    assert.equal((await list()).submodules.length, 1);
    await apply(
      await preview({ type: "initialize", path: modulePath, recursive: true }),
    );
    await restartWorker();
    assert.ok((await list()).submodules.every((row) => row.initialized));
    assert.equal(
      await readFile(journal, "utf8"),
      before,
      "submodule actions preserve the managed-operation journal",
    );
    await store.put(scope, {
      ...saved,
      state: "awaiting-user-action",
      completedAt: null,
      error: null,
    });
    const active = await readFile(journal, "utf8");
    plan = await preview({ type: "sync", path: modulePath, recursive: true });
    assert.deepEqual(
      await operation({
        type: "git.submodule.action.apply",
        arguments: { action: plan.action, token: plan.token },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    assert.equal(await readFile(journal, "utf8"), active);
  } finally {
    await store.put(scope, saved);
    // This checkout belongs to workspace-smoke's mkdtemp, never a user repo.
    // Restore its original HEAD and held sentinel before later smoke scenarios.
    git("reset", "--hard", oldHead);
    await rm(path.join(checkout, modulePath), { recursive: true, force: true });
    await rm(
      path.resolve(
        checkout,
        git("rev-parse", "--git-path", `modules/${modulePath}`),
      ),
      { recursive: true, force: true },
    );
    try {
      git("config", "--remove-section", `submodule.${modulePath}`);
    } catch {
      /* Already removed by deinit. */
    }
    if (oldProtocol !== null) git("config", "protocol.file.allow", oldProtocol);
    else {
      try {
        git("config", "--unset", "protocol.file.allow");
      } catch {
        /* Already absent. */
      }
    }
    if (held) git("stash", "pop");
    await rm(root, { recursive: true, force: true });
    assert.equal(
      git("status", "--porcelain=v1"),
      oldStatus,
      "owned fixture state restored",
    );
  }
}
