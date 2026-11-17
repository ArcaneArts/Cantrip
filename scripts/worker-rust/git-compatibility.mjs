// Actual Node Git helpers vs native queries, using owned repositories only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import {
  readGitStatus,
  readGitFileDiff,
} from "../../cantrip_worker/src/git.ts";
import {
  RepositoryManagedOperationStore,
  managedOperationRecord,
} from "../../cantrip_worker/src/repository-managed-operation-store.js";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-native-"));
const cwd = path.join(root, "checkout");
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
  comparisons = 0;
async function native(input) {
  child.stdin.write(JSON.stringify({ ...input, requestId: ++sequence }) + "\n");
  const message = await lines.next();
  assert.equal(message.done, false);
  const { id, result } = JSON.parse(message.value);
  assert.equal(id, sequence);
  const { code, ...output } = result;
  return output;
}
async function observe(read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function compare(input, read, label = input.op) {
  assert.deepEqual(await native(input), await observe(read), label);
  comparisons++;
}
function git(...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function status(label) {
  await compare(
    { op: "git", command: { type: "git.status", cwd } },
    () => readGitStatus(cwd),
    label,
  );
}
async function diff(file, scope = "unstaged", contextLines = 3) {
  await compare(
    {
      op: "git",
      command: { type: "git.diff", cwd, path: file, scope, contextLines },
    },
    () => readGitFileDiff(cwd, file, scope, contextLines),
    `${scope}: ${file}`,
  );
}
function commit(message) {
  git("add", "-A");
  git("commit", "--quiet", "-m", message);
}
try {
  git("-c", "init.defaultBranch=main", "init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  await status("unborn repository");
  await writeFile(path.join(cwd, "text.txt"), "one\ntwo\nthree\n");
  await writeFile(
    path.join(cwd, "old.txt"),
    "rename remains recognizable\n".repeat(10),
  );
  await writeFile(path.join(cwd, "image.PNG"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(cwd, "binary.bin"), Buffer.from([0, 9, 8]));
  await mkdir(path.join(cwd, "nested"));
  await writeFile(path.join(cwd, "nested", "escape.png"), Buffer.from([0, 1]));
  git("add", "-A");
  await status("unborn staged index");
  await diff("text.txt", "staged");
  git("commit", "--quiet", "-m", "initial");
  const initial = git("rev-parse", "HEAD");
  for (const name of [
    "a-local",
    "A-other",
    "ä-branch",
    "z-last",
    "I-branch",
    "İ-other",
    "ı-last",
  ]) {
    git("branch", name);
  }
  git("remote", "add", "origin", path.join(root, "unused-owned-remote.git"));
  git("update-ref", "refs/remotes/origin/main", initial);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("branch", "--set-upstream-to=origin/main", "main");
  await status("tracking and locale branch ordering");
  await writeFile(path.join(cwd, "text.txt"), "one\nstaged\nthree\n");
  git("add", "text.txt");
  await writeFile(path.join(cwd, "text.txt"), "one\nworking\nthree\nlast\n");
  await rename(path.join(cwd, "old.txt"), path.join(cwd, "renamed.txt"));
  git("add", "-A", "--", "old.txt", "renamed.txt");
  await writeFile(
    path.join(cwd, "renamed.txt"),
    "rename remains recognizable\n".repeat(10) + "extra\n",
  );
  const literal = "literal[*] 😀\tline\n.txt";
  await writeFile(path.join(cwd, literal), "literal pathspec\n");
  await writeFile(path.join(cwd, "binary.bin"), Buffer.from([0, 7, 6]));
  await writeFile(path.join(cwd, "image.PNG"), Buffer.from([0, 4, 5, 6]));
  await writeFile(
    path.join(cwd, "large.png"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  await writeFile(path.join(cwd, "vector.svg"), "<svg>text</svg>\n");
  await symlink(path.join(root, "outside-image"), path.join(cwd, "link.jpg"));
  await status("staged/unstaged/renamed/untracked and binary changes");
  for (const file of ["text.txt", "renamed.txt"]) {
    await diff(file, "staged", 0);
    await diff(file, "unstaged", 1000);
  }
  for (const file of [
    literal,
    "binary.bin",
    "image.PNG",
    "large.png",
    "vector.svg",
    "link.jpg",
  ]) {
    await diff(file);
  }
  await diff("not-changed.txt");
  await diff("../escape");
  await diff("missing\ud800");
  await rm(path.join(cwd, "nested"), { recursive: true });
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "escape.png"), Buffer.from([0, 8]));
  await symlink(outside, path.join(cwd, "nested"));
  await diff("nested/escape.png");
  await rm(path.join(cwd, "nested"));
  git("restore", "--worktree", "--", "nested");
  // Wire patch truncation counts UTF-16 units, including a split surrogate pair.
  await writeFile(path.join(cwd, "unicode.txt"), "😀".repeat(1_000_010));
  await diff("unicode.txt");
  await rm(path.join(cwd, "unicode.txt"));
  await writeFile(path.join(cwd, "bounded.txt"), "a".repeat(17 * 1024 * 1024));
  await diff("bounded.txt");
  await rm(path.join(cwd, "bounded.txt"));
  commit("local changes");
  await status("ahead of tracked branch");
  git("checkout", "--detach", "--quiet", initial);
  await status("detached head");
  git("checkout", "--quiet", "main");
  git("checkout", "--quiet", "-b", "conflict");
  await writeFile(path.join(cwd, "text.txt"), "conflict branch\n");
  commit("side");
  git("checkout", "--quiet", "main");
  await writeFile(path.join(cwd, "text.txt"), "main branch\n");
  commit("main");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "conflict"));
  await status("ahead and behind");
  try {
    git("merge", "--no-edit", "conflict");
    assert.fail("expected owned merge conflict");
  } catch (error) {
    assert.notEqual(error.status, 0);
  }
  await status("unmerged index");
  await diff("text.txt", "staged");
  await diff("text.txt");
  const scope = {
    serverId: "server",
    ownerId: "owner",
    workerId: "worker",
    projectId: "11111111-1111-4111-8111-111111111111",
    worktreeId: "22222222-2222-4222-8222-222222222222",
  };
  const directory = path.join(root, "profile"),
    store = new RepositoryManagedOperationStore(directory);
  const storedInput = {
    op: "git-stored",
    directory,
    command: scope,
    ownerId: scope.ownerId,
    workerId: scope.workerId,
  };
  await compare(storedInput, () => store.get(scope), "missing journal");
  const record = managedOperationRecord({
    scope,
    id: "33333333-3333-4333-8333-333333333333",
    now: "2026-08-20T12:00:00.000Z",
    state: {
      type: "merge",
      state: "conflicted",
      originalHead: initial,
      currentHead: initial,
      sourceRef: "conflict",
      sourceRevision: initial,
      targetRef: "refs/heads/main",
      targetRevision: initial,
      pendingCommits: [initial],
      currentStep: 1,
      totalSteps: 1,
      conflictedPaths: ["text.txt"],
      output: "private output",
      checkpointRef: null,
      status: await readGitStatus(cwd),
    },
  });
  await store.put(scope, record);
  await compare(storedInput, () => store.get(scope), "existing active journal");
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        scope.serverId,
        scope.ownerId,
        scope.workerId,
        scope.projectId,
        scope.worktreeId,
      ]),
    )
    .digest("hex");
  const file = path.join(directory, "repository-operations", key + ".json");
  await writeFile(
    file,
    JSON.stringify({ ...record, workerId: "another-worker" }),
  );
  await compare(storedInput, () => store.get(scope), "wrong journal scope");
  await writeFile(file, "{broken");
  await compare(storedInput, () => store.get(scope), "malformed journal");
  assert.equal(await readFile(file, "utf8"), "{broken");
  console.log(
    JSON.stringify({
      suite: "native-git-working-tree",
      comparisons,
      locale: new Intl.Collator().resolvedOptions().locale,
      actualGit: true,
      ownedRepositories: true,
    }),
  );
} finally {
  child.stdin.end();
  await completion;
  await rm(root, { recursive: true, force: true });
}
