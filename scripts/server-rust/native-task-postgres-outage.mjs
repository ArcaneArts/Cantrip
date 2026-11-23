// Watch the full worker's durable outcome delivery while PostgreSQL is down.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { taskGoalOutcomeDeliverySchema } from "../../packages/protocol/dist/index.js";
import { eventually } from "./full-worker.mjs";

async function readiness(fixture, status) {
  return eventually(
    () =>
      Promise.all(
        fixture.peers.map(async ({ server }) => {
          const response = await fetch(server.origin + "/readyz", {
            signal: AbortSignal.timeout(10_000),
          });
          return { status: response.status, body: await response.json() };
        }),
      ),
    (peers) => {
      for (const peer of peers) {
        assert.equal(peer.status, status === "ready" ? 200 : 503);
        assert.equal(peer.body.database.engine, "postgres");
        assert.equal(peer.body.database.status, status);
        assert.deepEqual(peer.body.coordination, {
          shared: true,
          status,
        });
      }
    },
  );
}

async function readPendingOutcome(directory, chatId, operationId) {
  for (const name of await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
    const filename = path.join(directory, name);
    const bytes = await readFile(filename).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!bytes) continue;
    const value = taskGoalOutcomeDeliverySchema.parse(JSON.parse(bytes));
    if (
      value.notification.chatId === chatId &&
      value.notification.taskDispatchFence?.operationId === operationId
    )
      return {
        filename,
        value,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
  }
  return null;
}

export async function nativeTaskPostgresOutage({
  fixture,
  cluster,
  worker,
  workerId,
  claim,
  dataDirectory,
  serverId,
  ownerId,
  dispatch,
  active,
  reply,
  assertOriginalStream,
}) {
  const outage = (active.postgresOutage = {
    serverPids: fixture.peers.map(({ server }) => server.child.pid),
    workerPid: worker.child.pid,
    before: claim,
  });
  const namespace = createHash("sha256")
    .update(JSON.stringify([serverId, ownerId, workerId]))
    .digest("hex");
  const directory = path.join(dataDirectory, "task-goal-outcomes", namespace);
  const deliveryWarnings = () =>
    worker
      .diagnostics()
      .split("\n")
      .filter((line) => line.includes("event=task.outcome-delivery-pending"));
  const priorWarnings = new Set(deliveryWarnings());
  outage.stop = await cluster.stop({ immediate: true });
  const stoppedAt = performance.now();
  let pending;
  try {
    assert.equal(outage.stop.requestedSignal, "SIGQUIT");
    outage.offlineReadiness = await readiness(fixture, "unavailable");
    outage.redisDuringOutage = await fixture.redis.client.ping();
    assert.equal(outage.redisDuringOutage, "PONG");
    assertOriginalStream();
    reply.release();
    await eventually(
      () => reply.request,
      (request) => assert.equal(request.completed, true),
    );
    pending = await eventually(
      () => readPendingOutcome(directory, active.chatId, dispatch.operation_id),
      (record) =>
        assert.ok(record, "original native outcome is durable locally"),
      50_000,
    );
    const { value } = pending;
    assert.equal(value.serverId, serverId);
    assert.equal(value.ownerId, ownerId);
    assert.equal(value.workerId, workerId);
    assert.equal(value.inputKind, "round");
    assert.equal(value.notification.outcome.ok, true);
    assert.deepEqual(value.notification.taskDispatchFence, {
      cycleId: dispatch.id,
      operationId: dispatch.operation_id,
      leaseOwner: dispatch.lease_owner,
      fencingToken: Number(dispatch.fencing_token),
    });
    outage.pendingOutcome = {
      deliveryId: value.deliveryId,
      taskInferenceInputOperationId:
        value.notification.taskInferenceInputOperationId,
      fence: value.notification.taskDispatchFence,
      sha256: pending.sha256,
    };
    outage.failedDelivery = await eventually(
      () => deliveryWarnings().find((line) => !priorWarnings.has(line)),
      (line) =>
        assert.ok(
          line,
          "authenticated outcome delivery fails during the real outage",
        ),
      20_000,
    );
    await delay(Math.max(0, 45_000 - (performance.now() - stoppedAt)));
    outage.outcomeReadiness = await readiness(fixture, "unavailable");
    assert.equal(await fixture.redis.client.ping(), "PONG");
    assert.equal(reply.request.closedBeforeCompletion, false);
    assert.equal(
      createHash("sha256")
        .update(await readFile(pending.filename))
        .digest("hex"),
      pending.sha256,
    );
  } finally {
    outage.offlineMs = performance.now() - stoppedAt;
    outage.restart = await cluster.start();
  }
  assert.notEqual(outage.restart.pid, outage.stop.pid);
  assert.equal(outage.restart.port, outage.stop.port);
  outage.recoveredReadiness = await readiness(fixture, "ready");
  await eventually(
    () =>
      stat(pending.filename).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ),
    (exists) =>
      assert.equal(exists, false, "matching commit drains the outbox"),
    60_000,
  );
  outage.outboxDrained = true;
  outage.after = await eventually(
    () => fixture.workerClaim(workerId),
    (value) => {
      assert.equal(value?.instanceId, claim.instanceId);
      assert.deepEqual(value.continuityIdentity, claim.continuityIdentity);
    },
  );
  assert.deepEqual(
    fixture.peers.map(({ server }) => server.child.pid),
    outage.serverPids,
  );
}
