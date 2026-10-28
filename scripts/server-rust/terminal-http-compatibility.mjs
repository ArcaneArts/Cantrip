// Production terminal HTTP/Live routes with controlled command outcomes. The
// separate --terminals browser flow uses real encrypted state and full PTYs.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { terminalCreationShutdown } from "./terminal-creation-shutdown.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat, password } from "./security-fixtures.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  label,
  state,
  json,
  literal,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-terminal-http-"));
const report = {
  suite: "actual-terminal-management-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const ids = Array.from(
  { length: 8 },
  (_, i) => `55555555-5555-4555-8555-${String(i + 1).padStart(12, "0")}`,
);
const runtimeId = "88888888-8888-4888-8888-888888888881",
  configurationId = "88888888-8888-4888-8888-888888888882";
const titleProtection = label("terminal"),
  stateProtection = state("terminal-state"),
  create = { id: ids[0], titleProtection, stateProtection };
async function eventually(read, check) {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (error) {
      if (Date.now() >= end) throw error;
    }
    await delay(15);
  }
}
const terminalEvents = (live) =>
  live.history
    .filter(
      (e) =>
        e.type === "event" &&
        ["terminal", "project-tab-layout"].includes(e.resource),
    )
    .map(({ resource, scope, entityId, revision, payload, action }) => ({
      resource,
      scope,
      entityId,
      revision,
      payload,
      action,
    }));
let pg, failure;
try {
  const executable =
      process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer()),
    repoExecutable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const outputs = [];
    report.profiles.push({ profile, runtimes: outputs });
    for (const kind of ["node", "rust"]) {
      const name = "terminals-" + profile,
        databaseUrl =
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = {
        kind,
        observations: [],
        transitions: [],
        commands: [],
        connections: 0,
      };
      outputs.push(result);
      let repo,
        worker,
        live,
        foreignLive,
        reconcileMode = "success",
        restartMode = "success";
      const visit = async (label, method, url, options = {}) => {
        const response = await fixture.observe(label, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          compareContentLength: method === "HEAD",
          ...options,
        });
        result.observations.push({ label, ...response });
        return fixture.records.get(label);
      };
      const openRepo = () =>
        repositoryFixture({
          kind,
          executable: repoExecutable,
          root: path.join(root, name),
          databaseMode,
          databaseUrl,
        });
      try {
        await fixture.start();
        if (kind === "rust")
          result.nativeStackLimits = fixture.server.events.filter(
            (e) => e.event === "test.native.stack-limit",
          );
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `terminal-${client}@example.invalid`,
                displayName: client,
                password,
              },
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        repo = await openRepo();
        for (const sql of targetStateSql(owner, other)) await repo.seed(sql);
        await repo.seed("UPDATE terminals SET position=1 WHERE id='�'");
        await repo.seed(
          `INSERT INTO run_configuration_runtimes(id,owner_id,project_id,configuration_id,worktree_id,worker_id,definition_revision,requested_operation_id,created_at,updated_at) VALUES(${literal(runtimeId)},${literal(owner)},'github',${literal(configurationId)},'github-alpha-main','alpha',${literal("a".repeat(64))},${literal(ids[7])},${literal(stamp)},${literal(stamp)})`,
        );
        await repo.seed(
          `INSERT INTO terminals(id,project_id,kind,worktree_id,active_worker_id,run_configuration_id,run_configuration_runtime_id,position,created_at,updated_at) VALUES('run-terminal','github','run-configuration','github-alpha-main','alpha',${literal(configurationId)},${literal(runtimeId)},2,${literal(stamp)},${literal(stamp)})`,
        );
        await repo.seed(
          `UPDATE run_configuration_runtimes SET terminal_id='run-terminal' WHERE id=${literal(runtimeId)}`,
        );
        await repo.close();
        repo = undefined;
        await fixture.start();
        await visit(
          "owned terminal list",
          "GET",
          "/api/projects/github/terminals",
        );
        await visit(
          "terminal list HEAD",
          "HEAD",
          "/api/projects/github/terminals",
        );
        await visit(
          "foreign project list hidden",
          "GET",
          "/api/projects/other/terminals",
        );
        await visit(
          "missing project list empty",
          "GET",
          "/api/projects/missing/terminals",
        );
        for (const body of [
          null,
          {},
          [],
          { ...create, extra: 1 },
          {
            ...create,
            worktreeId: "github-alpha-main",
            target: { kind: "project", projectId: "github" },
          },
          { ...create, paneId: "pane", targetRegion: "center" },
          { ...create, titleProtection: label("project") },
        ])
          await visit(
            "invalid create " + JSON.stringify(body),
            "POST",
            "/api/projects/github/terminals",
            { json: body, status: 400 },
          );
        for (const [terminal, status] of [
          ["missing", 404],
          ["other-terminal", 404],
          ["run-terminal", 409],
        ]) {
          await visit(
            "metadata guard " + terminal,
            "PATCH",
            `/api/terminals/${terminal}`,
            { json: { titleProtection }, status },
          );
          await visit(
            "service guard " + terminal,
            "PUT",
            `/api/terminals/${terminal}/service`,
            { json: { enabled: true, stateProtection }, status },
          );
          await visit(
            "restart guard " + terminal,
            "POST",
            `/api/terminals/${terminal}/service/restart`,
            { json: {}, status },
          );
        }
        await visit(
          "restart disabled service",
          "POST",
          "/api/terminals/terminal/service/restart",
          { json: {}, status: 409 },
        );
        const offlineConfigured = await visit(
          "enable offline service",
          "PUT",
          "/api/terminals/terminal/service",
          { json: { enabled: true, stateProtection } },
        );
        assert.equal(offlineConfigured.status, "offline");
        await visit(
          "restart known offline enabled service",
          "POST",
          "/api/terminals/terminal/service/restart",
          { json: {}, status: 503 },
        );
        const offlineDisabled = await visit(
          "disable offline service",
          "PUT",
          "/api/terminals/terminal/service",
          { json: { enabled: false, stateProtection } },
        );
        assert.equal(offlineDisabled.status, "idle");
        await visit(
          "restart malformed JSON is still parsed",
          "POST",
          "/api/terminals/terminal/service/restart",
          { json: {}, raw: "{", status: 400 },
        );
        if (profile === "accounts") {
          await visit(
            "CSRF before terminal mutation",
            "PATCH",
            "/api/terminals/terminal",
            { json: { titleProtection }, csrf: false, status: 403 },
          );
          await visit(
            "foreign terminal update hidden",
            "PATCH",
            "/api/terminals/terminal",
            { client: "other", json: { titleProtection }, status: 404 },
          );
        }
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { json: {}, status: 201 },
        );
        await visit("enrolled worker", "POST", "/api/internal/workers/enroll", {
          client: "worker",
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: { ...heartbeat, workerId: "alpha" },
          },
          status: 201,
        });
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("terminal scopes", [
          { kind: "current-user" },
          { kind: "project", projectId: "github" },
        ]);
        if (profile === "accounts") {
          foreignLive = await new LiveProbe(fixture, {
            client: "other",
          }).open();
          await foreignLive.initialized();
          await foreignLive.subscribed();
        }
        const config = {
          dataDirectory: path.join(root, name, kind, "worker"),
          name: "Terminal transport",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("enrolled worker").credential,
          tokenSource: "persisted",
          workerId: "alpha",
        };
        const connectWorker = () => {
          saveWorkerCredential({
            credential: config.token,
            dataDirectory: config.dataDirectory,
            serverUrl: config.serverUrl,
            workerId: config.workerId,
          });
          worker = new WorkerConnection(
            config,
            async (command) => {
              if (
                ![
                  "terminal.services.reconcile",
                  "terminal.service.restart",
                ].includes(command.type)
              )
                throw new Error("Controlled metadata command is unsupported");
              result.commands.push(command);
              if (command.type === "terminal.services.reconcile") {
                for (const service of command.services) {
                  assert.equal(service.terminalId, ids[0]);
                  assert.equal(service.worktreePath, "/fixture/github-alpha");
                  assert.deepEqual(service.stateProtection, stateProtection);
                  assert.match(service.serverId, /^[0-9a-f-]{36}$/);
                }
                if (reconcileMode === "error")
                  throw new Error("Controlled terminal reconciliation failure");
                return { notAResponseSchema: true };
              }
              if (restartMode === "error")
                throw new Error("Controlled terminal restart failure");
              return null;
            },
            undefined,
            undefined,
            undefined,
            1000,
            () => result.connections++,
          );
          worker.start();
        };
        connectWorker();
        await eventually(
          () => result.connections,
          (n) => assert.equal(n, 1),
        );
        const transition = async (
          label,
          method,
          url,
          options,
          resources,
          scope = "current-user",
          entity = ids[0],
        ) => {
          await live.ping("before " + label);
          const start = terminalEvents(live).length;
          const body = await visit(label, method, url, options);
          await eventually(
            () => terminalEvents(live).slice(start),
            (events) =>
              assert.equal(
                events.length,
                resources.length,
                label + " exact Live count",
              ),
          );
          await live.ping("after " + label);
          const events = terminalEvents(live).slice(start);
          assert.deepEqual(
            events.map((e) => e.resource),
            resources,
            label + " Live ordering",
          );
          for (const event of events) {
            assert.deepEqual(
              event.scope,
              scope === "project"
                ? { kind: "project", projectId: "github" }
                : { kind: "current-user" },
            );
            assert.equal(event.entityId, entity);
            assert.equal(event.action, "invalidated");
            assert.equal(event.revision, null);
            assert.equal(event.payload, null);
          }
          result.transitions.push({ label, events });
          return body;
        };
        const url = `/api/terminals/${ids[0]}`,
          configuration = { enabled: true, stateProtection };
        await transition(
          "create terminal and pane",
          "POST",
          "/api/projects/github/terminals",
          { json: create, status: 201 },
          ["terminal", "project-tab-layout"],
          "project",
          "github",
        );
        await transition(
          "rename opaque terminal",
          "PATCH",
          url,
          { json: { titleProtection } },
          ["terminal", "project-tab-layout"],
        );
        await transition(
          "duplicate terminal rolls back",
          "POST",
          "/api/projects/github/terminals",
          { json: create, status: 500 },
          [],
        );
        await transition(
          "enable connected service",
          "PUT",
          url + "/service",
          { json: configuration },
          ["terminal", "terminal", "terminal", "project-tab-layout"],
        );
        await transition(
          "restart enabled service",
          "POST",
          url + "/service/restart",
          { json: {}, status: 202 },
          ["terminal", "terminal", "project-tab-layout"],
        );
        restartMode = "error";
        await transition(
          "actual worker restart rejection",
          "POST",
          url + "/service/restart",
          { json: {}, status: 502 },
          [],
        );
        restartMode = "success";
        await transition(
          "disable connected service",
          "PUT",
          url + "/service",
          { json: { enabled: false, stateProtection } },
          ["terminal", "terminal", "project-tab-layout"],
        );
        reconcileMode = "error";
        const deferred = await transition(
          "reconcile failure retains enabled configuration",
          "PUT",
          url + "/service",
          { json: configuration },
          ["terminal", "terminal", "project-tab-layout"],
        );
        assert.equal(deferred.status, "offline");
        assert.equal(deferred.serviceEnabled, true);
        reconcileMode = "success";
        await transition(
          "connected reconciliation recovers",
          "PUT",
          url + "/service",
          { json: configuration },
          ["terminal", "terminal", "terminal", "project-tab-layout"],
        );
        await visit(
          "final projection",
          "GET",
          "/api/projects/github/terminals",
        );
        if (foreignLive) {
          await foreignLive.ping();
          assert.deepEqual(
            terminalEvents(foreignLive),
            [],
            "other owner receives no terminal/layout mutations",
          );
        }
        await live.close();
        live = undefined;
        await foreignLive?.close();
        foreignLive = undefined;
        if (databaseMode === "postgres") {
          result.shutdown = {};
          await terminalCreationShutdown(
            fixture,
            "github",
            { ...create, id: ids[1] },
            result.shutdown,
            () => {
              worker.close();
              worker = undefined;
            },
          );
        }
        worker?.close();
        worker = undefined;
        await fixture.close();
        repo = await openRepo();
        const persisted = await repo.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('status',t.status,'enabled',t.service_enabled,'members',(SELECT count(*) FROM tab_group_members WHERE tab_id=t.id),'revision',p.tab_layout_revision) result FROM terminals t JOIN projects p ON p.id=t.project_id WHERE t.id=${literal(ids[0])}`,
        });
        assert.equal(persisted.rejected, false);
        result.persisted = persisted.value;
        assert.equal(result.persisted.status, "running");
        assert.equal(result.persisted.enabled, true);
        assert.equal(result.persisted.members, 1);
        assert.equal(
          result.persisted.revision,
          databaseMode === "postgres" ? 2 : 1,
        );
      } finally {
        worker?.close();
        await live?.close();
        await foreignLive?.close();
        await repo?.close();
        await fixture.close();
      }
    }
    assert.deepEqual(
      outputs[1].observations,
      outputs[0].observations,
      profile + " exact HTTP contracts",
    );
    assert.deepEqual(
      outputs[1].transitions,
      outputs[0].transitions,
      profile + " exact ordered Live contracts",
    );
    assert.deepEqual(
      outputs[1].persisted,
      outputs[0].persisted,
      profile + " retained terminal/layout state",
    );
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      observations: p.runtimes[0].observations.length,
      transitions: p.runtimes[0].transitions.length,
    })),
  }),
);
