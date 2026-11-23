// Real read-only Node/native queries over one owned repository. No hosted Git,
// user configuration, account keys or production profiles are used.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { workerCommandSchema } from "../../packages/protocol/dist/index.js";
import { handleGitCommand } from "../../tests/reference-node-worker/src/commands/git.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const original = { ...process.env };
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
  GIT_AUTHOR_DATE: "2026-11-16T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-16T00:00:00+00:00",
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-history-"));
const cwd = path.join(root, "checkout with spaces 😀");
await mkdir(cwd);
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let sequence = 0,
  comparisons = 0,
  tick = 0;
const commands = new Set();
const missing = "f".repeat(40);
function git(...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function query(type, input = {}, expectedSuccess = true) {
  const command = workerCommandSchema.parse({
    type,
    cwd,
    ...(type === "git.revision.diff" ? { baseRevision: null } : {}),
    ...input,
  });
  commands.add(type);
  let expected;
  try {
    expected = { ok: true, value: await handleGitCommand(command) };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  assert.equal(
    expected.ok,
    expectedSuccess,
    "reference outcome: " + JSON.stringify(command),
  );
  child.stdin.write(
    JSON.stringify({ op: "git", command, requestId: ++sequence }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false, JSON.stringify(command));
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...actual } = result;
  assert.deepEqual(actual, expected, JSON.stringify(command));
  comparisons++;
  return actual;
}
function commit(message) {
  process.env.GIT_AUTHOR_DATE =
    process.env.GIT_COMMITTER_DATE = `2026-11-${16 + tick++}T12:00:00+00:00`;
  git("add", "-A");
  git("commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
}
try {
  git("-c", "init.defaultBranch=main", "init", "--quiet");
  for (const [key, value] of Object.entries({
    "user.name": "A.* Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "color.ui": "false",
  }))
    git("config", key, value);
  await query("git.history");
  await query("git.history", { options: { firstParent: true } }, false);
  await query("git.refs.list");
  await query("git.commit.get", { revision: missing }, false);
  await query("git.commit.signature.get", { revision: missing }, false);
  await query("git.file.history", { path: "missing", revision: "HEAD" }, false);
  await query("git.file.blame", { path: "missing", revision: "HEAD" }, false);
  await query("git.commit.search", { query: { message: "absent" } });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mP8DwABAQEAG7buVgAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(path.join(cwd, "original.txt"), "one\ntwo\nthree\nfour\n");
  await writeFile(path.join(cwd, "deleted.txt"), "delete me\n");
  await writeFile(path.join(cwd, "image.png"), png);
  await writeFile(path.join(cwd, "data.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(cwd, "literal[ab].txt"), "literal\n");
  await writeFile(path.join(cwd, "line\nbreak 😀.txt"), "newline name\n");
  const first = commit("Initial message 😀\n\nDetailed body with unicode 🧙\n");
  await query("git.commit.get", { revision: first, parentIndex: 8 });
  await query("git.commit.signature.get", { revision: first });
  await query("git.revision.diff", { revision: first, path: "image.png" });
  await query("git.revision.diff", { revision: first, path: "data.bin" });
  await query("git.revision.diff", {
    revision: first,
    path: "literal[ab].txt",
  });
  await query("git.revision.diff", {
    revision: first,
    path: "line\nbreak 😀.txt",
  });
  await rename(path.join(cwd, "original.txt"), path.join(cwd, "renamed.txt"));
  await writeFile(path.join(cwd, "renamed.txt"), "one\nchanged\nthree\nfour\n");
  await rm(path.join(cwd, "deleted.txt"));
  await writeFile(
    path.join(cwd, "image.png"),
    Buffer.concat([png, Buffer.from([0])]),
  );
  await writeFile(path.join(cwd, "data.bin"), Buffer.from([0, 4, 5, 6]));
  const second = commit("Rename and modify");
  git("tag", "light", first);
  git("tag", "-a", "annotated", "-m", "annotation", second);
  const blob = git("rev-parse", `${first}:original.txt`);
  git("update-ref", "refs/tags/blob-tag", blob);
  git("remote", "add", "origin", path.join(root, "unused-local-remote"));
  git("update-ref", "refs/remotes/origin/main", second);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("checkout", "--quiet", "-b", "feature", first);
  await writeFile(path.join(cwd, "feature.txt"), "feature\n");
  const feature = commit("Feature work");
  git("checkout", "--quiet", "main");
  git("merge", "--quiet", "--no-ff", "feature", "-m", "Merge feature");
  const merged = git("rev-parse", "HEAD");
  const detached = git(
    "commit-tree",
    `${merged}^{tree}`,
    "-p",
    merged,
    "-m",
    "Detached child",
  );
  const unrelated = git(
    "commit-tree",
    `${first}^{tree}`,
    "-m",
    "Unrelated root",
  );
  for (const input of [
    {},
    { limit: 1 },
    { limit: 1, cursor: 1 },
    { limit: 1, cursor: 999 },
    { revisions: [detached, detached, missing] },
    { options: { firstParent: true } },
    { options: { hideMerges: true } },
    { options: { filters: { message: "RENAME" } } },
    { options: { filters: { author: "A.* Fixture" } } },
    { options: { filters: { path: "renamed.txt" } } },
    { options: { filters: { dateFrom: "2026-11-17", dateTo: "2026-11-18" } } },
    { options: { filters: { branch: "feature" } } },
    { options: { filters: { branch: "origin/main" } } },
    { options: { filters: { tag: "annotated" } } },
    { options: { filters: { hash: first.slice(0, 12) } } },
    { options: { filters: { branch: "missing" } } },
    { options: { filters: { branch: "missing-\ud800" } } },
  ])
    await query(
      "git.history",
      input,
      !input.options?.filters?.branch?.startsWith("missing"),
    );
  await query("git.refs.list");
  for (const input of [
    {},
    { parentIndex: 1 },
    { parentIndex: 8 },
    { revisions: [detached, missing, detached] },
  ])
    await query(
      "git.commit.get",
      { revision: merged, ...input },
      input.parentIndex !== 8,
    );
  await query("git.commit.get", { revision: second });
  for (const input of [
    {},
    { limit: 1 },
    { limit: 1, cursor: 1 },
    { cursor: 999 },
  ])
    await query("git.file.history", {
      path: "renamed.txt",
      revision: merged,
      ...input,
    });
  for (const input of [
    { limit: 2 },
    { limit: 2, cursor: 2 },
    { limit: 1, cursor: 1 },
    { cursor: 999 },
  ])
    await query(
      "git.file.blame",
      { path: "renamed.txt", revision: merged, ...input },
      input.cursor !== 999,
    );
  await query("git.file.blame", { path: "missing", revision: merged }, false);
  for (const filter of [
    { message: "rename" },
    { author: "A.* Fixture" },
    { branch: "feature" },
    { branch: "origin/main" },
    { tag: "annotated" },
    { hash: first.slice(0, 12) },
    { path: "renamed.txt" },
    { message: "Initial", dateFrom: "2026-11-16", dateTo: "2026-11-16" },
    { branch: "missing" },
  ])
    await query(
      "git.commit.search",
      { query: filter, limit: 1 },
      filter.branch !== "missing",
    );
  await query("git.commit.search", {
    query: { message: "e" },
    limit: 1,
    cursor: 1,
  });
  for (const [left, right, mode] of [
    [second, feature, "direct"],
    [second, feature, "merge-base"],
    [merged, merged, "direct"],
    [merged, unrelated, "direct"],
    [merged, unrelated, "merge-base"],
  ])
    await query(
      "git.compare",
      { left, right, mode },
      !(right === unrelated && mode === "merge-base"),
    );
  for (const name of [
    "renamed.txt",
    "deleted.txt",
    "data.bin",
    "image.png",
    "missing",
  ])
    await query(
      "git.revision.diff",
      { revision: second, baseRevision: first, path: name, contextLines: 0 },
      name !== "missing",
    );
  git("checkout", "--quiet", "--detach", detached);
  await query("git.history");
  await query("git.refs.list");
  git("checkout", "--quiet", "main");
  // Real SSH signatures and Git's verification/configuration failure behavior.
  const key = path.join(root, "signing-key"),
    allowed = path.join(root, "allowed-signers");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  await writeFile(
    allowed,
    `fixture@example.invalid ${await readFile(key + ".pub", "utf8")}`,
  );
  git("config", "gpg.format", "ssh");
  git("config", "user.signingkey", key);
  git("config", "gpg.ssh.allowedSignersFile", allowed);
  git("commit", "--quiet", "--allow-empty", "-S", "-m", "Signed fixture");
  const signed = git("rev-parse", "HEAD");
  const signature = await query("git.commit.signature.get", {
    revision: signed,
  });
  assert.equal(signature.value.status, "valid");
  await query("git.commit.signature.get", { revision: signed });
  await rename(allowed, allowed + ".away");
  const cached = await query("git.commit.signature.get", { revision: signed });
  assert.deepEqual(
    cached,
    signature,
    "same signing configuration retains the source cache entry",
  );
  await rename(allowed + ".away", allowed);
  git("config", "--unset", "gpg.ssh.allowedSignersFile");
  await query("git.commit.signature.get", { revision: signed });
  git("config", "gpg.ssh.allowedSignersFile", allowed);
  git("config", "gpg.ssh.program", path.join(root, "missing-verifier"));
  await query("git.commit.signature.get", { revision: signed });
  git("config", "--unset", "gpg.ssh.program");
  await query("git.commit.signature.get", { revision: signed });
  console.log(
    JSON.stringify({
      comparisons,
      commands: [...commands],
      platform: process.platform,
    }),
  );
} finally {
  child.stdin.end();
  try {
    assert.equal(await completion, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const name of Object.keys(process.env))
      if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
  }
}
