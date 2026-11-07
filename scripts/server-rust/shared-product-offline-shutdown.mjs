// Exercise real production shutdown without restoring the unavailable service.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";

export async function verifySharedProductOfflineShutdown({
  fixture,
  worker,
  workerId,
  result,
}) {
  const claim = await fixture.assertRemoteWorker(workerId);
  const workerPid = worker.child.pid;
  const ttl = Number(fixture.environment.CANTRIP_COORDINATION_PRESENCE_TTL_MS);
  const report = (result.redisOfflineShutdown = {
    originalClaim: claim,
    originalWorkerPid: workerPid,
    presenceTtlMs: ttl,
    samples: [],
  });
  await fixture.redis.client.sendCommand(["SAVE"]);
  await fixture.redis.stop();
  const started = performance.now();
  for (let interval = 0; interval < 4; interval++) {
    for (const [index, peer] of fixture.peers.entries()) {
      const value = await eventually(
        async () => {
          const response = await fetch(peer.server.origin + "/readyz", {
            signal: AbortSignal.timeout(5000),
          });
          return { status: response.status, body: await response.json() };
        },
        (value) => {
          assert.equal(value.status, 503);
          assert.equal(value.body.database.status, "ready");
          assert.deepEqual(value.body.coordination, {
            shared: true,
            status: "unavailable",
          });
        },
      );
      report.samples.push({
        peer: index,
        kind: peer.kind,
        elapsedMs: performance.now() - started,
        ...value,
      });
    }
    if (interval < 3) await delay(ttl + 100);
  }
  report.outageMs = performance.now() - started;
  assert.ok(report.outageMs > ttl * 3);
  assert.equal(worker.child.pid, workerPid);
  assert.equal(worker.child.exitCode, null);
  assert.equal(worker.child.signalCode, null);
  const closing = performance.now();
  try {
    await fixture.close({ shutdownTimeoutMs: 30_000 });
  } finally {
    report.shutdownMs = performance.now() - closing;
    report.serverGenerations = fixture.generations;
    report.redisStillOffline = fixture.redis.client === null;
  }
  assert.equal(report.redisStillOffline, true);
  assert.ok(report.shutdownMs < 30_000);
  assert.equal(worker.child.pid, workerPid);
  assert.equal(worker.child.exitCode, null);
  assert.equal(worker.child.signalCode, null);
  result.steps.push(
    "production peers exit cleanly with the same full worker alive after Redis stays unavailable beyond three presence TTLs",
  );
}
