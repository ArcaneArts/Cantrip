import assert from "node:assert/strict";
// Exercise the production 30s renewal/sweep and 2-minute expiry without clock
// substitution or mutating durable leases behind the executor's back.
export async function replicaLeaseCases({
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
  live,
  events,
}) {
  const secondReplica = (await read(replicasPath)).find(
    (replica) => replica.workerId === "replica-b",
  );
  assert.ok(
    secondReplica,
    "lease scenario uses the reconnected second replica",
  );
  leaseState.holdSync = true;
  await visit(
    "held lease synchronization",
    "POST",
    `${replicasPath}/${firstReplica.id}/synchronize`,
    {
      status: 202,
      json: {
        repository,
        expectedRevision: nextRevision,
        idempotencyKey: "held-lease",
      },
    },
  );
  const held = fixture.records.get("held lease synchronization");
  const heldProgress = await until(
    () => read(`/api/project-replica-jobs/${held.id}`),
    (job) => {
      assert.equal(job.state, "running");
      assert.equal(job.progress.percent, 25);
      assert.equal(job.attempt, 1);
    },
  );
  leaseState.staleSync = true;
  await visit(
    "stale completion synchronization",
    "POST",
    `${replicasPath}/${secondReplica.id}/synchronize`,
    {
      status: 202,
      json: {
        repository,
        expectedRevision: nextRevision,
        idempotencyKey: "stale-completion",
      },
    },
  );
  const stale = fixture.records.get("stale completion synchronization");
  await until(
    () => read(`/api/project-replica-jobs/${stale.id}`),
    (job) => {
      assert.equal(job.state, "running");
      assert.equal(job.progress.percent, 25);
      assert.equal(job.attempt, 1);
    },
  );
  await visit(
    "stale completion still running",
    "GET",
    `/api/project-replica-jobs/${stale.id}`,
  );
  let heartbeatError, heartbeatPending;
  let heartbeatSequence = 0;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = live
      .ping(`lease heartbeat ${++heartbeatSequence}`)
      .catch((error) => {
        heartbeatError = error;
      })
      .finally(() => {
        heartbeatPending = undefined;
      });
  }, 10000);
  let recovered;
  try {
    recovered = await waitJob(stale.id, "succeeded", 190000);
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatPending;
  }
  if (heartbeatError) throw heartbeatError;
  assert.equal(recovered.attempt, 2);
  assert.ok(
    Date.now() - Date.parse(heldProgress.progress.updatedAt) >= 120000,
    "held worker remained active beyond its original two-minute lease",
  );
  const stillHeld = await read(`/api/project-replica-jobs/${held.id}`);
  assert.equal(stillHeld.state, "running");
  assert.equal(stillHeld.attempt, 1);
  assert.equal(stillHeld.stateRevision, 3);
  assert.equal(
    commands.filter(({ command }) => command.jobId === held.id).length,
    1,
    "renewed active command was never redispatched",
  );
  await visit(
    "renewed held job",
    "GET",
    `/api/project-replica-jobs/${held.id}`,
  );
  await visit(
    "stale completion recovered",
    "GET",
    `/api/project-replica-jobs/${stale.id}`,
  );
  assert.deepEqual(
    commands
      .filter(({ command }) => command.jobId === stale.id)
      .map(({ command }) => command.attempt),
    [1, 2],
  );
  leaseState.holdSync = false;
  releases.get(held.id)();
  releases.delete(held.id);
  await waitJob(held.id, "succeeded");
  await visit(
    "renewed job succeeded",
    "GET",
    `/api/project-replica-jobs/${held.id}`,
  );
  await live.ping("lease recovery barrier");
  for (const [job, revisions] of [
    [held.id, [1, 3, 4]],
    [stale.id, [1, 3, 6, 7]],
  ]) {
    const jobEvents = live.history.filter(
      (event) =>
        event.type === "event" &&
        event.resource === "project-replica-job" &&
        event.entityId === job,
    );
    assert.deepEqual(
      jobEvents.map((event) => event.revision),
      revisions,
    );
    events.push(...jobEvents);
  }
}
