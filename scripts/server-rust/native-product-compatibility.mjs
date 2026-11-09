// Keep Task lifecycle and native MCP Task scenarios in separate disposable
// projects: the latter must observe an initially empty Task catalog.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { repositoryRoot } from "./build.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", multiple: true },
    suite: { type: "string", multiple: true },
    "report-directory": { type: "string" },
    "production-server": { type: "boolean", default: false },
  },
});
const supportedDatabases = ["pglite", "postgres", "bundled-postgres"];
const suites = {
  tasks: ["--tasks"],
  "agent-tasks": ["--project-chats", "--agent-tasks"],
};
const databases = values.database ?? supportedDatabases;
const selectedSuites = values.suite ?? Object.keys(suites);
for (const database of databases)
  assert.ok(supportedDatabases.includes(database));
for (const suite of selectedSuites) assert.ok(Object.hasOwn(suites, suite));
const parent = path.resolve(
  values["report-directory"] ?? path.join(repositoryRoot, ".qa/rust-server"),
);
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, "native-product-"));
const summary = {
  suite: "actual-native-product-matrix",
  completeReplacement: false,
  platform: process.platform,
  architecture: process.arch,
  databaseModes: databases,
  selectedSuites,
  productionServer: values["production-server"],
  nativeExecutableOverride: process.env.CANTRIP_CODEX_BIN ?? null,
  scope: `Existing browser SDKs, ${values["production-server"] ? "production server executables without SQL fixture routes" : "production server startup/routes with development-only SQL failure capture"}, full production Node worker, actual native executable, controlled public model HTTP only. Separate disposable stores for every scenario; not packaged/platform/multi-instance acceptance.`,
  cases: [],
};
const summaryPath = path.join(directory, "summary.json");
const save = () =>
  writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
await save();
for (const database of databases) {
  for (const suite of selectedSuites) {
    const name = `${database}-${suite}`;
    const report = path.join(directory, name + ".json");
    const observation = { database, suite, report, status: "running" };
    summary.cases.push(observation);
    await save();
    const started = performance.now();
    console.log(JSON.stringify({ event: "native-product.case.started", name }));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/server-rust/actual-folder-client.mjs",
        "--database",
        database,
        ...suites[suite],
        ...(values["production-server"]
          ? ["--production-server"]
          : ["--task-diagnostics"]),
        "--report",
        report,
      ],
      { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
    );
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error: error.message }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    Object.assign(observation, result, {
      elapsedSeconds: (performance.now() - started) / 1000,
      status: result.code === 0 ? "passed" : "failed",
    });
    try {
      const recorded = JSON.parse(await readFile(report, "utf8"));
      observation.runtimes = recorded.runtimes.map((runtime) => ({
        kind: runtime.kind,
        steps: runtime.steps.length,
        stoppedWorkers: runtime.workerStops.length,
        taskExecution: runtime.taskExecution,
        nativeTaskChildExecution: runtime.mcpTaskProbe?.childExecution,
      }));
      observation.fixtureRoot = recorded.fixtureRoot;
      observation.failure = recorded.failure;
    } catch (error) {
      observation.reportError = error.message;
      observation.status = "failed";
    }
    await save();
    console.log(
      JSON.stringify({
        event: "native-product.case.completed",
        ...observation,
      }),
    );
  }
}
// Record the bytes actually supplied to completed runs; do not introduce an
// executable/manifest preflight that prevents the production worker trying it.
if (
  summary.nativeExecutableOverride &&
  path.isAbsolute(summary.nativeExecutableOverride)
) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(
      summary.nativeExecutableOverride,
    ))
      hash.update(chunk);
    summary.nativeExecutableSha256 = hash.digest("hex");
  } catch (error) {
    summary.nativeExecutableEvidenceError = error.message;
  }
}
summary.passed = summary.cases.every((value) => value.status === "passed");
summary.fullLocalMatrix =
  summary.passed &&
  supportedDatabases.every((value) => databases.includes(value)) &&
  Object.keys(suites).every((value) => selectedSuites.includes(value));
await save();
console.log(JSON.stringify({ summary: summaryPath, passed: summary.passed }));
if (!summary.passed) process.exitCode = 1;
