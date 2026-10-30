// Focused actual HTTP/WS, repository, session and worker invalidation evidence.
// Resource accounting, other publishers, Redis and full product acceptance are
// deliberately still tracked as unfinished replacement requirements.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { heartbeat, password, projectLabel } from "./security-fixtures.mjs";
import { LiveProbe, currentUser, deadline } from "./live-sockets.mjs";
import { liveAuthorizationFault } from "./live-socket-faults.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const executable = await buildRustServer(),
  repositoryBinary = await buildRustExample("project-repository-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-live-http-"));
const hash = await hashPassword(password);
const report = {
  suite: "live-http-websocket",
  databaseMode,
  completeReplacement: false,
  profiles: [],
  unfinished: [
    "resource/usage publishers and accounting",
    "Redis coordination",
    "full product/packaging acceptance",
  ],
};
let postgresOwner, failure;
const profiles = [
  { name: "development", mode: "none" },
  { name: "password", mode: "password" },
  { name: "accounts", mode: "accounts" },
  { name: "capacity", mode: "none", limit: 2 },
].filter((p) => !option("--profile") || p.name === option("--profile"));
assert.ok(profiles.length);
const owner = "00000000-0000-0000-0000-000000000001";
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function seedScopes(fixture) {
  const driver = await repositoryFixture({
    kind: fixture.kind,
    executable: repositoryBinary,
    root: path.join(root, fixture.name),
    databaseMode,
    databaseUrl: fixture.environment.DATABASE_URL,
  });
  try {
    for (const sql of [
      `INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES ('project-one','${owner}',${quote(JSON.stringify(projectLabel))}::jsonb,'fixture-index');`,
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('scope-worker','${owner}','Scope worker','linux','x64','2026-10-25','2026-10-25');`,
      "INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES ('scope-source','project-one','scope-worker','/fixture','/fixture');",
      "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES ('scope-worktree','scope-source','scope-worker','main','/fixture','/fixture',true,'cantrip','ready');",
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label) VALUES ('chat-one','${owner}','project-one','scope-worktree','scope-worker',${quote(JSON.stringify(projectLabel))}::jsonb);`,
    ])
      await driver.seed(sql);
  } finally {
    await driver.close();
  }
}
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const profile of profiles) {
    const environment = {
      CANTRIP_AUTH_MODE: profile.mode,
      ...(profile.mode !== "none"
        ? { CANTRIP_ACCOUNT_WEBSOCKET_LIMIT: "2" }
        : {}),
      ...(profile.mode === "password" ? { CANTRIP_PASSWORD_HASH: hash } : {}),
      ...(profile.limit
        ? { CANTRIP_ACCOUNT_WEBSOCKET_LIMIT: String(profile.limit) }
        : {}),
    };
    const pair = ["node", "rust"].map(
      (kind) =>
        new HttpFixture({
          kind,
          executable,
          root,
          name: profile.name,
          databaseMode,
          environment,
        }),
    );
    const result = {
      name: profile.name,
      http: [],
      sockets: [],
      observations: [],
    };
    report.profiles.push(result);
    if (postgresOwner) {
      pair[0].environment.DATABASE_URL = await postgresOwner.database();
      if (databaseMode === "postgres")
        pair[1].environment.DATABASE_URL = await postgresOwner.database();
      else
        pair[1].environment.CANTRIP_POSTGRES_BIN_DIR =
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
    }
    const probes = new Set();
    let scenarioFailure;
    async function visit(label, method, url, options) {
      const observations = [];
      for (const fixture of pair)
        observations.push(await fixture.observe(label, method, url, options));
      assert.deepEqual(observations[1], observations[0], label);
      result.http.push({ label, ...observations[0] });
    }
    async function open(fixture, options) {
      const probe = new LiveProbe(fixture, options);
      probes.add(probe);
      await probe.open();
      return probe;
    }
    try {
      if (profile.name === "development")
        for (const fixture of pair) await seedScopes(fixture);
      for (const fixture of pair) await fixture.start();
      await visit("without upgrade", "GET", "/api/live", {
        status: profile.mode === "none" ? 404 : 401,
      });
      if (profile.mode !== "none") {
        for (const fixture of pair) {
          const unauthenticated = new LiveProbe(fixture);
          probes.add(unauthenticated);
          assert.equal(
            await deadline(unauthenticated.opened, "unauthenticated upgrade"),
            false,
          );
          assert.deepEqual(unauthenticated.rejection, {
            status: 401,
            body: { error: "Authentication is required." },
          });
        }
        result.sockets.push({
          label:
            "unauthenticated upgrade is rejected before accepting the socket",
          status: 401,
        });
      }
      if (profile.mode === "password")
        await visit("login", "POST", "/api/auth/login", { json: { password } });
      if (profile.mode === "accounts")
        await visit("registration", "POST", "/api/auth/register", {
          json: {
            email: "owner@example.invalid",
            displayName: "Live owner",
            password,
          },
          status: 201,
        });
      if (profile.mode !== "none")
        await visit("session", "GET", "/api/auth/session");
      for (const fixture of pair) {
        const observations = {
          kind: fixture.kind,
          cases: [],
          backgroundEvents: [],
        };
        result.observations.push(observations);
        for (const [label, origin] of [
          ["missing origin", null],
          ["forbidden origin", "https://invalid.example"],
        ]) {
          const probe = await open(fixture, { origin });
          const closed = await probe.waitClosed();
          assert.deepEqual(closed, {
            code: 1008,
            reason: "Origin is not allowed",
          });
          observations.cases.push({ label, upgrade: probe.upgrade, closed });
        }
        const probe = await open(fixture, {
          protocols: ["fixture-first", "cantrip-worker-auth-ready-v2"],
        });
        assert.equal(
          probe.socket.protocol,
          "fixture-first",
          "Non-worker route selects first offered subprotocol",
        );
        const ready = await probe.initialized();
        const subscribed = await probe.subscribed();
        probe.send({
          type: "subscribe",
          requestId: "subscription",
          scopes: [currentUser],
        });
        assert.deepEqual(
          await probe.message((v) => v.requestId === "subscription"),
          subscribed,
          "Request history is retained",
        );
        assert.equal((await probe.ping()).type, "pong");
        if (profile.limit) {
          const second = await open(fixture);
          await second.initialized();
          const excess = await open(fixture);
          assert.deepEqual(await excess.waitClosed(), {
            code: 1013,
            reason: "Account WebSocket connection limit reached",
          });
          await second.close();
          const replacement = await open(fixture);
          await replacement.initialized();
          await replacement.close();
          observations.cases.push({
            label: "capacity held through actual close then reusable",
            passed: true,
          });
        } else {
          probe.send({
            type: "subscribe",
            requestId: "denied",
            scopes: [{ kind: "project", projectId: "missing" }],
          });
          const denied = await probe.message((v) => v.requestId === "denied");
          assert.equal(denied.code, "unauthorized-scope");
          observations.cases.push({
            label: "database denies absent project",
            message: denied,
          });
          if (profile.name === "development") {
            for (const resource of [
              { kind: "project", projectId: "project-one" },
              { kind: "chat", chatId: "chat-one" },
            ])
              await probe.subscribed("scope-" + resource.kind, [resource]);
            observations.cases.push({
              label: "database authorizes actual project and chat contexts",
              passed: true,
            });
            if (databaseMode === "postgres") {
              const { diagnostics, ...contract } =
                await liveAuthorizationFault(fixture);
              observations.authorizationFault = diagnostics;
              observations.cases.push(contract);
            }
          }
          // Trigger a real committed worker enrollment, then verify Live observes it
          // and the ordinary resource API already sees the same durable worker.
          await fixture.observe(
            "code",
            "POST",
            "/api/workers/enrollment-codes",
            { csrf: profile.mode !== "none", json: {}, status: 201 },
          );
          await fixture.observe(
            "enrolled",
            "POST",
            "/api/internal/workers/enroll",
            {
              client: "worker",
              json: { code: fixture.records.get("code").code, heartbeat },
              status: 201,
            },
          );
          const event = await probe.message(
            (v) =>
              v.type === "event" &&
              v.resource === "worker" &&
              v.entityId === heartbeat.workerId,
          );
          assert.deepEqual(
            { ...event, cursor: 0, occurredAt: "" },
            {
              type: "event",
              cursor: 0,
              scope: currentUser,
              resource: "worker",
              action: "invalidated",
              entityId: heartbeat.workerId,
              revision: null,
              payload: null,
              occurredAt: "",
            },
          );
          const catalog = await fixture.observe(
            "after event",
            "GET",
            "/api/workers",
          );
          assert.ok(
            catalog.body.some(
              (worker) => worker.workerId === heartbeat.workerId,
            ),
            "Invalidation points at committed state",
          );
          const resumed = await open(fixture);
          await resumed.initialized({
            serverEpoch: ready.serverEpoch,
            cursor: subscribed.cursor,
          });
          await resumed.subscribed("resume");
          const replay = await resumed.message(
            (v) =>
              v.type === "event" &&
              v.resource === "worker" &&
              v.entityId === heartbeat.workerId,
          );
          assert.deepEqual(
            replay,
            event,
            "Replay retains the original publication",
          );
          const caughtUp = await resumed.message((v) => v.type === "caught-up");
          assert.ok(caughtUp.replayedCount >= 1);
          await resumed.close();
          observations.cases.push({
            label: "post-commit worker invalidation and reconnect replay",
            passed: true,
          });
        }
        await probe.close();
        for (const [label, send, code, reason] of [
          [
            "five invalid JSON frames",
            (socket) => socket.send("{"),
            1008,
            "Too many live protocol errors",
          ],
          [
            "five binary frames",
            (socket) => socket.send(Buffer.from("binary")),
            1008,
            "Too many live protocol errors",
          ],
          [
            "application payload bound",
            (socket) => socket.send(" ".repeat(65537)),
            1009,
            "Live frame is too large",
          ],
        ]) {
          const invalid = await open(fixture);
          await invalid.initialized();
          const count = code === 1009 ? 1 : 5;
          for (let i = 0; i < count; i++) send(invalid.socket);
          for (let i = 0; i < count; i++) {
            const error = await invalid.message((v) => v.type === "error");
            assert.equal(
              error.code,
              code === 1009 ? "payload-too-large" : "invalid-message",
            );
          }
          const closed = await invalid.waitClosed();
          assert.deepEqual(closed, { code, reason });
          observations.cases.push({ label, closed, errors: count });
        }
        if (profile.mode !== "none") {
          await fixture.observe("second login", "POST", "/api/auth/login", {
            client: "second",
            json:
              profile.mode === "accounts"
                ? { email: "owner@example.invalid", password }
                : { password },
          });
          await fixture.observe("second session", "GET", "/api/auth/session", {
            client: "second",
          });
          const observer = await open(fixture);
          await observer.initialized();
          await observer.subscribed("presence");
          const other = await open(fixture, { client: "second" });
          await other.initialized();
          const connected = await observer.message(
            (v) => v.type === "event" && v.resource === "account-session",
          );
          await fixture.observe(
            "connected sessions",
            "GET",
            "/api/account/sessions",
          );
          const sessions = fixture.records.get("connected sessions");
          const remote = sessions.find((s) => !s.current);
          assert.equal(remote?.connected, true);
          assert.equal(connected.entityId, remote.id);
          // Hold the actual close acknowledgment. Database revocation and
          // session-index removal must not prematurely release account capacity.
          other.socket._socket.pause();
          await fixture.observe("second logout", "POST", "/api/auth/logout", {
            client: "second",
            csrf: true,
            status: 204,
          });
          const excess = await open(fixture);
          assert.deepEqual(await excess.waitClosed(), {
            code: 1013,
            reason: "Account WebSocket connection limit reached",
          });
          other.socket._socket.resume();
          assert.deepEqual(await other.waitClosed(), {
            code: 1008,
            reason: "Session was revoked",
          });
          await fixture.observe(
            "sessions after revoke",
            "GET",
            "/api/account/sessions",
          );
          assert.equal(
            fixture.records
              .get("sessions after revoke")
              .some((s) => s.id === remote.id),
            false,
          );
          await fixture.observe("logout all", "POST", "/api/auth/logout-all", {
            csrf: true,
          });
          assert.deepEqual(await observer.waitClosed(), {
            code: 1008,
            reason: "Account sessions were revoked",
          });
          observations.cases.push({
            label:
              "session presence, direct revocation and account-wide logout",
            passed: true,
          });
        } else {
          const anonymous = await open(fixture);
          await anonymous.initialized();
          await fixture.observe(
            "anonymous logout",
            "POST",
            "/api/auth/logout",
            { json: {}, status: 204 },
          );
          assert.deepEqual(await anonymous.waitClosed(), {
            code: 1008,
            reason: "Session was revoked",
          });
          observations.cases.push({
            label: "anonymous session revocation",
            passed: true,
          });
        }
        if (profile.name === "development") {
          const stopping = await open(fixture);
          await stopping.initialized();
          await fixture.close();
          const closed = await stopping.waitClosed();
          assert.deepEqual(closed, { code: 1005, reason: "" });
          observations.cases.push({
            label: "actual process shutdown closes active Live transport",
            closed,
          });
        }
        // Every received event is retained in this report. Additional background
        // resource publishers are not claimed as parity by this focused suite.
        observations.backgroundEvents = [...probes]
          .filter((p) => p.fixture === fixture)
          .flatMap((p) => p.history.filter((v) => v.type === "event"));
      }
      assert.deepEqual(
        result.observations[1].cases,
        result.observations[0].cases,
        "Focused actual Live behavior differs",
      );
      result.passed = true;
    } catch (error) {
      scenarioFailure = error;
      result.error = error.message;
    } finally {
      const socketResults = await Promise.allSettled(
        [...probes].map((p) => {
          p.socket._socket?.resume();
          return p.close();
        }),
      );
      const serverResults = await Promise.allSettled(
        pair.map((f) => f.close()),
      );
      const errors = [...socketResults, ...serverResults]
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason);
      if (scenarioFailure || errors.length)
        throw new AggregateError(
          [...(scenarioFailure ? [scenarioFailure] : []), ...errors],
          `Live profile ${profile.name}: ${scenarioFailure?.message ?? "cleanup failed"}`,
        );
    }
  }
} catch (error) {
  failure = error;
  report.error = {
    message: error.message,
    errors: error.errors?.map((v) => v.message),
  };
} finally {
  try {
    await postgresOwner?.close();
  } catch (error) {
    failure ??= error;
    report.error ??= { message: error.message };
  }
  await rm(root, { recursive: true, force: true });
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      {
        suite: report.suite,
        databaseMode,
        profiles: report.profiles.map((p) => ({
          name: p.name,
          passed: p.passed,
          cases: p.observations.map((o) => o.cases.length),
        })),
        error: report.error,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
