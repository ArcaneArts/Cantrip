// Stop only a dependency owned by the disposable product fixture. Release
// the actual observation response while the selected dependency is down.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";

async function readiness(fixture, dependency, offline) {
  return eventually(
    () =>
      Promise.all(
        fixture.peers.map(async ({ server }) => {
          try {
            const response = await fetch(server.origin + "/readyz", {
              signal: AbortSignal.timeout(5000),
            });
            return { status: response.status, body: await response.json() };
          } catch (error) {
            return { error };
          }
        }),
      ),
    (peers) => {
      for (const peer of peers) {
        assert.ifError(peer.error);
        assert.equal(peer.status, offline ? 503 : 200);
        assert.equal(peer.body.database.engine, "postgres");
        assert.equal(
          peer.body.database.status,
          offline && dependency === "postgres" ? "unavailable" : "ready",
        );
        assert.deepEqual(peer.body.coordination, {
          shared: true,
          status: offline ? "unavailable" : "ready",
        });
      }
    },
  );
}

function postgresQueueRetries(server) {
  return server
    .diagnostics()
    .split("\n")
    .filter(
      (line) =>
        line.includes("Managed queue notification will retry") &&
        (line.includes("error connecting to server") ||
          line.includes("db error")),
    ).length;
}

async function redisIdentity(service) {
  const info = await service.client.sendCommand(["INFO", "server"]);
  const pid = Number(/^process_id:(\d+)\r?$/m.exec(info)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0);
  return { pid, port: service.port };
}

export async function interruptGoalLaneDependency({
  fixture,
  workerId,
  before,
  dependency,
  cluster,
  faultFile,
  db,
  evidence,
}) {
  assert.ok(["redis", "postgres"].includes(dependency));
  const postgres = dependency === "postgres";
  const service = postgres ? cluster : fixture.redis;
  const serverPids = fixture.peers.map(({ server }) => server.child.pid);
  const outage = (evidence.dependencyOutage = { dependency, serverPids });
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
  try {
    if (postgres) assert.equal(outage.stop.requestedSignal, "SIGQUIT");
    else {
      assert.equal(outage.stop.signal, "SIGKILL");
      assert.equal(outage.stop.code, null);
    }
    outage.offlineReadiness = await readiness(fixture, dependency, true);
    if (postgres) {
      outage.redisDuringOutage = await fixture.redis.client.ping();
      assert.equal(outage.redisDuringOutage, "PONG");
    }
    const rustServers = fixture.peers
      .filter(({ kind }) => kind === "rust")
      .map(({ server }) => server);
    const previousRetries = postgres
      ? rustServers.map(postgresQueueRetries)
      : [];
    await writeFile(faultFile + ".resume", "");
    const released = await eventually(
      () => readFile(faultFile, "utf8").then(JSON.parse),
      (record) => assert.ok(record.releasedObservations?.length > 0),
    );
    assert.equal(released.deliveryId, evidence.beforeLoss.deliveryId);
    outage.releasedObservations = released.releasedObservations;
    assert.ok(outage.releasedObservations.includes(true));
    if (postgres) {
      outage.retryingPeerPids = await eventually(
        () =>
          rustServers.flatMap((server, index) =>
            postgresQueueRetries(server) > previousRetries[index]
              ? [server.child.pid]
              : [],
          ),
        (pids) => assert.ok(pids.length > 0),
      );
    } else {
      await delay(
        Math.max(0, outage.claimTtlMs + 500 - (performance.now() - stoppedAt)),
      );
      outage.offlineState = await db.read();
      assert.equal(
        outage.offlineState.cycle_turn_id,
        evidence.beforeLoss.turnId,
      );
    }
    outage.outcomeReadiness = await readiness(fixture, dependency, true);
  } finally {
    outage.offlineMs = Math.round(performance.now() - stoppedAt);
    outage.restart = await service.start();
  }
  if (!postgres) {
    assert.ok(outage.offlineMs > outage.claimTtlMs);
    outage.restart = await redisIdentity(service);
  }
  assert.notEqual(outage.restart.pid, outage.stop.pid);
  assert.equal(outage.restart.port, outage.stop.port);
  outage.recoveredReadiness = await readiness(fixture, dependency, false);
  assert.deepEqual(
    fixture.peers.map(({ server }) => server.child.pid),
    serverPids,
  );
  return eventually(
    () => fixture.workerClaim(workerId),
    (claim) => {
      assert.equal(claim?.instanceId, before.instanceId);
      assert.ok(claim.connectionId);
      if (!postgres) assert.notEqual(claim.connectionId, before.connectionId);
      assert.deepEqual(claim.continuityIdentity, before.continuityIdentity);
    },
  );
}
