// Existing browser SDKs, complete worker and native runtime across offline
// rollback/re-upgrade of real, written production server profiles.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { repositoryRoot } from "./build.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", multiple: true },
    "native-assets": { type: "string" },
    "profile-converter": { type: "string" },
    "profile-snapshot-probe": { type: "string" },
    "report-directory": { type: "string" },
  },
});
const required = (name) => {
  assert.ok(values[name], "--" + name + " is required");
  return path.resolve(values[name]);
};
const assets = required("native-assets"),
  converter = required("profile-converter"),
  probe = required("profile-snapshot-probe");
const databases = values.database ?? ["pglite", "bundled-postgres", "postgres"];
const parent = path.resolve(
  values["report-directory"] ?? path.join(repositoryRoot, ".qa/rust-server"),
);
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "profile-runtime-"));
const summary = {
  suite: "actual-native-worker-profile-runtime-recovery",
  completeReplacement: false,
  root,
  platform: process.platform,
  architecture: process.arch,
  cases: [],
  scope:
    "Real browser SDK/crypto, full production Node worker and actual native runtime. Rust -> Node -> Rust with an original held Agent/Goal model stream and exact offline database/file preservation; completed Tasks/history checked through the browser. Local qualification, not the complete desktop/platform matrix.",
};
const save = () =>
  writeFile(
    path.join(root, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { mode: 0o600 },
  );
const assetManifest = JSON.parse(
  await readFile(path.join(assets, "native-server.json"), "utf8"),
);
const executable = path.join(
  assets,
  "bin",
  "cantrip-server" + (process.platform === "win32" ? ".exe" : ""),
);
await save();
const scenarios = databases.map((database) => ({
  database,
  name: database,
  samePostgres: false,
}));
if (databases.includes("postgres"))
  scenarios.push({
    database: "postgres",
    name: "postgres-code-only",
    samePostgres: true,
  });
for (const { database, name, samePostgres } of scenarios) {
  const entry = {
    database,
    samePostgres,
    status: "running",
    report: path.join(root, name + ".json"),
    log: path.join(root, name + ".log"),
  };
  summary.cases.push(entry);
  await save();
  console.log(
    JSON.stringify({ event: "profile-runtime.case.started", database }),
  );
  const output = createWriteStream(entry.log, { flags: "wx", mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/server-rust/actual-folder-client.mjs",
      "--database",
      database,
      "--runtime",
      "rust",
      "--tasks",
      "--project-chats",
      "--production-server",
      "--native-single-agent-recovery",
      "--profile-runtime-recovery",
      "--native-assets",
      assets,
      "--profile-converter",
      converter,
      "--profile-snapshot-probe",
      probe,
      ...(samePostgres ? ["--profile-same-postgres"] : []),
      "--keep-fixture",
      "--report",
      entry.report,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CANTRIP_TEST_SERVER_BINARY: executable,
        PGLITE_RUNTIME_DIR: path.join(assets, "pglite"),
        CANTRIP_TEST_POSTGRES_BIN_DIR: path.join(
          assets,
          assetManifest.postgres.bin,
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const exit = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve) => output.end(resolve));
  Object.assign(entry, exit);
  try {
    assert.equal(exit.code, 0, "actual worker/product driver exits cleanly");
    const report = JSON.parse(await readFile(entry.report, "utf8"));
    assert.equal(report.failure, undefined);
    assert.equal(report.runtimes.length, 1);
    const runtime = report.runtimes[0];
    const transfers = runtime.profileRuntimeTransfers;
    assert.equal(transfers.length, 2);
    assert.deepEqual(
      transfers.map((t) => [t.sourceKind, t.targetKind]),
      [
        ["rust", "node"],
        ["node", "rust"],
      ],
    );
    assert.ok(
      transfers.every(
        (t) =>
          t.status === "passed" &&
          t.exit.signal === "SIGKILL" &&
          t.allRowsAndSequencesPreserved &&
          t.profileFilesPreserved,
      ),
    );
    const generations = runtime.profileRuntimeGenerations;
    const implementationChanges = generations
      .map((g) => g.kind)
      .filter((kind, index, array) => index === 0 || kind !== array[index - 1]);
    assert.deepEqual(implementationChanges, ["rust", "node", "rust"]);
    assert.equal(generations.filter((g) => g.signal === "SIGKILL").length, 2);
    assert.ok(
      generations.every((g) =>
        g.signal === "SIGKILL"
          ? g.exitCode === null
          : g.exitCode === 0 && g.signal === null,
      ),
    );
    for (const transfer of transfers) {
      assert.equal(
        generations.find((g) => g.pid === transfer.before.pid)?.kind,
        transfer.sourceKind,
      );
      assert.equal(
        generations.find((g) => g.pid === transfer.after.pid)?.kind,
        transfer.targetKind,
      );
      if (samePostgres) {
        assert.equal(transfer.samePostgres, true);
        assert.equal(transfer.sameDatabaseUrl, true);
        assert.equal(transfer.sourceMode, "postgres");
        assert.equal(transfer.targetMode, "postgres");
        assert.equal(transfer.targetData, transfer.sourceData);
        assert.equal(transfer.import, null);
      }
    }
    const identity = runtime.profileRuntimeGenerations[0].server.id;
    assert.ok(
      runtime.profileRuntimeGenerations.every((g) => g.server.id === identity),
    );
    assert.deepEqual(runtime.singleAgentInflight.summary.phases, [
      "agent",
      "goal",
    ]);
    assert.equal(runtime.singleAgentInflight.summary.workerRetained, true);
    assert.equal(
      runtime.singleAgentInflight.summary.originalStreamsRetained,
      true,
    );
    assert.deepEqual(
      runtime.profileRetainedTasks.map((t) => t.phase),
      ["agent", "goal"],
    );
    for (const retained of runtime.profileRetainedTasks) {
      assert.ok(retained.before.length > 0);
      assert.deepEqual(retained.after, retained.before);
    }
    entry.fixtureRoot = report.fixtureRoot;
    entry.steps = runtime.steps.length;
    entry.workerStops = runtime.workerStops.length;
    entry.generations = runtime.profileRuntimeGenerations.map(
      ({ kind, pid, server }) => ({ kind, pid, server }),
    );
    entry.transfers = transfers.map(
      ({
        sourceKind,
        targetKind,
        sourceMode,
        targetMode,
        tables,
        sequences,
        directory,
        sameDatabaseUrl,
      }) => ({
        sourceKind,
        targetKind,
        sourceMode,
        targetMode,
        tables,
        sequences,
        directory,
        sameDatabaseUrl,
      }),
    );
    entry.retainedTasks = runtime.profileRetainedTasks.map((t) => ({
      phase: t.phase,
      count: t.before.length,
      states: t.before.map((v) => v.task.state),
    }));
    entry.modelPosts = runtime.projectChatModel.requests.filter(
      (r) => r.method === "POST",
    ).length;
    entry.status = "passed";
  } catch (error) {
    entry.status = "failed";
    entry.failure = { message: error.message, stack: error.stack };
    try {
      const report = JSON.parse(await readFile(entry.report, "utf8"));
      entry.fixtureRoot = report.fixtureRoot;
      entry.productFailure = report.failure;
    } catch {}
  }
  await save();
  console.log(
    JSON.stringify({
      event: "profile-runtime.case.completed",
      database,
      status: entry.status,
      fixtureRoot: entry.fixtureRoot,
    }),
  );
}
// Record the actual supplied files after the worker has tried the runtime.
// These receipts do not preflight or substitute for the production execution.
summary.artifacts = {};
for (const [name, file] of Object.entries({
  nativeServer: executable,
  nativeManifest: path.join(assets, "native-server.json"),
  snapshotProbe: probe,
  converter: path.join(converter, "dist/index.mjs"),
  nodeProductionEntry: path.join(
    repositoryRoot,
    "cantrip_server/dist/index.js",
  ),
  ...(process.env.CANTRIP_CODEX_BIN
    ? { nativeWorkerRuntime: process.env.CANTRIP_CODEX_BIN }
    : {}),
  ...(process.env.CANTRIP_TEST_WORKER_PACKAGE
    ? {
        workerEntry: path.join(
          process.env.CANTRIP_TEST_WORKER_PACKAGE,
          "dist/index.js",
        ),
        workerRuntimeManifest: path.join(
          process.env.CANTRIP_TEST_WORKER_PACKAGE,
          "bin/codex-runtime.json",
        ),
      }
    : {}),
  lockfile: path.join(repositoryRoot, "pnpm-lock.yaml"),
})) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  summary.artifacts[name] = { file, bytes, sha256: hash.digest("hex") };
}
summary.passed = summary.cases.every((c) => c.status === "passed");
summary.fullLocalStorageMatrix =
  summary.passed &&
  ["pglite", "bundled-postgres", "postgres"].every((d) =>
    summary.cases.some((c) => c.database === d && !c.samePostgres),
  );
summary.samePostgresCutover = summary.cases.some(
  (c) => c.samePostgres && c.status === "passed",
);
await save();
console.log(
  JSON.stringify({
    summary: path.join(root, "summary.json"),
    passed: summary.passed,
  }),
);
if (!summary.passed) process.exitCode = 1;
