import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import {
  redisIdentity,
  sharedDependencyReadiness,
} from "./goal-lane-dependency-outage.mjs";

export async function interruptTaskGoalTransferDependency({
  dependency,
  fixture,
  cluster,
  workerId,
  worker,
  file,
  held,
  interruption,
}) {
  const postgres = dependency === "postgres";
  const service = postgres ? cluster : fixture.redis;
  const serverPids = () => fixture.peers.map(({ server }) => server.child.pid);
  const outage = (interruption.dependencyOutage = {
    dependency,
    serverPids: serverPids(),
    workerPid: worker.child.pid,
    originalClaim: await fixture.assertRemoteWorker(workerId),
  });
  assert.equal(outage.workerPid, held.pid);
  if (!postgres) {
    await service.client.sendCommand(["SAVE"]);
    outage.claimTtlMs = await service.client.pTTL(
      "cantrip:relay:v1:worker:" + encodeURIComponent(workerId),
    );
    assert.ok(outage.claimTtlMs > 0);
  }
  outage.stop = postgres
    ? await service.stop({ immediate: true })
    : { ...(await service.stop()), port: service.port };
  const stoppedAt = performance.now();
  outage.stoppedAt = Date.now();
  try {
    if (postgres) {
      assert.equal(outage.stop.requestedSignal, "SIGQUIT");
      assert.equal(await fixture.redis.client.ping(), "PONG");
    } else {
      assert.equal(outage.stop.signal, "SIGKILL");
      assert.equal(outage.stop.code, null);
    }
    outage.offlineReadiness = await sharedDependencyReadiness(
      fixture.peers,
      dependency,
      true,
    );
    await writeFile(file + ".resume", "");
    outage.release = await eventually(
      () =>
        readFile(file + ".released", "utf8").then(JSON.parse, (error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      (record) => assert.ok(record),
    );
    assert.equal(outage.release.operationId, held.operationId);
    // Let Redis's recorded claim expire. During PostgreSQL loss leave time
    // for the worker to issue the next request after receiving the commit.
    await delay(
      postgres
        ? 1000
        : Math.max(
            0,
            outage.claimTtlMs + 500 - (performance.now() - stoppedAt),
          ),
    );
    outage.afterReleaseReadiness = await sharedDependencyReadiness(
      fixture.peers,
      dependency,
      true,
    );
  } finally {
    outage.offlineMs = Math.round(performance.now() - stoppedAt);
    outage.restartStartedAt = Date.now();
    outage.restart = await service.start();
  }
  if (!postgres) {
    assert.ok(outage.offlineMs > outage.claimTtlMs);
    outage.restart = await redisIdentity(service);
  }
  assert.notEqual(outage.restart.pid, outage.stop.pid);
  assert.equal(outage.restart.port, outage.stop.port);
  outage.recoveredReadiness = await sharedDependencyReadiness(
    fixture.peers,
    dependency,
    false,
  );
  outage.recoveredClaim = await eventually(
    () => fixture.workerClaim(workerId),
    (claim) => {
      assert.equal(claim?.instanceId, outage.originalClaim.instanceId);
      assert.ok(claim.connectionId);
      if (!postgres)
        assert.notEqual(claim.connectionId, outage.originalClaim.connectionId);
      assert.deepEqual(
        claim.continuityIdentity,
        outage.originalClaim.continuityIdentity,
      );
    },
  );
  assert.deepEqual(serverPids(), outage.serverPids);
  assert.equal(worker.child.exitCode, null);
  assert.equal(worker.child.signalCode, null);
}
