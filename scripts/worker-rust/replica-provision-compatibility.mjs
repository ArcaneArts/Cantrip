// Actual Node/native provisioning, over the same owned paths and repositories.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  cp,
  lstat,
  readlink,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GithubClient,
  parseGithubCloneProgress,
  summarizeGithubCloneFailure,
  githubCloneFailureDetails,
} from "../../cantrip_worker/src/github.ts";
import { workerEventSchema } from "../../packages/protocol/dist/index.js";
import { replicaProvisionFixture } from "./replica-provision-fixture.mjs";
const execute = promisify(execFile);
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary replica-provision-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-replica-provision-")),
);
const backup = await mkdtemp(path.join(tmpdir(), "cantrip-replica-backup-"));
const git = (await execute("/usr/bin/which", ["git"])).stdout.trim();
const fixture = await replicaProvisionFixture(root, git);
const saved = new Map(
  Object.keys(fixture.environment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, fixture.environment);
const worker = "replica-fixture-worker",
  project = randomUUID();
let directory = path.join(root, "worker"),
  id = 0,
  comparisons = 0,
  helperComparisons = 0;
const sourceClients = new Map();
const source = () => {
  const key = directory + "|" + worker;
  if (!sourceClients.has(key))
    sourceClients.set(key, new GithubClient(directory, worker));
  return sourceClients.get(key);
};
const child = spawn(path.resolve(values.binary), [], {
  cwd: root,
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const run = async (...args) =>
  (await execute(git, args, { env: process.env })).stdout.trim();
async function native(method, payload) {
  child.stdin.write(
    JSON.stringify({
      id: ++id,
      method,
      directory,
      workerId: worker,
      ...payload,
    }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  return reply.result;
}
async function node(command) {
  const progress = [];
  try {
    if (command.type === "project.replica.link.repair") {
      return {
        ok: true,
        value: await source().repairReplicaLink({
          projectId: command.projectId,
          nameWithOwner: command.repository.nameWithOwner,
          sourcePath: command.sourcePath,
          linkPath: command.linkPath,
          repositoryFingerprint: command.repositoryFingerprint,
        }),
        progress,
      };
    }
    const value = await source().provisionReplica(
      {
        jobId: command.jobId,
        attempt: command.attempt,
        projectId: command.projectId,
        nameWithOwner: command.repository?.nameWithOwner ?? null,
        placement: command.placement,
        workspaceStorage: command.workspaceStorage,
        expectedRevision: command.expectedRevision,
      },
      (event) => progress.push(event),
    );
    return { ok: true, value, progress };
  } catch (error) {
    return { ok: false, error: error.message, progress };
  }
}
function normalizedTime(text) {
  return text.replace(
    /"(?:createdAt|releasedAt)":"([^"\n]+)"/gu,
    (match, time) => {
      if (Math.abs(Date.now() - Date.parse(time)) >= 30000) return match;
      assert.match(time, /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
      return match.replace(time, "<current-time>");
    },
  );
}
async function state() {
  const entries = [],
    repositories = [];
  async function visit(relative) {
    const absolute = path.join(root, relative),
      metadata = await lstat(absolute);
    const mode = metadata.mode & 0o777;
    if (metadata.isSymbolicLink())
      entries.push({
        relative,
        kind: "link",
        target: await readlink(absolute),
      });
    else if (metadata.isDirectory()) {
      entries.push({ relative, kind: "directory", mode });
      for (const name of (await readdir(absolute)).sort()) {
        if (name === ".git") {
          repositories.push(absolute);
          try {
            const target = path.join(
              absolute,
              name,
              "cantrip-project-owner.json",
            );
            const owner = await lstat(target);
            entries.push({
              relative: path.join(relative, name, "cantrip-project-owner.json"),
              kind: "owner",
              mode: owner.mode & 0o777,
              bytes: await readFile(target, "utf8"),
            });
          } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
              throw error;
          }
        } else await visit(path.join(relative, name));
      }
    } else
      entries.push({
        relative,
        kind: "file",
        mode,
        bytes: normalizedTime((await readFile(absolute)).toString("base64")),
      });
  }
  for (const name of (await readdir(root)).sort()) {
    if (name !== "replica-fixture") await visit(name);
  }
  // Preserve registry JSON byte/key order while masking only fresh wall-clock values.
  for (const entry of entries)
    if (
      entry.kind === "file" &&
      path.basename(entry.relative) === "project-replica-placements.json"
    ) {
      entry.bytes = Buffer.from(
        normalizedTime(Buffer.from(entry.bytes, "base64").toString("utf8")),
      ).toString("base64");
    }
  const gitState = [];
  for (const repo of repositories) {
    const query = async (...args) => {
      try {
        return await run("-C", repo, ...args);
      } catch (error) {
        return { failed: true, stderr: error.stderr };
      }
    };
    gitState.push({
      path: path.relative(root, repo),
      head: await query("rev-parse", "--verify", "HEAD"),
      branch: await query("branch", "--show-current"),
      status: await query("status", "--porcelain=v1", "--untracked-files=all"),
      refs: await query(
        "for-each-ref",
        "--format=%(refname) %(objectname) %(symref)",
      ),
      origin: await query("config", "--get", "remote.origin.url"),
    });
  }
  return { entries, gitState };
}
async function copyContents(from, to) {
  for (const name of await readdir(to))
    await rm(path.join(to, name), { recursive: true, force: true });
  for (const name of await readdir(from))
    await cp(path.join(from, name), path.join(to, name), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
}
function normalizedProgress(result, command) {
  if (Array.isArray(result))
    return result.map((r, i) => normalizedProgress(r, command[i]));
  let materializing = false,
    percent = 30;
  const progress = [];
  for (const event of result.progress) {
    workerEventSchema.parse({
      type: "project.replica.progress",
      jobId: command.jobId,
      attempt: command.attempt,
      progress: event,
    });
    if (event.stage === "materializing") {
      assert.ok(event.percent >= percent && event.percent <= 88);
      percent = event.percent;
      if (materializing) continue;
      materializing = true;
      assert.equal(event.percent, 30);
    }
    progress.push(event);
  }
  return { ...result, progress };
}
async function compare(
  command,
  { status = "ready", ok = true, batch = false } = {},
) {
  await writeFile(fixture.trace, "");
  await copyContents(root, backup);
  const expected = batch
    ? await Promise.all(command.map(node))
    : await node(command);
  const expectedTrace = await readFile(fixture.trace),
    expectedState = await state();
  await copyContents(backup, root);
  const actual = await native(
    batch ? "batch" : "command",
    batch ? { commands: command } : { command },
  );
  const actualTrace = await readFile(fixture.trace),
    actualState = await state();
  const label = "provision " + comparisons;
  assert.deepEqual(
    normalizedProgress(actual, command),
    normalizedProgress(expected, command),
    label,
  );
  assert.deepEqual(
    actualTrace,
    expectedTrace,
    "exact gh/Git arguments/order " + label,
  );
  assert.deepEqual(
    actualState,
    expectedState,
    "files, ownership records, modes and Git state " + label,
  );
  if (!batch) {
    assert.equal(actual.ok, ok, label);
    if (ok)
      assert.equal(
        actual.value.status,
        status,
        label + " " + JSON.stringify(actual),
      );
  }
  comparisons++;
  return actual;
}
const command = (overrides = {}) => ({
  type: "project.replica.provision",
  jobId: randomUUID(),
  attempt: 1,
  projectId: project,
  repository: { nameWithOwner: "fixture/repository" },
  workspaceStorage: { kind: "system" },
  expectedRevision: null,
  ...overrides,
});
const direct = (target, overrides = {}) =>
  command({ placement: { mode: "direct", path: target }, ...overrides });
const managedTarget = () =>
  path.join(directory, "repositories", "fixture", "repository");
async function checkout(target) {
  await mkdir(path.dirname(target), { recursive: true });
  await run("clone", fixture.remote, target);
  await run(
    "-C",
    target,
    "remote",
    "set-url",
    "origin",
    "https://github.com/fixture/repository.git",
  );
}
try {
  for (const output of [
    "",
    "Receiving objects: 50%",
    "receiving OBJECTS:\t99%",
    "Receiving objects: 101%\rResolving deltas: 75%\nUpdating files: 25%",
    "Updating files: 100%\nReceiving objects: 0%",
    "Receiving objects: -2%",
    "Receiving objects: " + "9".repeat(400) + "%",
    "notice\nfatal: failed\nerror: gone\nchatter",
    Array.from({ length: 25 }, (_, i) => "line " + i).join("\r\n"),
    Array.from({ length: 12 }, (_, i) => "fatal: line " + i).join("\n"),
    "fatal: " + "x".repeat(4000) + "\ud800",
    "filename too long",
    "File name or extension is too long",
    "path is too long",
    "unrelated long line",
    "\u00a0fatal: trimmed\u00a0",
  ])
    for (const windows of [false, true]) {
      const expected = {
        progress: parseGithubCloneProgress(output),
        summary: summarizeGithubCloneFailure(output),
        failure: githubCloneFailureDetails(
          output,
          windows ? "win32" : "darwin",
        ),
      };
      assert.deepEqual(await native("helpers", { output, windows }), expected);
      helperComparisons++;
    }
  await compare(command({ repository: null }), { status: "blocked" });
  await compare(direct(path.join(root, "missing"), { repository: null }), {
    status: "blocked",
  });
  await compare(
    direct(path.join(root, "missing"), {
      repository: null,
      expectedRevision: fixture.revision,
    }),
    { status: "blocked" },
  );
  await compare(direct("relative"), { status: "blocked" });
  await writeFile(path.join(root, "occupied"), "preserve this");
  await compare(direct(path.join(root, "occupied")), { status: "blocked" });
  const existing = path.join(root, "existing 😀");
  await checkout(existing);
  const local = direct(existing, {
    repository: null,
    expectedRevision: fixture.revision,
  });
  await writeFile(path.join(existing, "user.txt"), "user content\n");
  assert.equal(
    (await compare(local)).value.placement.materialization,
    "attached",
  );
  await compare(local);
  await compare({ ...local, projectId: randomUUID() }, { status: "blocked" });
  await compare(
    { ...local, expectedRevision: "f".repeat(40) },
    { status: "blocked" },
  );
  await compare(
    { ...local, repository: { nameWithOwner: "fixture/other" } },
    { status: "blocked" },
  );
  await compare(
    { ...local, repository: { nameWithOwner: "fixture/repository" } },
    { status: "blocked" },
  );
  await compare(
    direct(path.join(existing, ".cantrip"), {
      repository: null,
      expectedRevision: fixture.revision,
    }),
    { status: "blocked" },
  );
  const secondary = path.join(root, "secondary");
  await run(
    "-C",
    existing,
    "worktree",
    "add",
    "--detach",
    secondary,
    fixture.revision,
  );
  await compare(
    direct(secondary, { repository: null, expectedRevision: fixture.revision }),
    { status: "blocked" },
  );
  await compare(command());
  await compare(command());
  await compare(command({ expectedRevision: "f".repeat(40) }), {
    status: "blocked",
  });
  await writeFile(
    path.join(managedTarget(), "README.md"),
    "preserve dirty managed content\n",
  );
  await compare(command(), { status: "blocked" });
  await run("-C", managedTarget(), "checkout", "--", "README.md");
  const cloned = direct(path.join(root, "cloned 😀"));
  assert.equal((await compare(cloned)).value.placement.ownership, "cantrip");
  assert.equal(
    (await compare(cloned)).value.placement.materialization,
    "reused",
  );
  const link = command({
    projectId: randomUUID(),
    placement: {
      mode: "managed-link",
      path: path.join(root, "external", "repository-link"),
    },
  });
  const linked = (await compare(link)).value;
  await compare(link);
  const repair = {
    type: "project.replica.link.repair",
    projectId: link.projectId,
    repository: link.repository,
    sourcePath: linked.path,
    linkPath: linked.placement.linkPath,
    repositoryFingerprint: linked.repositoryFingerprint,
  };
  await rm(repair.linkPath);
  assert.equal((await compare(repair)).value.repaired, true);
  assert.equal((await compare(repair)).value.repaired, false);
  await compare(
    { ...repair, repositoryFingerprint: "f".repeat(64) },
    { status: "blocked" },
  );
  await compare({ ...repair, projectId: randomUUID() }, { status: "blocked" });
  await compare({ ...repair, sourcePath: existing }, { status: "blocked" });
  await compare({ ...repair, sourcePath: "relative" }, { ok: false });
  await rm(repair.linkPath);
  await writeFile(repair.linkPath, "preserve replaced link");
  await compare(repair, { status: "blocked" });
  await rm(repair.linkPath);
  await compare(repair);
  const managedWorkspace = command({
    projectId: randomUUID(),
    workspaceStorage: { kind: "managed", workspaceId: randomUUID() },
    placement: {
      mode: "managed-link",
      path: path.join(root, "external", "workspace-link"),
    },
  });
  const workspace = (await compare(managedWorkspace)).value;
  await rm(workspace.placement.linkPath);
  await compare({
    ...repair,
    projectId: managedWorkspace.projectId,
    sourcePath: workspace.path,
    linkPath: workspace.placement.linkPath,
    repositoryFingerprint: workspace.repositoryFingerprint,
  });
  const invalidWorkspace = path.join(
    directory,
    "workspaces",
    "not-a-uuid",
    "repositories",
    "fixture",
    "repository",
  );
  await checkout(invalidWorkspace);
  await compare(
    { ...repair, sourcePath: invalidWorkspace },
    { status: "blocked" },
  );
  directory = path.join(root, "worker-pinned");
  const pinned = direct(path.join(root, "pinned-checkout"), {
    expectedRevision: fixture.revision,
  });
  assert.equal((await compare(pinned)).value.branch, null);
  await compare(pinned);
  directory = path.join(root, "worker-missing-revision");
  await compare(command({ expectedRevision: "f".repeat(40) }), {
    status: "blocked",
  });
  await compare(
    direct(path.join(root, "direct-missing-revision"), {
      expectedRevision: "f".repeat(40),
    }),
    { status: "blocked" },
  );
  await writeFile(fixture.behavior, "fail");
  directory = path.join(root, "worker-failure");
  await compare(command(), { status: "blocked" });
  await compare(direct(path.join(root, "direct-failed")), {
    status: "blocked",
  });
  await writeFile(fixture.behavior, "normal");
  const occupiedStage = direct(path.join(root, "unowned-clone"));
  const staging =
    occupiedStage.placement.path + ".cantrip-provision-" + occupiedStage.jobId;
  await mkdir(staging);
  await writeFile(path.join(staging, "user.txt"), "keep unowned staging");
  await compare(occupiedStage, { status: "blocked" });
  directory = path.join(root, "worker-empty");
  await compare(command({ repository: { nameWithOwner: "fixture/empty" } }));
  directory = path.join(root, "worker-unborn");
  await mkdir(managedTarget(), { recursive: true });
  await run("init", "--initial-branch=unborn", managedTarget());
  await run(
    "-C",
    managedTarget(),
    "remote",
    "add",
    "origin",
    "https://github.com/fixture/repository.git",
  );
  await compare(command());
  directory = path.join(root, "worker-queue");
  await writeFile(fixture.behavior, "slow");
  const queued = await compare([command(), command()], { batch: true });
  assert.equal(queued[0].value.reused, false);
  assert.equal(queued[1].value.reused, true);
  await writeFile(fixture.behavior, "normal");
  const afterRejection = await compare(
    [{ ...local, expectedRevision: "f".repeat(40) }, local],
    { batch: true },
  );
  assert.equal(afterRejection[0].value.status, "blocked");
  assert.equal(afterRejection[1].value.status, "ready");
  // Policy contents are read from a regular bounded file; local dirty checkouts
  // remain attachable, so these are actual production policy reads.
  for (const policy of [
    "invalid",
    JSON.stringify({ worktreePolicy: "unknown" }),
    "x".repeat(65537),
  ]) {
    await writeFile(path.join(existing, ".cantrip/project.json"), policy);
    assert.equal((await compare(local)).value.worktreePolicy, null);
  }
  console.log(
    JSON.stringify({
      suite: "native-replica-provision",
      comparisons,
      helperComparisons,
      actualNodeAndNative: true,
      actualOwnedGitRepositories: true,
      exactCliArgumentsAndOrder: true,
      samePathsAndFingerprints: true,
      exactPrivateStateAndFilesystemModes: true,
      gitRefsStatusAndBranches: true,
      allPlacementModes: true,
      stagingCleanupAndUserPreservation: true,
      sameTargetSerializationAndRejectedQueueRecovery: true,
      sourceCompatibleProgress: true,
      boundedPolicyRead: true,
      managedLinkRepairAndWorkspaceContainment: true,
      exactRevisionDetach: true,
      nodeAbsentFromNativePath: true,
    }),
  );
} finally {
  child.stdin.end();
  assert.equal(await completion, 0);
  for (const [key, value] of saved)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  await rm(root, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
}
