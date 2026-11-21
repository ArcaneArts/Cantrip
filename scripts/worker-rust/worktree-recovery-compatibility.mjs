// Real Node/native dirty-worktree transfers and checkpointed Git recovery.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  rm,
  realpath,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import * as p from "../../packages/protocol/dist/index.js";
import { handleGitCommand } from "../../tests/reference-node-worker/src/commands/git.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-worktree-recovery-")),
);
const original = { ...process.env };
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_AUTHOR_DATE: "2026-11-17T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-17T00:00:00+00:00",
});
const template = path.join(root, "template"),
  lanes = [path.join(root, "node"), path.join(root, "rust")],
  sources = lanes.map((l) => path.join(l, "source")),
  targets = lanes.map((l) => path.join(l, "target"));
const bin = path.join(root, "bin"),
  cancel = path.join(root, "cancel"),
  ready = path.join(root, "preview-ready");
const realGit = execFileSync("/usr/bin/which", ["git"], {
  encoding: "utf8",
}).trim();
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
await mkdir(bin);
await writeFile(
  path.join(bin, "git"),
  `#!/bin/sh
if [ -f ${quote(cancel)} ] && [ "$3" = worktree ] && [ "$4" = add ] && [ "$5" = --detach ]; then
 ${quote(realGit)} "$@" || exit "$?"
 printf '%s' "$6" > ${quote(ready)}
 exec /bin/sleep 30
fi
exec ${quote(realGit)} "$@"
`,
);
await chmod(path.join(bin, "git"), 0o700);
const child = spawn(path.resolve(values.binary), [], {
  env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
  stdio: ["pipe", "pipe", "inherit"],
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let sequence = 0,
  comparisons = 0;
const tokens = new Map(),
  hashes = new Map(),
  commands = new Set(),
  scenarios = [];
const hash = (text) => createHash("sha256").update(text).digest("hex");
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
const write = (cwd, file, contents) =>
  writeFile(path.join(cwd, file), contents);
const both = async (visit) => {
  for (let i = 0; i < 2; i++) await visit(i);
};
function normalize(value) {
  if (typeof value === "string") {
    for (const lane of lanes) value = value.replaceAll(lane, "<owned>");
    for (const [token, label] of tokens)
      value = value
        .replaceAll(token, label)
        .replaceAll(token.slice(0, 12), label + "-prefix");
    for (const [hash, label] of hashes) value = value.replaceAll(hash, label);
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, normalize(value)]),
    );
  return value;
}
function compare(actual, expected, label, normalized = true) {
  actual = normalized ? normalize(actual) : actual;
  expected = normalized ? normalize(expected) : expected;
  if (JSON.stringify(expected).length > 20000) {
    if (!isDeepStrictEqual(actual, expected))
      throw new Error(
        label +
          " large result mismatch " +
          JSON.stringify({
            actualHash: hash(JSON.stringify(actual)),
            expectedHash: hash(JSON.stringify(expected)),
            actualBytes: JSON.stringify(actual).length,
            expectedBytes: JSON.stringify(expected).length,
            actualError: actual.ok === false ? actual.error : undefined,
          }),
      );
  } else assert.deepEqual(actual, expected, label);
  comparisons++;
}
const outcome = async (run) => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};
async function native(command, op = "git", extra = {}) {
  child.stdin.write(
    JSON.stringify({ op, command, ...extra, requestId: ++sequence }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...value } = result;
  return value;
}
const command = (i, type, args = {}, target = false) =>
  p.workerCommandSchema.parse({
    type,
    cwd: target ? targets[i] : sources[i],
    ...args,
  });
async function reset() {
  tokens.clear();
  hashes.clear();
  for (let i = 0; i < 2; i++) {
    await rm(lanes[i], { recursive: true, force: true });
    await mkdir(lanes[i]);
    await cp(template, sources[i], { recursive: true });
    git(sources[i], "worktree", "add", "--quiet", "-b", "target", targets[i]);
    git(sources[i], "status", "--porcelain=v1");
    git(targets[i], "status", "--porcelain=v1");
  }
}
async function dirty() {
  await both(async (i) => {
    await write(sources[i], "staged.txt", "staged index\n");
    git(sources[i], "add", "staged.txt");
    await write(sources[i], "unstaged.txt", "unstaged worktree\n");
    await write(sources[i], "binary.bin", Buffer.from([0, 3, 4]));
    await write(sources[i], "line\n🧙.txt", "untracked\n");
    await rm(path.join(sources[i], "deleted.txt"));
    // Warm Git's own stat-cache refresh before checking exact source/native
    // tokens. The raw index bytes remain part of the real review fingerprint.
    git(sources[i], "status", "--porcelain=v1");
    git(sources[i], "diff", "--binary", "--no-ext-diff", "HEAD");
  });
}
const request = { sourceWorktreeId: "source-worktree" };
async function movePreview(success = true, sourceOverride) {
  const plans = [];
  for (let i = 0; i < 2; i++) {
    const cmd = command(
      i,
      "git.worktree.changes.preview",
      { sourceCwd: sourceOverride?.(i) ?? sources[i], request },
      true,
    );
    commands.add(cmd.type);
    const expected = await outcome(() => handleGitCommand(cmd));
    assert.equal(expected.ok, success, JSON.stringify(expected));
    // Both implementations inspect the exact same real index and paths.
    // No token normalization is allowed in these comparisons.
    const actual = await native(cmd);
    compare(actual, expected, "exact move preview in lane " + i, false);
    if (success) {
      assert.match(actual.value.token, /^[0-9a-f]{64}$/);
      tokens.set(actual.value.token, "<move-review>");
      plans.push(actual.value);
    }
  }
  return plans;
}
async function checkStates(label) {
  for (const tree of [sources, targets]) {
    compare(
      git(tree[1], "status", "--porcelain=v1", "-z"),
      git(tree[0], "status", "--porcelain=v1", "-z"),
      label + " porcelain",
    );
    compare(
      git(tree[1], "diff", "--cached", "--binary"),
      git(tree[0], "diff", "--cached", "--binary"),
      label + " index",
    );
    compare(
      git(tree[1], "diff", "--binary", "HEAD"),
      git(tree[0], "diff", "--binary", "HEAD"),
      label + " working content",
    );
  }
}
function validateStash(i, result, plan) {
  if (!result.stash) return;
  const stash = result.stash;
  assert.equal(
    stash.message,
    `Cantrip move from ${request.sourceWorktreeId} (${plan.token.slice(0, 12)})`,
  );
  assert.equal(git(targets[i], "rev-parse", stash.hash), stash.hash);
  assert.equal(stash.baseHash, plan.sourceHead);
  assert.ok(stash.hash.startsWith(stash.shortHash));
  assert.equal(
    git(targets[i], "rev-parse", result.operation.checkpointRef),
    plan.targetHead,
  );
  hashes.set(stash.hash, "<verified-recovery-stash>");
  hashes.set(stash.shortHash, "<verified-recovery-short>");
}
async function moveApply(plans, success = true, override) {
  const results = [];
  for (let i = 0; i < 2; i++) {
    const cmd = command(
      i,
      "git.worktree.changes.apply",
      { sourceCwd: sources[i], request, token: override ?? plans[i].token },
      true,
    );
    commands.add(cmd.type);
    const result =
      i === 0 ? await outcome(() => handleGitCommand(cmd)) : await native(cmd);
    assert.equal(result.ok, success, JSON.stringify(result));
    if (result.ok) validateStash(i, result.value, plans[i]);
    results.push(result);
  }
  compare(results[1], results[0], "actual move outcome");
  await checkStates("move outcome");
  return results.map((r) => r.value);
}
async function recover(type, args = {}, success = true) {
  commands.add(type);
  const expected = await outcome(() =>
    handleGitCommand(command(0, type, args)),
  );
  assert.equal(expected.ok, success, JSON.stringify(expected));
  const actual = await native(command(1, type, args));
  compare(actual, expected, type);
  return expected.value;
}
try {
  await mkdir(template);
  git(template, "init", "--quiet", "-b", "main");
  for (const [key, value] of Object.entries({
    "user.name": "Recovery Fixture",
    "user.email": "recovery@invalid.test",
    "core.autocrlf": "false",
    "core.safecrlf": "false",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "color.ui": "false",
  }))
    git(template, "config", key, value);
  for (const name of [
    "staged.txt",
    "unstaged.txt",
    "shared.txt",
    "deleted.txt",
  ])
    await write(template, name, "base\n");
  await write(template, "binary.bin", Buffer.from([0, 1, 2]));
  git(template, "add", ".");
  git(template, "commit", "--quiet", "-m", "Base");
  const base = git(template, "rev-parse", "HEAD");
  await reset();
  await dirty();
  let plans = await movePreview();
  assert.equal(plans[0].wouldConflict, false);
  let moved = await moveApply(plans);
  assert.equal(git(sources[1], "status", "--porcelain"), "");
  assert.equal(
    await readFile(path.join(targets[1], "line\n🧙.txt"), "utf8"),
    "untracked\n",
  );
  assert.equal(git(targets[1], "stash", "list"), "");
  assert.equal(
    git(
      targets[1],
      "for-each-ref",
      "--format=%(refname)",
      "refs/cantrip/checkpoints",
    ),
    "",
  );
  scenarios.push("staged/unstaged/binary/deleted/untracked transfer");
  await reset();
  await movePreview(false);
  await dirty();
  await movePreview(false, (i) => targets[i]);
  await both(async (i) => {
    await write(targets[i], "dirty-target", "reject\n");
  });
  await movePreview(false);
  scenarios.push("empty/same/dirty guards");
  await reset();
  await dirty();
  const foreign = path.join(root, "foreign");
  await mkdir(foreign);
  git(foreign, "init", "--quiet", "-b", "main");
  for (let i = 0; i < 2; i++) {
    const cmd = command(
      i,
      "git.worktree.changes.preview",
      { sourceCwd: foreign, request },
      true,
    );
    const expected = await outcome(() => handleGitCommand(cmd));
    assert.equal(expected.ok, false);
    compare(await native(cmd), expected, "common-directory mismatch", false);
  }
  await reset();
  await dirty();
  plans = await movePreview();
  await both((i) =>
    write(
      sources[i],
      "unstaged.txt",
      "different bytes with same status flags\n",
    ),
  );
  await moveApply(plans, false);
  scenarios.push("stale content rejection");
  await reset();
  await both(async (i) => {
    await write(sources[i], "staged.txt", "first staged\n");
    git(sources[i], "add", "staged.txt");
    await write(sources[i], "staged.txt", "working stays unchanged\n");
    git(sources[i], "status", "--porcelain");
  });
  plans = await movePreview();
  await both(async (i) => {
    const object = execFileSync(
      "git",
      ["-C", sources[i], "hash-object", "-w", "--stdin"],
      { input: "different staged\n", encoding: "utf8" },
    ).trim();
    git(
      sources[i],
      "update-index",
      "--cacheinfo",
      `100644,${object},staged.txt`,
    );
  });
  await moveApply(plans, false);
  scenarios.push("stale staged-only snapshot rejection");
  await reset();
  await both(async (i) => {
    await write(targets[i], "shared.txt", "target branch\n");
    git(targets[i], "commit", "--quiet", "-am", "Target");
    await write(sources[i], "shared.txt", "source changes\n");
    git(sources[i], "status", "--porcelain");
  });
  plans = await movePreview();
  assert.equal(plans[0].wouldConflict, true);
  moved = await moveApply(plans);
  assert.equal(moved[1].operation.type, "stash");
  const aborted = [];
  for (let i = 0; i < 2; i++) {
    const cmd = command(
      i,
      "git.operation.control",
      { context: moved[i].operation, action: "abort" },
      true,
    );
    aborted.push(
      i === 0 ? await outcome(() => handleGitCommand(cmd)) : await native(cmd),
    );
  }
  compare(aborted[1], aborted[0], "retained move recovery abort");
  await checkStates("aborted move");
  scenarios.push("conflict stash/checkpoint and abort");
  await reset();
  await both(async (i) => {
    await write(targets[i], ".gitignore", "collision\n");
    git(targets[i], "add", ".gitignore");
    git(targets[i], "commit", "--quiet", "-m", "Ignore collision");
    await write(targets[i], "collision", "target retained\n");
    await write(sources[i], "collision", "source retained\n");
  });
  plans = await movePreview();
  assert.equal(plans[0].wouldConflict, true);
  await moveApply(plans, false);
  await both(async (i) => {
    assert.equal(
      await readFile(path.join(sources[i], "collision"), "utf8"),
      "source retained\n",
    );
    assert.equal(
      await readFile(path.join(targets[i], "collision"), "utf8"),
      "target retained\n",
    );
  });
  scenarios.push("untracked collision rollback");
  await reset();
  await both(async (i) => {
    git(targets[i], "switch", "--quiet", "--detach");
    await write(sources[i], "shared.txt", "🧙".repeat(1_000_020));
    git(sources[i], "status", "--porcelain");
  });
  plans = await movePreview();
  assert.equal(plans[0].patchTruncated, true);
  assert.equal(plans[0].patch.length, 2_000_000);
  assert.equal(plans[0].targetBranch, null);
  scenarios.push("truncated Unicode patch and detached target");
  await reset();
  await both(async (i) => {
    await write(sources[i], "shared.txt", "second\n");
    git(sources[i], "commit", "--quiet", "-am", "Second");
  });
  const second = git(sources[0], "rev-parse", "HEAD");
  assert.equal(git(sources[1], "rev-parse", "HEAD"), second);
  await recover("git.recovery.list", { kind: "reflog", limit: 1, cursor: 0 });
  await recover("git.recovery.list", { kind: "reflog", limit: 5, cursor: 1 });
  for (const mode of ["soft", "mixed", "hard"]) {
    if (mode !== "soft")
      await both((i) => {
        git(sources[i], "reset", "--hard", second);
      });
    let plan = await recover("git.recovery.preview", {
      action: { type: "reset", mode, target: base },
    });
    await recover(
      "git.recovery.apply",
      {
        request: {
          action: plan.action,
          token: plan.token,
          confirmation: "wrong",
        },
      },
      false,
    );
    await both((i) =>
      write(sources[i], "shared.txt", "stale recovery content\n"),
    );
    await recover(
      "git.recovery.apply",
      {
        request: {
          action: plan.action,
          token: plan.token,
          confirmation: plan.confirmation,
        },
      },
      false,
    );
    await both((i) => write(sources[i], "shared.txt", "second\n"));
    plan = await recover("git.recovery.preview", { action: plan.action });
    await both((i) => {
      git(sources[i], "update-ref", plan.checkpointRef, base);
    });
    await recover(
      "git.recovery.apply",
      {
        request: {
          action: plan.action,
          token: plan.token,
          confirmation: plan.confirmation,
        },
      },
      false,
    );
    await both((i) => {
      git(sources[i], "update-ref", "-d", plan.checkpointRef);
    });
    const result = await recover("git.recovery.apply", {
      request: {
        action: plan.action,
        token: plan.token,
        confirmation: plan.confirmation,
      },
    });
    await both((i) =>
      assert.equal(git(sources[i], "rev-parse", result.checkpointRef), second),
    );
    await checkStates("recovery " + mode);
  }
  let plan = await recover("git.recovery.preview", {
    action: { type: "createBranch", branch: "recovery/second", target: second },
  });
  await recover("git.recovery.apply", {
    request: {
      action: plan.action,
      token: plan.token,
      confirmation: plan.confirmation,
    },
  });
  await recover("git.recovery.preview", { action: plan.action }, false);
  await recover(
    "git.recovery.preview",
    { action: { type: "restoreBranch", branch: "main", target: second } },
    false,
  );
  await recover(
    "git.recovery.preview",
    { action: { type: "restoreBranch", branch: "target", target: second } },
    false,
  );
  await recover(
    "git.recovery.preview",
    { action: { type: "restoreBranch", branch: "missing", target: second } },
    false,
  );
  plan = await recover("git.recovery.preview", {
    action: { type: "restoreBranch", branch: "recovery/second", target: base },
  });
  await recover("git.recovery.apply", {
    request: {
      action: plan.action,
      token: plan.token,
      confirmation: plan.confirmation,
    },
  });
  await both(async (i) => {
    git(sources[i], "switch", "--quiet", "-c", "lost");
    await write(sources[i], "lost", "lost commit\n");
    git(sources[i], "add", "lost");
    git(sources[i], "commit", "--quiet", "-m", "Lost");
    git(sources[i], "switch", "--quiet", "main");
    git(sources[i], "branch", "-D", "lost");
  });
  const candidates = await recover("git.recovery.list", {
    kind: "dangling",
    limit: 1,
    cursor: 0,
  });
  assert.ok(candidates.entries.length > 0);
  await recover("git.recovery.list", {
    kind: "dangling",
    limit: 100,
    cursor: 1,
  });
  scenarios.push(
    "reflog/dangling pagination and checkpointed soft/mixed/hard/ref recovery",
  );
  await reset();
  await dirty();
  await writeFile(cancel, "stop after actual worktree registration\n");
  const stopped = await native(
    command(
      1,
      "git.worktree.changes.preview",
      { sourceCwd: sources[1], request },
      true,
    ),
    "git-preview-stop",
    { ready },
  );
  assert.equal(stopped.ok, false, JSON.stringify(stopped));
  assert.match(stopped.error, /stopp|cancel/i);
  const previewPath = await readFile(ready, "utf8");
  assert.equal(
    git(targets[1], "worktree", "list", "--porcelain").includes(previewPath),
    false,
    "stopped add cannot retain its preview registration",
  );
  await assert.rejects(
    stat(path.dirname(previewPath)),
    (error) => error.code === "ENOENT",
  );
  child.stdin.end();
  assert.equal(await completion, 0);
  console.log(
    JSON.stringify({
      suite: "node-native-worktree-transfer-and-recovery",
      passed: true,
      comparisons,
      commands: [...commands],
      scenarios,
      exactPerCheckoutPreviewTokens: true,
      nativeCancellationAfterWorktreeRegistration: true,
      realGit: true,
      platform: process.platform,
    }),
  );
} finally {
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await completion;
  }
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  await rm(root, { recursive: true, force: true });
}
