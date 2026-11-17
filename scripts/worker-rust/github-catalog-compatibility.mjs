// Actual Node handler versus native gh subprocesses and profile persistence.
// All gh execution is intercepted by an owned shell fixture; no user auth/network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { workerCommandSchema } from "../../packages/protocol/dist/index.js";
import { GithubClient } from "../../cantrip_worker/src/github.ts";
import { handleGithubCommand } from "../../cantrip_worker/src/commands/github.ts";
import {
  githubCatalogFixture,
  catalogRepository,
} from "./github-catalog-fixture.mjs";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const original = { ...process.env };
const root = await mkdtemp(path.join(tmpdir(), "cantrip-github-catalog-"));
const bin = path.join(root, "bin"),
  nativeDirectory = path.join(root, "native 😀"),
  nodeDirectory = path.join(root, "node 😀");
const fixture = await githubCatalogFixture(root, bin);
const binary = path.resolve(values.binary);
process.env.PATH = bin;
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
let child,
  completion,
  lines,
  sequence = 0,
  comparisons = 0;
const commands = new Set();
function start() {
  child = spawn(binary, [], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdout.setEncoding("utf8");
  lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}
async function stop() {
  if (!child) return;
  child.stdin.end();
  assert.equal(await completion, 0);
  child = undefined;
}
async function native(command) {
  child.stdin.write(
    JSON.stringify({
      op: "github",
      directory: nativeDirectory,
      command,
      requestId: ++sequence,
    }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...value } = result;
  return value;
}
async function query(type, input = {}, ok = true) {
  const command = workerCommandSchema.parse({ type, ...input });
  commands.add(type);
  await fixture.calls();
  let expected;
  try {
    expected = {
      ok: true,
      value: await handleGithubCommand(command, {
        github: new GithubClient(nodeDirectory),
      }),
    };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  const nodeCalls = await fixture.calls();
  const actual = await native(command);
  assert.deepEqual(actual, expected, JSON.stringify(command));
  assert.deepEqual(await fixture.calls(), nodeCalls, "exact gh argv " + type);
  assert.equal(expected.ok, ok, JSON.stringify(expected));
  comparisons++;
  return actual.value;
}
async function cache(directory) {
  return JSON.parse(
    await readFile(path.join(directory, "github", "repositories.json"), "utf8"),
  );
}
async function caches(raw) {
  for (const directory of [nodeDirectory, nativeDirectory]) {
    await mkdir(path.join(directory, "github"), { recursive: true });
    await writeFile(path.join(directory, "github", "repositories.json"), raw);
  }
}
try {
  start();
  await query("github.auth.status");
  await query("github.repositories.cached", { login: "fixture-user" });
  const repositories = [
    { ...catalogRepository, id: 1, updated_at: "2026-11-16T00:00:00Z" },
    {
      ...catalogRepository,
      id: 2,
      name: 7,
      description: 3,
      private: "true",
      fork: true,
    },
    { ...catalogRepository, id: null, name: null, description: "\ud800" },
    { ...catalogRepository, id: 4 },
  ];
  await fixture.response("repositories", [
    repositories.slice(0, 2),
    repositories.slice(2),
  ]);
  const listed = await query("github.repositories.list");
  assert.deepEqual(
    listed.map((value) => value.id),
    ["2", "null", "4", "1"],
  );
  assert.equal(listed[0].isPrivate, false);
  assert.equal(listed[1].description, "\ud800");
  for (const directory of [nodeDirectory, nativeDirectory]) {
    const saved = await cache(directory);
    assert.equal(saved.login, "fixture-user");
    assert.deepEqual(saved.repositories, listed);
    assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
    assert.equal(
      (await stat(path.join(directory, "github", "repositories.json"))).mode &
        0o777,
      0o600,
    );
    assert.equal(
      (await stat(path.join(directory, "github"))).mode & 0o777,
      0o700,
    );
    assert.deepEqual(await readdir(path.join(directory, "github")), [
      "repositories.json",
    ]);
  }
  await query("github.repositories.cached", { login: "fixture-user" });
  await query("github.repositories.cached", { login: "Fixture-user" });
  await stop();
  start();
  await query("github.repositories.cached", { login: "fixture-user" });
  const saved = await readFile(
    path.join(nativeDirectory, "github", "repositories.json"),
    "utf8",
  );
  await fixture.response("repositories", "", {
    raw: true,
    status: 23,
    stderr: "fixture permission denied\n",
  });
  await query("github.repositories.list", {}, false);
  assert.equal(
    await readFile(
      path.join(nativeDirectory, "github", "repositories.json"),
      "utf8",
    ),
    saved,
  );
  await fixture.response("owners", [
    [
      { login: "Zoo" },
      { login: "alpha" },
      { login: "fixture-user" },
      { login: 5 },
    ],
    [
      { login: "Alpha" },
      { login: "alpha" },
      { login: "_org" },
      { login: "org-name" },
    ],
  ]);
  await query("github.repository-owners.list");
  const create = {
    owner: " ArcaneArts ",
    name: " cantrip-labs ",
    description: "  A fixture 😀  ",
    visibility: "private",
  };
  await query("github.repositories.create", { request: create });
  await query("github.repositories.create", {
    request: {
      ...create,
      initialize: "empty",
      description: "",
      visibility: "public",
    },
  });
  await query(
    "github.repositories.create",
    { request: { ...create, description: "hello\0world" } },
    false,
  );
  await query(
    "github.repositories.create",
    { request: { ...create, description: "hello\ud800\0world" } },
    false,
  );
  await query(
    "github.repositories.create",
    { request: { ...create, description: "a'\"`\0\u2028b" } },
    false,
  );
  await query("github.repositories.create", {
    request: { ...create, description: "hello\ud800world" },
  });
  await fixture.response("create", "", {
    raw: true,
    status: 1,
    stderr: "owned create failure\n",
  });
  await query("github.repositories.create", { request: create }, false);
  await query(
    "github.repositories.create",
    { request: { ...create, description: "hello\ud800world" } },
    false,
  );
  await fixture.response("create", "", { raw: true });
  for (const value of [
    {},
    null,
    "undefined",
    [null],
    [
      [
        {
          ...catalogRepository,
          full_name: "invalid",
          html_url: "broken",
          updated_at: "today",
        },
      ],
    ],
    [[{ ...catalogRepository, id: undefined, name: undefined }]],
  ]) {
    await fixture.response("repositories", value);
    await query(
      "github.repositories.list",
      {},
      Array.isArray(value) &&
        value[0]?.[0]?.id === undefined &&
        value[0]?.[0]?.html_url !== undefined,
    );
  }
  await fixture.response("repositories", "not json", { raw: true });
  await query("github.repositories.list", {}, false);
  // Exercise each actual execFile output budget, without involving GitHub.
  await fixture.response("repositories", " ".repeat(32 * 1024 * 1024 + 1), {
    raw: true,
  });
  await query("github.repositories.list", {}, false);
  await fixture.response("owners", " ".repeat(8 * 1024 * 1024 + 1), {
    raw: true,
  });
  await query("github.repository-owners.list", {}, false);
  for (const value of [
    null,
    {},
    [null],
    [[{ login: ".." }]],
    [[{ login: " bad space " }]],
  ]) {
    await fixture.response("owners", value);
    await query("github.repository-owners.list", {}, false);
  }
  await fixture.response("repositories", [[catalogRepository]]);
  for (const raw of [
    "not json",
    "null",
    JSON.stringify({
      login: "fixture-user",
      repositories: [{ invalid: true }],
    }),
    JSON.stringify({ login: "fixture-user", repositories: [] }),
  ]) {
    await caches(raw);
    await query("github.repositories.cached", { login: "fixture-user" });
  }
  // A failed cache publication must not fail a successful GitHub query.
  for (const directory of [nodeDirectory, nativeDirectory]) {
    await rm(path.join(directory, "github"), { recursive: true });
    await writeFile(
      path.join(directory, "github"),
      "owned cache path collision",
    );
  }
  await query("github.repositories.list");
  await query("github.repositories.cached", { login: "fixture-user" });
  await fixture.response("auth", "\ufeff  fixture-user \t\n", { raw: true });
  await query("github.auth.status");
  for (const login of ["", " \t\n", "fixture-user\n"]) {
    await fixture.response("auth", login, {
      raw: true,
      status: login.startsWith("fixture") ? 1 : 0,
    });
    await query("github.auth.status");
    await query("github.repositories.list", {}, false);
    await query("github.repository-owners.list", {}, false);
  }
  await fixture.response("auth", "fixture-user\n", { raw: true });
  await fixture.response("auth", "x".repeat(1024 * 1024 + 1), { raw: true });
  await query("github.auth.status");
  await fixture.response("auth", "fixture-user\n", { raw: true });
  // Create invokes gh directly, rather than adding an authentication preflight.
  await fixture.response("auth", "", { raw: true, status: 1 });
  await query("github.repositories.create", { request: create });
  await fixture.response("auth", "fixture-user\n", { raw: true });
  await stop();
  for (const tokens of [
    { GH_TOKEN: "owned-fake" },
    { GH_TOKEN: "", GITHUB_TOKEN: " " },
    { GH_TOKEN: "", GITHUB_TOKEN: "" },
  ]) {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    Object.assign(process.env, tokens);
    start();
    const result = await query("github.auth.status");
    assert.equal(
      result.source,
      Object.values(tokens).some(Boolean) ? "token" : "gh-cli",
    );
    await stop();
  }
  process.env.PATH = path.join(root, "missing-bin");
  start();
  await query("github.auth.status");
  await query("github.repositories.list", {}, false);
  await query("github.repositories.create", { request: create }, false);
  console.log(
    JSON.stringify({
      suite: "native-github-catalog-compatibility",
      comparisons,
      commands: [...commands],
      realGhProcessBoundary: true,
      nodeAbsentFromNativePath: true,
      persistedCacheRestart: true,
    }),
  );
} finally {
  await stop();
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  await rm(root, { recursive: true, force: true });
}
