// Restore access after an actual backend rejection, without waiting for every
// caller to finish while the dependency remains unavailable.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function databaseOutageCases({
  origin,
  cookie,
  admin,
  role,
  errors,
  probes,
  waitForConsole,
  progress = {},
}) {
  const stage = (value) => {
    progress.stage = value;
    console.error(
      JSON.stringify({ event: "database-outage.stage", origin, stage: value }),
    );
  };
  stage("capture accepted state");
  const headers = { cookie, origin: "http://127.0.0.1:5173" };
  async function json(route, options = {}) {
    const response = await fetch(origin + route, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(60000),
    });
    const body = await response.json();
    assert.equal(response.status, 200, route + ": " + JSON.stringify(body));
    return body;
  }
  async function state() {
    const bootstrap = await json("/api/bootstrap"),
      settings = await json("/api/settings"),
      session = await json("/api/auth/session");
    return {
      serverId: bootstrap.server.id,
      theme: settings.preferences.theme,
      user: session.currentUser,
      csrf: session.csrfToken,
      sessionExpiresAt: session.expiresAt,
    };
  }
  const initial = await state(),
    theme = initial.theme === "dark" ? "light" : "dark";
  async function write(theme, csrf) {
    await json("/api/settings", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(typeof csrf === "string" ? { "x-cantrip-csrf": csrf } : {}),
      },
      body: JSON.stringify({ theme }),
    });
  }
  await write(theme, initial.csrf);
  const before = await state();
  assert.equal(before.theme, theme);
  const path = "/api/log-health-boundary-" + randomUUID();
  const boundary = await fetch(origin + path, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  await boundary.arrayBuffer();
  assert.equal(boundary.status, 404);
  const requestId = boundary.headers.get("x-request-id");
  assert.ok(requestId);
  await waitForConsole(`GET ${path} -> 404 Not Found (`);
  const result = Object.assign(progress, {
    boundary: { path, requestId },
    before: {
      serverId: before.serverId,
      theme: before.theme,
      user: before.user,
      sessionExpiresAt: before.sessionExpiresAt,
    },
    probes: [],
  });
  const pending = [];
  let phase = "unavailable";
  const firstError = errors.length,
    firstProbe = probes.length;
  try {
    stage("revoke access and terminate old backends");
    await admin.unsafe(`ALTER ROLE "${role}" CONNECTION LIMIT 0`);
    const stopped =
      await admin`SELECT pid,pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE usename=${role} AND pid<>pg_backend_pid()`;
    assert.ok(stopped.length && stopped.every((row) => row.terminated));
    result.terminatedPids = stopped.map((row) => row.pid);
    const deadline = Date.now() + 10000;
    for (;;) {
      const remaining =
        await admin`SELECT pid FROM pg_stat_activity WHERE usename=${role} AND pid=ANY(${result.terminatedPids})`;
      if (!remaining.length) break;
      assert.ok(
        Date.now() < deadline,
        "All specifically terminated backend processes must exit",
      );
      await delay(10);
    }
    for (let index = 0; index < 6; index++) {
      const record = { index, settled: false };
      result.probes.push(record);
      const operation = fetch(origin + "/readyz", {
        signal: AbortSignal.timeout(60000),
      }).then(
        async (response) => {
          const body = await response.json();
          Object.assign(record, {
            settled: true,
            status: response.status,
            database: body.database?.status,
            phase,
          });
          return record;
        },
        (error) => {
          Object.assign(record, { settled: true, error: error.message, phase });
          throw error;
        },
      );
      operation.catch(() => {});
      pending.push(operation);
    }
    const refused = Date.now() + 10000;
    while (!errors.slice(firstError).some((error) => error.code === "53300")) {
      assert.ok(
        Date.now() < refused,
        "The real PostgreSQL backend must reject a new role connection",
      );
      await delay(10);
    }
    await delay(500);
    result.beforeRestore = result.probes.map((record) => ({ ...record }));
    for (const record of result.beforeRestore)
      if (record.settled) {
        assert.equal(record.status, 503);
        assert.equal(record.database, "unavailable");
      }
    assert.equal(
      probes.length - firstProbe,
      0,
      "No health SELECT succeeds while old backends are gone and new admissions are rejected",
    );
    result.backendRejections = errors.slice(firstError);
  } finally {
    stage("restore actual role access");
    phase = "restoring";
    await admin.unsafe(`ALTER ROLE "${role}" CONNECTION LIMIT -1`);
    phase = "restored";
  }
  stage("settle previously admitted callers after recovery");
  await Promise.all(pending);
  for (const record of result.probes) {
    assert.ok([200, 503].includes(record.status));
    assert.equal(
      record.database,
      record.status === 200 ? "ready" : "unavailable",
    );
    if (record.status === 200) assert.notEqual(record.phase, "unavailable");
  }
  result.successfulQueryWitnesses = probes.slice(firstProbe);
  assert.ok(
    result.successfulQueryWitnesses.length >=
      result.probes.filter((record) => record.status === 200).length,
  );
  const ready = await json("/readyz");
  assert.equal(ready.database.status, "ready");
  const after = await state();
  assert.deepEqual(
    {
      serverId: after.serverId,
      theme: after.theme,
      user: after.user,
      sessionExpiresAt: after.sessionExpiresAt,
    },
    result.before,
    "Accepted write, retained identity and original session survive the real outage",
  );
  assert.equal(after.csrf, before.csrf, "Original session CSRF is retained");
  await write(initial.theme, after.csrf);
  assert.equal((await state()).theme, initial.theme);
  result.after = {
    serverId: after.serverId,
    theme: after.theme,
    user: after.user,
    sessionExpiresAt: after.sessionExpiresAt,
  };
  result.postRecoveryWrite = true;
  stage("completed");
  return result;
}
