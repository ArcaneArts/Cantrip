// Focused local comparisons with actual Node folder/Git/path implementations.
// Every directory is owned by this fixture; no external GitHub API is called.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  ManagedFolderManager,
  deriveManagedFolderLocation,
} from "../../cantrip_worker/src/managed-folders.ts";
import { normalizeProjectSourcePath } from "../../cantrip_worker/src/project-source-path.ts";
import {
  GithubClient,
  githubRepositoryFromRemoteUrl,
} from "../../cantrip_worker/src/github.ts";
import { WorkerRoutingRegistry } from "../../cantrip_worker/src/routing-registry.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-native-folders-")),
);
const originalPath = process.env.PATH;
const bin = path.join(root, "bin"),
  nodeData = path.join(root, "node"),
  rustData = path.join(root, "rust");
await mkdir(bin);
await mkdir(nodeData);
await mkdir(rustData);
const childCwd = path.join(root, "child-cwd");
await mkdir(childCwd);
const gitBinary = execFileSync("/usr/bin/which", ["git"], {
  encoding: "utf8",
}).trim();
await symlink(gitBinary, path.join(bin, "git"));
await writeFile(
  path.join(bin, "gh"),
  `#!/bin/sh
case "$2" in
 repos/owner/good) printf '%s' '{"id":42,"full_name":"Owner/Good","html_url":"https://github.com/Owner/Good"}';;
 repos/owner/alternative) printf '%s' '{"id":null,"full_name":"Owner/Alternative","html_url":"https://elsewhere.invalid/repository"}';;
 repos/owner/wrong) printf '%s' '{"id":43,"full_name":"Owner/Other","html_url":"https://github.com/Owner/Other"}';;
 *) exit 1;;
esac
`,
);
await chmod(path.join(bin, "gh"), 0o700);
process.env.PATH = bin;
const child = spawn(path.resolve(values.binary), [], {
  cwd: childCwd,
  env: { ...process.env, PATH: bin },
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[
  Symbol.asyncIterator
]();
let stderr = "",
  sequence = 0,
  comparisons = 0;
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-16000);
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
async function rust(input) {
  const requestId = ++sequence;
  child.stdin.write(JSON.stringify({ ...input, requestId }) + "\n");
  let timer;
  try {
    const line = await Promise.race([
      lines.next(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native folder driver timed out: " + stderr)),
          20000,
        );
      }),
    ]);
    assert.equal(line.done, false, stderr);
    const response = JSON.parse(line.value);
    assert.equal(response.id, requestId);
    return response.result;
  } finally {
    clearTimeout(timer);
  }
}
async function native(input) {
  const result = await rust(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
function normalize(value, profile) {
  if (typeof value === "string") return value.replaceAll(profile, "<profile>");
  if (Array.isArray(value))
    return value.map((value) => normalize(value, profile));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [
        key,
        normalize(value, profile),
      ]),
    );
  return value;
}
async function observe(read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      code:
        typeof error.code === "string" &&
        error.code.length <= 100 &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(error.code)
          ? error.code
          : null,
    };
  }
}
async function compare(input, read, label = input.op) {
  assert.deepEqual(
    normalize(await rust(input), rustData),
    normalize(await observe(read), nodeData),
    label,
  );
  comparisons++;
}
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
const nodeGithub = new GithubClient(nodeData, "fixture-worker");
const nodeManager = new ManagedFolderManager(nodeData, (cwd) =>
  nodeGithub.inspectCheckout(cwd),
);
const nodeRegistry = new WorkerRoutingRegistry(nodeData);
const projectId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
  jobId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
  workspaceId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb337";
const input = { projectId, jobId, attempt: 1 };
function git(args) {
  return execFileSync(
    gitBinary,
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
try {
  for (const [platform, paths] of [
    [
      "linux",
      [
        "/tmp/cantrip/../project/",
        "//tmp//project/.",
        "file:///tmp/project%20space",
        "file://localhost/tmp/%E7%A7%81",
        "file:///tmp/back%5Cslash",
        "relative",
        "ssh://host/project",
      ],
    ],
    [
      "win32",
      [
        "c:/Cantrip/../Project/",
        "\\\\?\\C:\\Cantrip\\..\\Project",
        "\\\\?\\unc\\server\\share\\source",
        "\\\\server\\share\\a\\..\\b\\",
        "file:///c:/Project%20Space",
        "file://server/share/Project",
        "file://xn--bcher-kva/share/project",
        "FILE://LOCALHOST/C:/Project",
        "C:\\私\\\ud800",
        "C:relative",
        "relative",
        "/posix/root",
      ],
    ],
  ])
    for (const value of paths)
      await compare(
        { op: "source-path", path: value, windows: platform === "win32" },
        () => normalizeProjectSourcePath(value, platform),
      );
  for (const origin of [
    "git@github.com:Owner/Repo.GIT",
    "https://user@github.com:443/Owner/Repo/",
    "ssh://git@github.com/Owner/Repo.git",
    "https://elsewhere.invalid/Owner/Repo",
    "git@github.com:Owner/.git",
    "https://github.com/Owner/Repo/extra",
  ]) {
    same(
      await native({ op: "github-origin-name", origin }),
      githubRepositoryFromRemoteUrl(origin),
      "actual GitHub remote parser",
    );
  }
  for (const storage of [
    { kind: "system" },
    { kind: "legacy" },
    { kind: "attached", workspaceId, workerId: "fixture-worker" },
    { kind: "managed", workspaceId },
  ]) {
    await compare(
      {
        op: "folder-location",
        directory: rustData,
        projectId: projectId.toUpperCase(),
        storage,
      },
      () =>
        deriveManagedFolderLocation(nodeData, projectId.toUpperCase(), storage),
    );
    const request = { ...input, workspaceStorage: storage };
    await compare(
      { op: "folder-materialize", directory: rustData, input: request },
      () => nodeManager.materialize(request),
    );
    const target = deriveManagedFolderLocation(
      rustData,
      projectId,
      storage,
    ).target;
    const reference = deriveManagedFolderLocation(
      nodeData,
      projectId,
      storage,
    ).target;
    await writeFile(path.join(target, "kept.txt"), "preserved");
    await writeFile(path.join(reference, "kept.txt"), "preserved");
    await compare(
      {
        op: "folder-materialize",
        directory: rustData,
        input: { ...request, attempt: 2 },
      },
      () => nodeManager.materialize({ ...request, attempt: 2 }),
    );
    await compare(
      { op: "folder-resolve", directory: rustData, projectId, storage },
      () => nodeManager.resolve(projectId, storage),
    );
    assert.equal(
      await readFile(path.join(target, "kept.txt"), "utf8"),
      "preserved",
    );
    await compare(
      { op: "folder-delete", directory: rustData, projectId, storage },
      () => nodeManager.delete(projectId, storage),
    );
    await compare(
      { op: "folder-delete", directory: rustData, projectId, storage },
      () => nodeManager.delete(projectId, storage),
    );
  }
  for (const id of ["../escape", "00000000-0000-0000-0000-000000000000"])
    await compare(
      {
        op: "folder-location",
        directory: rustData,
        projectId: id,
        storage: { kind: "system" },
      },
      () => deriveManagedFolderLocation(nodeData, id),
    );
  const external = path.join(root, "external"),
    file = path.join(root, "file");
  await mkdir(external);
  await writeFile(file, "keep file");
  await writeFile(path.join(external, "dirty.txt"), "external content");
  const alias = path.join(root, "alias");
  await symlink(external, alias);
  for (const existingPath of [
    external,
    alias,
    pathToFileURL(external).href,
    path.join(root, "missing"),
    file,
    path.join(file, "child"),
    "relative",
    "ssh://host/path",
    "file:///invalid%2Fpath",
  ]) {
    const request = { ...input, existingPath };
    await compare(
      { op: "folder-materialize", directory: rustData, input: request },
      () => nodeManager.materialize(request),
      "existing folder attachment",
    );
  }
  const corrected = path.join(root, "corrected");
  const correctedInput = { ...input, existingPath: corrected, attempt: 2 };
  await mkdir(corrected);
  await compare(
    { op: "folder-materialize", directory: rustData, input: correctedInput },
    () => nodeManager.materialize(correctedInput),
  );
  await compare(
    {
      op: "folder-delete",
      directory: rustData,
      projectId,
      storage: { kind: "system" },
    },
    () => nodeManager.delete(projectId),
  );
  assert.equal(
    await readFile(path.join(external, "dirty.txt"), "utf8"),
    "external content",
  );
  const repository = path.join(root, "repository");
  await mkdir(repository);
  git(["init", "--quiet", repository]);
  git([
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  ]);
  for (const repositoryName of [
    "Good",
    "Alternative",
    "Wrong",
    "Unavailable",
  ]) {
    git([
      "-C",
      repository,
      "config",
      "remote.origin.url",
      `https://github.com/Owner/${repositoryName}.git`,
    ]);
    await compare(
      { op: "folder-inspect", path: repository },
      () => nodeGithub.inspectCheckout(repository),
      "real Git and gh repository inspection",
    );
  }
  git([
    "-C",
    repository,
    "config",
    "remote.origin.url",
    "https://github.com/Owner/Good.git",
  ]);
  const linked = path.join(root, "linked");
  git([
    "-C",
    repository,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    linked,
    "HEAD",
  ]);
  await mkdir(path.join(repository, "subdirectory"));
  for (const existingPath of [
    repository,
    linked,
    path.join(repository, "subdirectory"),
  ]) {
    const request = { ...input, existingPath };
    await compare(
      { op: "folder-materialize", directory: rustData, input: request },
      () => nodeManager.materialize(request),
      "Git attachment metadata",
    );
  }
  const boundaryId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb336";
  for (const profile of [nodeData, rustData])
    await symlink(external, path.join(profile, "workspaces", boundaryId));
  const unsafe = {
    ...input,
    workspaceStorage: { kind: "managed", workspaceId: boundaryId },
  };
  await compare(
    { op: "folder-materialize", directory: rustData, input: unsafe },
    () => nodeManager.materialize(unsafe),
  );
  assert.equal(
    await readFile(path.join(external, "dirty.txt"), "utf8"),
    "external content",
  );
  await native({ op: "open-registry", directory: rustData });
  const command = { type: "project.folder.materialize", ...input };
  const protectedResult = await native({
    op: "folder-command",
    directory: rustData,
    command,
  });
  assert.match(protectedResult.path, /^ctrr_[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(protectedResult).includes(rustData), false);
  const opened = await new WorkerRoutingRegistry(rustData).resolveCommand(
    protectedResult,
  );
  same(
    normalize(opened, rustData),
    normalize(await nodeManager.materialize(input), nodeData),
    "Node opens native folder result tokens",
  );
  const badCommand = { ...command, existingPath: path.join(root, "missing") };
  await compare(
    { op: "folder-command", directory: rustData, command: badCommand },
    async () => {
      try {
        return await nodeManager.materialize(badCommand);
      } catch (error) {
        throw nodeRegistry.protectError(command.type, error);
      }
    },
    "protected typed attachment failure",
  );
  await rm(childCwd, { recursive: true });
  await compare(
    {
      op: "folder-location",
      directory: rustData,
      projectId,
      storage: { kind: "system" },
    },
    () => deriveManagedFolderLocation(nodeData, projectId),
    "absolute storage survives a removed process cwd",
  );
  console.log(
    JSON.stringify({
      suite: "native-managed-folder-compatibility",
      passed: true,
      comparisons,
      actualNodeManager: true,
      actualGitAndGh: true,
      portableWindowsNormalization: true,
      opaqueResults: true,
      externalFilesPreserved: true,
      scope:
        "Managed folder service and placement; Git mutations, runtime supervisors and explorer remain pending.",
    }),
  );
} finally {
  process.env.PATH = originalPath;
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    assert.equal(await completion, 0, stderr);
  } finally {
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
}
