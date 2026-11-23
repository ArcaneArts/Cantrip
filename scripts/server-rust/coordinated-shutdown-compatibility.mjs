// Shutdown fencing around actual bridges, owner lookups and private real Redis.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import {
  bridgePeer,
  eventually,
  redisFixture,
} from "./coordinated-fixture-tools.mjs";
const { values } = parseArgs({
  options: {
    "redis-bin": { type: "string" },
    pair: { type: "string", multiple: true },
    report: { type: "string" },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-coordinated-shutdown-"),
);
const report = {
  root,
  suite: "coordinated-shutdown",
  completeReplacement: false,
  cases: [],
};
let redis;
async function event(peer, matches) {
  return eventually(
    async () => {
      await peer.drain();
      return peer.events.find(matches);
    },
    (v) => v !== undefined,
    "actual bridge shutdown completion",
  );
}
async function run(pair, executable) {
  const kinds = pair.split("/");
  const item = { pair, steps: [] };
  report.cases.push(item);
  const a = bridgePeer(
      kinds[0],
      executable,
      root,
      pair.replace("/", "-") + "-a",
    ),
    b = bridgePeer(kinds[1], executable, root, pair.replace("/", "-") + "-b");
  try {
    for (const [i, peer] of [a, b].entries())
      await peer.call("init", {
        options: {
          url: redis.url,
          instanceId: i ? "b" : "a",
          keyPrefix: "cantrip:shutdown:" + pair,
          presenceTtlMs: 60000,
          maximumInstances: 2,
        },
      });
    for (const workerId of ["pending", "held"])
      assert.equal(
        await b.call("attach", { workerId, peer: workerId, ownerId: "owner" }),
        true,
      );
    await a.call("begin", {
      workerId: "pending",
      name: "pending",
      command: { type: "worker.version" },
      options: { ownerId: "owner", timeoutMs: null },
    });
    await event(
      b,
      (e) => e.kind === "worker-output" && e.peer === "pending" && e.text,
    );
    await a.call("gateOwner", { workerId: "held" });
    await a.call("begin", {
      workerId: "held",
      name: "held",
      command: { type: "worker.version" },
      options: { timeoutMs: 1000 },
    });
    await event(a, (e) => e.kind === "owner-lookup" && e.workerId === "held");
    await a.call("closeBridge");
    async function rejected(name) {
      const result = await event(
        a,
        (e) => e.kind === "completion" && e.name === name,
      );
      assert.equal(result.ok, false);
      assert.equal(result.error.class, "WorkerUnavailableError");
      assert.equal(result.error.message, "Server is shutting down.");
      assert.equal((await a.call("stats")).activeRequests, 0);
    }
    await rejected("pending");
    item.steps.push("existing pending command rejects during shutdown");
    await a.call("releaseOwner", { workerId: "held" });
    await rejected("held");
    item.steps.push(
      "owner lookup completing after shutdown cannot create a pending request",
    );
    await a.call("begin", {
      workerId: "held",
      name: "after",
      command: { type: "worker.version" },
      options: { ownerId: "owner", timeoutMs: 1000 },
    });
    await rejected("after");
    item.steps.push(
      "new request after shutdown rejects without remote dispatch",
    );
    await b.drain();
    assert.equal(
      b.events.filter(
        (e) => e.kind === "worker-output" && e.peer === "held" && e.text,
      ).length,
      0,
    );
    item.passed = true;
  } catch (error) {
    item.failure = error.stack;
    throw error;
  } finally {
    const stopped = await Promise.allSettled([a.stop(), b.stop()]);
    item.shutdown = stopped.map((s) => ({
      passed: s.status === "fulfilled",
      ...(s.status === "rejected" ? { error: String(s.reason) } : {}),
    }));
    if (item.passed)
      assert.ok(
        stopped.every((s) => s.status === "fulfilled"),
        JSON.stringify(item.shutdown),
      );
  }
}
try {
  const executable = await buildRustExample("coordinated-bridge-fixture");
  redis = await redisFixture(values["redis-bin"] ?? "redis-server", root);
  for (const pair of values.pair ?? [
    "node/node",
    "node/rust",
    "rust/node",
    "rust/rust",
  ])
    await run(pair, executable);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await redis?.stop();
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(JSON.stringify(report));
