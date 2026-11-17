// Current Node behavior vs native workspace/routing implementation, using owned
// Git repositories and a controlled gh process boundary. No external API calls.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  chmod,
  rename,
  realpath,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as source from "../../cantrip_worker/src/workspace-repository-discovery.ts";
import { handleWorkspaceCommand } from "../../cantrip_worker/src/commands/workspace.ts";
import { WorkerRoutingRegistry } from "../../cantrip_worker/src/routing-registry.ts";
import { REPOSITORY_METADATA_FIELDS } from "../../packages/protocol/src/repository-operation.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-workspace-compatibility-")),
);
const bin = path.join(root, "bin"),
  tree = path.join(root, "tree"),
  outside = path.join(root, "outside");
const originalEnvironment = { ...process.env },
  git = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
await mkdir(bin);
await symlink(git, path.join(bin, "git"));
await mkdir(tree);
await mkdir(outside);
const gh = path.join(bin, "gh");
await writeFile(
  gh,
  `#!/bin/sh
case "$2" in
 repos/Owner/Good) printf '%s' '{"id":42,"full_name":"Owner/Good","html_url":"https://github.com/Owner/Good"}';;
 repos/Owner/Invalid) printf '%s' '[]';;
 repos/Owner/Wrong) printf '%s' '{"id":43,"full_name":"Owner/Other","html_url":"https://github.com/Owner/Other"}';;
 repos/Owner/Broken) printf '%s' '{';;
 *) exit 1;;
esac
`,
);
await chmod(gh, 0o700);
const nativeDirectory = path.join(root, "native"),
  nodeDirectory = path.join(root, "node");
await mkdir(nativeDirectory);
await mkdir(nodeDirectory);
const nodeRegistry = new WorkerRoutingRegistry(nodeDirectory);
const routing = await nodeRegistry.protectMetadata({
  rootPath: tree,
  displayPath: tree,
});
await copyFile(
  path.join(nodeDirectory, "repository-routing.json"),
  path.join(nativeDirectory, "repository-routing.json"),
);
const child = spawn(path.resolve(values.binary), [], {
  env: { ...originalEnvironment, PATH: bin },
  stdio: ["pipe", "pipe", "pipe"],
});
let partial = "",
  stderr = "",
  sequence = 0,
  comparisons = 0;
const pending = new Map();
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-16000);
});
child.stdout.on("data", (chunk) => {
  partial += chunk;
  let end;
  while ((end = partial.indexOf("\n")) >= 0) {
    const message = JSON.parse(partial.slice(0, end));
    partial = partial.slice(end + 1);
    const finish = pending.get(message.id);
    assert.ok(finish);
    pending.delete(message.id);
    finish(message.result);
  }
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => {
    for (const finish of pending.values())
      finish({
        ok: false,
        error: `fixture exited ${code}: ${stderr}`,
        code: null,
      });
    pending.clear();
    resolve(code);
  });
});
function rust(input) {
  return new Promise((resolve) => {
    const requestId = ++sequence;
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ ...input, requestId }) + "\n");
  });
}
async function native(input) {
  const result = await rust(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
async function observe(read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code ?? null };
  }
}
async function compare(input, read, label = input.op) {
  assert.deepEqual(await rust(input), await observe(read), label);
  comparisons++;
}
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
function command(args) {
  return execFileSync(git, args, {
    env: originalEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function init(directory) {
  await mkdir(directory, { recursive: true });
  command(["-c", "init.defaultBranch=main", "init", "--quiet", directory]);
}
async function discover(directory, limits = {}) {
  const progress = [];
  const result = await source.discoverWorkspaceRepositories(
    directory,
    limits,
    (value) => progress.push(value),
  );
  return { result, first: progress[0], last: progress.at(-1) };
}
let sample;
try {
  process.env.PATH = bin;
  await native({ op: "open-registry", directory: nativeDirectory });
  for (const origin of [
    " https://github.com/Owner/Good.git/ ",
    "git@github.com:Owner/Good.git",
    "ssh://git@github.com/Owner/Good.git/",
    "https://github.com/Owner/../",
    "https://github.com/-Owner/Repo",
    "https://github.com/Owner/Repo.GIT",
    "https://github.com/Kelvin/Repo.git",
    "https://gitlab.com/Owner/Repo",
    "https://github.com/Owner/Repo/extra",
    "https://github.com/Owner/.git",
  ]) {
    await compare({ op: "origin", origin }, () =>
      source.parseGithubRepositoryOrigin(origin),
    );
  }
  for (const origin of [
    null,
    "  ",
    "git@gitlab.com:Owner/Repo.git",
    "https://github.com/Owner/Good.git",
    "https://github.com/Owner/Invalid",
    "https://github.com/Owner/Wrong",
    "https://github.com/Owner/Broken",
    "https://github.com/Owner/Unavailable",
    "x".repeat(32769),
  ]) {
    await compare({ op: "classify", origin }, () =>
      source.classifyWorkspaceRepositoryOrigin(origin, {
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      }),
    );
  }
  await rename(gh, gh + ".disabled");
  await compare(
    { op: "classify", origin: "https://github.com/Owner/Good" },
    () =>
      source.classifyWorkspaceRepositoryOrigin(
        "https://github.com/Owner/Good",
        { maxBuffer: 1024 * 1024, timeout: 5000 },
      ),
  );
  await rename(gh + ".disabled", gh);
  await init(path.join(tree, "nested", "private-repository"));
  await init(path.join(tree, "Z-main"));
  await init(path.join(tree, "Z-main", "vendor", "hidden"));
  await init(path.join(tree, "éclair"));
  await init(path.join(tree, "Ωmega"));
  await init(path.join(outside, "outside-repository"));
  await symlink(outside, path.join(tree, "outside-link"), "dir");
  command([
    "-C",
    path.join(tree, "Z-main"),
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  command([
    "-C",
    path.join(tree, "Z-main"),
    "worktree",
    "add",
    "--quiet",
    "--detach",
    path.join(tree, "a-linked"),
    "HEAD",
  ]);
  command(["init", "--bare", "--quiet", path.join(tree, "bare")]);
  await mkdir(path.join(tree, "invalid-marker"));
  await writeFile(path.join(tree, "invalid-marker", ".git"), "invalid");
  await mkdir(path.join(tree, "symlink-marker"));
  await symlink(
    path.join(tree, "Z-main", ".git"),
    path.join(tree, "symlink-marker", ".git"),
    "dir",
  );
  command([
    "-C",
    path.join(tree, "éclair"),
    "remote",
    "add",
    "origin",
    "https://github.com/Owner/Good.git",
  ]);
  await writeFile(path.join(tree, "plain-file"), "untouched");
  for (const limits of [
    {},
    { maxDepth: 0 },
    { maxDepth: 1 },
    { maxEntries: 1 },
    { maxDirectories: 2 },
    { maxCandidates: 1 },
  ]) {
    await compare(
      { op: "discover", root: tree, limits },
      () => discover(tree, limits),
      "real Git traversal and bounds",
    );
  }
  sample = (await discover(tree)).result.candidates.find(
    (value) => value.relativePath === "Z-main",
  );
  assert.ok(sample);
  const validation = {
    candidateId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    rootPath: tree,
    path: sample.canonicalPath,
    expectedRepositoryFingerprint: sample.repositoryFingerprint,
  };
  for (const input of [
    validation,
    { ...validation, expectedRepositoryFingerprint: "0".repeat(64) },
    { ...validation, path: path.join(tree, "Z-main", "vendor", "hidden") },
    { ...validation, path: path.join(outside, "outside-repository") },
    { ...validation, path: path.join(tree, "a-linked") },
    { ...validation, path: path.join(tree, "bare") },
    { ...validation, path: "relative" },
    { ...validation, rootPath: "relative" },
  ]) {
    await compare({ op: "validate", input }, () =>
      source.validateWorkspaceRepositoryImport(input),
    );
  }
  for (const requested of [
    "relative",
    path.join(root, "missing"),
    path.join(tree, "outside-link"),
    path.join(tree, "plain-file"),
  ]) {
    await compare({ op: "discover", root: requested }, () =>
      discover(requested),
    );
  }
  const allFields = Object.fromEntries(
    REPOSITORY_METADATA_FIELDS.map((field) => [
      field,
      field + " synthetic\ud800",
    ]),
  );
  const protectedAll = await native({
    op: "metadata-protect",
    value: allFields,
  });
  assert.ok(
    Object.values(protectedAll).every((value) =>
      /^ctrr_[A-Za-z0-9_-]{43}$/.test(value),
    ),
  );
  same(
    await native({ op: "metadata-resolve", value: protectedAll }),
    allFields,
    "all authoritative metadata fields and UTF16 reopen",
  );
  const commandInput = {
    type: "workspace.repositories.discover",
    jobId: "22222222-2222-4222-8222-222222222222",
    attempt: 1,
    rootPath: routing.rootPath,
    depth: -1,
  };
  const nativeResult = await native({ op: "command", command: commandInput });
  const events = [];
  const raw = await handleWorkspaceCommand(
    await nodeRegistry.resolveCommand(commandInput),
    (event) => events.push(event),
  );
  same(
    await native({ op: "resolve", value: nativeResult.result }),
    raw,
    "real command result resolves to current Node behavior",
  );
  same(nativeResult.first, events[0], "progress event correlation");
  same(nativeResult.last, events.at(-1), "final progress counts");
  assert.ok(
    nativeResult.result.candidates.every(
      (value) => /^ctrr_/.test(value.path) && /^ctrr_/.test(value.displayPath),
    ),
  );
  const candidate = nativeResult.result.candidates.find(
    (value) => value.repositoryFingerprint === sample.repositoryFingerprint,
  );
  assert.ok(candidate);
  const importInput = {
    ...validation,
    type: "workspace.repository-import.validate",
    rootPath: routing.rootPath,
    path: candidate.path,
  };
  const nativeImport = await native({ op: "command", command: importInput });
  same(
    await native({ op: "resolve", value: nativeImport.result }),
    await source.validateWorkspaceRepositoryImport(validation),
    "routed import validates actual checkout",
  );
  const reopenedDirectory = path.join(root, "node-reopened");
  await mkdir(reopenedDirectory);
  await copyFile(
    path.join(nativeDirectory, "repository-routing.json"),
    path.join(reopenedDirectory, "repository-routing.json"),
  );
  const reopened = new WorkerRoutingRegistry(reopenedDirectory);
  same(
    await reopened.resolveCommand(nativeResult.result),
    raw,
    "actual Node registry reopens Rust-published records",
  );
  same(
    await reopened.resolveMetadata(protectedAll),
    allFields,
    "actual Node registry preserves Rust UTF16 records",
  );
  const missing = { ...commandInput, rootPath: "ctrr_" + "9".repeat(43) };
  await compare({ op: "command", command: missing }, async () => {
    try {
      return await handleWorkspaceCommand(
        await nodeRegistry.resolveCommand(missing),
        () => {},
      );
    } catch (error) {
      throw nodeRegistry.protectError(missing.type, error);
    }
  });
  for (const value of [{ unsupported: "value" }]) {
    await compare({ op: "metadata-protect", value }, () =>
      nodeRegistry.protectMetadata(value),
    );
  }
  same(
    await readFile(path.join(tree, "plain-file"), "utf8"),
    "untouched",
    "discovery/import remain read-only",
  );
  console.log(
    JSON.stringify({
      suite: "native-workspace-compatibility",
      passed: true,
      comparisons,
      realGit: true,
      actualNodeRegistryReopen: true,
      localeOrdering: true,
      opaqueCommandResults: true,
      scope:
        "Workspace discovery/import validation and routing; other filesystem and project execution remain pending.",
    }),
  );
} finally {
  process.env.PATH = originalEnvironment.PATH;
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    assert.equal(await completion, 0, stderr);
  } finally {
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
}
