import assert from "node:assert/strict";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { LiveProbe } from "./live-sockets.mjs";

export async function managementReopen({
  f,
  profile,
  state,
  worker,
  live,
  root,
  snapshot,
  visit,
  settle,
  management,
  result,
  replace,
}) {
  const oldCredential = worker.config.token,
    oldReport = worker.report;
  const before = await snapshot(),
    port = +new URL(f.server.origin).port;
  result.initialLiveHistory = live.history;
  result.initialDiagnostics = f.server.diagnostics();
  worker.close();
  await live.close();
  await f.close();
  f.environment.CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE = "60";
  f.environment.CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE = "60";
  await f.start({ port });
  const after = await snapshot();
  assert.deepEqual(
    after,
    before,
    "Restart retains unlink tombstones, every credential, display name and existing source/project data",
  );
  result.serverDatabaseReopenedAfterWrites = true;
  worker = await managementWorker({ f, visit, root, state });
  replace({ worker, live: null });
  live = new LiveProbe(f);
  replace({ worker, live });
  await live.opened;
  await live.initialized();
  await live.subscribed("reopened management scopes");
  await live.ping("reopened baseline");
  const catalog = await management(
      "re-enrollment retains display name and identity",
    ),
    alpha = catalog.find((w) => w.workerId === "alpha");
  assert.equal(alpha.name, "Final display");
  assert.equal(alpha.runtimeName, "alpha worker");
  assert.equal(alpha.credentialCount, 4);
  assert.equal(alpha.activeCredentialCount, 1);
  await settle(
    "old credential remains revoked after re-enrollment",
    "POST",
    "/api/internal/workers/heartbeat",
    {
      client: "worker",
      status: 401,
      json: oldReport,
      headers: { authorization: "Bearer " + oldCredential },
    },
  );
  const client = f.client();
  result.quotaWarmup = [];
  for (let index = 0; index < 61; index++) {
    const response = await fetch(
      f.server.origin + "/api/workers/alpha/restart",
      {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:5173",
          cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    const body = await response.json();
    assert.ok([202, 429].includes(response.status), JSON.stringify(body));
    result.quotaWarmup.push({
      status: response.status,
      body,
      headers: Object.fromEntries(response.headers),
    });
    if (response.status === 429) break;
  }
  assert.equal(result.quotaWarmup.at(-1).status, 429);
  await live.ping("quota warmup complete");
  await settle(
    "actual restart command quota",
    "POST",
    "/api/workers/alpha/restart",
    {
      status: 429,
      fetcher: async (...args) => {
        const response = await fetch(...args),
          retry = response.headers.get("retry-after");
        assert.match(retry, /^[1-9]\d*$/);
        assert.ok(+retry <= 60);
        result.commandQuotaRetryAfterSeconds = +retry;
        return response;
      },
    },
  );
  await settle(
    "rename remains usable after restart quota",
    "PATCH",
    "/api/workers/alpha",
    { json: { name: "After quota" } },
    ["workers"],
  );
  return { worker, live };
}
