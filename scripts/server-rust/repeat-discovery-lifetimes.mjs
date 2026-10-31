// Repeated isolated successes expose intermittent failures. Stop on the first
// failed scenario; never retry a request, suppress resets or weaken SQL checks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustServer, repositoryRoot } from "./build.mjs";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "10" },
    "report-directory": {
      type: "string",
      default: ".qa/rust-server/discovery-lifetime-repeat",
    },
  },
  strict: true,
});
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const directory = path.resolve(values["report-directory"]);
await mkdir(directory, { recursive: true });
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
const results = [];
for (let iteration = 1; iteration <= iterations; iteration++) {
  const report = path.join(directory, `iteration-${iteration}.json`);
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/server-rust/discovery-http-compatibility.mjs",
      "--database",
      "postgres",
      "--lifetimes",
      "--trace-http",
      "--report",
      report,
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, CANTRIP_RUST_SERVER_BINARY: executable },
      stdio: "inherit",
    },
  );
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  results.push({
    iteration,
    report,
    startedAt: started,
    elapsedMs: Date.now() - started,
    ...exit,
  });
  await writeFile(
    path.join(directory, "runs.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  assert.equal(
    exit.code,
    0,
    `discovery lifetime iteration ${iteration} failed (${exit.signal ?? exit.code}); retained ${report}`,
  );
  const evidence = JSON.parse(await readFile(report, "utf8"));
  assert.equal(evidence.passed, true);
  for (const profile of evidence.profiles) {
    for (const runtime of profile.runtimes) {
      const label = `${profile.profile}/${runtime.kind}`;
      const stages = runtime.lifetimeEvidence.stages;
      const closed = stages.find((stage) => stage.phase === "closed");
      const restarted = stages.find((stage) => stage.phase === "restarted");
      const recovered = stages.find(
        (stage) => stage.phase === "recovered-state-read" && stage.shutdown,
      );
      assert.ok(
        closed && restarted && recovered,
        `${label}: actual restart and durable catalog read completed`,
      );
      assert.notEqual(
        restarted.serverPid,
        closed.serverPid,
        `${label}: new server process`,
      );
      assert.equal(
        restarted.origin,
        closed.origin,
        `${label}: restart uses the same port`,
      );
      assert.equal(runtime.lifetimes.disconnected.length, 2);
      const sends = evidence.httpConnections.filter(
        (event) =>
          event.event === "send" &&
          event.method === "GET" &&
          event.path === "/api/workspaces" &&
          event.origin === restarted.origin &&
          event.at >= restarted.at &&
          event.at <= recovered.at,
      );
      assert.ok(
        sends.length > 0,
        `${label}: post-restart catalog request observed`,
      );
      for (const sent of sends) {
        const connected = evidence.httpConnections.find(
          (event) =>
            event.event === "connected" && event.socket === sent.socket,
        );
        assert.ok(connected, `${label}: actual TCP connection time recorded`);
        assert.ok(
          connected.at >= closed.at,
          `${label}: post-restart catalog used a new-process connection`,
        );
      }
    }
  }
}
