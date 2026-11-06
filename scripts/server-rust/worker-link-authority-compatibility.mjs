import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { bridgePeer, redisFixture } from "./coordinated-fixture-tools.mjs";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
import { verifyAuthorityOperations } from "./worker-link-authority-operation-cases.mjs";
import { verifyAuthorityFences } from "./worker-link-authority-fence-cases.mjs";
import { verifyAuthorityRevocations } from "./worker-link-authority-revocation-cases.mjs";
const { values } = parseArgs({
  options: {
    pair: { type: "string", multiple: true },
    "redis-bin": { type: "string" },
    report: { type: "string" },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-link-authority-"),
);
const report = {
  suite: "real-redis-worker-link-authority",
  root,
  completeReplacement: false,
  platform: process.platform,
  architecture: process.arch,
  scope:
    "Actual Node WorkerLinkService and native Authority/local coordinators with real private Redis and controlled worker ACKs. No SQL, HTTP, production startup or real-worker product claim.",
  cases: [],
};
async function save() {
  if (!values.report) return;
  await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
await save();
const executable = await buildRustExample("worker-link-authority-fixture");
const redis = await redisFixture(
  values["redis-bin"] ?? process.env.CANTRIP_TEST_REDIS_BIN ?? "redis-server",
  root,
);
const configuration = {
  ...workerLinkWireFixtures.workerLinkPeerConfigurationSchema[0],
  directRoutes: { local: true, lan: true, wan: true },
};
const peers = [];
async function run(pair) {
  const kinds = pair.split("/");
  assert.ok(
    kinds.length === 2 && kinds.every((k) => ["node", "rust"].includes(k)),
  );
  const observation = { pair, steps: [] };
  report.cases.push(observation);
  const prefix = "cantrip:relay:v1:link-" + randomUUID();
  const make = (kind, name) =>
    bridgePeer(
      kind,
      executable,
      root,
      pair.replace("/", "-") + "-" + name,
      "scripts/server-rust/worker-link-authority-node.mjs",
    );
  const a = make(kinds[0], "a"),
    b = make(kinds[1], "b");
  peers.push(a, b);
  const messages = [];
  const tap = redis.client.duplicate();
  tap.on("error", () => {});
  await tap.connect();
  await tap.subscribe(prefix + ":messages", (raw) =>
    messages.push(JSON.parse(raw)),
  );
  const options = (instanceId) => ({
    url: redis.url,
    instanceId,
    keyPrefix: prefix,
    presenceTtlMs: 60000,
    maximumInstances: 4,
  });
  const init = (instance) => ({
    options: options(instance),
    configuration,
    serverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    serverGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workerGeneration: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  const context = {
    a,
    b,
    redis,
    messages,
    prefix,
    key: (session) => `${prefix}:worker-link:${encodeURIComponent(session)}`,
    step(name) {
      observation.steps.push(name);
    },
  };
  let failure;
  try {
    await a.call("init", init("a"));
    await b.call("init", init("b"));
    await verifyAuthorityOperations(context);
    await verifyAuthorityRevocations(context);
    await verifyAuthorityFences(context);
    observation.passed = true;
  } catch (error) {
    failure = error;
    observation.failure = error.stack;
    throw error;
  } finally {
    await writeFile(
      path.join(root, pair.replace("/", "-") + "-redis-messages.json"),
      JSON.stringify(messages, null, 2) + "\n",
    );
    if (tap.isOpen) await tap.quit();
    const stopped = await Promise.allSettled([a.stop(), b.stop()]);
    observation.shutdown = stopped.map((v) =>
      v.status === "fulfilled"
        ? { ok: true }
        : { ok: false, error: String(v.reason) },
    );
    await save();
    if (!failure)
      assert.ok(
        stopped.every((v) => v.status === "fulfilled"),
        JSON.stringify(observation.shutdown),
      );
  }
}
try {
  for (const pair of values.pair ?? [
    "node/node",
    "node/rust",
    "rust/node",
    "rust/rust",
  ])
    await run(pair);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await Promise.allSettled(peers.map((p) => p.stop()));
  await redis.stop();
  await save();
}
console.log(JSON.stringify(report, null, 2));
