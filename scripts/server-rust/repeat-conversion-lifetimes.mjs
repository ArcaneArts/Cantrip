// Repeat successful, isolated scenarios to expose intermittent lifetime faults.
// Stop at the first real failure; never retry a failed request or scenario.
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
      default: ".qa/rust-server/conversion-lifetime-repeat",
    },
  },
  strict: true,
});
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const directory = path.resolve(values["report-directory"]);
await mkdir(directory, { recursive: true });
const executable = await buildRustServer();
const results = [];
for (let iteration = 1; iteration <= iterations; iteration++) {
  const report = path.join(directory, `iteration-${iteration}.json`);
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/server-rust/conversion-http-compatibility.mjs",
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
    `conversion lifetime iteration ${iteration} failed (${exit.signal ?? exit.code}); retained ${report}`,
  );
  const evidence = JSON.parse(await readFile(report, "utf8"));
  for (const profile of evidence.profiles) {
    for (const runtime of profile.runtimes) {
      const label = `${profile.profile}/${runtime.kind}`;
      const stages = runtime.lifetimeEvidence.stages;
      const closed = stages.find((stage) => stage.phase === "closed");
      const restarted = stages.find((stage) => stage.phase === "restarted");
      const recovered = stages.find(
        (stage) => stage.phase === "recovered-state-read",
      );
      assert.ok(
        closed && restarted && recovered,
        `${label}: actual restart completed`,
      );
      const sends = evidence.httpConnections.filter(
        (event) =>
          event.event === "send" &&
          event.method === "GET" &&
          event.origin === restarted.origin &&
          event.at >= restarted.at &&
          event.at <= recovered.at,
      );
      assert.ok(sends.length > 0, `${label}: actual post-restart GET observed`);
      for (const sent of sends) {
        const connected = evidence.httpConnections.find(
          (event) =>
            event.event === "connected" && event.socket === sent.socket,
        );
        assert.ok(connected, `${label}: actual TCP connection time recorded`);
        assert.ok(
          connected.at >= closed.at,
          `${label}: post-restart request did not reuse a previous-process connection`,
        );
      }
    }
  }
}
