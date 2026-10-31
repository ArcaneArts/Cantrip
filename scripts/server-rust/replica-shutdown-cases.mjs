import assert from "node:assert/strict";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
export async function replicaShutdownCases({
  fixture,
  visit,
  read,
  waitJob,
  until,
  replicasPath,
  firstReplica,
  repository,
  nextRevision,
  leaseState,
  releases,
  commands,
  workers,
  reconnect,
  id,
}) {
  leaseState.holdSync = true;
  await visit(
    "shutdown held synchronization",
    "POST",
    `${replicasPath}/${firstReplica.id}/synchronize`,
    {
      status: 202,
      json: {
        repository,
        expectedRevision: nextRevision,
        idempotencyKey: "shutdown-held",
      },
    },
  );
  const job = fixture.records.get("shutdown held synchronization");
  await until(
    () => read(`/api/project-replica-jobs/${job.id}`),
    (value) => {
      assert.equal(value.state, "running");
      assert.equal(value.progress.percent, 25);
      assert.equal(value.attempt, 1);
    },
  );
  await until(
    () => releases.has(job.id),
    (value) => assert.equal(value, true),
  );
  const server = fixture.server;
  const port = Number(new URL(server.origin).port);
  try {
    await fixture.close();
  } finally {
    fixture.replicaShutdownStages = server.events.filter(
      (event) => event.event === "server.shutdown.stage",
    );
  }
  for (const worker of workers) worker.close();
  leaseState.holdSync = false;
  releases.get(job.id)();
  releases.delete(job.id);
  await fixture.start({ port });
  await visit(
    "shutdown retained job",
    "GET",
    `/api/project-replica-jobs/${job.id}`,
  );
  const retained = fixture.records.get("shutdown retained job");
  assert.equal(retained.state, "blocked");
  assert.equal(retained.attempt, 1);
  assert.equal(retained.stateRevision, 4);
  assert.deepEqual(retained.error, { code: "worker-offline", retryable: true });
  const live = await new LiveProbe(fixture).open();
  try {
    await live.initialized();
    await live.subscribed("after restart", [
      currentUser,
      { kind: "project", projectId: id },
    ]);
    await reconnect.get("replica-a")();
    const completed = await waitJob(job.id, "succeeded");
    assert.equal(completed.attempt, 2);
    assert.equal(completed.stateRevision, 8);
    assert.equal(completed.error, null);
    await visit(
      "shutdown resumed completion",
      "GET",
      `/api/project-replica-jobs/${job.id}`,
    );
    assert.deepEqual(
      commands
        .filter(({ command }) => command.jobId === job.id)
        .map(({ command }) => command.attempt),
      [1, 2],
    );
    await live.ping("resumed shutdown barrier");
    const events = live.history.filter(
      (event) =>
        event.type === "event" &&
        event.resource === "project-replica-job" &&
        event.entityId === job.id,
    );
    assert.deepEqual(
      events.map((event) => event.revision),
      [7, 8],
    );
    return {
      events: events.map(({ entityId, revision, scope, resource, action }) => ({
        entityId,
        revision,
        scope,
        resource,
        action,
      })),
    };
  } finally {
    await live.close();
  }
}
