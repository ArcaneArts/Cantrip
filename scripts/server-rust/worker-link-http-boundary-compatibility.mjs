import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { redisFixture, eventually } from "./coordinated-fixture-tools.mjs";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const { values } = parseArgs({
  options: {
    "redis-bin": { type: "string" },
    report: { type: "string" },
    peer: { type: "string", multiple: true },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-link-http-boundary-"),
);
const report = {
  suite: "worker-link-http-boundaries",
  root,
  completeReplacement: false,
  scope:
    "Actual production HTTP/WS handlers and composed Service on isolated PGlite, real private Redis reads followed by controlled faults/awaits. Test-only dependency injection; no shared production bootstrap, SQL cluster or real-worker product claim.",
  peers: [],
};
const executable = await buildRustExample("worker-link-http-fixture");
const redis = await redisFixture(
  values["redis-bin"] ?? process.env.CANTRIP_TEST_REDIS_BIN ?? "redis-server",
  root,
);
async function save() {
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
const origin = "http://127.0.0.1:5173";
const fixed = "55555555-5555-4555-8555-555555555555";
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(label + " timed out")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function socket(fixture, session) {
  const url = new URL(
    `/api/worker-links/${session.sessionId}/connect`,
    fixture.server.origin,
  );
  url.protocol = "ws:";
  url.searchParams.set("clientInstanceId", session.identity.clientInstanceId);
  url.searchParams.set("routeGeneration", "1");
  const ws = new WebSocket(url, { headers: { origin } });
  let opened = false;
  const open = new Promise((resolve, reject) => {
    ws.once("open", () => {
      opened = true;
      resolve();
    });
    ws.once("error", reject);
  });
  // A pre-upgrade rejection is observed separately and never awaits open.
  void open.catch(() => {});
  const closed = new Promise((resolve) =>
    ws.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );
  return {
    ws,
    open,
    closed,
    get opened() {
      return opened;
    },
  };
}
async function run(kind) {
  const prefix = "cantrip:relay:v1:http-boundary:" + randomUUID();
  const f = new HttpFixture({
    kind,
    executable,
    root,
    name: "facade",
    databaseMode: "pglite",
    environment: {
      CANTRIP_WORKER_LINK_HTTP_FIXTURE: "true",
      CANTRIP_WORKER_LINK_HTTP_NAMESPACE: prefix,
      REDIS_URL: redis.url,
    },
  });
  const result = { kind, observations: [] };
  report.peers.push(result);
  await save();
  const sockets = [];
  const raw = async (label, method, url, json, status = 200) => {
    return f.observe(label, method, url, {
      status,
      ...(json === undefined ? {} : { json }),
    });
  };
  const command = async (route, body) => {
    const client = f.client();
    const response = await fetch(new URL(route, f.server.origin), {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(client.cookies.size
          ? {
              cookie: [...client.cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            }
          : {}),
        ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, await response.text());
  };
  const control = async (nth, action) => {
    await command("/__worker_link_http/configure", {
      session: session.sessionId,
      nth,
      action,
    });
  };
  const state = async () => {
    const value = await fetch(
      new URL("/__worker_link_http/state", f.server.origin),
      { headers: { origin } },
    );
    assert.equal(value.status, 200);
    return value.json();
  };
  const release = () => command("/__worker_link_http/release", {});
  let session,
    stopped = false;
  try {
    await f.start();
    assert.equal((await raw("bootstrap", "GET", "/api/bootstrap")).status, 200);
    const owner = f.records.get("bootstrap").auth.currentUser.id;
    session = structuredClone(
      workerLinkWireFixtures.workerLinkSessionSchema[0],
    );
    session.sessionId = randomUUID();
    session.identity.ownerId = owner;
    session.identity.accountSessionId = "local:" + owner;
    session.identity.clientInstanceId = "http-control";
    session.routePolicy.enabled = ["local", "relay"];
    session.lease = {
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 43200000).toISOString(),
    };
    const key = `${prefix}:worker-link:${session.sessionId}`;
    await redis.client.set(
      key,
      JSON.stringify({
        authorityInstanceId: "ghost",
        expiresAt: Date.parse(session.lease.expiresAt),
        session,
      }),
      { PX: 120000 },
    );
    const base = `/api/worker-links/${session.sessionId}`;
    const envelope = {
      ...workerLinkWireFixtures.workerLinkPeerSignalEnvelopeSchema[0],
      sessionId: session.sessionId,
      peerSessionId: fixed,
      sender: "client",
    };
    const authorizations = [
      ["renew", "POST", base + "/renew"],
      ["peer", "POST", base + "/peers", { route: "lan", routeGeneration: 1 }],
      [
        "signals",
        "POST",
        base + `/peers/${fixed}/signals`,
        { signals: [envelope] },
      ],
      ["mailbox", "POST", base + `/peers/${fixed}/mailbox`, {}],
      ["grant-renew", "POST", base + `/grants/${fixed}/renew`],
      ["route", "POST", base + "/route", { preferredRoute: "relay" }],
      ["delete-session", "DELETE", base],
      ["delete-peer", "DELETE", base + `/peers/${fixed}`],
      ["delete-grant", "DELETE", base + `/grants/${fixed}`],
      [
        "observation",
        "POST",
        base + "/observations/grant",
        workerLinkWireFixtures.workerLinkObservationGrantRequestSchema?.[0] ?? {
          topics: ["terminal"],
        },
      ],
      [
        "terminal",
        "POST",
        base + `/terminals/${fixed}/grant`,
        { operationId: fixed },
      ],
      [
        "surface",
        "POST",
        base + `/remote-surfaces/${fixed}/grant`,
        { viewport: { width: 1024, height: 768, devicePixelRatio: 1 } },
      ],
      ["tunnel", "POST", base + `/tunnel-attachments/${fixed}/grant`, {}],
      ["direct", "POST", base + "/direct", {}],
      ["activate", "POST", base + "/direct-activate", { capabilityId: fixed }],
    ];
    for (const [label, method, url, body] of authorizations) {
      await control(1, "fail");
      const response = await raw("auth-" + label, method, url, body, 500);
      assert.equal(response.status, 500, JSON.stringify(response));
      assert.equal(response.body.error, "Internal server error.");
      assert.ok(response.body.requestId);
      assert.equal((await state()).lookup.reads, 1);
      result.observations.push({ label: "auth-" + label, response });
    }
    for (const [label, method, url, body] of authorizations.slice(0, 9)) {
      await control(2, "fail");
      const response = await raw(
        "operation-" + label,
        method,
        url,
        body,
        method === "DELETE" ? 500 : 502,
      );
      assert.equal(
        response.status,
        method === "DELETE" ? 500 : 502,
        JSON.stringify(response),
      );
      assert.equal(
        response.body.error,
        method === "DELETE"
          ? "Internal server error."
          : "Controlled authority lookup failure.",
      );
      assert.equal((await state()).lookup.reads, 2);
      result.observations.push({ label: "operation-" + label, response });
    }
    await control(0, "pass");
    const timeoutStart = Date.now();
    const timeout = await raw(
      "rpc-timeout",
      "POST",
      base + "/renew",
      undefined,
      409,
    );
    assert.equal(timeout.status, 409);
    assert.equal(
      timeout.body.error,
      "WorkerLink authority did not answer in time.",
    );
    assert.ok(Date.now() - timeoutStart >= 9900);
    result.observations.push({ label: "rpc-timeout", response: timeout });
    await control(1, "fail");
    const before = socket(f, session);
    sockets.push(before);
    const denied = await within(
      new Promise((resolve, reject) => {
        before.ws.once("unexpected-response", (_, response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(text) }),
          );
        });
        before.ws.once("open", () =>
          reject(new Error("Failed prevalidation unexpectedly upgraded")),
        );
      }),
      "prevalidation rejection",
    );
    assert.equal(denied.status, 500);
    assert.equal(denied.body.error, "Internal server error.");
    assert.match(denied.body.requestId, /^[a-f0-9-]{36}$/);
    denied.body.requestId = "<request>";
    before.ws.terminate();
    result.observations.push({ label: "ws-prevalidation", response: denied });
    await control(2, "fail");
    const failed = socket(f, session);
    sockets.push(failed);
    await within(failed.open, "upgraded-error open");
    assert.deepEqual(await within(failed.closed, "upgraded-error close"), {
      code: 1006,
      reason: "",
    });
    result.observations.push({
      label: "ws-upgraded-error",
      close: { code: 1006, reason: "" },
    });
    await control(2, "hold");
    const pending = socket(f, session);
    sockets.push(pending);
    await within(pending.open, "pending open");
    await eventually(
      state,
      (v) => v.lookup.paused,
      "actual second lookup paused",
    );
    pending.ws.send("before relay listener");
    const pong = new Promise((resolve) =>
      pending.ws.once("pong", (data) => resolve(data.toString())),
    );
    pending.ws.ping("pending-auth");
    assert.equal(await within(pong, "pending-auth pong"), "pending-auth");
    await release();
    await eventually(
      state,
      (v) => v.relay.connections === 1,
      "actual relay attached",
    );
    pending.ws.send("after relay listener");
    assert.deepEqual(
      await within(pending.closed, "attached relay rejects text"),
      { code: 1003, reason: "WorkerLink relay requires binary frames" },
    );
    result.observations.push({
      label: "ws-await-drops-early-text-and-answers-ping",
      close: { code: 1003, reason: "WorkerLink relay requires binary frames" },
    });
    await control(2, "hold");
    const departed = socket(f, session);
    sockets.push(departed);
    await within(departed.open, "departing open");
    await eventually(
      state,
      (v) => v.lookup.paused,
      "closed client lookup paused",
    );
    departed.ws.close(1000, "client-left");
    assert.deepEqual(await within(departed.closed, "departed client close"), {
      code: 1000,
      reason: "client-left",
    });
    await release();
    await eventually(
      state,
      (v) => v.lookup.completed === 2 && !v.lookup.paused,
      "lookup completes after client departure",
    );
    assert.equal((await state()).relay.connections, 0);
    result.observations.push({
      label: "ws-departure-cannot-resurrect-relay",
      connections: 0,
    });
    await control(2, "hold");
    const closing = socket(f, session);
    sockets.push(closing);
    await within(closing.open, "shutdown pending open");
    await eventually(state, (v) => v.lookup.paused, "shutdown lookup paused");
    const stopping = f.close();
    const close = await within(closing.closed, "shutdown during authorization");
    await stopping;
    stopped = true;
    result.observations.push({
      label: "ws-server-shutdown-during-lookup",
      close,
    });
    result.passed = true;
  } catch (error) {
    result.failure = error.stack;
    throw error;
  } finally {
    for (const p of sockets) p.ws.terminate();
    if (!stopped) {
      try {
        await release();
      } catch {}
      await f.close();
    }
    await save();
  }
  return result;
}
try {
  const results = [];
  for (const kind of values.peer ?? ["node", "rust"])
    results.push(await run(kind));
  if (results.length === 2)
    assert.deepEqual(
      results[1].observations,
      results[0].observations,
      "reference/native HTTP facade boundaries",
    );
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await redis.stop();
  await save();
}
console.log(JSON.stringify(report, null, 2));
