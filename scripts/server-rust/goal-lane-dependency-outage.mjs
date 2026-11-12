// Stop only a dependency owned by the disposable product fixture. Release
// the actual observation response while the selected dependency is down.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";

const readinessTimeoutMs = 5000;

async function probe({ kind, server }, route = "/readyz") {
  const started = performance.now();
  try {
    const response = await fetch(server.origin + route, {
      signal: AbortSignal.timeout(readinessTimeoutMs),
    });
    const body = await response.json();
    return {
      kind,
      status: response.status,
      body,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      kind,
      transportError: error.name,
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}

function assertReadiness(peer, dependency, offline) {
  assert.equal(peer.transportError, undefined, `${peer.kind} readiness probe`);
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

export async function sharedDependencyReadiness(peers, dependency, offline) {
  return eventually(
    () => Promise.all(peers.map((peer) => probe(peer))),
    (samples) => {
      for (const sample of samples)
        assertReadiness(sample, dependency, offline);
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

export async function redisIdentity(service) {
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
  const nativePeers = postgres
    ? fixture.peers.filter(({ kind }) => kind === "rust")
    : fixture.peers;
  const referencePeers = postgres
    ? fixture.peers.filter(({ kind }) => kind === "node")
    : [];
  const referenceSamples = [];
  function sampleReference(phase) {
    for (const peer of referencePeers) {
      referenceSamples.push(
        Promise.all([probe(peer), probe(peer, "/healthz")]).then(
          ([readiness, liveness]) => ({ phase, readiness, liveness }),
        ),
      );
    }
  }
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
    sampleReference("after-stop");
    outage.offlineReadiness = await sharedDependencyReadiness(
      nativePeers,
      dependency,
      true,
    );
    if (postgres) {
      outage.redisDuringOutage = await fixture.redis.client.ping();
      assert.equal(outage.redisDuringOutage, "PONG");
    }
    const rustServers = nativePeers.map(({ server }) => server);
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
    sampleReference("after-observation");
    const referenceWindowEnd = performance.now() + readinessTimeoutMs + 250;
    outage.outcomeReadiness = await sharedDependencyReadiness(
      nativePeers,
      dependency,
      true,
    );
    // The legacy pool may back off past the HTTP deadline. Sample it during
    // a fixed outage window and restart the database on the same schedule.
    if (referenceSamples.length) {
      await delay(Math.max(0, referenceWindowEnd - performance.now()));
    }
  } finally {
    outage.offlineMs = Math.round(performance.now() - stoppedAt);
    outage.restart = await service.start();
  }
  if (referenceSamples.length) {
    outage.referenceOfflineReadiness = await Promise.all(referenceSamples);
    for (const { readiness, liveness } of outage.referenceOfflineReadiness) {
      assert.equal(liveness.status, 200);
      assert.equal(liveness.body.status, "alive");
      if (readiness.transportError) {
        assert.equal(readiness.transportError, "TimeoutError");
      } else assertReadiness(readiness, dependency, true);
    }
  }
  if (!postgres) {
    assert.ok(outage.offlineMs > outage.claimTtlMs);
    outage.restart = await redisIdentity(service);
  }
  assert.notEqual(outage.restart.pid, outage.stop.pid);
  assert.equal(outage.restart.port, outage.stop.port);
  outage.recoveredReadiness = await Promise.all(
    fixture.peers.map(async (peer) => {
      const [sample] = await sharedDependencyReadiness(
        [peer],
        dependency,
        false,
      );
      return sample;
    }),
  );
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
