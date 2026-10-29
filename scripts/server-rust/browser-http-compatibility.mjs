// Real HTTP, response validation, CSRF, Live and production worker transport.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { AttachmentFixture } from "./tunnel-attachment-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  label,
  state,
  literal,
} from "./project-target-state.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { tunnelRecord } from "./tunnel-record-fixture.mjs";
import { browserCleanupFailure } from "./browser-cleanup-failure.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report"),
  root = await mkdtemp(path.join(tmpdir(), "cantrip-browser-http-"));
const report = {
  suite: "actual-browser-management-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const ids = Array.from(
    { length: 8 },
    (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i + 1).padStart(12, "0")}`,
  ),
  titleProtection = label("browser"),
  stateProtection = state("browser-state"),
  create = { id: ids[0], titleProtection, stateProtection };
const resources = new Set([
  "browser",
  "tunnel",
  "project-tab-layout",
  "remote-desktop",
  "project-view",
]);
const events = (live) =>
  live.history
    .filter((e) => e.type === "event" && resources.has(e.resource))
    .map(({ resource, scope, entityId, revision, payload, action }) => ({
      resource,
      scope,
      entityId,
      revision,
      payload,
      action,
    }));
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
    await delay(10);
  }
}
let pg, failure;
try {
  const executable = await buildRustServer(),
    repositoryBinary = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new AttachmentFixture({
        kind,
        executable,
        root,
        name: profile,
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
        changes: [],
        commands: [],
        states: [],
      };
      runtimes.push(result);
      let repo,
        live,
        foreignLive,
        worker,
        configureMode = "ok";
      const openRepo = () =>
        repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
      const visit = async (name, method, url, options = {}) => {
        const before = live ? events(live).length : 0,
          foreignBefore = foreignLive ? events(foreignLive).length : 0;
        const observation = await fixture.observe(name, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ name, ...observation });
        if (live) {
          const expected = options.eventResources ?? [];
          if (expected.length)
            await eventually(
              () => events(live).slice(before),
              (es) =>
                assert.equal(es.length, expected.length, name + " event count"),
            );
          await live.ping(name);
          const es = events(live).slice(before);
          assert.deepEqual(
            es.map((e) => e.resource),
            expected,
            name + " exact resource order",
          );
          if (foreignLive) {
            await foreignLive.ping(name);
            assert.equal(
              events(foreignLive).length,
              foreignBefore,
              name + " tenant isolation",
            );
          }
          result.changes.push({ name, events: es });
        }
        return fixture.records.get(name);
      };
      const stored = async (name) => {
        await live?.ping(name);
        await fixture.close();
        repo = await openRepo();
        const raw = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('surfaces',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'lastError',last_error,'stateRevision',state_revision) ORDER BY id) FROM remote_surfaces),'browsers',(SELECT jsonb_agg(jsonb_build_object('id',id,'stateRevision',state_revision,'titleProtection',protected_label,'stateProtection',protected_state) ORDER BY id) FROM browsers),'tunnels',(SELECT jsonb_agg(jsonb_build_object('id',id,'management',management,'status',status,'destinationWorkerId',destination_worker_id,'protectedRevision',protected_revision) ORDER BY id) FROM tunnels)) result",
        });
        assert.equal(raw.rejected, false, raw.diagnostic);
        result.states.push({ name, value: fixture.normalize(raw.value) });
        await repo.close();
        repo = undefined;
      };
      try {
        await fixture.start();
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `browser-${client}@example.invalid`,
                displayName: client,
                password,
              },
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else await visit("session", "GET", "/api/auth/session");
        fixture.sqlErrorOwner = owner;
        await fixture.close();
        repo = await openRepo();
        for (const sql of targetStateSql(owner, other)) await repo.seed(sql);
        await repo.close();
        repo = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("browser scopes", [
          currentUser,
          { kind: "project", projectId: "github" },
        ]);
        if (profile === "accounts") {
          foreignLive = await new LiveProbe(fixture, {
            client: "other",
          }).open();
          await foreignLive.initialized();
          await foreignLive.subscribed();
        }
        for (const project of ["github", "other", "missing"])
          await visit(
            "list " + project,
            "GET",
            `/api/projects/${project}/browsers`,
          );
        await visit("HEAD list", "HEAD", "/api/projects/github/browsers", {
          compareContentLength: true,
        });
        for (const [i, body] of [
          null,
          {},
          [],
          { ...create, extra: 1 },
          { ...create, paneId: "pane", targetRegion: "center" },
          { ...create, titleProtection: label("terminal") },
        ].entries())
          await visit(
            "invalid create " + i,
            "POST",
            "/api/projects/github/browsers",
            { json: body, status: 400 },
          );
        await visit("foreign create", "POST", "/api/projects/other/browsers", {
          json: { ...create, id: ids[1] },
          status: 404,
        });
        await visit(
          "missing create",
          "POST",
          "/api/projects/missing/browsers",
          { json: { ...create, id: ids[1] }, status: 404 },
        );
        for (const [i, body] of [
          {},
          { stateProtection },
          { expectedStateRevision: 1 },
          { titleProtection: label("terminal") },
          { titleProtection, extra: true },
        ].entries())
          await visit(
            "invalid update " + i,
            "PATCH",
            "/api/browsers/" + ids[0],
            { json: body, status: 400 },
          );
        await visit("foreign update", "PATCH", "/api/browsers/other-browser", {
          json: { titleProtection },
          status: 404,
        });
        await visit("missing update", "PATCH", "/api/browsers/missing", {
          json: { titleProtection },
          status: 404,
        });
        await visit("offline state update", "PATCH", "/api/browsers/browser", {
          json: { expectedStateRevision: 1, stateProtection },
          eventResources: [
            "browser",
            "browser",
            "remote-desktop",
            "project-view",
            "browser",
            "tunnel",
            "project-tab-layout",
          ],
        });
        await visit("stale update", "PATCH", "/api/browsers/browser", {
          json: { expectedStateRevision: 1, stateProtection },
          status: 409,
        });
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { json: {}, status: 201 },
        );
        const enrolled = await visit(
          "enroll worker",
          "POST",
          "/api/internal/workers/enroll",
          {
            client: "worker",
            json: {
              code: fixture.records.get("enrollment code").code,
              heartbeat: {
                ...heartbeat,
                workerId: "alpha",
                remoteSurfaces: {
                  browser: true,
                  desktop: true,
                  transports: ["websocket", "webrtc"],
                  maxSessions: 8,
                },
              },
            },
            status: 201,
          },
        );
        const config = {
          dataDirectory: path.join(root, profile, kind, "worker"),
          name: "Browser metadata worker",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: enrolled.credential,
          tokenSource: "persisted",
          workerId: "alpha",
        };
        saveWorkerCredential({
          credential: config.token,
          dataDirectory: config.dataDirectory,
          serverUrl: config.serverUrl,
          workerId: config.workerId,
        });
        let connected = 0;
        worker = new WorkerConnection(
          config,
          async (command) => {
            if (command.type.startsWith("surface.")) {
              result.commands.push(fixture.normalize(command));
              if (
                command.type === "surface.configure" &&
                configureMode === "error"
              )
                throw new Error("Controlled browser configure failure");
            }
            return null;
          },
          undefined,
          undefined,
          undefined,
          1000,
          () => connected++,
        );
        worker.start();
        await eventually(
          () => connected,
          (n) => assert.ok(n > 0),
        );
        if (profile === "accounts") {
          await visit(
            "create requires CSRF",
            "POST",
            "/api/projects/github/browsers",
            { json: create, csrf: false, status: 403 },
          );
          await visit(
            "update requires CSRF",
            "PATCH",
            "/api/browsers/browser",
            { json: { titleProtection }, csrf: false, status: 403 },
          );
          await visit(
            "delete requires CSRF",
            "DELETE",
            "/api/browsers/browser",
            { csrf: false, status: 403 },
          );
        }
        await visit("create browser", "POST", "/api/projects/github/browsers", {
          json: create,
          status: 201,
          eventResources: ["browser", "project-tab-layout"],
        });
        await visit("title update", "PATCH", "/api/browsers/" + ids[0], {
          json: { titleProtection },
          eventResources: ["browser", "tunnel", "project-tab-layout"],
        });
        await visit("online state update", "PATCH", "/api/browsers/" + ids[0], {
          json: { expectedStateRevision: 1, stateProtection },
          eventResources: [
            "browser",
            "browser",
            "tunnel",
            "project-tab-layout",
          ],
        });
        configureMode = "error";
        await visit(
          "worker failure retains committed state",
          "PATCH",
          "/api/browsers/" + ids[0],
          {
            json: { expectedStateRevision: 2, stateProtection },
            eventResources: [
              "browser",
              "browser",
              "remote-desktop",
              "project-view",
              "browser",
              "tunnel",
              "project-tab-layout",
            ],
          },
        );
        const protectedRecord = { ...tunnelRecord, operationId: ids[6] };
        await visit(
          "browser tunnel create",
          "POST",
          `/api/browsers/${ids[0]}/tunnel`,
          {
            json: {
              tunnelId: ids[6],
              protocolHint: "http-websocket",
              workerId: "alpha",
              protectedRecord,
            },
            eventResources: ["browser", "tunnel"],
          },
        );
        const attachment = await visit(
          "browser tunnel attachment",
          "POST",
          `/api/tunnels/${ids[6]}/attachments`,
          {
            json: { clientId: "browser-cleanup-client" },
            status: 201,
            eventResources: ["tunnel", "tunnel"],
          },
        );
        await visit(
          "browser tunnel revision conflict",
          "POST",
          `/api/browsers/${ids[0]}/tunnel`,
          {
            json: {
              tunnelId: ids[6],
              protocolHint: "http-websocket",
              workerId: "alpha",
              protectedRecord,
            },
            status: 409,
          },
        );
        await visit(
          "browser tunnel foreign worker",
          "POST",
          `/api/browsers/${ids[0]}/tunnel`,
          {
            json: {
              tunnelId: ids[6],
              protocolHint: "http-websocket",
              workerId: "foreign",
              protectedRecord: { ...protectedRecord, revision: 2 },
            },
            status: 404,
          },
        );
        const updatedTunnel = await visit(
          "browser tunnel update",
          "POST",
          `/api/browsers/${ids[0]}/tunnel`,
          {
            json: {
              tunnelId: ids[6],
              protocolHint: "https-websocket",
              workerId: "beta",
              resetAttachments: true,
              protectedRecord: {
                ...protectedRecord,
                operationId: ids[7],
                revision: 2,
              },
            },
            eventResources: ["tunnel", "browser", "tunnel"],
          },
        );
        assert.equal(updatedTunnel.desiredState, "started");
        assert.equal(
          updatedTunnel.attachments.find(
            (a) => a.id === attachment.attachmentId,
          )?.status,
          "stopped",
        );
        await visit("foreign delete", "DELETE", "/api/browsers/other-browser", {
          status: 404,
        });
        await visit(
          "delete browser and owned tunnel",
          "DELETE",
          "/api/browsers/" + ids[0],
          {
            status: 204,
            eventResources: [
              "tunnel",
              "browser",
              "tunnel",
              "project-tab-layout",
            ],
          },
        );
        await eventually(
          () => result.commands,
          (cs) => assert.ok(cs.some((c) => c.type === "surface.close")),
        );
        await visit("repeat delete", "DELETE", "/api/browsers/" + ids[0], {
          status: 404,
        });
        assert.equal(
          result.commands.filter((c) => c.type === "surface.configure").length,
          2,
        );
        if (databaseMode === "postgres") {
          await foreignLive?.close();
          foreignLive = undefined;
          await live.close();
          live = undefined;
          await browserCleanupFailure({ fixture, databaseUrl, owner, result });
        }
        worker.close();
        worker = undefined;
        await foreignLive?.close();
        foreignLive = undefined;
        await live?.close();
        live = undefined;
        await stored("persisted state after deletion");
        await fixture.start();
        await visit(
          "retained catalog after restart",
          "GET",
          "/api/projects/github/browsers",
        );
      } finally {
        worker?.close();
        await foreignLive?.close();
        await live?.close();
        await repo?.close();
        await fixture.close();
      }
    }
    assert.deepEqual(
      runtimes[1].observations,
      runtimes[0].observations,
      profile + " complete HTTP contract",
    );
    for (const key of ["changes", "commands", "states"])
      assert.deepEqual(runtimes[1][key], runtimes[0][key], profile + " " + key);
    if (databaseMode === "postgres") {
      for (const key of ["observation", "stored", "expectedSiblings"])
        assert.deepEqual(
          runtimes[1].cleanupFailure[key],
          runtimes[0].cleanupFailure[key],
          profile + " sibling cleanup failure " + key,
        );
    }
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
  else report.fixtureRoot = root;
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      runtimes: p.runtimes.map((r) => ({
        kind: r.kind,
        observations: r.observations.length,
      })),
    })),
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
