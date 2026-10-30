import assert from "node:assert/strict";
import { LiveProbe, currentUser } from "./live-sockets.mjs";

export async function conversionLifecycleCases({
  fixture,
  visit,
  read,
  until,
  ids,
  createFolder,
  startInput,
  commands,
  releases,
  setMode,
  connectWorker,
  stopWorker,
}) {
  const route = (id) => `/api/projects/${id}/github-conversion`;
  const waitJob = (id, state) =>
    until(
      () => read(route(id)),
      (job) => assert.equal(job.state, state, JSON.stringify(job)),
    );
  for (let n = 3; n < 7; n++) await createFolder(n);
  setMode("capacity-held");
  const jobs = [];
  for (let n = 3; n < 6; n++)
    jobs.push(
      await visit("capacity admission " + n, "POST", route(ids[n]), {
        status: 202,
        json: startInput(n),
      }),
    );
  const state = await until(
    () => Promise.all(ids.slice(3, 6).map((id) => read(route(id)))),
    (jobs) => {
      assert.equal(
        jobs.filter(
          (j) =>
            j.state === "running" && j.attempt === 1 && j.stateRevision === 2,
        ).length,
        2,
      );
      assert.equal(
        jobs.filter(
          (j) =>
            j.state === "queued" && j.attempt === 0 && j.stateRevision === 1,
        ).length,
        1,
      );
    },
  );
  await until(
    () => releases.size,
    (n) => assert.equal(n, 2),
  );
  assert.equal(commands.length, 2);
  for (let n = 3; n < 6; n++)
    await visit("capacity held status " + n, "GET", route(ids[n]));
  const first = state.find((j) => j.state === "running");
  releases.get(first.id)();
  await waitJob(first.projectId, "succeeded");
  await until(
    () => commands.length,
    (n) => assert.equal(n, 3),
  );
  await until(
    () => releases.size,
    (n) => assert.equal(n, 2),
  );
  for (const release of releases.values()) release();
  const completions = [];
  for (let n = 3; n < 6; n++) {
    const job = await waitJob(ids[n], "succeeded");
    assert.equal(job.attempt, 1);
    assert.equal(job.stateRevision, 3);
    completions.push(job);
    await visit("capacity completed " + n, "GET", route(ids[n]));
  }
  assert.deepEqual(
    new Set(commands.map((c) => c.projectId)),
    new Set(ids.slice(3, 6)),
  );
  const capacity = {
    running: 2,
    queued: 1,
    commands: commands
      .slice()
      .sort((a, b) => a.projectId.localeCompare(b.projectId)),
    jobs: completions,
  };
  setMode("held");
  const admitted = await visit("shutdown admission", "POST", route(ids[6]), {
    status: 202,
    json: startInput(6),
  });
  await until(
    () => releases.has(admitted.id),
    (v) => assert.equal(v, true),
  );
  const running = await waitJob(ids[6], "running");
  assert.equal(running.attempt, 1);
  assert.equal(running.stateRevision, 2);
  const server = fixture.server,
    port = Number(new URL(server.origin).port);
  try {
    await fixture.close();
  } finally {
    fixture.conversionShutdownStages = server.events.filter(
      (e) => e.event === "server.shutdown.stage",
    );
  }
  stopWorker();
  setMode("ready");
  releases.get(admitted.id)();
  await until(
    () => releases.size,
    (n) => assert.equal(n, 0),
  );
  await fixture.start({ port });
  const retained = await visit("shutdown retained job", "GET", route(ids[6]));
  assert.equal(retained.id, admitted.id);
  assert.equal(retained.state, "blocked");
  assert.equal(retained.attempt, 1);
  assert.equal(retained.stateRevision, 3);
  assert.deepEqual(retained.error, { code: "worker-offline", retryable: true });
  const live = await new LiveProbe(fixture).open();
  try {
    await live.initialized();
    await live.subscribed("conversion recovery", [
      currentUser,
      { kind: "project", projectId: ids[6] },
    ]);
    await connectWorker();
    const completed = await waitJob(ids[6], "succeeded");
    assert.equal(completed.id, admitted.id);
    assert.equal(completed.attempt, 2);
    assert.equal(completed.stateRevision, 6);
    assert.equal(completed.error, null);
    await visit("shutdown resumed conversion", "GET", route(ids[6]));
    const attempts = commands
      .filter((c) => c.jobId === admitted.id)
      .map((c) => c.attempt);
    assert.deepEqual(attempts, [1, 2]);
    await live.ping("conversion recovery barrier");
    const events = live.history.filter(
      (e) =>
        e.type === "event" &&
        e.resource === "project-github-conversion-job" &&
        e.entityId === admitted.id,
    );
    assert.deepEqual(
      events.map((e) => e.revision),
      [6],
    );
    return {
      capacity: fixture.normalize(capacity),
      shutdown: {
        retained: fixture.normalize(retained),
        completed: fixture.normalize(completed),
        attempts,
        events: events.map(({ resource, scope, entityId, revision, action }) =>
          fixture.normalize({ resource, scope, entityId, revision, action }),
        ),
      },
      commands: fixture.normalize(
        commands
          .slice()
          .sort(
            (a, b) =>
              a.projectId.localeCompare(b.projectId) || a.attempt - b.attempt,
          ),
      ),
    };
  } finally {
    await live.close();
  }
}
