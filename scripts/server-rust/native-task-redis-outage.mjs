// Interrupt only the private Redis process while actual native execution runs.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";

async function readiness(fixture, status) {
  return eventually(
    () =>
      Promise.all(
        fixture.peers.map(async ({ server }) => {
          const response = await fetch(server.origin + "/readyz", {
            signal: AbortSignal.timeout(5000),
          });
          return { status: response.status, body: await response.json() };
        }),
      ),
    (peers) => {
      for (const peer of peers) {
        assert.equal(peer.status, status === "ready" ? 200 : 503);
        assert.equal(peer.body.database.status, "ready");
        assert.deepEqual(peer.body.coordination, { shared: true, status });
      }
    },
  );
}

function dispatchCycle(snapshot, operationId) {
  const cycles = snapshot.rows.task_dispatch_cycles.filter(
    (cycle) => cycle.operation_id === operationId,
  );
  assert.equal(cycles.length, 1);
  return cycles[0];
}

export async function nativeTaskRedisOutage({
  fixture,
  workerId,
  claim,
  operationId,
  active,
  read,
  snapshot,
  reply,
  assertOriginalStream,
}) {
  const redis = fixture.redis;
  const outage = (active.redisOutage = {
    serverPids: fixture.peers.map(({ server }) => server.child.pid),
    before: claim,
  });
  const original = dispatchCycle(active.beforeCrash, operationId);
  assert.equal(original.state, "running");
  assert.equal(original.attempt_count, 1);
  // Preserve Redis's real snapshot so its worker claim must age out normally.
  await redis.client.sendCommand(["SAVE"]);
  outage.claimTtlMs = await redis.client.pTTL(
    "cantrip:relay:v1:worker:" + encodeURIComponent(workerId),
  );
  assert.ok(outage.claimTtlMs > 0);
  outage.stop = await redis.stop();
  const stoppedAt = performance.now();
  try {
    assert.equal(outage.stop.signal, "SIGKILL");
    assert.equal(outage.stop.code, null);
    outage.offlineReadiness = await readiness(fixture, "unavailable");
    await delay(
      Math.max(45_000, outage.claimTtlMs + 1000) -
        (performance.now() - stoppedAt),
    );
    outage.beforeOfflineCompletion = await snapshot();
    const renewed = dispatchCycle(outage.beforeOfflineCompletion, operationId);
    assert.equal(renewed.state, "running");
    assert.equal(renewed.lease_owner, original.lease_owner);
    assert.equal(renewed.fencing_token, original.fencing_token);
    assert.equal(renewed.attempt_count, original.attempt_count);
    assert.ok(
      Date.parse(renewed.lease_expires_at) >
        Date.parse(original.lease_expires_at),
      "the original PostgreSQL dispatch lease advances while Redis is offline",
    );
    const activeTask = await read();
    assert.equal(activeTask.state, "implementing");
    assert.equal(activeTask.activeOperationId, operationId);
    assertOriginalStream();
    reply.release();
    await eventually(
      () => reply.request,
      (request) => assert.equal(request.completed, true),
    );
    await eventually(
      read,
      (task) => assert.equal(task.state, "complete"),
      15_000,
    );
    outage.completedWhileOffline = await snapshot();
    const completed = dispatchCycle(outage.completedWhileOffline, operationId);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.attempt_count, original.attempt_count);
    assert.equal(completed.fencing_token, original.fencing_token);
    outage.offlineCompletionReadiness = await readiness(fixture, "unavailable");
  } catch (error) {
    try {
      outage.failureWhileOffline = await snapshot();
    } catch (cause) {
      outage.failureSnapshotError = cause.message;
    }
    throw error;
  } finally {
    outage.offlineMs = performance.now() - stoppedAt;
    await redis.start();
  }
  assert.ok(outage.offlineMs > outage.claimTtlMs);
  outage.recoveredReadiness = await readiness(fixture, "ready");
  outage.after = await eventually(
    () => fixture.workerClaim(workerId),
    (value) => {
      assert.equal(value?.instanceId, claim.instanceId);
      assert.ok(value.connectionId);
      assert.notEqual(value.connectionId, claim.connectionId);
      assert.deepEqual(value.continuityIdentity, claim.continuityIdentity);
    },
  );
  assert.deepEqual(
    fixture.peers.map(({ server }) => server.child.pid),
    outage.serverPids,
  );
}

export async function verifyRedisRecoveredWorker(page, workerId) {
  return page.evaluate(async (id) => {
    const api = await import("/src/lib/api/worker-link.ts");
    const session = await api.createWorkerLinkSession(
      id,
      "after-native-task-redis-recovery",
    );
    await api.deleteWorkerLinkSession(session.sessionId);
    return session.identity.workerId;
  }, workerId);
}
