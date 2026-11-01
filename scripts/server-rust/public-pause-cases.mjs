import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { standalone, task, taskProject } from "./native-event-http-setup.mjs";
import { until } from "./native-settings-http-fixture.mjs";

// Real HTTP, owner-scoped Live and durable pause services; worker boundary
// acknowledgments and failures are explicitly controlled by this fixture.
export async function publicPauseCases({ h, modelWorker, visit, profile }) {
  const chatRoute = `/api/chats/${standalone}/pause`;
  const projectRoute = `/api/projects/${taskProject}/tasks/pause`;
  const absent = "00000000-1111-4111-8111-000000000099";
  await h.live.subscribed("public-pause", [
    { kind: "project", projectId: taskProject },
    { kind: "current-user" },
  ]);
  for (const [name, route] of [
    ["chat", chatRoute],
    ["project", projectRoute],
  ])
    await visit(`invalid ${name} pause`, "PATCH", route, {
      json: {},
      status: 400,
    });
  await visit("absent chat pause", "PATCH", `/api/chats/${absent}/pause`, {
    json: { paused: true },
    status: 404,
  });
  await visit(
    "absent project pause read",
    "GET",
    `/api/projects/${absent}/tasks/pause`,
    { status: 404 },
  );
  await visit(
    "absent project pause write",
    "PATCH",
    `/api/projects/${absent}/tasks/pause`,
    {
      json: { paused: true, rowVersion: 1 },
      status: 404,
    },
  );
  if (profile === "accounts") {
    await visit("foreign chat pause", "PATCH", chatRoute, {
      client: "other",
      json: { paused: true },
      status: 404,
    });
    await visit("foreign project pause read", "GET", projectRoute, {
      client: "other",
      status: 404,
    });
    await visit("foreign project pause write", "PATCH", projectRoute, {
      client: "other",
      json: { paused: true, rowVersion: 1 },
      status: 404,
    });
  }
  assert.deepEqual(
    await visit("standalone pause acknowledged", "PATCH", chatRoute, {
      json: { paused: true, unknown: "stripped by Source schema" },
    }),
    { paused: true },
  );
  modelWorker.failNextPause("reject");
  await visit("standalone resume worker failure", "PATCH", chatRoute, {
    json: { paused: false },
    status: 502,
  });
  modelWorker.failNextPause("opposite");
  await visit("standalone opposite pause acknowledgement", "PATCH", chatRoute, {
    json: { paused: false },
    status: 502,
  });
  assert.deepEqual(
    await visit("standalone resume acknowledged", "PATCH", chatRoute, {
      json: { paused: false },
    }),
    { paused: false },
  );

  let state = await visit("project initial pause state", "GET", projectRoute);
  assert.equal(state.paused, false);
  assert.equal(state.pausedAt, null);
  async function update(
    name,
    paused,
    status = 200,
    rowVersion = state.rowVersion,
  ) {
    await h.live.ping(name + " before");
    const offset = h.live.history.length;
    const next = await visit(name, "PATCH", projectRoute, {
      json: { paused, rowVersion },
      status,
    });
    await h.live.ping(name + " after");
    const invalidations = h.live.history
      .slice(offset)
      .filter(
        (event) =>
          event.type === "event" &&
          event.resource === "task" &&
          event.scope.kind === "project" &&
          event.scope.projectId === taskProject &&
          event.entityId === null,
      );
    assert.equal(
      invalidations.length,
      status === 409 && !next.pauseState ? 0 : 1,
    );
    for (const event of invalidations)
      assert.equal(event.action, "invalidated");
    return next;
  }
  modelWorker.failNextPause("reject");
  const failed = await update(
    "project pause retains partial failure",
    true,
    409,
  );
  assert.match(
    failed.error,
    /^1 Task could not pause: The worker could not pause this chat at a safe boundary: Controlled worker pause failure$/,
  );
  assert.equal(failed.pauseState.paused, true);
  assert.equal(failed.pauseState.rowVersion, state.rowVersion + 1);
  assert.ok(Number.isFinite(Date.parse(failed.pauseState.pausedAt)));
  state = await visit(
    "partial failure committed project pause",
    "GET",
    projectRoute,
  );
  assert.deepEqual(state, failed.pauseState);
  await update(
    "project rejects stale pause revision",
    false,
    409,
    state.rowVersion - 1,
  );
  state = await update("project resumes after partial pause", false, 202);
  assert.equal(state.paused, false);
  assert.equal(state.pausedAt, null);
  state = await update("project pauses active Task", true);
  assert.equal(state.paused, true);
  state = await update("project resumes acknowledged Task", false, 202);
  assert.equal(state.paused, false);
  assert.equal(state.pausedAt, null);
  const final = await visit("project final pause state", "GET", projectRoute);
  assert.deepEqual(final, state);
  assert.equal(modelWorker.pauses.length, 7);

  async function observeUntil(name, route, predicate) {
    const deadline = Date.now() + 15000;
    let value;
    do {
      await h.fixture.observe(name, "GET", route);
      value = h.fixture.records.get(name);
      if (predicate(value)) return value;
      await delay(20);
    } while (Date.now() < deadline);
    assert.ok(predicate(value), name);
  }
  const held = modelWorker.holdNextPause();
  const abort = new AbortController();
  const caller = h.fixture
    .observe("lost pause caller", "PATCH", chatRoute, {
      json: { paused: true },
      csrf: !!h.fixture.client().csrf,
      fetcher: (url, input) =>
        fetch(url, {
          ...input,
          signal: AbortSignal.any([input.signal, abort.signal]),
        }),
    })
    .then(
      () => {
        throw new Error("Held pause unexpectedly returned before abort");
      },
      (error) => error,
    );
  await until(() => held.dispatched, Boolean);
  abort.abort();
  assert.equal((await caller).name, "AbortError");
  held.release();
  await observeUntil(
    "aborted pause persists after worker acknowledgement",
    "/api/chats?context=standalone",
    (chats) =>
      chats.find((chat) => chat.id === standalone)?.automationPaused === true,
  );
  assert.deepEqual(
    await visit("resume after lost pause caller", "PATCH", chatRoute, {
      json: { paused: false },
    }),
    { paused: false },
  );
  assert.equal(modelWorker.pauses.length, 9);
  await modelWorker.drained();
  h.worker.close();
  await observeUntil(
    "actual worker transport disconnected",
    "/api/workers",
    (workers) =>
      workers.some(
        (worker) =>
          worker.workerId === h.scope.workerId && worker.online === false,
      ),
  );
  assert.deepEqual(
    await visit("offline pause remains durable", "PATCH", chatRoute, {
      json: { paused: true },
    }),
    { paused: true },
  );
  await visit("offline threaded resume retains pause", "PATCH", chatRoute, {
    json: { paused: false },
    status: 503,
  });
  await observeUntil(
    "offline resume leaves chat paused",
    "/api/chats?context=standalone",
    (chats) =>
      chats.find((chat) => chat.id === standalone)?.automationPaused === true,
  );
  const taskRoute = `/api/chats/${task}/pause`;
  assert.deepEqual(
    await visit("offline empty Task pause", "PATCH", taskRoute, {
      json: { paused: true },
    }),
    { paused: true },
  );
  assert.deepEqual(
    await visit(
      "offline empty Task resumes without worker action",
      "PATCH",
      taskRoute,
      { json: { paused: false } },
    ),
    { paused: false },
  );
  assert.equal(modelWorker.pauses.length, 9);
  return {
    workerPauseAcknowledgments: 9,
    projectInvalidations: 4,
    partialFailureRetainsState: true,
    staleRevisionRejected: true,
    callerDisconnectStateRetained: true,
    offlineThreadedResumeRetainsPause: true,
    offlineEmptyTaskCanResume: true,
  };
}
