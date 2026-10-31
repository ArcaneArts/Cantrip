import assert from "node:assert/strict";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { projectLabel } from "./security-fixtures.mjs";

// Use production 30-second renewal/recovery timers and two-minute leases.
// No clock substitution or direct database lease changes are involved.
export async function conversionLeaseCases({
  fixture,
  visit,
  read,
  until,
  ids,
  startInput,
  commands,
  releases,
  setMode,
  workerId,
}) {
  const route = (id) => `/api/projects/${id}/github-conversion`;
  const live = await new LiveProbe(fixture).open();
  let heartbeatTimer, heartbeatPending, heartbeatError;
  try {
    await live.initialized();
    for (let n = 7; n < 9; n++) {
      await visit("lease folder " + n, "POST", "/api/projects/from-folder", {
        status: 202,
        json: { id: ids[n], workerId, nameProtection: projectLabel },
      });
      await until(
        () => read(`/api/projects/${ids[n]}/folder-setup`),
        (job) => assert.equal(job.state, "succeeded"),
      );
    }
    await live.subscribed("conversion leases", [
      currentUser,
      ...ids.slice(7, 9).map((projectId) => ({ kind: "project", projectId })),
    ]);
    setMode("lease");
    const held = await visit(
      "renewed conversion admission",
      "POST",
      route(ids[7]),
      { status: 202, json: startInput(7) },
    );
    await until(
      () => releases.has(held.id),
      (v) => assert.equal(v, true),
    );
    const heldRunning = await read(route(ids[7]));
    assert.equal(heldRunning.state, "running");
    assert.equal(heldRunning.stateRevision, 2);
    assert.equal(heldRunning.attempt, 1);
    const started = Date.now();
    const stale = await visit(
      "stale conversion admission",
      "POST",
      route(ids[8]),
      { status: 202, json: startInput(8) },
    );
    await until(
      () => commands.filter((c) => c.jobId === stale.id).length,
      (n) => assert.equal(n, 1),
    );
    const rejected = await visit(
      "stale conversion remains running",
      "GET",
      route(ids[8]),
    );
    assert.equal(rejected.state, "running");
    assert.equal(rejected.attempt, 1);
    assert.equal(rejected.stateRevision, 2);
    let heartbeatSequence = 0;
    heartbeatTimer = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = live
        .ping(`conversion lease heartbeat ${++heartbeatSequence}`)
        .catch((error) => {
          heartbeatError = error;
        })
        .finally(() => {
          heartbeatPending = undefined;
        });
    }, 10000);
    const recovered = await until(
      () => read(route(ids[8])),
      (job) => {
        assert.equal(job.state, "succeeded", JSON.stringify(job));
        assert.equal(job.attempt, 2);
        assert.equal(job.stateRevision, 5);
      },
      190000,
    );
    assert.ok(
      Date.now() - started >= 120000,
      "worker remains held beyond the original two-minute lease",
    );
    const renewed = await visit(
      "conversion renewed beyond original lease",
      "GET",
      route(ids[7]),
    );
    assert.equal(renewed.state, "running");
    assert.equal(renewed.attempt, 1);
    assert.equal(renewed.stateRevision, 2);
    assert.equal(
      commands.filter((c) => c.jobId === held.id).length,
      1,
      "renewed conversion is never redispatched",
    );
    assert.deepEqual(
      commands.filter((c) => c.jobId === stale.id).map((c) => c.attempt),
      [1, 2],
    );
    await visit("expired stale conversion recovered", "GET", route(ids[8]));
    releases.get(held.id)();
    const completed = await until(
      () => read(route(ids[7])),
      (job) => {
        assert.equal(job.state, "succeeded");
        assert.equal(job.attempt, 1);
        assert.equal(job.stateRevision, 3);
      },
    );
    await visit("renewed conversion completed", "GET", route(ids[7]));
    await live.ping("conversion lease recovery barrier");
    const events = live.history.filter(
      (e) =>
        e.type === "event" && e.resource === "project-github-conversion-job",
    );
    for (const [id, revisions] of [
      [held.id, [1, 3]],
      [stale.id, [1, 5]],
    ]) {
      assert.deepEqual(
        events.filter((e) => e.entityId === id).map((e) => e.revision),
        revisions,
      );
    }
    return fixture.normalize({
      rejected,
      recovered,
      renewed,
      completed,
      commands: commands
        .slice()
        .sort(
          (a, b) =>
            a.projectId.localeCompare(b.projectId) || a.attempt - b.attempt,
        ),
      events: events.map(({ resource, scope, entityId, revision, action }) => ({
        resource,
        scope,
        entityId,
        revision,
        action,
      })),
    });
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatPending;
    for (const release of releases.values()) release();
    await live.close();
    if (heartbeatError) throw heartbeatError;
  }
}
