// Actual Node/native watcher, HEAD and managed-operation observations in owned Git.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  WorktreeManager,
  buildGitOperationObservation,
  worktreeWatchEventTouchesFiles,
} from "../../tests/reference-node-worker/src/worktrees.ts";
import {
  WorktreeFileActivity,
  activityPath,
  boundedFileChanges,
  commitFileChanges,
} from "../../tests/reference-node-worker/src/worktree-file-activity.ts";
import { serverWorkerNotification } from "../../tests/reference-node-worker/src/worker-notification-privacy.ts";
import { handleWorktreeCommand } from "../../tests/reference-node-worker/src/commands/worktree.ts";
import {
  previewGitManagedOperation,
  startGitManagedOperation,
  controlGitManagedOperation,
} from "../../tests/reference-node-worker/src/git.ts";
import * as protocol from "../../packages/protocol/dist/index.js";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary observations-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-observations-")),
);
const tree = path.join(root, "checkout"),
  data = path.join(root, "data");
const original = { ...process.env };
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
});
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
let stderr = "",
  buffer = "",
  sequence = 0,
  comparisons = 0,
  accept = true;
const pending = new Map(),
  nativeEvents = [],
  nodeEvents = [];
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-16000);
});
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const value = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (value.kind === "notification") nativeEvents.push(value);
    else {
      const finish = pending.get(value.id);
      assert.ok(finish);
      pending.delete(value.id);
      finish(value);
    }
  }
});
async function native(input) {
  const id = ++sequence;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ ...input, id }) + "\n");
  const response = await promise;
  assert.equal(response.ok, true, JSON.stringify(response) + stderr);
  return response.result;
}
const git = (...args) =>
  execFileSync("git", ["-C", tree, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function compare(actual, expected, label) {
  try {
    assert.deepEqual(actual, expected, label);
  } catch (error) {
    if (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      JSON.stringify(expected).length > 12000
    ) {
      const brief = (values) =>
        values.map((value) => ({
          kind: value.kind,
          length: value.path?.length,
          start: value.path?.slice(0, 16),
          end: value.path?.slice(-16),
        }));
      throw new Error(
        label +
          JSON.stringify({ actual: brief(actual), expected: brief(expected) }),
      );
    }
    throw error;
  }
  comparisons++;
}
async function until(visit, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = visit();
    if (result) return result;
    await delay(50);
  }
  throw new Error(
    "Timed out: " +
      label +
      "\n" +
      JSON.stringify({ nodeEvents, nativeEvents, stderr }),
  );
}
const manager = new WorktreeManager(data);
manager.setObservationEmitter((notification) => {
  nodeEvents.push({ notification, accepted: accept });
  return accept;
});
function latest(events, type, predicate = () => true) {
  return events.findLast(
    (event) =>
      event.notification.type === type && predicate(event.notification, event),
  );
}
function withoutTime(notification) {
  const { observedAt, ...result } = notification;
  return result;
}
const target = {
  projectId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f3",
  worktreeId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f4",
  sourcePath: tree,
  worktreePath: tree,
};
try {
  await mkdir(tree);
  git("init", "-b", "main", "--quiet");
  git("config", "user.name", "Observation Fixture");
  git("config", "user.email", "observation@invalid.test");
  await mkdir(path.join(tree, "src"));
  await writeFile(path.join(tree, "src", "tracked"), "initial\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Initial");
  for (const value of [
    "",
    ".",
    "./",
    ".//tracked",
    "./src/file/",
    "src\\file",
    "../escape",
    "/absolute",
    "c:relative",
    ".git",
    "src/.git/config",
    "a/../b",
    "\ud800",
    "a".repeat(8193),
  ]) {
    compare(
      await native({ op: "path", value }),
      activityPath(value),
      "activity path " + JSON.stringify(value),
    );
    compare(
      await native({ op: "touches", value }),
      worktreeWatchEventTouchesFiles(value),
      "watch event " + JSON.stringify(value),
    );
  }
  compare(
    await native({ op: "touches", value: null }),
    worktreeWatchEventTouchesFiles(null),
    "unknown filename",
  );
  for (const changes of [
    [
      { path: "./same", kind: "modified" },
      { path: "same", kind: "added" },
      { path: "same", kind: "deleted" },
      { path: "../escape", kind: "added" },
    ],
    Array.from({ length: 2001 }, (_, i) => ({
      path: "file-" + i,
      kind: "modified",
    })),
    Array.from({ length: 40 }, (_, i) => ({
      path: i + "-" + "🧪".repeat(3900),
      kind: "added",
    })),
  ])
    compare(
      await native({ op: "bounded", changes }),
      boundedFileChanges(changes),
      "bounded raw paths and UTF-8 byte budget",
    );
  const output = "A\0space name\0D\0line\nname\0M\0src/file\0R100\0old\0";
  compare(
    await native({ op: "commits", output }),
    commitFileChanges(output),
    "NUL commit paths",
  );
  const activity = new WorktreeFileActivity(tree, async (args) =>
    execFileSync("git", ["-C", tree, ...args], { encoding: "utf8" }),
  );
  await activity.initialize();
  await native({ op: "activity-open", root: tree });
  await writeFile(path.join(tree, "src", "tracked"), "saved\n");
  await writeFile(path.join(tree, "src", "new"), "new\n");
  const paths = [
    "src",
    "src/tracked",
    "src/new",
    "src/new",
    ".git/config",
    "temporary",
    ".//src/tracked",
  ];
  for (const filename of paths) activity.record(filename);
  compare(
    await native({ op: "activity-flush", paths }),
    await activity.flush(),
    "actual saves and directory suppression",
  );
  await rm(path.join(tree, "src", "new"));
  activity.record("src/new");
  compare(
    await native({ op: "activity-flush", paths: ["src/new"] }),
    await activity.flush(),
    "deleted and transient paths",
  );
  const first = git("rev-parse", "HEAD");
  compare(
    await native({ op: "activity-head", head: first }),
    await activity.observeHead(first),
    "initial head",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "Saved");
  const second = git("rev-parse", "HEAD");
  compare(
    await native({ op: "activity-head", head: second }),
    await activity.observeHead(second),
    "actual HEAD diff",
  );
  const notification = {
    type: "worktree.filesystem.changed",
    ...target,
    changes: [{ path: "private-name", kind: "added" }],
  };
  compare(
    await native({ op: "server", notification }),
    serverWorkerNotification(notification),
    "server strips file changes",
  );
  await native({ op: "open", directory: data });
  manager.configureObservation([target]);
  await native({ op: "configure", targets: [target] });
  for (const type of [
    "worktree.inventory.observed",
    "worktree.status.observed",
  ]) {
    const expected = await until(
      () => latest(nodeEvents, type),
      "Node initial " + type,
    );
    const actual = await until(
      () => latest(nativeEvents, type),
      "native initial " + type,
    );
    compare(actual.notification, expected.notification, "initial " + type);
  }
  await delay(1800);
  nodeEvents.length = 0;
  nativeEvents.length = 0;
  manager.configureObservation([target]);
  await native({ op: "configure", targets: [target] });
  await delay(400);
  compare(
    nativeEvents.length,
    nodeEvents.length,
    "identical config suppresses unchanged publication",
  );
  await writeFile(path.join(tree, "watched"), "external\n");
  for (const events of [nodeEvents, nativeEvents])
    await until(
      () =>
        latest(events, "worktree.filesystem.changed", (n) =>
          n.changes?.some((c) => c.path === "watched" && c.kind === "added"),
        ),
      "recursive watcher file creation",
    );
  for (const events of [nodeEvents, nativeEvents])
    await until(
      () =>
        latest(events, "worktree.status.observed", (n) =>
          n.result.status.files.some((f) => f.path === "watched"),
        ),
      "watcher status",
    );
  compare(
    latest(nativeEvents, "worktree.status.observed").notification,
    latest(nodeEvents, "worktree.status.observed").notification,
    "actual watched Git status",
  );
  nodeEvents.length = 0;
  nativeEvents.length = 0;
  git("add", "watched");
  git("commit", "--quiet", "-m", "Observed commit");
  const committed = git("rev-parse", "HEAD");
  for (const events of [nodeEvents, nativeEvents]) {
    await until(
      () =>
        latest(
          events,
          "worktree.status.observed",
          (n) => n.result.status.head === committed,
        ),
      "metadata HEAD reconciliation",
    );
    await until(
      () =>
        latest(events, "worktree.filesystem.changed", (n) =>
          n.changes?.some((c) => c.path === "watched" && c.kind === "added"),
        ),
      "commit-derived file changes",
    );
  }
  compare(
    latest(nativeEvents, "worktree.status.observed").notification,
    latest(nodeEvents, "worktree.status.observed").notification,
    "committed status",
  );
  git("switch", "-c", "feature");
  await writeFile(path.join(tree, "src", "tracked"), "feature\n");
  git("commit", "--quiet", "-am", "Feature");
  git("switch", "main");
  await writeFile(path.join(tree, "src", "tracked"), "main\n");
  git("commit", "--quiet", "-am", "Main");
  git("switch", "feature");
  const preview = await previewGitManagedOperation(tree, {
    type: "rebase",
    sourceRef: "main",
  });
  const conflicted = await startGitManagedOperation(
    tree,
    preview.action,
    preview.token,
  );
  assert.equal(conflicted.state, "conflicted");
  const observed = {
    ...target,
    operation: {
      id: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
      context: preview.context,
    },
  };
  const synthetic = {
    conflicts: {
      files: Array.from({ length: 80 }, (_, i) => ({
        path: "🧪".repeat(1200) + i,
        code: "UU",
        kind: "both-modified",
        baseAvailable: true,
        oursAvailable: true,
        theirsAvailable: true,
      })),
      truncated: false,
    },
    observedAt: "2026-11-17T00:00:00.000Z",
    state: conflicted,
    target: observed,
  };
  compare(
    await native({ op: "operation", ...synthetic }),
    buildGitOperationObservation(synthetic),
    "operation compact state, conflict byte budget and exact digest",
  );
  nodeEvents.length = 0;
  nativeEvents.length = 0;
  accept = false;
  await native({ op: "accept", value: false });
  manager.configureObservation([observed]);
  await native({ op: "configure", targets: [observed] });
  for (const events of [nodeEvents, nativeEvents])
    await until(
      () =>
        events.filter((e) => e.notification.type === "git.operation.observed")
          .length >= 2,
      "rejected publication retries",
    );
  compare(
    withoutTime(latest(nativeEvents, "git.operation.observed").notification),
    withoutTime(latest(nodeEvents, "git.operation.observed").notification),
    "actual conflicted operation and fingerprint",
  );
  accept = true;
  await native({ op: "accept", value: true });
  for (const events of [nodeEvents, nativeEvents])
    await until(
      () =>
        latest(events, "git.operation.observed", (_, event) => event.accepted),
      "accepted operation retry",
    );
  await controlGitManagedOperation(tree, preview.context, "abort");
  manager.configureObservation([observed]);
  await native({ op: "configure", targets: [observed] });
  for (const events of [nodeEvents, nativeEvents])
    await until(
      () =>
        latest(
          events,
          "git.operation.observed",
          (n) => n.state.state === "aborted",
        ),
      "aborted operation transition",
    );
  compare(
    withoutTime(latest(nativeEvents, "git.operation.observed").notification),
    withoutTime(latest(nodeEvents, "git.operation.observed").notification),
    "operation abort transition",
  );
  const alias = path.join(root, "alias");
  await symlink(tree, alias, "dir");
  const command = protocol.workerCommandSchema.parse({
    type: "worktree.observation.configure",
    targets: [
      {
        ...target,
        sourcePath: new URL("file://" + alias).href,
        worktreePath: alias,
      },
    ],
    codegraphTargets: [],
  });
  const expected = await handleWorktreeCommand(command, {
    worktrees: { configureObservation() {} },
    codegraphObservations: {
      async configure() {
        throw new Error("Controlled unavailable CodeGraph");
      },
    },
  });
  const actual = await native({ op: "routed", command, directory: data });
  // The same opaque-path tokens are reused when source/worktree identify one path.
  assert.equal(actual.accepted, true);
  assert.equal(actual.paths.length, expected.paths.length);
  assert.equal(actual.paths[0].sourcePath, actual.paths[0].worktreePath);
  assert.match(actual.paths[0].sourcePath, /^ctrr_/);
  comparisons++;
  manager.configureObservation([]);
  await native({ op: "configure", targets: [] });
  await delay(1500);
  nodeEvents.length = 0;
  nativeEvents.length = 0;
  await writeFile(path.join(tree, "after-unconfigure"), "quiet\n");
  await delay(2200);
  compare(
    nativeEvents,
    nodeEvents,
    "removed targets retire watchers and publications",
  );
  manager.close();
  await native({ op: "close" });
  manager.configureObservation([target]);
  await native({ op: "configure", targets: [target] });
  await delay(600);
  compare(nativeEvents, nodeEvents, "late config after close stays stopped");
  child.stdin.end();
  assert.equal(await completion, 0, stderr);
  console.log(
    JSON.stringify({
      suite: "node-native-worktree-observations",
      passed: true,
      comparisons,
      recursiveWatchers: true,
      metadataHeadUpdates: true,
      operationConflictAndAbort: true,
      rejectedDeliveryRetries: true,
      opaqueCanonicalPaths: true,
      unconfigureAndClose: true,
    }),
  );
} finally {
  manager.close();
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
