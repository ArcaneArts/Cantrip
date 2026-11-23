// WorkerConnection owns the command socket; the full worker's separate HTTP
// heartbeat loop is represented here with actual authenticated heartbeat calls.
import assert from "node:assert/strict";
import { heartbeat } from "./security-fixtures.mjs";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";
export async function cliWorkerHeartbeat(h, result) {
  const response = await fetch(
    h.fixture.server.origin + "/api/internal/workers/heartbeat",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + h.credential,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...heartbeat,
        workerId: worker,
        remoteSurfaces: {
          ...heartbeat.remoteSurfaces,
          browser: true,
          desktop: true,
        },
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = await response.json();
  result.heartbeats ??= [];
  result.heartbeats.push({ status: response.status, body });
  assert.equal(response.status, 202, JSON.stringify(body));
  assert.equal(body.workerId, worker);
  assert.equal(body.online, true);
}
