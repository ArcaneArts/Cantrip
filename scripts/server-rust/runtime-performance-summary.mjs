import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    report: { type: "string" },
    warmups: { type: "string", default: "5" },
    iterations: { type: "string", default: "20" },
  },
});
const root = path.resolve(values.root);
const warmups = Number(values.warmups),
  iterations = Number(values.iterations);
assert.ok(Number.isInteger(warmups) && warmups >= 0);
assert.ok(Number.isInteger(iterations) && iterations > 0);
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  assert.ok(n && sorted.every(Number.isFinite));
  return {
    median:
      n % 2
        ? sorted[Math.floor(n / 2)]
        : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1],
    count: n,
  };
};
function metrics(r) {
  const result = {
    warmReadyMs: r.readyMs,
    idleRssKiB: r.idleRssKiB.median,
    readRequestsPerSecond: r.concurrentReads.requestsPerSecond,
    pausedConsumerWriteMs: r.pausedConsumerWriteMs,
    pausedConsumerCatchupMs: r.pausedConsumerCatchupMs,
    shutdownMs: r.shutdownMs,
  };
  for (const [name, observation] of [
    ["bootstrap", r.httpLatencyMs["/api/bootstrap"]],
    ["settings", r.httpLatencyMs["/api/settings"]],
    ["projects", r.httpLatencyMs["/api/projects"]],
    ["livePing", r.livePingMs],
    ["settingsWrite", r.settingsWriteMs],
    ["workerEnrollmentLive", r.workerEnrollmentToLiveMs],
  ]) {
    result[name + "MedianMs"] = observation.median;
    result[name + "RunP95Ms"] = observation.p95;
  }
  return result;
}
const runs = {};
for (const runtime of ["node", "rust"]) {
  const directory = path.join(root, runtime, "runs");
  const files = (await readdir(directory))
    .filter((f) => f.endsWith(".json"))
    .sort();
  assert.equal(
    files.length,
    warmups + iterations,
    runtime + " actual run count",
  );
  const all = await Promise.all(
    files.map(async (f) =>
      JSON.parse(await readFile(path.join(directory, f), "utf8")),
    ),
  );
  assert.ok(
    all.every((r) => r.status === "passed" && r.exit.code === 0),
    runtime + " workload/shutdown failures",
  );
  assert.ok(
    all.slice(1).every((r) => r.previousWritesRetained),
    runtime + " durable restart failures",
  );
  assert.equal(
    new Set(all.map((r) => r.identity)).size,
    1,
    runtime + " server identity changed",
  );
  runs[runtime] = all.slice(warmups).map(metrics);
}
const comparison = {};
for (const key of Object.keys(runs.node[0])) {
  const baseline = stats(runs.node.map((r) => r[key]));
  const candidate = stats(runs.rust.map((r) => r[key]));
  comparison[key] = {
    node: baseline,
    rust: candidate,
    medianDeltaPercent: (candidate.median / baseline.median - 1) * 100,
  };
}
const result = {
  warmupsPerRuntime: warmups,
  measuredRunsPerRuntime: iterations,
  allRunsPassed: true,
  writesAndIdentityRetainedAcrossWarmRestarts: true,
  metrics: comparison,
  interpretation:
    "Run-level median and p95. Fields named RunP95 aggregate per-run request p95s; these are not pooled percentiles. Throughput higher is better; time/RSS lower is better. Small local PGlite workload only; bulk relays, sustained backpressure, large profiles, other stores and fault recovery require separate measurements.",
};
if (values.report)
  await writeFile(values.report, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
