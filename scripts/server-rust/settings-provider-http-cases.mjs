import assert from "node:assert/strict";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";

export async function runSettingsProviderHttpCases({
  h,
  visit,
  result,
  controller,
  deadline,
}) {
  const endpoint = "/api/settings/providers/probe-zai/test";
  const probe = (name, suffix = "", options = {}) =>
    visit(name, "POST", endpoint + suffix, { json: {}, ...options });
  const sql = (...statements) => h.fixture.sql(statements);
  const headers = () => {
    const client = h.fixture.client();
    return {
      origin: "http://127.0.0.1:5173",
      "content-type": "application/json",
      cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
      ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
    };
  };
  async function online(expected) {
    await eventually(
      async () => {
        const response = await fetch(h.fixture.server.origin + "/api/workers", {
          headers: headers(),
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(response.status, 200);
        return (await response.json()).find((w) => w.workerId === worker)
          .online;
      },
      (value) => assert.equal(value, expected),
      15000,
    );
  }
  for (const suffix of [
    "?workerId=" + worker,
    "?workerId=",
    "?ignored=true",
    "?workerId=missing&workerId=",
  ]) {
    const value = await probe(
      "explicit/empty/extra worker query " + suffix,
      suffix,
      { status: suffix.includes("&workerId=") ? 500 : 200 },
    );
    if (!suffix.includes("&workerId=")) assert.equal(value.workerId, worker);
  }
  const offline = "provider-offline-worker";
  await sql(
    `INSERT INTO workers SELECT populated.* FROM workers original CROSS JOIN LATERAL jsonb_populate_record(NULL::workers,to_jsonb(original)||jsonb_build_object('id',${literal(offline)})) populated WHERE original.id=${literal(worker)}`,
  );
  const unavailable = await probe(
    "owned offline worker",
    "?workerId=" + offline,
  );
  assert.equal(unavailable.stage, "worker-placement");
  assert.equal(unavailable.workerId, offline);
  for (const defaultWorker of [offline, worker, null]) {
    await sql(
      `INSERT INTO user_settings(user_id,default_worker_id) VALUES(${literal(h.owner)},${literal(defaultWorker)}) ON CONFLICT(user_id) DO UPDATE SET default_worker_id=excluded.default_worker_id`,
    );
    assert.equal(
      (await probe("default worker fallback " + defaultWorker)).workerId,
      worker,
    );
  }
  // Missing relations cause the real repository reads to fail. They must not
  // be mistaken for provider errors or silently converted to an offline worker.
  for (const table of [
    "model_providers",
    "model_routes",
    "model_profiles",
    "user_settings",
    "workers",
  ]) {
    await sql(`ALTER TABLE "${table}" RENAME TO "provider_fault_hidden"`);
    try {
      await probe("actual provider SQL failure " + table, "", { status: 500 });
    } finally {
      await sql(`ALTER TABLE "provider_fault_hidden" RENAME TO "${table}"`);
    }
    assert.equal((await probe("provider SQL recovers " + table)).ok, true);
  }
  const gate = controller.hold(),
    abort = new AbortController();
  const abandoned = fetch(h.fixture.server.origin + endpoint, {
    method: "POST",
    headers: headers(),
    body: "{}",
    signal: abort.signal,
  }).then(
    () => assert.fail("held provider probe unexpectedly completed"),
    (error) => error,
  );
  await eventually(
    () => gate.requests,
    (n) => assert.equal(n, 1),
    15000,
  );
  abort.abort();
  assert.equal((await abandoned).name, "AbortError");
  gate.release();
  await eventually(
    () => gate.completed,
    (n) => assert.equal(n, 1),
    15000,
  );
  controller.reset();
  assert.equal((await probe("probe survives abandoned caller")).ok, true);
  const limited = controller.hold(),
    first = probe("first held provider probe");
  await eventually(
    () => limited.requests,
    (n) => assert.equal(n, 1),
    15000,
  );
  const second = probe("second held provider probe");
  await eventually(
    () => limited.requests,
    (n) => assert.equal(n, 2),
    15000,
  );
  const beforeLimit = result.commands.length;
  const saturated = await probe("provider command capacity saturated");
  assert.equal(saturated.ok, false);
  assert.equal(saturated.stage, "provider-response");
  assert.equal(
    result.commands.length,
    beforeLimit,
    "overload is rejected before dispatch",
  );
  assert.deepEqual(
    await visit(
      "desktop counter works while worker capacity is full",
      "GET",
      "/api/desktop-update/active-work",
    ),
    {
      activeChats: 0,
      queuedPrompts: 0,
      terminalServices: 0,
      backgroundJobs: 0,
    },
  );
  limited.releaseOne(0);
  assert.equal((await first).ok, true);
  limited.releaseOne(1);
  assert.equal((await second).ok, true);
  controller.reset();
  if (deadline) {
    const held = controller.hold(),
      started = Date.now();
    const outcome = await probe(
      "actual production 120-second provider deadline",
      "",
      { timeoutMs: 125000 },
    );
    assert.equal(held.requests, 1);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.stage, "provider-response");
    assert.ok(outcome.durationMs >= 119900 && outcome.durationMs <= 124000);
    assert.ok(Date.now() - started >= 119900);
    held.release();
    await eventually(
      () => held.completed,
      (n) => assert.equal(n, 1),
      15000,
    );
    controller.reset();
    assert.equal((await probe("late reply cannot poison next probe")).ok, true);
  }
  h.worker.close();
  await online(false);
  const disconnected = await probe("no online workers");
  assert.equal(disconnected.stage, "worker-placement");
  assert.equal(disconnected.workerId, null);
  await probe(
    "empty worker with none online retains output validation",
    "?workerId=",
    { status: 500 },
  );
  assert.equal(
    (await probe("explicit disconnected worker", "?workerId=" + worker))
      .workerId,
    worker,
  );
  await h.reconnectWorker();
  await online(true);
  assert.equal(
    (await probe("provider recovers after worker reconnect")).ok,
    true,
  );
  h.worker.close();
  await online(false);
  await h.live.close();
  const port = Number(new URL(h.fixture.server.origin).port);
  await h.fixture.close();
  await h.fixture.start({ port });
  await h.reconnectWorker();
  await online(true);
  assert.equal(
    (await probe("provider retained after actual server restart")).ok,
    true,
  );
  result.providerRecovery = {
    realSqlFailures: 5,
    callerDisconnect: true,
    workerReconnect: true,
    serverRestart: true,
    realDeadline: deadline,
    backpressure: true,
  };
}
