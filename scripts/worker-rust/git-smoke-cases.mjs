// Production encrypted repository operations against the owned smoke checkout.
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { handleGitCommand } from "../../tests/reference-node-worker/src/commands/git.ts";
import { verifyForcePush } from "./git-force-push-smoke.mjs";
import { verifyCommitActions } from "./git-commit-smoke-cases.mjs";
import { verifyStashes } from "./git-stash-smoke-cases.mjs";
import { verifyPartialPatches } from "./git-patch-smoke-cases.mjs";
import { verifyBranches } from "./git-branch-smoke-cases.mjs";
import { verifyRemotes } from "./git-remote-smoke-cases.mjs";
import { verifyTags } from "./git-tag-smoke-cases.mjs";
import { verifySubmodules } from "./git-submodule-smoke-cases.mjs";
import { verifyLfs } from "./git-lfs-smoke-cases.mjs";
import { verifyGraph } from "./git-graph-smoke-cases.mjs";
import {
  inspectGitManagedOperation,
  previewGitManagedOperation,
} from "../../tests/reference-node-worker/src/git.ts";
import {
  managedOperationRecord,
  RepositoryManagedOperationStore,
} from "../../tests/reference-node-worker/src/repository-managed-operation-store.ts";

async function verifyChangeSummary(checkout, operation) {
  const start = Math.floor(Date.now() / 1_000) + 120;
  const date = (seconds) => new Date((start + seconds) * 1_000).toISOString();
  function gitAt(seconds, ...args) {
    const timestamp = String(start + seconds) + " +0000";
    return execFileSync(
      "git",
      [
        "-C",
        checkout,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_DATE: timestamp,
        },
        encoding: "utf8",
      },
    );
  }
  async function compare(until) {
    const arguments_ = { since: date(0), until };
    const response = await operation({
      type: "git.change-summary",
      arguments: { ...arguments_, cwd: "/not-the-routed-checkout" },
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    const actual = p.gitChangeSummarySchema.parse(response.result);
    const expected = await handleGitCommand({
      type: "git.change-summary",
      cwd: checkout,
      ...arguments_,
    });
    assert.deepEqual(
      { ...actual, observedAt: null },
      { ...expected, observedAt: null },
    );
    return actual;
  }
  const original =
    process.platform === "win32" ? "before name.txt" : "before\tname.txt";
  const renamed =
    (process.platform === "win32" ? "" : "commit:") + "b".repeat(40);
  const file = (name) => path.join(checkout, name);
  await writeFile(file(original), "original line\n");
  gitAt(-60, "add", "--", original);
  gitAt(-60, "commit", "-qm", "Before task");
  assert.equal((await compare(null)).commits, 0);

  gitAt(10, "switch", "-qc", "summary-topic");
  await rename(file(original), file(renamed));
  await writeFile(file("topic.txt"), "one\ntwo\n");
  gitAt(10, "add", "--", original, renamed, "topic.txt");
  gitAt(10, "commit", "-qm", "Topic changes");
  gitAt(20, "switch", "-q", "main");
  await writeFile(file("main.txt"), "main\n");
  gitAt(20, "add", "--", "main.txt");
  gitAt(20, "commit", "-qm", "Main changes");
  gitAt(30, "merge", "--no-ff", "-qm", "Merge task branch", "summary-topic");
  assert.equal((await compare(date(25))).commits, 1);

  await writeFile(file("main.txt"), "staged\n");
  gitAt(40, "add", "--", "main.txt");
  await writeFile(file("main.txt"), "staged\nunstaged\n");
  await writeFile(file("untracked.txt"), "text\nwithout final newline");
  await writeFile(file("binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(file("large.txt"), "");
  await truncate(file("large.txt"), 8 * 1_024 * 1_024 + 1);
  if (process.platform !== "win32")
    await symlink("main.txt", file("untracked-link"));
  const before = gitAt(40, "status", "--porcelain=v1", "-z");
  const result = await compare(null);
  assert.equal(result.commits, 2);
  assert.equal(result.binaryFiles, 1);
  assert.equal(result.partial, true);
  assert.equal(gitAt(40, "status", "--porcelain=v1", "-z"), before);
}

export async function verifyGit({
  call,
  ownerId,
  serverId,
  componentKey,
  projectId,
  workerId,
  workerDirectory,
  checkout,
  restartWorker,
  summaryOnly = false,
  forcePushOnly = false,
}) {
  const worktrees = await call("GET", `/api/projects/${projectId}/worktrees`);
  assert.equal(worktrees.status, 200, JSON.stringify(worktrees));
  const worktree = worktrees.body.find(
    (tree) => tree.workerId === workerId && tree.isPrimary,
  );
  assert.ok(worktree, JSON.stringify(worktrees));
  const worktreeId = worktree.id;
  async function operation(content, override = {}, expectedStatus = 200) {
    const context = {
      serverId,
      projectId,
      worktreeId,
      operationId: crypto.randomUUID(),
      direction: "request",
    };
    const plaintext = new TextEncoder().encode(
      JSON.stringify(p.repositoryOperationRequestContentSchema.parse(content)),
    );
    let protectedRequest;
    try {
      protectedRequest = await c.encryptRepositoryOperationPayload({
        ownerId,
        context,
        keyRevision: 1,
        componentKey,
        plaintext,
      });
    } finally {
      plaintext.fill(0);
    }
    const body = {
      operationId: context.operationId,
      protectedRequest,
      access: p.repositoryOperationAccess(content.type),
      agent: false,
      ...override,
    };
    const response = await call(
      "POST",
      `/api/projects/${projectId}/worktrees/${worktreeId}/repository-operation`,
      body,
    );
    assert.equal(response.status, expectedStatus, JSON.stringify(response));
    if (expectedStatus !== 200) return response.body;
    assert.equal(JSON.stringify(response.body).includes(checkout), false);
    const opened = await c.decryptRepositoryOperationPayload({
      ownerId,
      context: { ...context, direction: "response" },
      keyRevision: 1,
      componentKey,
      opaque: response.body.protectedResponse,
    });
    try {
      return p.repositoryOperationOutcomeContentSchema.parse(
        JSON.parse(new TextDecoder().decode(opened)),
      );
    } finally {
      opened.fill(0);
    }
  }
  if (summaryOnly) return verifyChangeSummary(checkout, operation);
  if (forcePushOnly) return verifyForcePush(checkout, operation);
  const status = await operation({
    type: "git.status",
    arguments: { cwd: "/untrusted-overridden" },
  });
  assert.equal(status.ok, true, JSON.stringify(status));
  const checked = p.gitStatusSchema.parse(status.result);
  assert.equal(checked.branch, "main");
  assert.ok(checked.files.some((file) => file.path === "untouched.txt"));
  const diff = await operation({
    type: "git.diff",
    arguments: { path: "untouched.txt", scope: "unstaged", contextLines: 0 },
  });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.ok(
    p.gitFileDiffSchema
      .parse(diff.result)
      .patch.includes("+private dirty content"),
  );
  const wrong = await operation(
    { type: "git.status", arguments: {} },
    { access: "write" },
    502,
  );
  // Public access metadata and authenticated inner operation must agree.
  assert.equal(wrong.error, "Repository operation access metadata is invalid.");
  const mutable = "native-action.txt",
    literal = "native-literal[ab].txt",
    sibling = "native-literala.txt";
  for (const [name, value] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
  }))
    execFileSync("git", ["-C", checkout, "config", name, value]);
  await writeFile(path.join(checkout, mutable), "first\n");
  async function action(action) {
    return operation({ type: "git.action", arguments: { action } });
  }
  const scope = { ownerId, serverId, workerId, projectId, worktreeId };
  const store = new RepositoryManagedOperationStore(workerDirectory);
  const workerStatus = async () => {
    const outcome = await operation({ type: "git.status", arguments: {} });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    return p.gitStatusSchema.parse(outcome.result);
  };
  const active = managedOperationRecord({
    scope,
    state: {
      type: "merge",
      state: "conflicted",
      originalHead: checked.head,
      currentHead: checked.head,
      sourceRef: "private/fixture",
      sourceRevision: checked.head,
      targetRef: "refs/heads/main",
      targetRevision: checked.head,
      pendingCommits: [checked.head],
      currentStep: 1,
      totalSteps: 1,
      conflictedPaths: [mutable],
      output: "private existing operation",
      checkpointRef: null,
      status: await workerStatus(),
    },
  });
  await store.put(scope, active);
  const activeHistory = await operation({
    type: "git.history",
    arguments: { limit: 1 },
  });
  assert.equal(activeHistory.ok, true, JSON.stringify(activeHistory));
  assert.equal(activeHistory.result.head, checked.head);
  assert.deepEqual(await action({ type: "stage", paths: [mutable] }), {
    ok: false,
    error: "Finish or abort the active Git operation first.",
  });
  assert.equal(
    (await workerStatus()).files.find((file) => file.path === mutable).staged,
    false,
  );
  await store.put(
    scope,
    managedOperationRecord({
      existing: active,
      scope,
      state: { ...active, state: "completed" },
    }),
  );
  const staged = await action({ type: "stage", paths: [mutable] });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(
    p.gitActionResultSchema
      .parse(staged.result)
      .status.files.find((file) => file.path === mutable).staged,
    true,
  );
  const unstaged = await action({ type: "unstage", paths: [mutable] });
  assert.equal(unstaged.ok, true, JSON.stringify(unstaged));
  assert.equal(
    unstaged.result.status.files.find((file) => file.path === mutable).staged,
    false,
  );
  assert.equal((await action({ type: "stage", paths: [mutable] })).ok, true);
  const committed = await action({
    type: "commit",
    message: "Native encrypted action",
    all: false,
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.notEqual(committed.result.status.head, checked.head);
  const revision = committed.result.status.head;
  const queries = [
    ["git.history", { limit: 1, options: { filters: { message: "Native" } } }],
    ["git.file.history", { path: mutable, revision }],
    ["git.file.blame", { path: mutable, revision, limit: 2 }],
    ["git.commit.search", { query: { message: "Native" } }],
    ["git.commit.get", { revision }],
    ["git.commit.signature.get", { revision }],
    ["git.refs.list", {}],
    ["git.compare", { left: checked.head, right: revision, mode: "direct" }],
    [
      "git.revision.diff",
      { revision, baseRevision: checked.head, path: mutable },
    ],
  ];
  for (const [type, arguments_] of queries) {
    const outcome = await operation({ type, arguments: arguments_ });
    const expected = await handleGitCommand(
      p.workerCommandSchema.parse({ ...arguments_, type, cwd: checkout }),
    );
    assert.deepEqual(outcome, { ok: true, result: expected }, type);
  }
  const wrongHistory = await operation(
    { type: "git.history", arguments: {} },
    { access: "write" },
    502,
  );
  assert.equal(
    wrongHistory.error,
    "Repository operation access metadata is invalid.",
  );
  assert.equal(
    committed.result.status.files.find((file) => file.path === "untouched.txt")
      .staged,
    false,
  );
  await writeFile(path.join(checkout, mutable), "discard this\n");
  await writeFile(path.join(checkout, literal), "remove literal\n");
  await writeFile(path.join(checkout, sibling), "keep sibling\n");
  const discarded = await action({
    type: "discard",
    paths: [mutable, literal],
  });
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  assert.equal(await readFile(path.join(checkout, mutable), "utf8"), "first\n");
  assert.equal(
    await readFile(path.join(checkout, sibling), "utf8"),
    "keep sibling\n",
  );
  await assert.rejects(readFile(path.join(checkout, literal)), {
    code: "ENOENT",
  });
  await rm(path.join(checkout, sibling));
  const branch = await action({
    type: "createBranch",
    name: "native-encrypted",
  });
  assert.equal(branch.ok, true, JSON.stringify(branch));
  assert.equal(branch.result.status.branch, "native-encrypted");
  const switched = await action({ type: "checkout", branch: "main" });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(switched.result.status.branch, "main");
  assert.deepEqual(await action({ type: "push" }), {
    ok: false,
    error: "This repository has no Git remote.",
  });
  const directory = path.join(workerDirectory, "repository-operations");
  await mkdir(directory, { recursive: true });
  const key = createHash("sha256")
    .update(
      JSON.stringify([serverId, ownerId, workerId, projectId, worktreeId]),
    )
    .digest("hex");
  const journal = path.join(directory, key + ".json");
  await writeFile(journal, "{malformed-owned-fixture");
  const invalid = await operation({ type: "git.status", arguments: {} });
  assert.deepEqual(invalid, {
    ok: false,
    error: "Stored repository operation is invalid.",
  });
  assert.equal(await readFile(journal, "utf8"), "{malformed-owned-fixture");
  assert.deepEqual(
    await operation({ type: "git.history", arguments: {} }),
    invalid,
    "history preserves the existing journal validation path",
  );
  return async () => {
    const reopened = await operation({ type: "git.status", arguments: {} });
    assert.deepEqual(
      reopened,
      invalid,
      "restart preserves an invalid journal rather than resetting it",
    );
    await store.put(scope, active);
    const before = await readFile(journal, "utf8");
    await restartWorker();
    assert.equal(
      await readFile(journal, "utf8"),
      before,
      "legacy active record survives native restart byte-for-byte",
    );
    assert.deepEqual(await action({ type: "stageAll" }), {
      ok: false,
      error: "Finish or abort the active Git operation first.",
    });
    assert.equal(
      (await workerStatus()).files.find((file) => file.path === "untouched.txt")
        .staged,
      false,
    );
    // Resume actual Node-created state after native journal refresh/restart.
    const git = (...args) =>
      execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const file = "native-managed.txt";
    async function commit(text, message) {
      await writeFile(path.join(checkout, file), text);
      git("add", file);
      git("commit", "--quiet", "-m", message);
      return git("rev-parse", "HEAD");
    }
    const managedBase = await commit("base\n", "Managed base");
    git("checkout", "--quiet", "-b", "native-managed-feature");
    const feature = await commit("feature\n", "Managed feature");
    git("checkout", "--quiet", "main");
    const main = await commit("main\n", "Managed main");
    assert.throws(() => git("merge", "--no-ff", "native-managed-feature"));
    const context = p.gitManagedOperationContextSchema.parse({
      type: "merge",
      originalHead: main,
      sourceRef: "native-managed-feature",
      sourceRevision: feature,
      targetRef: "refs/heads/main",
      targetRevision: main,
      pendingCommits: [feature],
      totalSteps: 1,
      checkpointRef: null,
    });
    const legacy = managedOperationRecord({
      scope,
      state: await inspectGitManagedOperation(checkout, context),
    });
    await store.put(scope, legacy);
    const current = await operation({
      type: "git.operation.current",
      arguments: {},
    });
    assert.equal(current.ok, true, JSON.stringify(current));
    assert.equal(current.result.operation.state, "conflicted");
    assert.equal(current.result.operation.id, legacy.id);
    assert.equal(current.result.operation.createdAt, legacy.createdAt);
    assert.deepEqual(
      await store.get(scope),
      current.result.operation,
      "Node reopens native journal writes",
    );
    if (process.platform !== "win32")
      assert.equal((await stat(journal)).mode & 0o777, 0o600);
    assert.deepEqual(
      await operation({
        type: "git.operation.control",
        arguments: { operationId: crypto.randomUUID(), action: "abort" },
      }),
      { ok: false, error: "Git operation not found." },
    );
    assert.equal(git("rev-parse", "--verify", "MERGE_HEAD"), feature);
    await restartWorker();
    const aborted = await operation({
      type: "git.operation.control",
      arguments: {
        operationId: legacy.id,
        action: "abort",
        context: { ...context, originalHead: feature },
      },
    });
    assert.equal(aborted.ok, true, JSON.stringify(aborted));
    assert.equal(aborted.result.operation.state, "aborted");
    assert.equal(
      git("rev-parse", "HEAD"),
      main,
      "control takes its context from the scoped journal",
    );
    assert.equal(aborted.result.operation.id, legacy.id);
    const completedBytes = await readFile(journal, "utf8");
    assert.deepEqual(
      await operation({ type: "git.operation.current", arguments: {} }),
      aborted,
    );
    assert.equal(
      await readFile(journal, "utf8"),
      completedBytes,
      "terminal records are not refreshed",
    );
    // Native previews and starts preserve the terminal legacy record until an
    // accepted start publishes its new identity. No Node is in the worker PATH.
    git(
      "stash",
      "push",
      "--include-untracked",
      "--message",
      "Owned smoke sentinel",
    );
    const mergeAction = { type: "merge", sourceRef: "native-managed-feature" };
    const mergePlan = await operation({
      type: "git.operation.preview",
      arguments: { action: mergeAction },
    });
    assert.equal(mergePlan.ok, true, JSON.stringify(mergePlan));
    assert.equal(mergePlan.result.wouldConflict, true);
    assert.equal(
      await readFile(journal, "utf8"),
      completedBytes,
      "preview does not publish a journal",
    );
    assert.deepEqual(
      await operation({
        type: "git.operation.start",
        arguments: { action: mergeAction, token: "0".repeat(64) },
      }),
      {
        ok: false,
        error:
          "The worktree or selected revisions changed after this preview. Review the operation again.",
      },
    );
    assert.equal(
      await readFile(journal, "utf8"),
      completedBytes,
      "rejected start does not replace the record",
    );
    const newMerge = await operation({
      type: "git.operation.start",
      arguments: {
        action: mergePlan.result.action,
        token: mergePlan.result.token,
      },
    });
    assert.equal(newMerge.ok, true, JSON.stringify(newMerge));
    assert.equal(newMerge.result.operation.state, "conflicted");
    assert.notEqual(newMerge.result.operation.id, legacy.id);
    assert.deepEqual(
      await operation({
        type: "git.operation.preview",
        arguments: { action: mergeAction },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    await restartWorker();
    const conflictList = await operation({
      type: "git.conflicts.list",
      arguments: {},
    });
    assert.equal(conflictList.ok, true, JSON.stringify(conflictList));
    assert.deepEqual(
      conflictList.result.files.map((item) => item.path),
      [file],
    );
    const conflictDetail = await operation({
      type: "git.conflicts.get",
      arguments: { path: file },
    });
    assert.equal(conflictDetail.ok, true, JSON.stringify(conflictDetail));
    assert.equal(conflictDetail.result.ours.content, "main\n");
    assert.equal(conflictDetail.result.theirs.content, "feature\n");
    const request = {
      path: file,
      strategy: "manual",
      content: "Native resolved conflict 🧙\n",
    };
    const resolutionPlan = await operation({
      type: "git.conflicts.preview",
      arguments: { request },
    });
    assert.equal(resolutionPlan.ok, true, JSON.stringify(resolutionPlan));
    const sourcePlan = await handleGitCommand(
      p.workerCommandSchema.parse({
        type: "git.conflicts.preview",
        cwd: checkout,
        request,
      }),
    );
    assert.deepEqual(
      resolutionPlan.result,
      sourcePlan,
      "exact Node/native conflict token",
    );
    const beforeResolve = await readFile(journal, "utf8");
    assert.deepEqual(
      await operation({
        type: "git.conflicts.apply",
        arguments: { request, token: "0".repeat(64) },
      }),
      {
        ok: false,
        error:
          "The conflict or result changed after this preview. Review it again.",
      },
    );
    assert.equal(await readFile(journal, "utf8"), beforeResolve);
    await restartWorker();
    const resolution = await operation({
      type: "git.conflicts.apply",
      arguments: { request, token: sourcePlan.token },
    });
    assert.equal(resolution.ok, true, JSON.stringify(resolution));
    assert.equal(resolution.result.resolved, true);
    assert.deepEqual(resolution.result.remainingPaths, []);
    assert.equal(
      await readFile(path.join(checkout, file), "utf8"),
      request.content,
    );
    const stagedRecord = await store.get(scope);
    assert.equal(stagedRecord.id, newMerge.result.operation.id);
    assert.equal(stagedRecord.createdAt, newMerge.result.operation.createdAt);
    assert.equal(stagedRecord.state, "awaiting-user-action");
    assert.deepEqual(stagedRecord.conflictedPaths, []);
    await restartWorker();
    const continued = await operation({
      type: "git.operation.control",
      arguments: {
        operationId: newMerge.result.operation.id,
        action: "continue",
      },
    });
    assert.equal(continued.ok, true, JSON.stringify(continued));
    assert.equal(
      continued.result.operation.state,
      "completed",
      JSON.stringify(continued),
    );
    assert.notEqual(git("rev-parse", "HEAD"), main);
    assert.equal(git("show", `HEAD:${file}`), request.content.trim());
    const upstream = git("rev-parse", "HEAD");
    const edits = [];
    for (const name of ["A", "B"]) {
      const name_ = `native-rebase-${name}.txt`;
      await writeFile(path.join(checkout, name_), `${name}\n`);
      git("add", name_);
      git("commit", "--quiet", "-m", `Rebase ${name}`);
      edits.push(git("rev-parse", "HEAD"));
    }
    const rebaseAction = {
      type: "interactiveRebase",
      upstreamRef: upstream,
      todo: [
        { action: "edit", revision: edits[0], message: null },
        {
          action: "reword",
          revision: edits[1],
          message: "Native queued reword 🧙",
        },
      ],
    };
    const planned = await previewGitManagedOperation(checkout, rebaseAction);
    const nativePlan = await operation({
      type: "git.operation.preview",
      arguments: { action: rebaseAction },
    });
    assert.deepEqual(
      nativePlan,
      { ok: true, result: planned },
      "Node and Rust agree on the reviewed token",
    );
    const started = await operation({
      type: "git.operation.start",
      arguments: { action: nativePlan.result.action, token: planned.token },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    const edit = started.result.operation;
    assert.equal(edit.pausedAction, "edit");
    assert.deepEqual(await store.get(scope), edit);
    await restartWorker();
    const amended = await operation({
      type: "git.operation.amend",
      arguments: { operationId: edit.id, message: "Native amended edit" },
    });
    assert.equal(amended.ok, true, JSON.stringify(amended));
    assert.equal(amended.result.operation.state, "completed");
    assert.equal(git("log", "-1", "--format=%s"), "Native queued reword 🧙");
    assert.deepEqual(await store.get(scope), amended.result.operation);
    const bisectPlan = await operation({
      type: "git.operation.preview",
      arguments: {
        action: {
          type: "bisect",
          goodRef: managedBase,
          badRef: git("rev-parse", "HEAD"),
        },
      },
    });
    assert.equal(bisectPlan.ok, true, JSON.stringify(bisectPlan));
    const bisected = await operation({
      type: "git.operation.start",
      arguments: {
        action: bisectPlan.result.action,
        token: bisectPlan.result.token,
      },
    });
    assert.equal(bisected.ok, true, JSON.stringify(bisected));
    const reset = await operation({
      type: "git.operation.control",
      arguments: { operationId: bisected.result.operation.id, action: "reset" },
    });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(reset.result.operation.state, "completed");
    git("stash", "pop");
    assert.equal(
      await readFile(path.join(checkout, "untouched.txt"), "utf8"),
      "private dirty content\n",
    );
    await verifyCommitActions({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    await verifyStashes({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    await verifyPartialPatches({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    await verifyBranches({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    await verifyRemotes({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    await verifyTags({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    await verifySubmodules({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    await verifyLfs({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    await verifyGraph({
      operation,
      checkout,
      restartWorker,
      store,
      scope,
      journal,
    });
    return {
      completedRuntimeChecks: [
        "commits",
        "stashes",
        "partial-patches",
        "branches",
        "remotes",
        "tags",
        "submodules",
        "lfs",
        "graphs",
      ],
    };
  };
}
