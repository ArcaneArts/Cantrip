// Actual production HTTP/Live routes and unchanged worker transport; controlled
// refresh/reconcile outcomes keep every transition observable and repeatable.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { terminalMaintenanceShutdown } from "./maintenance-shutdown.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import {
  heartbeat,
  password,
  workerPrincipalId,
  timestamp,
} from "./security-fixtures.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
} from "./project-target-state.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-maintenance-http-"));
const report = {
  suite: "actual-worker-encryption-refresh-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const baseline = {
  supported: true,
  state: "ready",
  principalId: workerPrincipalId,
  grants: [
    { component: "repository-content", keyRevision: 1 },
    { component: "surface-private-state", keyRevision: 1 },
  ],
  lastSyncedAt: timestamp,
  error: null,
};
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
const events = (live) =>
  live.history
    .filter(
      (f) => f.type === "event" && ["terminal", "worker"].includes(f.resource),
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
      const name = "maintenance-" + profile,
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
        commands: [],
        transitions: [],
        connections: 0,
      };
      outputs.push(result);
      let repo,
        worker,
        live,
        foreignLive,
        nextStatus = baseline,
        mode = "success",
        reconcileMode = "success";
      const visit = async (label, method, url, options = {}) => {
        const response = await fixture.observe(label, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ label, ...response });
        return fixture.records.get(label);
      };
      const endpoint = "/api/workers/alpha/encryption/refresh",
        input = { component: "surface-private-state", keyRevision: 1 };
      try {
        await fixture.start();
        if (kind === "rust")
          result.nativeStackLimits = fixture.server.events.filter(
            (event) => event.event === "test.native.stack-limit",
          );
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `maintenance-${client}@example.invalid`,
                displayName: client,
                password,
              },
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        const openRepo = () =>
          repositoryFixture({
            kind,
            executable: repoExecutable,
            root: path.join(root, name),
            databaseMode,
            databaseUrl,
          });
        repo = await openRepo();
        for (const sql of targetStateSql(owner, other)) await repo.seed(sql);
        await repo.seed(
          "UPDATE terminals SET service_enabled=true WHERE id IN ('terminal','�','other-terminal')",
        );
        await repo.close();
        repo = undefined;
        await fixture.start();
        for (const body of [
          null,
          {},
          [],
          { ...input, extra: true },
          { ...input, keyRevision: 0 },
        ])
          await visit("invalid " + JSON.stringify(body), "POST", endpoint, {
            json: body,
            status: 400,
          });
        await visit(
          "invalid before missing worker",
          "POST",
          "/api/workers/missing/encryption/refresh",
          { json: {}, status: 400 },
        );
        await visit(
          "missing worker",
          "POST",
          "/api/workers/missing/encryption/refresh",
          { json: input, status: 404 },
        );
        await visit("offline worker", "POST", endpoint, {
          json: input,
          status: 503,
        });
        await visit("no HEAD handler", "HEAD", endpoint, { status: 404 });
        if (profile === "accounts") {
          await visit("foreign owner hidden", "POST", endpoint, {
            client: "other",
            json: input,
            status: 404,
          });
          await visit("CSRF required", "POST", endpoint, {
            csrf: false,
            json: input,
            status: 403,
          });
        }
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 201, json: {} },
        );
        await visit("enrolled worker", "POST", "/api/internal/workers/enroll", {
          status: 201,
          client: "worker",
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: {
              ...heartbeat,
              workerId: "alpha",
              encryption: baseline,
            },
          },
        });
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed();
        if (profile === "accounts") {
          foreignLive = await new LiveProbe(fixture, {
            client: "other",
          }).open();
          await foreignLive.initialized();
          await foreignLive.subscribed();
        }
        const config = {
          dataDirectory: path.join(root, name, kind, "worker"),
          name: "Encryption transport",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("enrolled worker").credential,
          tokenSource: "persisted",
          workerId: "alpha",
        };
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
                "worker.encryption.refresh",
                "terminal.services.reconcile",
              ].includes(command.type)
            )
              throw new Error("Controlled metadata command is unsupported");
            result.commands.push(command);
            if (command.type === "terminal.services.reconcile") {
              assert.deepEqual(
                new Set(command.services.map((s) => s.terminalId)),
                new Set(["terminal", "�"]),
              );
              for (const service of command.services) {
                assert.match(service.serverId, /^[0-9a-f-]{36}$/);
                assert.equal(service.worktreePath, "/fixture/github-alpha");
                assert.ok(service.stateProtection.protectedState);
              }
              if (reconcileMode === "error")
                throw new Error("Controlled terminal reconcile failure");
              return { unvalidatedReconcileResult: true };
            }
            if (mode === "error")
              throw new Error("Controlled encryption refresh failure");
            if (mode === "null") return null;
            return {
              component: command.component,
              keyRevision: command.keyRevision,
              status: nextStatus,
            };
          },
          undefined,
          undefined,
          undefined,
          1000,
          () => result.connections++,
        );
        worker.start();
        await eventually(
          () => result.connections,
          (n) => assert.equal(n, 1),
        );
        await eventually(
          () =>
            result.commands.filter(
              (c) => c.type === "terminal.services.reconcile",
            ).length,
          (n) =>
            assert.equal(
              n,
              1,
              "worker reconnect dispatches real terminal services",
            ),
        );
        if (profile === "none")
          await eventually(
            () => events(live).filter((e) => e.resource === "terminal").length,
            (n) =>
              assert.equal(
                n,
                2,
                "worker reconnect publishes under its existing local request owner",
              ),
          );
        result.connectedEvents = events(live);
        const refresh = async (
          label,
          component,
          status,
          changed = false,
          expectedStatus = 200,
        ) => {
          await live.ping("before " + label);
          const start = events(live).length,
            commands = result.commands.length;
          nextStatus = status;
          await visit(label, "POST", endpoint, {
            json: { component, keyRevision: 1 },
            status: expectedStatus,
          });
          if (expectedStatus === 200)
            await eventually(
              () => events(live).slice(start),
              (items) =>
                assert.equal(
                  items.filter((e) => e.resource === "worker").length,
                  1,
                ),
            );
          await live.ping("after " + label);
          const observed = events(live).slice(start),
            routed = result.commands.slice(commands);
          assert.equal(
            routed.filter((c) => c.type === "terminal.services.reconcile")
              .length,
            changed ? 1 : 0,
            label + " reconciliation dispatch",
          );
          const terminals = observed.filter((e) => e.resource === "terminal");
          assert.deepEqual(
            terminals.map((e) => e.entityId).sort(),
            changed && expectedStatus === 200 ? ["terminal", "�"] : [],
            label + " committed status invalidations",
          );
          for (const event of observed) {
            assert.deepEqual(event.scope, { kind: "current-user" });
            assert.equal(event.action, "invalidated");
            assert.equal(event.payload, null);
            assert.equal(event.revision, null);
          }
          if (expectedStatus === 200)
            assert.equal(
              observed.at(-1).resource,
              "worker",
              label + " worker invalidation follows terminal writes",
            );
          result.transitions.push({
            label,
            events: observed,
            commands: routed.map((c) => c.type),
          });
        };
        await refresh(
          "repository change skips terminal hook",
          "repository-content",
          { ...baseline, state: "error", error: "Repository error" },
        );
        await refresh(
          "same surface material skips hook",
          "surface-private-state",
          baseline,
        );
        await refresh("timestamp alone skips hook", "surface-private-state", {
          ...baseline,
          lastSyncedAt: null,
        });
        await refresh("grant order alone skips hook", "surface-private-state", {
          ...baseline,
          grants: [...baseline.grants].reverse(),
        });
        await refresh(
          "principal material change reconciles",
          "surface-private-state",
          { ...baseline, principalId: "44444444-4444-4444-8444-444444444444" },
          true,
        );
        await refresh(
          "grant revision change reconciles",
          "surface-private-state",
          {
            ...baseline,
            grants: baseline.grants.map((g) => ({ ...g, keyRevision: 2 })),
          },
          true,
        );
        mode = "error";
        await refresh(
          "actual worker refresh failure",
          "surface-private-state",
          baseline,
          false,
          502,
        );
        mode = "null";
        await refresh(
          "invalid worker response",
          "surface-private-state",
          baseline,
          false,
          502,
        );
        mode = "success";
        reconcileMode = "error";
        await refresh(
          "actual terminal reconcile failure",
          "surface-private-state",
          { ...baseline, state: "error", error: "Surface error" },
          true,
          502,
        );
        reconcileMode = "success";
        if (foreignLive) {
          await foreignLive.ping();
          assert.deepEqual(
            events(foreignLive),
            [],
            "foreign account receives no terminal or worker events",
          );
        }
        if (databaseMode === "postgres") {
          nextStatus = {
            ...baseline,
            state: "error",
            error: "Surface state changed before retained status writes",
          };
          result.shutdown = {};
          await terminalMaintenanceShutdown(fixture, input, result.shutdown, {
            disconnectCaller: profile === "none",
            stopWorker: () => {
              worker.close();
              worker = undefined;
            },
          });
        }
        worker?.close();
        worker = undefined;
        await live.close();
        live = undefined;
        await foreignLive?.close();
        foreignLive = undefined;
        await fixture.close();
        repo = await openRepo();
        const persisted = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_agg(jsonb_build_object('id',id,'status',status) ORDER BY id) result FROM terminals",
        });
        assert.equal(persisted.rejected, false);
        result.persisted = persisted.value;
        for (const id of ["terminal", "�"])
          assert.equal(
            result.persisted.find((t) => t.id === id).status,
            databaseMode === "postgres" &&
              profile === "accounts" &&
              id === "terminal"
              ? "idle"
              : "running",
          );
        assert.equal(
          result.persisted.find((t) => t.id === "other-terminal").status,
          "idle",
        );
      } finally {
        result.serverEvents = fixture.server?.events ?? [];
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
      profile + " HTTP contracts",
    );
    // Promise.all starts independent status writes; actual reference receipts
    // show either terminal finishing first. Preserve raw arrival order above,
    // require both terminal commits before the worker event in refresh(), and
    // compare only that independent sibling group without imposing an order.
    const siblingEvents = (items) => [
      ...items
        .filter((e) => e.resource === "terminal")
        .sort((a, b) => a.entityId.localeCompare(b.entityId)),
      ...items.filter((e) => e.resource !== "terminal"),
    ];
    assert.deepEqual(
      outputs[1].transitions.map((t) => ({
        ...t,
        events: siblingEvents(t.events),
      })),
      outputs[0].transitions.map((t) => ({
        ...t,
        events: siblingEvents(t.events),
      })),
      profile + " refresh command and Live contracts",
    );
    assert.deepEqual(
      siblingEvents(outputs[1].connectedEvents),
      siblingEvents(outputs[0].connectedEvents),
      profile + " reconnect Live contracts",
    );
    assert.deepEqual(
      outputs[1].persisted,
      outputs[0].persisted,
      profile + " persisted terminal status",
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
