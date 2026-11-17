// Actual Node/native tag behavior with real Git, signing and owned bare remotes.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
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
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-tags-")),
  template = path.join(root, "template"),
  roots = [path.join(root, "node"), path.join(root, "rust")],
  trees = roots.map((r) => path.join(r, "checkout")),
  remotes = roots.map((r) => path.join(r, "origin.git")),
  key = path.join(root, "signing-key"),
  signers = path.join(root, "allowed-signers");
for (const dir of [template, ...roots]) await mkdir(dir);
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
async function reset(remote = true) {
  for (let i = 0; i < trees.length; i++) {
    await rm(trees[i], { recursive: true, force: true });
    await rm(remotes[i], { recursive: true, force: true });
    await cp(template, trees[i], { recursive: true });
    git(trees[i], "clone", "--quiet", "--bare", template, remotes[i]);
    if (remote) git(trees[i], "remote", "add", "origin", remotes[i]);
  }
}
function normalize(value, key) {
  if (key === "generatedAt") {
    assert.ok(Number.isFinite(Date.parse(value)));
    return "<timestamp>";
  }
  if (typeof value === "string")
    return value
      .replaceAll(roots[0], "<owned>")
      .replaceAll(roots[1], "<owned>");
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, normalize(value, key)]),
    );
  return value;
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
  for (const args of [["show-ref"], ["diff", "--binary", "HEAD"]])
    assert.deepEqual(
      normalize(await observe(() => git(trees[1], ...args))),
      normalize(await observe(() => git(trees[0], ...args))),
      `actual ${args[0]}`,
    );
  assert.equal(
    git(remotes[1], "show-ref"),
    git(remotes[0], "show-ref"),
    "actual remote refs",
  );
  comparisons++;
  return actual.value;
}
async function preview(action, success = true) {
  actions.add(action.type);
  return query("git.tag.action.preview", { action }, success);
}
async function apply(plan, success = true, token = plan.token) {
  return query("git.tag.action.apply", { action: plan.action, token }, success);
}
const create = (name, annotated = false, target = null, message = null) => ({
  type: "create",
  name,
  target,
  annotated,
  message,
});
try {
  git(template, "-c", "init.defaultBranch=main", "init", "--quiet");
  for (const [k, v] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "tag.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "color.ui": "false",
  }))
    git(template, "config", k, v);
  await writeFile(path.join(template, "base.txt"), "base\n");
  git(template, "add", "-A");
  git(template, "commit", "--quiet", "-m", "Base");
  await reset(false);
  await query("git.tag.list");
  for (const action of [
    create("light"),
    create("annotated", true, "HEAD", "Subject 🧙\n\nBody\n"),
    create("utf16-\ud800", true, "HEAD", "Message \ud800"),
    create("tree", false, "HEAD^{tree}"),
    create("blob", false, git(template, "rev-parse", "HEAD:base.txt")),
  ]) {
    await reset();
    const plan = await preview(action);
    await apply(plan, false, "0".repeat(64));
    await apply(plan);
    await query(
      "git.tag.get",
      { name: action.name },
      !action.name.includes("\ud800"),
    );
  }
  await reset();
  for (const cwd of trees) {
    git(
      cwd,
      "tag",
      "-a",
      "annotated",
      "-m",
      "Notes\n\nParagraph one\n\nParagraph two",
    );
    git(cwd, "tag", "nested", "annotated");
    for (const name of ["éclair", "eclair", "Apple", "🧙", "\ue000", "0zero"])
      git(cwd, "tag", name);
  }
  await query("git.tag.list");
  await query("git.tag.get", { name: "annotated" });
  await query("git.tag.get", { name: "nested" });
  await query("git.tag.get", { name: "missing" }, false);
  await preview(create("bad name"), false);
  await preview(create("éclair"), false);
  await preview(create("bad-target", false, "does-not-exist"), false);
  await preview(create("path-target", false, "HEAD:base.txt"), false);
  await preview({ type: "push", name: "missing", remote: "origin" }, false);
  await preview({ type: "deleteLocal", name: "missing" }, false);
  await preview(
    { type: "deleteRemote", name: "missing", remote: "origin" },
    false,
  );
  await preview({ type: "push", name: "éclair", remote: "missing" }, false);
  await preview(
    { type: "deleteRemote", name: "éclair", remote: "origin" },
    false,
  );
  let plan = await preview({
    type: "push",
    name: "annotated",
    remote: "origin",
  });
  await apply(plan);
  await preview(plan.action);
  plan = await preview({ type: "deleteLocal", name: "annotated" });
  assert.equal(plan.warnings.length, 1);
  await preview({ type: "deleteRemote", name: "annotated", remote: "origin" });
  await apply(
    await preview({
      type: "deleteRemote",
      name: "annotated",
      remote: "origin",
    }),
  );
  await apply(plan, false); // publication state changed
  await apply(await preview({ type: "deleteLocal", name: "annotated" }));
  await reset();
  plan = await preview(create("stale-tags"));
  for (const cwd of trees) git(cwd, "tag", "changed");
  await apply(plan, false);
  await reset();
  plan = await preview(create("stale-workspace"));
  for (const cwd of trees)
    await writeFile(path.join(cwd, "dirty.txt"), "dirty\n");
  await apply(plan, false);
  // Remote advertisements are name-based; actual Git refuses a conflicting push.
  await reset();
  for (let i = 0; i < trees.length; i++) {
    const cwd = trees[i];
    git(cwd, "tag", "conflicting");
    git(cwd, "commit", "--allow-empty", "--quiet", "-m", "Second");
    git(cwd, "push", "--quiet", "origin", "main");
    git(
      remotes[i],
      "update-ref",
      "refs/tags/conflicting",
      git(cwd, "rev-parse", "HEAD"),
    );
  }
  plan = await preview({ type: "push", name: "conflicting", remote: "origin" });
  assert.equal(plan.warnings.length, 1);
  await apply(plan, false);
  // Remote failures share the same owned path so exact review hashes can compare.
  await reset();
  for (const cwd of trees) {
    git(cwd, "tag", "local");
    git(cwd, "remote", "set-url", "origin", path.join(root, "missing.git"));
  }
  await query("git.tag.list");
  await preview(
    { type: "deleteRemote", name: "local", remote: "origin" },
    false,
  );
  // UTF-16 message limit can split a supplementary character, as in Node.
  await reset(false);
  const message = "Subject\n\n" + "x".repeat(999990) + "🧙tail";
  const messageFile = path.join(root, "message");
  await writeFile(messageFile, message);
  for (const cwd of trees) git(cwd, "tag", "-a", "long", "-F", messageFile);
  const long = await query("git.tag.get", { name: "long" });
  assert.equal(long.message.length, 1000000);
  assert.equal(long.messageTruncated, true);
  await reset(false);
  for (const cwd of trees)
    git(cwd, "symbolic-ref", "HEAD", "refs/heads/unborn");
  await query("git.tag.list");
  await preview(create("unborn"), false);
  await preview(
    create("unborn-target", false, git(template, "rev-parse", "HEAD")),
    false,
  );
  // Actual SSH signatures: immutable tags, signed targets, failures and trust edits.
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
  await writeFile(signers, `fixture@example.invalid ${publicKey}\n`);
  await reset(false);
  for (const cwd of trees) {
    git(cwd, "config", "gpg.format", "ssh");
    git(cwd, "config", "user.signingKey", key);
    git(cwd, "config", "gpg.ssh.allowedSignersFile", signers);
    git(cwd, "commit", "-S", "--allow-empty", "--quiet", "-m", "Signed target");
    git(cwd, "tag", "light-signed-target");
    git(cwd, "tag", "-s", "signed", "-m", "Signed fixture");
    const signed = git(cwd, "rev-parse", "refs/tags/signed");
    git(cwd, "update-ref", "refs/tags/-signed", signed);
    const raw =
      git(cwd, "cat-file", "tag", "signed")
        .replace("tag signed\n", "tag tampered\n")
        .replace("Signed fixture\n", "Tampered fixture\n") + "\n";
    const objectFile = path.join(root, "tampered");
    await writeFile(objectFile, raw);
    git(
      cwd,
      "update-ref",
      "refs/tags/tampered",
      git(cwd, "hash-object", "-t", "tag", "-w", objectFile),
    );
    git(cwd, "tag", "-a", "unsigned", "-m", "Unsigned fixture");
  }
  const inventory = await query("git.tag.list");
  await query("git.commit.signature.get", {
    revision: git(trees[0], "rev-parse", "HEAD"),
  });
  assert.equal(
    inventory.tags.find((t) => t.name === "signed").signature.status,
    "valid",
  );
  assert.equal(
    inventory.tags.find((t) => t.name === "tampered").signature.status,
    "invalid",
  );
  assert.equal(
    inventory.tags.find((t) => t.name === "light-signed-target").signature
      .status,
    "unsigned",
  );
  for (const name of ["signed", "tampered", "unsigned", "light-signed-target"])
    await query("git.tag.get", { name });
  for (const cwd of trees)
    git(cwd, "config", "--unset", "gpg.ssh.allowedSignersFile");
  await query("git.commit.signature.get", {
    revision: git(trees[0], "rev-parse", "HEAD"),
  });
  await query("git.tag.list");
  await query("git.tag.get", { name: "signed" });
  for (const cwd of trees) {
    git(cwd, "config", "gpg.ssh.allowedSignersFile", signers);
    git(cwd, "config", "gpg.ssh.program", path.join(root, "missing-verifier"));
  }
  await query("git.tag.list");
  for (const cwd of trees) git(cwd, "config", "--unset", "gpg.ssh.program");
  await writeFile(signers, `other@example.invalid ${publicKey}\n`);
  await query("git.tag.list");
  await writeFile(signers, "");
  const unknown = await query("git.tag.get", { name: "signed" });
  assert.equal(unknown.signature.status, "valid-unknown");
  console.log(
    JSON.stringify({
      comparisons,
      actions: [...actions],
      actualGit: true,
      ownedBareRemotes: true,
      exactTokens: true,
      actualSshSignatures: true,
      mutableTrustRechecked: true,
      utf16Messages: true,
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
