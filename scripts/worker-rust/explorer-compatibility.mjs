// Local comparisons with the actual Explorer production engine. Disposable
// repositories only; no server mocks, provider calls, GUI or hosted Actions.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  symlink,
  utimes,
  lutimes,
  lstat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { executeExplorerRequest } from "../../cantrip_worker/src/commands/explorer-request.ts";
import { TextPreviewRequiredError } from "../../cantrip_worker/src/explorer-text-preview.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary explorer-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-native-explorer-")),
);
const node = path.join(root, "node"),
  rust = path.join(root, "rust");
let comparisons = 0;
let child;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
};
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function issue(error) {
  const text = String(error.message);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function normalized(value, ignoreTimestamp) {
  if (Array.isArray(value))
    return value.map((v) => normalized(v, ignoreTimestamp));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !ignoreTimestamp || k !== "modifiedAt")
        .map(([k, v]) => [k, normalized(v, ignoreTimestamp)]),
    );
  return value;
}
try {
  for (const parent of [node, rust]) {
    const project = path.join(parent, "project");
    await mkdir(path.join(project, "folder"), { recursive: true });
    await writeFile(path.join(parent, "outside.md"), "external markdown\n");
    await mkdir(path.join(parent, "outside-directory"));
    await writeFile(path.join(parent, "outside-directory", "keep.txt"), "keep");
    for (const [name, content] of Object.entries({
      "README.md": "\ufeffHello 🌍\n",
      "alpha.txt": "old\n",
      "Éclair.md": "accent",
      "eclair.MD": "plain",
      "Iİ.txt": "case",
      "INDEX_FILE_NAME_LONG.txt": "case",
      "folder/INDEX_FILE_NAME_LONG.txt": "case",
      "binary.bin": Buffer.from([1, 0, 2]),
      "invalid.txt": Buffer.from([0xff]),
      "ignored.txt": "ignored",
      ".gitignore": "ignored.txt\n",
      "folder/nested.txt": "nested",
    }))
      await writeFile(path.join(project, name), content);
    await symlink("../outside.md", path.join(project, "alias.txt"));
    await symlink(
      "../outside-directory",
      path.join(project, "linked-directory"),
      "dir",
    );
    await symlink("missing", path.join(project, "dangling"));
    await writeFile(
      path.join(project, "preview.txt"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 65),
    );
    await writeFile(
      path.join(project, "too-large.txt"),
      Buffer.alloc(10 * 1024 * 1024 + 1, 65),
    );
    git(project, "init", "-q");
    git(project, "config", "user.name", "Explorer Fixture");
    git(project, "config", "user.email", "fixture@example.invalid");
    git(project, "commit", "--allow-empty", "-qm", "empty baseline");
    git(project, "add", ".");
    git(project, "commit", "-qm", "initial");
    await writeFile(path.join(project, "alpha.txt"), "new\n");
    git(project, "add", "alpha.txt");
    git(project, "commit", "-qm", "updated alpha");
    // Align actual metadata for directory comparisons, including link lstat.
    for (const name of [
      "folder",
      "folder/nested.txt",
      "README.md",
      "alpha.txt",
      "Éclair.md",
      "eclair.MD",
      "Iİ.txt",
      "INDEX_FILE_NAME_LONG.txt",
      "folder/INDEX_FILE_NAME_LONG.txt",
      "binary.bin",
      "invalid.txt",
      "ignored.txt",
      ".gitignore",
      "preview.txt",
      "too-large.txt",
    ])
      await utimes(path.join(project, name), 1000.123456, 1000.123456);
    for (const name of ["outside.md", "outside-directory"])
      await utimes(path.join(parent, name), 1000.123456, 1000.123456);
    await lutimes(path.join(project, "dangling"), 1000.123456, 1000.123456);
  }
  // Only Git is available to the native fixture. Node is reference tooling.
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const gitBinary = execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  await symlink(gitBinary, path.join(bin, "git"));
  child = spawn(path.resolve(values.binary), [], {
    cwd: root,
    env: { ...process.env, PATH: bin },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  async function native(request, directory = "project") {
    child.stdin.write(
      JSON.stringify({ root: path.join(rust, directory), request }) + "\n",
    );
    const line = await lines.next();
    assert.ok(!line.done, "Native fixture exited unexpectedly");
    return JSON.parse(line.value);
  }
  async function compare(
    request,
    { directory = "project", ignoreTimestamp = false } = {},
  ) {
    let expected;
    try {
      const value = await executeExplorerRequest(
        path.join(node, directory),
        request,
        { fileImports: null },
        {
          serverId: "fixture",
          surfaceKind: "explorer",
          surfaceId: "fixture",
          operationId: "fixture",
          sequence: 0,
        },
      );
      expected = { ok: true, value: value.outcome.result };
    } catch (error) {
      expected = {
        ok: false,
        error: issue(error),
        code:
          error instanceof TextPreviewRequiredError
            ? "text-preview-required"
            : null,
      };
    }
    const actual = await native(request, directory);
    if (!actual.ok) actual.error = issue({ message: actual.error });
    assert.deepEqual(
      normalized(actual, ignoreTimestamp),
      normalized(expected, ignoreTimestamp),
      JSON.stringify(request),
    );
    comparisons++;
    return actual;
  }
  await compare({ type: "explorer.directory.list", path: "" });
  await compare({ type: "explorer.directory.list", path: "folder//" });
  await compare(
    { type: "explorer.directory.list", path: "linked-directory" },
    { ignoreTimestamp: true },
  );
  const commits = await compare({
    type: "explorer.directory.commits",
    path: "",
  });
  assert.equal(commits.value.value.available, true);
  assert.ok(
    commits.value.value.entries.find((e) => e.path === "alpha.txt").lastCommit
      .subject === "updated alpha",
  );
  await compare({ type: "explorer.directory.commits", path: "folder" });
  for (const query of [
    "md",
    "README.md",
    "FOLDER\\nested",
    "écl",
    "I",
    "ı",
    "İ",
    "  INDEX_FILE_NAME_LONG  ",
    "   alpha  ",
    "nothing",
    "   ",
  ])
    await compare({ type: "explorer.files.search", query, limit: 2 });
  for (const file of [
    "README.md",
    "alias.txt",
    "binary.bin",
    "invalid.txt",
    "preview.txt",
    "too-large.txt",
    "folder",
  ])
    await compare({ type: "explorer.file.read", path: file });
  const original = await compare({
    type: "explorer.file.read",
    path: "alpha.txt",
  });
  const version = original.value.value.version;
  await compare({
    type: "explorer.file.write",
    path: "alpha.txt",
    content: "short",
    version,
  });
  await compare({
    type: "explorer.file.write",
    path: "alpha.txt",
    content: "stale",
    version,
  });
  const current = await compare({
    type: "explorer.file.read",
    path: "alpha.txt",
  });
  await compare({
    type: "explorer.file.write",
    path: "alpha.txt",
    content: "\ufefflone\ud800",
    version: current.value.value.version,
  });
  assert.deepEqual(
    await readFile(path.join(node, "project/alpha.txt")),
    await readFile(path.join(rust, "project/alpha.txt")),
  );
  await compare({
    type: "explorer.file.write",
    path: "alpha.txt",
    content: "nul\0",
    version,
  });
  const external = await compare({
    type: "explorer.file.read",
    path: "alias.txt",
  });
  await compare({
    type: "explorer.file.write",
    path: "alias.txt",
    content: "outside edit",
    version: external.value.value.version,
  });
  for (const name of [
    "  created.md  ",
    "created.md",
    "dangling",
    "..",
    "folder/file",
    "file\\bad",
    "bad\0",
    " ",
  ])
    await compare(
      { type: "explorer.file.create", path: "folder//", name },
      { ignoreTimestamp: true },
    );
  await compare(
    { type: "explorer.file.create", path: "", name: "dangling" },
    { ignoreTimestamp: true },
  );
  for (let i = 0; i < 2; i++)
    await compare(
      { type: "explorer.directory.create", path: "folder//" },
      { ignoreTimestamp: true },
    );
  for (const request of [
    {
      type: "explorer.entry.rename",
      path: "folder//created.md",
      name: " renamed.md ",
    },
    { type: "explorer.entry.rename", path: "README.md", name: "alpha.txt" },
    { type: "explorer.entry.rename", path: "README.md", name: "readme.md" },
    { type: "explorer.entry.rename", path: "", name: "bad" },
    { type: "explorer.entry.delete", path: "" },
    { type: "explorer.entry.delete", path: "linked-directory/keep.txt" },
    { type: "explorer.file.create", path: "linked-directory", name: "no" },
    { type: "explorer.entry.delete", path: "dangling" },
    { type: "explorer.entry.delete", path: "linked-directory" },
    { type: "explorer.entry.delete", path: "folder/New Folder" },
  ])
    await compare(request, { ignoreTimestamp: true });
  for (const bad of [
    "../escape",
    "/absolute",
    "C:drive",
    "folder/./nested.txt",
    "folder\\nested.txt",
    "bad\0",
  ])
    await compare({ type: "explorer.file.read", path: bad });
  for (const parent of [node, rust]) {
    await mkdir(path.join(parent, "plain/dir"), { recursive: true });
    for (const name of [
      "Alpha.txt",
      "dir/alpha-long.txt",
      "alpha.md",
      "INDEX_FILE_NAME_LONG.txt",
      "dir/INDEX_FILE_NAME_LONG.txt",
    ])
      await writeFile(path.join(parent, "plain", name), "plain");
  }
  await compare(
    { type: "explorer.files.search", query: "alpha", limit: 1 },
    { directory: "plain" },
  );
  for (const query of ["I", "ı", "  INDEX_FILE_NAME_LONG  "])
    await compare(
      { type: "explorer.files.search", query, limit: 10 },
      { directory: "plain" },
    );
  await compare(
    { type: "explorer.directory.commits", path: "" },
    { directory: "plain" },
  );
  for (const parent of [node, rust]) {
    const p = path.join(parent, "limit");
    await mkdir(p);
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) =>
        writeFile(path.join(p, `file-${i}.txt`), ""),
      ),
    );
    await symlink("../outside.md", path.join(p, "zzz-link"));
  }
  const limited = await compare(
    { type: "explorer.directory.list", path: "" },
    { directory: "limit", ignoreTimestamp: true },
  );
  assert.equal(limited.value.value.truncated, true);
  assert.equal(limited.value.value.entries[0].name, "zzz-link");
  if (process.platform !== "win32")
    for (const parent of [node, rust]) {
      assert.equal(
        (await lstat(path.join(parent, "project/folder/renamed.md"))).mode &
          0o777,
        0o600,
      );
      assert.equal(
        (await lstat(path.join(parent, "project/folder/New Folder 2"))).mode &
          0o777,
        0o700,
      );
    }
  assert.equal(
    await readFile(path.join(rust, "outside-directory/keep.txt"), "utf8"),
    "keep",
  );
  console.log(
    JSON.stringify({
      comparisons,
      platform: process.platform,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      nativePathContainsOnlyGit: true,
    }),
  );
} finally {
  if (child) {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
  await rm(root, { recursive: true, force: true });
}
