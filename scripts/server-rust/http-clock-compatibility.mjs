// Real process controls for opt-in Node and development-only native observers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import {
  startOperationClock,
  assertGeneratedAtInOperation,
} from "./operation-clock.mjs";

const at = process.argv.indexOf("--report");
const reportPath = at < 0 ? undefined : process.argv[at + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-http-clock-"));
const report = {
  suite: "actual-http-producer-clock-controls",
  completeReplacement: false,
  runtimes: [],
};
let failure;
try {
  const production = await buildRustServer();
  const observed = await buildRustExample("http-clock-fixture");
  for (const kind of ["node", "rust"])
    for (const enabled of [false, true]) {
      const fixture = new HttpFixture({
        kind,
        executable: enabled ? observed : production,
        root,
        name: `clock-${enabled}`,
        databaseMode: "pglite",
        observeHttpClocks: enabled,
      });
      const result = {
        kind,
        enabled,
        requests: [],
        events: [],
        rejectedOutsideValues: 0,
      };
      report.runtimes.push(result);
      try {
        await fixture.start();
        for (const [label, url, status] of [
          ["health", "/healthz", 200],
          ["ready", "/readyz", 200],
          ["missing", "/__http_clock_missing", 404],
        ]) {
          const finish = startOperationClock();
          const response = await fixture.observe(label, "GET", url, { status });
          const parentClock = finish();
          const requestId = [...fixture.requests].findLast(
            ([, value]) => value === label,
          )[0];
          result.requests.push({
            label,
            requestId,
            parentClock,
            response,
            rawTimestamp: fixture.records.get(label)?.timestamp ?? null,
          });
        }
        const server = fixture.server;
        await fixture.close();
        result.events = server.events.filter(
          (event) => event.event === "fixture.http.clock",
        );
        assert.equal(
          result.events.length,
          enabled ? 3 : 0,
          `${kind}: observers must be independent of ordinary execution`,
        );
        if (enabled)
          for (const request of result.requests) {
            const matching = result.events.filter(
              (event) => event.requestId === request.requestId,
            );
            assert.equal(
              matching.length,
              1,
              "Exactly one actual producer receipt per HTTP request",
            );
            const timing = {
              ...request,
              operationClock: matching[0].operationClock,
              actualGeneratedAt: request.rawTimestamp,
            };
            if (request.rawTimestamp !== null) {
              assertGeneratedAtInOperation(timing);
              for (const outside of [
                timing.operationClock.before - 1,
                timing.operationClock.after + 1,
              ]) {
                assert.throws(() =>
                  assertGeneratedAtInOperation({
                    ...timing,
                    actualGeneratedAt: new Date(outside).toISOString(),
                    parentClock: {
                      before: outside - 10,
                      after: outside + 10,
                      elapsedNanoseconds: "20000000",
                    },
                  }),
                );
                result.rejectedOutsideValues++;
              }
            }
          }
      } finally {
        await fixture.close();
      }
    }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    requests: report.runtimes.reduce((n, r) => n + r.requests.length, 0),
    rejectedOutsideValues: report.runtimes.reduce(
      (n, r) => n + r.rejectedOutsideValues,
      0,
    ),
  }),
);
