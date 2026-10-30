// The actual source descriptor builder, including opaque titles and JS ordering.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { projectLabel } from "./security-fixtures.mjs";
const at = process.argv.indexOf("--report"),
  reportPath = at < 0 ? undefined : process.argv[at + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-target-catalog-"));
const report = {
  suite: "actual-execution-target-catalog-builder",
  completeReplacement: false,
  scope:
    "Descriptor composition; database/resource projection and HTTP acceptance remain separate",
  cases: [],
};
const pair = [];
let failure;
const label = (recordKind) => ({
  ...projectLabel,
  classification: { recordKind },
});
const worker = (workerId, online = true, browser = true, desktop = true) => ({
  workerId,
  name: workerId + " worker",
  online,
  remoteSurfaces: { browser, desktop },
});
const base = {
  projectId: "project",
  workers: [
    worker("alpha"),
    worker("beta", false),
    worker("gamma", true, false, false),
  ],
  replicas: [
    {
      id: "replica-alpha",
      workerId: "alpha",
      workerName: "Alpha",
      ready: true,
      primaryWorktreeId: "tree-alpha",
    },
    {
      id: "replica-beta",
      workerId: "beta",
      workerName: "Beta",
      ready: false,
      primaryWorktreeId: null,
    },
  ],
  worktrees: [
    {
      id: "tree-alpha",
      projectSourceId: "replica-alpha",
      workerId: "alpha",
      name: "main",
      lifecycleState: "ready",
    },
    {
      id: "tree-creating",
      projectSourceId: "replica-alpha",
      workerId: "alpha",
      name: "creating",
      lifecycleState: "creating",
    },
  ],
  chats: [
    {
      id: "chat",
      activeWorkerId: null,
      activeWorktreeId: "tree-alpha",
      status: "idle",
      titleProtection: label("chat"),
    },
  ],
  terminals: [
    {
      id: "terminal",
      activeWorkerId: "alpha",
      worktreeId: "tree-alpha",
      kind: "shell",
      status: "ready",
      titleProtection: label("terminal"),
    },
    {
      id: "run",
      activeWorkerId: "alpha",
      worktreeId: "tree-alpha",
      kind: "run-configuration",
      status: "ready",
      titleProtection: label("terminal"),
    },
  ],
  explorers: [
    {
      id: "explorer",
      activeWorkerId: null,
      worktreeId: "tree-alpha",
      titleProtection: label("explorer"),
    },
  ],
  codeTabs: [
    {
      id: "code",
      activeWorkerId: null,
      worktreeId: "tree-alpha",
      titleProtection: label("code-tab"),
    },
  ],
  browsers: [
    { id: "browser", workerId: null, titleProtection: label("browser") },
  ],
  desktops: [
    {
      id: "desktop",
      workerId: "alpha",
      status: "running",
      titleProtection: label("project-view"),
    },
  ],
  remoteSurfaces: [
    {
      id: "browser",
      workerId: "alpha",
      kind: "browser",
      status: "running",
      titleProtection: label("remote-surface"),
    },
    {
      id: "desktop",
      workerId: "alpha",
      kind: "desktop",
      status: "running",
      titleProtection: label("remote-surface"),
    },
    {
      id: "remote",
      workerId: "gamma",
      kind: "desktop",
      status: "starting",
      titleProtection: label("remote-surface"),
    },
  ],
};
const check = async (name, input, connected) => {
  const request = {
    op: "target-catalog",
    input,
    ...(connected === undefined ? {} : { connected }),
  };
  const expected = await pair[0].request(request),
    actual = await pair[1].request(request);
  if (expected.rejected || actual.rejected) {
    report.failure = { label: name, request, expected, actual };
    assert.fail(`Catalog builder rejected ${name}`);
  }
  try {
    assert.deepEqual(actual.value, expected.value, name);
    assert.equal(
      JSON.stringify(actual.value),
      JSON.stringify(expected.value),
      name + " serialized property order",
    );
  } catch (e) {
    report.failure = { label: name, request, expected, actual };
    throw e;
  }
  report.cases.push({
    label: name,
    targets: expected.value.targets.length,
    truncated: expected.value.truncated,
    sha256: createHash("sha256")
      .update(JSON.stringify(expected.value))
      .digest("hex"),
  });
};
try {
  const executable = await buildRustExample("project-repository-fixture");
  for (const kind of ["node", "rust"])
    pair.push(
      await repositoryFixture({
        kind,
        executable,
        root,
        databaseMode: "pglite",
      }),
    );
  await check("all surface kinds and run-configuration exclusion", base);
  for (const connected of [
    [],
    ["alpha"],
    ["beta"],
    ["gamma"],
    ["alpha", "beta", "gamma"],
  ])
    await check("presence " + JSON.stringify(connected), base, connected);
  const kinds = [
    "project",
    "worker",
    "replica",
    "worktree",
    "chat",
    "terminal",
    "explorer",
    "code",
    "browser",
    "remote-desktop",
    "remote-surface",
  ];
  for (const resourceKinds of [
    [],
    ...kinds.map((k) => [k]),
    ["worker", "browser", "terminal"],
  ])
    await check("resource filter " + JSON.stringify(resourceKinds), {
      ...base,
      resourceKinds,
    });
  for (const maximumTargets of [
    null,
    -2,
    -0.5,
    0,
    1,
    1.5,
    2,
    100,
    2000,
    "0x3",
    "invalid",
  ])
    await check("limit " + String(maximumTargets), { ...base, maximumTargets });
  for (const field of [
    "workers",
    "replicas",
    "worktrees",
    "chats",
    "terminals",
    "explorers",
    "codeTabs",
    "browsers",
    "desktops",
    "remoteSurfaces",
  ])
    await check("empty " + field, { ...base, [field]: [] });
  let input = structuredClone(base);
  input.worktrees[0].lifecycleState = "creating";
  await check("non-ready roots affect every related surface", input);
  input = structuredClone(base);
  input.chats[0].activeWorkerId = "beta";
  await check("mismatched active worker suppresses surface", input);
  input = structuredClone(base);
  input.browsers[0].workerId = "";
  await check("empty browser worker preserves raw remote fallback", input);
  input = structuredClone(base);
  input.workers.push(worker("alpha", false));
  await check("last duplicate worker wins map availability", input);
  input = structuredClone(base);
  input.worktrees.push({ ...input.worktrees[0], workerId: "beta" });
  await check("surface worktree map uses last duplicate", input);
  input = structuredClone(base);
  input.browsers.push({
    id: "unknown",
    workerId: null,
    titleProtection: label("browser"),
  });
  await check("browser without worker or remote is absent", input);
  input = structuredClone(base);
  input.replicas[0].primaryWorktreeId = "tree-creating";
  await check("primary readiness preserves replica unavailable reason", input);
  for (const id of [
    "Z",
    "a",
    "é",
    "e\u0301",
    "I",
    "ı",
    "İ",
    "file-10",
    "file-2",
    "_source",
    "-source",
    "😀",
    "\ud800",
  ]) {
    input = structuredClone(base);
    input.chats.push({ ...input.chats[0], id });
    await check("locale target serialization " + JSON.stringify(id), input);
  }
  const workers = Array.from({ length: 2001 }, (_, i) => worker("worker-" + i));
  await check("default 2000 descriptor cap", { ...base, workers });
  await check("uncapped descriptor composition", {
    ...base,
    workers,
    maximumTargets: null,
  });
} catch (e) {
  failure = e;
  report.failure ??= { message: e.message, stack: e.stack };
} finally {
  for (const fixture of pair) await fixture.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({ suite: report.suite, cases: report.cases.length }),
);
