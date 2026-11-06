// Real shared SQL/Redis and production HTTP/WS graph. This initial suite covers
// startup, App Live and worker control. Resource execution/fault acceptance remains.
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { redisFixture } from "./coordinated-fixture-tools.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { heartbeat, projectLabel, password } from "./security-fixtures.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { verifySharedWorkers } from "./shared-runtime-worker.mjs";
import { verifyLiveOrder } from "./shared-runtime-live.mjs";
import { verifyRedisInterruption } from "./shared-runtime-redis-fault.mjs";
import {
  prepareForeignAccount,
  verifyTenantLive,
} from "./shared-runtime-tenants.mjs";
import {
  seedPeerJobLeases,
  verifyPeerJobLeases,
} from "./shared-runtime-jobs.mjs";

const { values } = parseArgs({
  options: {
    "redis-bin": { type: "string" },
    report: { type: "string" },
    pair: { type: "string", multiple: true },
    profile: { type: "string", multiple: true },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-shared-runtime-http-"));
const report = {
  suite: "shared-runtime-http",
  root,
  completeReplacement: false,
  scope:
    "Production runtime graph on actual shared PostgreSQL and private Redis. Committed HTTP enrollment, App Live fanout/replay/order, readiness, transient surface and six seeded active job-lease preservation, unchanged WorkerConnection with controlled WorkerLink ACKs and actual relay sockets. No resource execution, actual worker job renewal/expiry, platform or packaging claim.",
  pairs: [],
};
async function save() {
  if (!values.report) return;
  await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
await save();
let postgres;
const snapshotQuery =
  "SELECT json_build_object('count',count(*),'active',count(*) FILTER (WHERE status='active'))::text AS result FROM remote_surfaces";
async function ready(fixture) {
  const response = await fetch(fixture.server.origin + "/readyz", {
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, "ready");
  assert.equal(body.database.engine, "postgres");
  assert.equal(body.database.status, "ready");
  assert.deepEqual(body.coordination, { shared: true, status: "ready" });
}
async function run(pair, executable, profile, passwordHash) {
  assert.ok(["none", "password", "accounts"].includes(profile));
  const kinds = pair.split("/");
  assert.ok(
    kinds.length === 2 && kinds.every((k) => ["node", "rust"].includes(k)),
  );
  const directory = path.join(root, profile + "-" + pair.replace("/", "-"));
  await mkdir(directory);
  const redis = await redisFixture(
    values["redis-bin"] ?? process.env.CANTRIP_TEST_REDIS_BIN ?? "redis-server",
    directory,
  );
  const databaseUrl = await postgres.database();
  const peers = kinds.map(
    (kind, i) =>
      new HttpFixture({
        kind,
        executable,
        root: directory,
        name: "peer-" + i,
        databaseMode: "postgres",
        liveSqlFixture: true,
        environment: {
          DATABASE_URL: databaseUrl,
          REDIS_URL: redis.url,
          CANTRIP_SHARED_RUNTIME_FIXTURE: "true",
          CANTRIP_COORDINATION_MAX_INSTANCES: "2",
          CANTRIP_SERVER_INSTANCE_ID: "shared-peer-" + i,
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
        },
      }),
  );
  const result = { pair, profile, cases: [] };
  report.pairs.push(result);
  const probes = [],
    logs = [];
  async function start(peer, i) {
    await peer.start();
    for (const name of ["stdout", "stderr"]) {
      const output = createWriteStream(
        path.join(directory, "peer-" + i + "." + name + ".log"),
      );
      peer.server.child[name].pipe(output);
      logs.push(output);
    }
    await ready(peer);
    if (profile !== "none") {
      if (i === 0) {
        await peer.observe(
          "shared-auth",
          "POST",
          profile === "accounts" ? "/api/auth/register" : "/api/auth/login",
          {
            status: profile === "accounts" ? 201 : 200,
            json:
              profile === "accounts"
                ? {
                    email: "shared-owner@example.invalid",
                    displayName: "Shared owner",
                    password,
                  }
                : { password },
          },
        );
      } else {
        const original = peers[0].client();
        peer.clients.set("main", {
          cookies: new Map(original.cookies),
          csrf: original.csrf,
        });
      }
    }
    await peer.observe("bootstrap", "GET", "/api/bootstrap");
  }
  try {
    await start(peers[0], 0);
    // Empty profiles have no projects/browsers to materialize. Install a valid
    // canonical surface on actual worker/project rows before the rolling start.
    const label = JSON.stringify(projectLabel).replaceAll("'", "''");
    const ownerId = peers[0].records.get("bootstrap").auth.currentUser.id;
    await peers[0].sql([
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('shared-surface-worker','${ownerId}','Shared surface worker','linux','x64',now(),now())`,
      `INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES ('shared-surface-project','${ownerId}','${label}'::jsonb,'shared-surface-index')`,
      `INSERT INTO remote_surfaces(id,project_id,worker_id,kind,preferred_transport,configuration,status) VALUES ('shared-surface','shared-surface-project','shared-surface-worker','browser','webrtc','{"kind":"browser","profileId":null}'::jsonb,'active')`,
    ]);
    const [before] = await peers[0].sql([], [snapshotQuery]);
    assert.ok(
      before.count > 0,
      "Fixture installs a canonical surface on actual project and worker rows",
    );
    assert.equal(before.active, before.count);
    const jobLeases = await seedPeerJobLeases(peers[0]);
    await start(peers[1], 1);
    if (profile === "accounts") await prepareForeignAccount(peers);
    await verifyPeerJobLeases(peers[0], jobLeases, result);
    const [after] = await peers[0].sql([], [snapshotQuery]);
    assert.deepEqual(
      after,
      before,
      "Second shared startup retains the first instance's active surfaces",
    );
    result.cases.push(
      "ready probes actual shared coordinator; second startup preserves active peer-owned surfaces",
    );
    const live = [],
      initial = [],
      events = [new Map(), new Map()];
    for (const peer of peers) {
      const probe = new LiveProbe(peer);
      probes.push(probe);
      await probe.open();
      const initialized = await probe.initialized();
      const subscribed = await probe.subscribed();
      initial.push({
        serverEpoch: initialized.serverEpoch,
        cursor: subscribed.cursor,
      });
      live.push(probe);
    }
    for (const [i, peer] of peers.entries()) {
      const workerId = "shared-enrolled-" + i;
      await peer.observe("code", "POST", "/api/workers/enrollment-codes", {
        json: {},
        status: 201,
        csrf: !!peer.client().csrf,
      });
      await peer.observe("enroll", "POST", "/api/internal/workers/enroll", {
        client: "worker",
        json: {
          code: peer.records.get("code").code,
          heartbeat: { ...heartbeat, workerId },
        },
        status: 201,
      });
      for (const [j, probe] of live.entries()) {
        const event = await probe.message(
          (v) =>
            v.type === "event" &&
            v.resource === "worker" &&
            v.entityId === workerId,
        );
        assert.deepEqual(
          { ...event, cursor: 0, occurredAt: "" },
          {
            type: "event",
            cursor: 0,
            scope: currentUser,
            resource: "worker",
            action: "invalidated",
            entityId: workerId,
            revision: null,
            payload: null,
            occurredAt: "",
          },
        );
        events[j].set(workerId, event);
        const catalog = await peers[j].observe(
          "committed-" + workerId,
          "GET",
          "/api/workers",
        );
        assert.ok(
          catalog.body.some((w) => w.workerId === workerId),
          "Both SQL peers see committed state when Live invalidates it",
        );
      }
      result.cases.push(
        "committed worker enrollment " +
          i +
          " reaches local and remote live clients and both resource APIs",
      );
    }
    for (const [i, peer] of peers.entries()) {
      const replay = new LiveProbe(peer);
      probes.push(replay);
      await replay.open();
      await replay.initialized(initial[i]);
      await replay.subscribed("resume");
      for (const [workerId, event] of events[i])
        assert.deepEqual(
          await replay.message(
            (v) =>
              v.type === "event" &&
              v.resource === "worker" &&
              v.entityId === workerId,
          ),
          event,
          "Replay retains exact local or externally received publication",
        );
      assert.ok(
        (await replay.message((v) => v.type === "caught-up")).replayedCount >=
          2,
      );
      await replay.close();
    }
    result.cases.push(
      "both peers replay original local and externally received committed publications",
    );
    await verifySharedWorkers(peers, directory, result, async (controls) => {
      await verifyLiveOrder(peers, live, result);
      if (profile === "accounts") await verifyTenantLive(peers, live, result);
      await verifyRedisInterruption(peers, live, redis, controls, result);
    });
    result.passed = true;
  } catch (error) {
    result.failure = error.stack;
    throw error;
  } finally {
    await Promise.allSettled(probes.map((p) => p.close()));
    const stopped = await Promise.allSettled(peers.map((p) => p.close()));
    result.shutdown = stopped.map((p) =>
      p.status === "fulfilled"
        ? { ok: true }
        : { ok: false, error: String(p.reason) },
    );
    await Promise.all(
      logs.map((p) => (p.writableFinished ? undefined : once(p, "finish"))),
    );
    await redis.stop();
    await save();
    if (result.passed)
      assert.ok(
        stopped.every((p) => p.status === "fulfilled"),
        JSON.stringify(result.shutdown),
      );
  }
}
try {
  const executable = await buildRustExample("http-sql-fixture");
  postgres = await postgresFixture(path.join(root, "postgres"));
  const profiles = values.profile ?? ["none", "password", "accounts"];
  const passwordHash = profiles.includes("password")
    ? await hashPassword(password)
    : undefined;
  for (const profile of profiles)
    for (const pair of values.pair ?? [
      "node/node",
      "node/rust",
      "rust/node",
      "rust/rust",
    ])
      await run(pair, executable, profile, passwordHash);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await postgres?.close();
  await save();
}
console.log(
  JSON.stringify({
    root,
    passed: report.passed,
    pairs: report.pairs.map((p) => ({
      pair: p.pair,
      profile: p.profile,
      cases: p.cases.length,
      passed: p.passed,
    })),
  }),
);
