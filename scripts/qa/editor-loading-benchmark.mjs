import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const iterations = Number(option("--iterations", "3"));
const warmups = Number(option("--warmups", "1"));
assert.ok(
  Number.isInteger(iterations) &&
    iterations > 0 &&
    Number.isInteger(warmups) &&
    warmups >= 0,
);
const label = option("--label", "current");
const output = path.resolve(
  option("--output", path.join(root, ".qa", `loading-${label}.json`)),
);
await mkdir(path.dirname(output), { recursive: true });
const observations = [];
for (let iteration = 0; iteration < warmups + iterations; iteration++) {
  let directory;
  let lastOutput = "";
  const child = spawn(
    process.execPath,
    [
      path.join(root, "scripts/qa/editor-recovery-browser.mjs"),
      "--case",
      "cold-editor-usable,warm-close-reopen,transient-renewal",
    ],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("QA_EVT ")) continue;
      try {
        const event = JSON.parse(line.slice(7));
        if (event.type === "fixture.ready") directory = event.directory;
      } catch {
        /* Non-event build output. */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    lastOutput = (lastOutput + chunk.toString()).slice(-2000);
  });
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const observation = {
    iteration,
    warmup: iteration < warmups,
    exitCode: code,
  };
  if (directory) {
    assert.ok(directory.startsWith(`${path.join(root, ".qa", "editor-")}`));
    const results = JSON.parse(
      await readFile(path.join(directory, "browser-results.json"), "utf8"),
    );
    const metrics = JSON.parse(
      await readFile(path.join(directory, "browser-metrics.json"), "utf8"),
    );
    const workerLog = await readFile(
      path.join(directory, "worker.log"),
      "utf8",
    );
    const stages = metrics.workbenchTimeline;
    const first = (stage) =>
      stages.find((entry) => entry.stage === stage && entry.visible)?.at;
    const bootstrapping = first("bootstrapping");
    const ready = first("ready");
    const firstRequest = (match) => metrics.networkTimings.find(match);
    const session = firstRequest((entry) =>
      entry.path.endsWith("/worker-link/sessions"),
    );
    const document = firstRequest(
      (entry) =>
        entry.path.startsWith("/__cantrip_code/") &&
        entry.path.endsWith("/code/"),
    );
    const duration = (request) =>
      request?.responseEnd >= 0 ? request.responseEnd : null;
    observation.cases = results.results.map(
      ({ name, status, durationMs, evidence, error }) => ({
        name,
        status,
        durationMs,
        ...(evidence?.phases
          ? {
              phases: evidence.phases,
              setupRetries: evidence.setupRetries,
              modeRetries: evidence.modeRetries,
            }
          : {}),
        ...(error ? { error: error.split("\n")[0] } : {}),
      }),
    );
    observation.phases = {
      profileEndpointReadyMs: [
        ...workerLog.matchAll(
          /event=code\.profile\.ready[^\n]*durationMs=(\d+)/gu,
        ),
      ].map((match) => Number(match[1])),
      sessionCreateMs: duration(session),
      documentCompleteMs: duration(document),
      workbenchBootstrapToReadyMs:
        ready !== undefined && bootstrapping !== undefined
          ? ready - bootstrapping
          : null,
      stages: stages.map(({ at, stage, visible }) => ({
        offsetFromBootstrapMs:
          bootstrapping === undefined ? null : at - bootstrapping,
        stage,
        visible,
      })),
      extensionBridgeReadyMs: [
        ...workerLog.matchAll(
          /event=code\.bridge\.connected[^\n]*durationMs=(\d+)/gu,
        ),
      ].map((match) => Number(match[1])),
      presentationMs: [
        ...workerLog.matchAll(
          /event=code\.session\.presentation\.completed[^\n]*durationMs=(\d+)/gu,
        ),
      ].map((match) => Number(match[1])),
      workerFileOpenMs: [
        ...workerLog.matchAll(
          /event=code\.session\.file-open\.completed[^\n]*durationMs=(\d+)/gu,
        ),
      ].map((match) => Number(match[1])),
      socketHandshakes: metrics.socketHandshakes.map((entry) => ({
        ...entry,
        path: entry.path.replace(
          /\/worker-links\/[^/]+/u,
          "/worker-links/:session",
        ),
      })),
    };
    observation.rendererMetrics = metrics.rendererMetrics;
    observation.garbageCollected = metrics.garbageCollected;
    observation.retainedRendererMetrics = metrics.retainedRendererMetrics;
    observation.assetRequests = metrics.networkTimings.filter((entry) =>
      entry.path.includes("/static/"),
    ).length;
    const assets = metrics.networkTimings.filter((entry) =>
      entry.path.includes("/static/"),
    );
    observation.completedAssetResponseBytes = assets
      .filter((entry) => entry.responseBodyBytes >= 0)
      .reduce((sum, entry) => sum + entry.responseBodyBytes, 0);
    observation.assetRequestsWithUnavailableSizes = assets.filter(
      (entry) => entry.responseBodyBytes < 0,
    ).length;
    if (
      assets.length &&
      observation.assetRequestsWithUnavailableSizes === assets.length
    )
      observation.completedAssetResponseBytes = null;
  } else observation.startupError = lastOutput;
  observations.push(observation);
  await writeFile(
    output,
    JSON.stringify(
      {
        label,
        runtime: process.version,
        platform: `${process.platform}-${process.arch}`,
        iterations,
        warmups,
        observations,
      },
      null,
      2,
    ),
  );
  console.log(
    `BENCH_EVT ${JSON.stringify({ label, iteration, exitCode: code, warmup: observation.warmup })}`,
  );
}
if (observations.some((observation) => observation.exitCode !== 0))
  process.exitCode = 1;
