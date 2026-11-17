// Remote config/review/redaction compatibility with actual Git and local bare repos.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as p from "../../packages/protocol/dist/index.js";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const original = { ...process.env };
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
  GIT_AUTHOR_DATE: "2026-11-17T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-17T00:00:00+00:00",
});
const { handleGitCommand } =
  await import("../../cantrip_worker/src/commands/git.ts");
const { readGitStatus } = await import("../../cantrip_worker/src/git.ts");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-remotes-")),
  template = path.join(root, "template"),
  nodeRoot = path.join(root, "node"),
  rustRoot = path.join(root, "rust"),
  first = path.join(root, "first.git"),
  second = path.join(root, "second.git");
for (const dir of [template, nodeRoot, rustRoot]) await mkdir(dir);
const trees = [
  path.join(nodeRoot, "checkout"),
  path.join(rustRoot, "checkout"),
];
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let sequence = 0,
  comparisons = 0;
const actions = new Set();
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
async function reset() {
  for (const cwd of trees) {
    await rm(cwd, { recursive: true, force: true });
    await cp(template, cwd, { recursive: true });
  }
}
function normalize(v, key) {
  if (key === "generatedAt") {
    assert.ok(Number.isFinite(Date.parse(v)));
    return "<timestamp>";
  }
  if (typeof v === "string")
    return v.replaceAll(nodeRoot, "<owned>").replaceAll(rustRoot, "<owned>");
  if (Array.isArray(v)) return v.map((item) => normalize(item));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, v]) => [k, normalize(v, k)]),
    );
  return v;
}
async function observe(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function native(command) {
  child.stdin.write(
    JSON.stringify({ op: "git", command, requestId: ++sequence }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...value } = result;
  return value;
}
async function query(type, input = {}, success = true) {
  const command = p.workerCommandSchema.parse({
    type,
    cwd: trees[0],
    ...input,
  });
  const expected = await observe(() => handleGitCommand(command));
  assert.equal(expected.ok, success, JSON.stringify(expected));
  const actual = await native({ ...command, cwd: trees[1] });
  assert.deepEqual(
    normalize(actual),
    normalize(expected),
    type + JSON.stringify(input),
  );
  assert.deepEqual(
    await readGitStatus(trees[1]),
    await readGitStatus(trees[0]),
  );
  for (const args of [
    ["show-ref"],
    ["config", "--local", "--list"],
    ["diff", "--binary", "HEAD"],
  ])
    assert.equal(
      git(trees[1], ...args),
      git(trees[0], ...args),
      `actual Git ${args[0]}`,
    );
  comparisons++;
  return actual.value;
}
async function preview(action, success = true) {
  actions.add(action.type);
  return query("git.remote.action.preview", { action }, success);
}
async function apply(plan, success = true, token = plan.token) {
  return query(
    "git.remote.action.apply",
    { action: plan.action, token },
    success,
  );
}
const add = (name, fetchUrl = first, pushUrl = null) => ({
  type: "add",
  name,
  fetchUrl,
  pushUrl,
});
try {
  git(template, "-c", "init.defaultBranch=main", "init", "--quiet");
  for (const [k, v] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "color.ui": "false",
  }))
    git(template, "config", k, v);
  await writeFile(path.join(template, "base.txt"), "base\n");
  git(template, "add", "-A");
  git(template, "commit", "--quiet", "-m", "Base");
  git(template, "clone", "--quiet", "--bare", template, first);
  git(template, "clone", "--quiet", "--bare", template, second);
  await reset();
  await query("git.remote.list");
  for (const value of [
    "https://user:password@EXAMPLE.invalid:443/a/../repo.git?access_token=hidden&public=x%20y#frag",
    "https://host.invalid/repo?secret=one&secret=two&Token=three&token2=four&public=a~b+z%2F",
    "https://host.invalid/repo?api%5Fkey=one&Key=two&paſſword=three",
    "git@host.invalid:owner/repo.git",
    "ssh://user:password@host.invalid:22/home/repo?auth=hidden",
    "file:///tmp/a b/repo?key=hidden",
    "C:\\Users\\person\\repo",
    "//host/path?token=hidden",
    "mailto:user:password@example.invalid?secret=hidden value",
    "data:text/plain,hi there?password=hidden&x=%7E",
    "https://[::1]:443/repo?key=hidden",
    "https://0x7f.1/repo?token=hidden",
    "not a URL https://name:password@host.invalid/repo?token=hidden&x=y",
    "https://bad host.invalid/repo?secret=hidden",
    "opaque:trailing space  ?token=hidden",
    "opaque:trailing space  ?public=value",
    "opaque:trailing space  #fragment",
    "https://user:password@faß.invalid/repo?key=hidden",
    "https://host.invalid/repo?secret=%FF&public=%FF",
    "https://host.invalid/repo?public=%7e&public=a%20b",
    "https://user:@host.invalid/repo",
    "https://:password@host.invalid/repo",
  ]) {
    await reset();
    for (const cwd of trees) git(cwd, "remote", "add", "credentialed", value);
    await query("git.remote.list");
  }
  for (const [action, setup] of [
    [add("origin"), false],
    [add("origin", first, second), false],
    [
      add(
        "native-🧙\ud800",
        "https://name:password@host.invalid/repo?secret=hidden",
      ),
      false,
    ],
    [{ type: "edit", name: "origin", fetchUrl: second, pushUrl: first }, true],
    [{ type: "edit", name: "origin", fetchUrl: second, pushUrl: null }, true],
    [{ type: "remove", name: "origin" }, true],
    [
      { type: "setDefaults", fetchRemote: "origin", pushRemote: "origin" },
      true,
    ],
    [{ type: "setDefaults", fetchRemote: null, pushRemote: null }, false],
    [{ type: "fetch", remote: "origin", prune: false }, true],
    [{ type: "fetch", remote: "origin", prune: true }, true],
  ]) {
    await reset();
    if (setup)
      for (const cwd of trees) git(cwd, "remote", "add", "origin", first);
    const plan = await preview(action);
    await apply(plan, false, "0".repeat(64));
    await apply(plan);
  }
  await reset();
  for (const cwd of trees) {
    git(cwd, "remote", "add", "origin", first);
    git(cwd, "remote", "add", "backup", second);
    git(cwd, "config", "branch.main.remote", "backup");
    git(cwd, "config", "branch.main.merge", "refs/heads/main");
  }
  await query("git.remote.list");
  await apply(
    await preview({
      type: "setDefaults",
      fetchRemote: "backup",
      pushRemote: "origin",
    }),
  );
  await query("git.remote.list");
  await apply(
    await preview({ type: "setDefaults", fetchRemote: null, pushRemote: null }),
  );
  for (const action of [
    add("bad name"),
    { type: "edit", name: "missing", fetchUrl: first, pushUrl: null },
    { type: "remove", name: "missing" },
    { type: "setDefaults", fetchRemote: "missing", pushRemote: null },
    { type: "fetch", remote: "missing", prune: false },
  ]) {
    await reset();
    await preview(action, false);
  }
  await reset();
  for (const cwd of trees) git(cwd, "remote", "add", "origin", first);
  await preview(add("origin"), false);
  // Hidden credentials still bind tokens through the raw configuration digest.
  await reset();
  for (const cwd of trees)
    git(
      cwd,
      "remote",
      "add",
      "credentialed",
      "https://user:first-password@host.invalid/repo?token=first-hidden",
    );
  let plan = await preview({
    type: "edit",
    name: "credentialed",
    fetchUrl: first,
    pushUrl: null,
  });
  assert.equal(plan.warnings.length, 1);
  for (const cwd of trees)
    git(
      cwd,
      "remote",
      "set-url",
      "credentialed",
      "https://user:second-password@host.invalid/repo?token=second-hidden",
    );
  await apply(plan, false);
  await reset();
  for (const cwd of trees) git(cwd, "remote", "add", "origin", first);
  plan = await preview({ type: "remove", name: "origin" });
  for (const cwd of trees)
    await writeFile(path.join(cwd, "dirty.txt"), "new\n");
  await apply(plan, false);
  // Real local fetch/prune and failure output exercise the bounded process path.
  await reset();
  for (const cwd of trees) git(cwd, "remote", "add", "origin", first);
  const head = git(template, "rev-parse", "HEAD");
  git(first, "update-ref", "refs/heads/fetched", head);
  await apply(await preview({ type: "fetch", remote: "origin", prune: false }));
  git(first, "update-ref", "-d", "refs/heads/fetched");
  await apply(await preview({ type: "fetch", remote: "origin", prune: true }));
  await reset();
  for (const cwd of trees)
    git(
      cwd,
      "remote",
      "add",
      "missing-local",
      path.join(root, "does-not-exist.git"),
    );
  await apply(
    await preview({ type: "fetch", remote: "missing-local", prune: false }),
    false,
  );
  console.log(
    JSON.stringify({
      comparisons,
      actions: [...actions],
      actualGit: true,
      ownedBareRemotes: true,
      exactTokens: true,
      urlRedaction: true,
      hiddenCredentialFingerprint: true,
      platform: process.platform,
    }),
  );
} finally {
  child.stdin.end();
  try {
    assert.equal(await completion, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
}
