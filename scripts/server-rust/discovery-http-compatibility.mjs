// Actual production HTTP routes/executor, App Live, and unchanged worker transport.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import {
  heartbeat,
  password,
  projectLabel,
  initialization,
} from "./security-fixtures.mjs";
import { discoveryWireFixtures } from "./discovery-wire-fixtures.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { discoveryLifecycleCases } from "./discovery-lifecycle-cases.mjs";
import { discoveryExpiryCases } from "./discovery-expiry-cases.mjs";
import { discoveryLifetimeCases } from "./discovery-lifetime-cases.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const profiles = option("--profile")
  ? [option("--profile")]
  : ["none", "password", "accounts"];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-discovery-http-"));
const report = {
  suite: "workspace-discovery-http-worker-live",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const ids = Array.from(
  { length: 8 },
  (_, i) => `66666666-6666-4666-8666-${String(i + 1).padStart(12, "0")}`,
);
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
const counts = (candidates) => ({
  candidates,
  collapsedRepositories: 0,
  rejectedRepositories: 0,
  scannedDirectories: 3,
  scannedEntries: 5,
  skippedSymlinks: 1,
  unreadableDirectories: 0,
});
const name =
  discoveryWireFixtures(projectLabel).encryptedProjectWorkspaceCreateSchema[0]
    .nameProtection;
const until = async (read, check, timeoutMs = 20000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (e) {
      if (Date.now() >= end) throw e;
    }
    await delay(20);
  }
};
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  const passwordHash = await hashPassword(password);
  for (const profile of profiles) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
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
        events: [],
        responseInvalidations: [],
      };
      let ownerId;
      const normalize = fixture.normalize.bind(fixture);
      fixture.normalize = (value, key = "") => {
        if (
          key === "error" &&
          typeof value === "string" &&
          value.startsWith('Failed query: insert into "project_workspaces"')
        ) {
          const parameters = `\nparams: ${ids[4]},${ownerId},`;
          assert.ok(
            value.includes(parameters),
            "failed insert diagnostic retains the requested project identity and authenticated owner",
          );
          return value.replace(
            parameters,
            `\nparams: ${ids[4]},${normalize(ownerId)},`,
          );
        }
        if (
          typeof value === "string" &&
          value.startsWith("workspace:default:")
        ) {
          assert.equal(
            value,
            "workspace:default:" + ownerId,
            "system workspace retains the authenticated owner's identity",
          );
          return "workspace:default:" + normalize(ownerId);
        }
        return normalize(value, key);
      };
      runtimes.push(result);
      let worker,
        live,
        connected = false,
        releaseScan,
        releaseImport,
        attachMode = "cancel",
        scanMode = "ready",
        importMode = "ready";
      let lifecycleHandler;
      const scanGate = new Promise((resolve) => (releaseScan = resolve)),
        importGate = new Promise((resolve) => (releaseImport = resolve));
      const visit = async (label, method, url, options = {}) => {
        const workspaceId =
          /^\/api\/workspaces\/([^/]+)\/repository-/.exec(url)?.[1] ?? ids[1];
        const broad = () =>
          live?.history.filter(
            (f) =>
              f.type === "event" &&
              f.resource === "workspace-repository-discovery-job" &&
              f.entityId === workspaceId &&
              f.revision === null,
          ) ?? [];
        const before = broad().length;
        const observation = await fixture.observe(label, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({
          label,
          ...observation,
        });
        if (
          live &&
          method === "POST" &&
          observation.status < 400 &&
          /\/repository-(?:discovery|imports)$/.test(url)
        ) {
          await live.ping("response completion " + label);
          const events = broad().slice(before);
          assert.equal(
            events.length,
            1,
            "one completed-response invalidation: " + label,
          );
          const { scope, resource, action, entityId, revision, payload } =
            events[0];
          result.responseInvalidations.push({
            label,
            event: fixture.normalize({
              scope,
              resource,
              action,
              entityId,
              revision,
              payload,
            }),
          });
        }
        return fixture.records.get(label);
      };
      const read = async (url) => {
        const response = await fetch(fixture.server.origin + url, {
          headers: {
            cookie: [...fixture.client().cookies]
              .map(([k, v]) => `${k}=${v}`)
              .join("; "),
          },
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const discovery = (id = ids[1]) =>
        `/api/workspaces/${id}/repository-discovery`;
      const imports = (id = ids[1]) =>
        `/api/workspaces/${id}/repository-imports`;
      const waitScan = (state) =>
        until(
          () => read(discovery()),
          (s) => assert.equal(s.job.state, state, JSON.stringify(s)),
        );
      const attachedInput = (id = ids[1]) => ({
        id,
        nameProtection: {
          ...name,
          blindIndex: Buffer.alloc(32, 1).toString("base64url"),
        },
        storage: { kind: "attached", workerId: "discovery-worker" },
        operationId: ids[5],
        protectedRequest: projectLabel.protectedLabel,
      });
      try {
        await fixture.start();
        if (profile === "accounts")
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: client + "-discovery@example.invalid",
                displayName: client,
                password,
              },
            });
        else if (profile === "password")
          await visit("password sign-in", "POST", "/api/auth/login", {
            json: { password },
          });
        else await visit("session", "GET", "/api/auth/session");
        ownerId =
          profile === "accounts"
            ? fixture.records.get("register main").currentUser.id
            : "00000000-0000-0000-0000-000000000001";
        await visit("initial workspace catalog", "GET", "/api/workspaces");
        await visit(
          "workspace encryption not initialized",
          "POST",
          "/api/workspaces",
          {
            status: 409,
            json: {
              id: ids[0],
              nameProtection: name,
              storage: { kind: "managed" },
            },
          },
        );
        await visit(
          "initialize account encryption",
          "POST",
          "/api/encryption/profile/initialize",
          { status: 201, json: initialization() },
        );
        await visit("create managed workspace", "POST", "/api/workspaces", {
          status: 201,
          json: {
            id: ids[0],
            nameProtection: name,
            storage: { kind: "managed" },
          },
        });
        await visit(
          "duplicate workspace name rejected",
          "POST",
          "/api/workspaces",
          {
            status: 409,
            json: {
              id: ids[4],
              nameProtection: name,
              storage: { kind: "managed" },
            },
          },
        );
        for (const [label, json] of [
          ["empty", {}],
          [
            "unknown",
            {
              id: ids[4],
              nameProtection: name,
              storage: { kind: "managed" },
              unknown: true,
            },
          ],
        ])
          await visit("invalid create " + label, "POST", "/api/workspaces", {
            status: 400,
            json,
          });
        await visit(
          "invalid workspace update",
          "PATCH",
          `/api/workspaces/${ids[0]}`,
          { status: 400, json: { expectedRevision: 1 } },
        );
        await visit(
          "stale workspace update",
          "PATCH",
          `/api/workspaces/${ids[0]}`,
          { status: 409, json: { expectedRevision: 99, isDefault: true } },
        );
        await visit(
          "promote workspace default",
          "PATCH",
          `/api/workspaces/${ids[0]}`,
          { json: { expectedRevision: 1, isDefault: true } },
        );
        await visit(
          "default deletion rejected",
          "DELETE",
          `/api/workspaces/${ids[0]}`,
          { status: 409 },
        );
        await visit(
          "missing workspace update",
          "PATCH",
          `/api/workspaces/${ids[4]}`,
          { status: 404, json: { expectedRevision: 1, isDefault: true } },
        );
        await visit(
          "missing workspace deletion",
          "DELETE",
          `/api/workspaces/${ids[4]}`,
          { status: 404 },
        );
        await visit("missing discovery", "GET", discovery(), { status: 404 });
        await visit(
          "managed workspace scan rejected",
          "POST",
          discovery(ids[0]),
          { status: 409, json: {} },
        );
        await visit(
          "missing attachment worker",
          "POST",
          "/api/workspaces/attached",
          { status: 404, json: attachedInput() },
        );
        const workerHeartbeat = {
          ...heartbeat,
          workerId: "discovery-worker",
          managedFolders: {
            ...heartbeat.managedFolders,
            attachWorkspaceRoot: true,
            discoverWorkspaceRepositories: true,
          },
        };
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 201, json: { label: "Discovery worker" } },
        );
        await visit("enroll worker", "POST", "/api/internal/workers/enroll", {
          client: "worker",
          status: 201,
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: workerHeartbeat,
          },
        });
        const config = {
          dataDirectory: path.join(root, profile, kind, "worker"),
          name: "Discovery worker",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("enroll worker").credential,
          tokenSource: "persisted",
          workerId: workerHeartbeat.workerId,
        };
        saveWorkerCredential({
          credential: config.token,
          dataDirectory: config.dataDirectory,
          serverUrl: config.serverUrl,
          workerId: config.workerId,
        });
        const connectWorker = async () => {
          connected = false;
          worker = new WorkerConnection(
            config,
            async (command, emit) => {
              if (
                lifecycleHandler &&
                [
                  "repository.operation",
                  "workspace.repositories.discover",
                  "workspace.repository-import.validate",
                ].includes(command.type)
              )
                return lifecycleHandler(command, emit);
              if (
                ![
                  "repository.operation",
                  "workspace.repositories.discover",
                  "workspace.repository-import.validate",
                  "terminal.close",
                  "surface.close",
                ].includes(command.type)
              )
                return { accepted: true, paths: [] };
              result.commands.push(command);
              if (command.type === "repository.operation")
                return {
                  operationId: command.operationId,
                  protectedResponse: projectLabel.protectedLabel,
                  ...(attachMode === "ready"
                    ? {
                        workspaceRootAttachment: {
                          rootPathHandle: handle(1),
                          displayHandle: handle(2),
                        },
                      }
                    : {}),
                };
              if (command.type === "workspace.repositories.discover") {
                const progress = {
                  counts: counts(0),
                  truncated: false,
                  diagnosticCode: null,
                };
                emit({
                  type: "workspace.repositories.discovery-progress",
                  jobId: ids[7],
                  attempt: command.attempt,
                  progress,
                });
                emit({
                  type: "workspace.repositories.discovery-progress",
                  jobId: command.jobId,
                  attempt: command.attempt + 1,
                  progress,
                });
                emit({
                  type: "workspace.repositories.discovery-progress",
                  jobId: command.jobId,
                  attempt: command.attempt,
                  progress,
                });
                if (command.attempt === 1) await scanGate;
                if (scanMode === "root-unavailable")
                  throw Object.assign(
                    new Error("Controlled unavailable root"),
                    {
                      code: "root-unavailable",
                    },
                  );
                return {
                  jobId: command.jobId,
                  attempt: command.attempt,
                  counts: counts(1),
                  truncated: false,
                  diagnosticCode: null,
                  candidates: [
                    {
                      path: handle(3),
                      displayPath: handle(4),
                      originUrl: null,
                      github: null,
                      repositoryFingerprint: "a".repeat(64),
                      classification: "local-git",
                      diagnosticCode: null,
                    },
                  ],
                };
              }
              if (command.type === "workspace.repository-import.validate") {
                if (command.attempt === 1) await importGate;
                if (importMode === "repository-changed")
                  throw Object.assign(
                    new Error("Controlled changed repository"),
                    { code: "repository-changed" },
                  );
                return {
                  candidateId: command.candidateId,
                  attempt: command.attempt,
                  path: handle(3),
                  displayPath: handle(4),
                  originUrl: null,
                  github: null,
                  repositoryFingerprint: command.expectedRepositoryFingerprint,
                  classification: "local-git",
                  diagnosticCode: null,
                  branch: "main",
                  head: "f".repeat(40),
                };
              }
              return { accepted: true };
            },
            undefined,
            undefined,
            undefined,
            1000,
            () => (connected = true),
          );
          worker.start();
          await until(
            () => connected,
            (v) => assert.equal(v, true),
          );
          await sendHeartbeat(config, workerHeartbeat);
        };
        await connectWorker();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("discovery", [currentUser]);
        await visit(
          "cancelled attachment",
          "POST",
          "/api/workspaces/attached",
          { json: attachedInput() },
        );
        attachMode = "ready";
        await visit("verified attachment", "POST", "/api/workspaces/attached", {
          status: 201,
          json: attachedInput(),
        });
        await until(
          () =>
            result.commands.filter(
              (c) => c.type === "workspace.repositories.discover",
            ).length,
          (v) => assert.equal(v, 1),
        );
        await visit("running discovery", "GET", discovery());
        await visit("already running scan", "POST", discovery(), {
          status: 409,
          json: {},
        });
        await visit("invalid scan depth", "POST", discovery(), {
          status: 400,
          json: { depth: 17 },
        });
        if (process.argv.includes("--leases")) {
          const started = Date.now();
          while (Date.now() - started < 125000) {
            await delay(Math.min(30000, 125000 - (Date.now() - started)));
            await live.ping("held scan lease heartbeat");
            const retained = await read(discovery());
            assert.equal(retained.job.state, "running");
            assert.equal(retained.job.attempt, 1);
            assert.equal(retained.job.stateRevision, 2);
            assert.equal(
              result.commands.filter(
                (c) => c.type === "workspace.repositories.discover",
              ).length,
              1,
            );
          }
          result.actualHeldMilliseconds = Date.now() - started;
          result.lease = {
            elapsedAtLeastMs: 125000,
            attempt: 1,
            revision: 2,
            commands: 1,
            originalCommandStillRunning: true,
          };
        }
        if (profile === "accounts") {
          await visit("foreign workspace hidden", "GET", discovery(), {
            client: "other",
            status: 404,
          });
          await visit("foreign workspace cannot queue", "POST", discovery(), {
            client: "other",
            status: 409,
            json: {},
          });
          await visit(
            "foreign workspace cannot delete",
            "DELETE",
            `/api/workspaces/${ids[1]}`,
            { client: "other", status: 404 },
          );
        }
        releaseScan();
        let snapshot = await waitScan("succeeded");
        await visit("discovered repository snapshot", "GET", discovery());
        const candidate = snapshot.candidates[0];
        const importInput = (revision = snapshot.job.stateRevision) => ({
          expectedStateRevision: revision,
          candidates: [
            {
              candidateId: candidate.id,
              projectId: ids[2],
              nameProtection: projectLabel,
            },
          ],
        });
        await visit("stale import revision", "POST", imports(), {
          status: 409,
          json: importInput(1),
        });
        const duplicate = importInput();
        duplicate.candidates.push(duplicate.candidates[0]);
        await visit("duplicate import candidates", "POST", imports(), {
          status: 400,
          json: duplicate,
        });
        await visit("queue repository import", "POST", imports(), {
          status: 202,
          json: importInput(),
        });
        await until(
          () => read(discovery()),
          (s) => assert.equal(s.candidates[0].importState, "importing"),
        );
        await visit("importing repository snapshot", "GET", discovery());
        releaseImport();
        snapshot = await until(
          () => read(discovery()),
          (s) => assert.equal(s.candidates[0].importState, "imported"),
        );
        snapshot = await visit(
          "imported repository snapshot",
          "GET",
          discovery(),
        );
        const projects = await visit(
          "imported projects",
          "GET",
          "/api/projects",
        );
        const imported = projects.find((p) => p.id === ids[2]);
        assert.equal(imported.folderManagement, "external");
        assert.equal(imported.capabilities.git, true);
        assert.equal(imported.capabilities.github, false);
        assert.equal(imported.worktreePolicy, "direct");
        await visit(
          "attached workspace cannot be default",
          "PATCH",
          `/api/workspaces/${ids[1]}`,
          { status: 409, json: { expectedRevision: 1, isDefault: true } },
        );
        await visit(
          "rename attached workspace",
          "PATCH",
          `/api/workspaces/${ids[1]}`,
          {
            json: {
              expectedRevision: 1,
              nameProtection: {
                ...name,
                blindIndex: Buffer.alloc(32, 9).toString("base64url"),
              },
            },
          },
        );
        scanMode = "root-unavailable";
        await visit("queue root failure rescan", "POST", discovery(), {
          status: 202,
          json: { expectedStateRevision: snapshot.job.stateRevision, depth: 0 },
        });
        await waitScan("failed");
        await visit("root unavailable snapshot", "GET", discovery());
        scanMode = "ready";
        await visit("retry failed scan", "POST", discovery(), {
          status: 202,
          json: {},
        });
        await waitScan("succeeded");
        await visit(
          "rescanned imported candidate retained",
          "GET",
          discovery(),
        );
        await live.ping("before deletion");
        await visit(
          "delete attached workspace preserving worker files",
          "DELETE",
          `/api/workspaces/${ids[1]}`,
          { status: 204 },
        );
        await visit("workspace gone after removal", "GET", discovery(), {
          status: 404,
        });
        const remaining = await visit(
          "project removed with workspace",
          "GET",
          "/api/projects",
        );
        assert.ok(!remaining.some((p) => p.id === ids[2]));
        await live.ping("final discovery barrier");
        result.commands = result.commands.map((c) => fixture.normalize(c));
        result.events = live.history
          .filter(
            (f) =>
              f.type === "event" &&
              f.resource === "workspace-repository-discovery-job" &&
              f.entityId === ids[1],
          )
          .map((event) =>
            fixture.normalize({
              scope: event.scope,
              resource: event.resource,
              action: event.action,
              entityId: event.entityId,
              revision: event.revision,
              payload: event.payload,
            }),
          );
        // Actual Node PGlite and PostgreSQL produce both interleavings of
        // response-only invalidations and an asynchronous claim. Compare the
        // strict durable/progress sequence and every response at its own
        // boundary; retain the unmodified combined trace as evidence.
        result.liveTrace = result.events;
        result.events = result.events.filter(
          (event) => event.revision !== null,
        );
        assert.deepEqual(
          result.events.map((event) => event.revision),
          [1, 2, 2, 3, 4, 5, 6, 7, 8, 8, 9, 10, 11, 11, 12],
        );
        assert.equal(
          result.events.filter((e) => e.action === "status").length,
          3,
          "only matching progress is published once per scan",
        );
        assert.equal(
          result.commands.filter(
            (c) => c.type === "workspace.repository-import.validate",
          ).length,
          1,
        );
        assert.equal(
          result.commands.some(
            (c) => c.type.includes("remove") || c.type.includes("delete"),
          ),
          false,
          "workspace removal never deletes worker files",
        );
        if (process.argv.includes("--expiry"))
          result.expiry = await discoveryExpiryCases({
            fixture,
            visit,
            read,
            until,
            live,
            name,
            handle,
            counts,
            workerId: config.workerId,
            setHandler: (handler) => (lifecycleHandler = handler),
          });
        if (process.argv.includes("--lifecycle"))
          result.lifecycle = await discoveryLifecycleCases({
            fixture,
            visit,
            read,
            until,
            name,
            handle,
            counts,
            workerId: config.workerId,
            setHandler: (handler) => (lifecycleHandler = handler),
            connectWorker,
            stopWorker: () => {
              worker?.close();
              worker = undefined;
              connected = false;
            },
            setCapability: async (available) =>
              sendHeartbeat(config, {
                ...workerHeartbeat,
                managedFolders: {
                  ...workerHeartbeat.managedFolders,
                  discoverWorkspaceRepositories: available,
                },
              }),
          });
        if (process.argv.includes("--lifetimes")) {
          result.lifetimes = await discoveryLifetimeCases({
            fixture,
            databaseMode,
            databaseUrl,
            ownerId,
            visit,
            read,
            until,
            name,
            handle,
            counts,
            workerId: config.workerId,
            setHandler: (handler) => (lifecycleHandler = handler),
            connectWorker,
            stopWorker: () => {
              worker?.close();
              worker = undefined;
              connected = false;
            },
          });
          result.lifetimeEvidence = fixture.discoveryLifetimeEvidence;
        }
      } catch (error) {
        result.diagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        result.recoverySnapshots = fixture.discoveryRecoverySnapshots;
        releaseScan();
        releaseImport();
        worker?.close();
        await live?.close();
        await fixture.close();
      }
    }
    assert.deepEqual(
      runtimes[1].observations,
      runtimes[0].observations,
      profile + " HTTP behavior",
    );
    assert.deepEqual(
      runtimes[1].commands,
      runtimes[0].commands,
      profile + " worker commands",
    );
    assert.deepEqual(
      runtimes[1].events,
      runtimes[0].events,
      profile + " ordered discovery Live events",
    );
    assert.deepEqual(
      runtimes[1].responseInvalidations,
      runtimes[0].responseInvalidations,
      profile + " response-completion invalidations",
    );
    assert.deepEqual(
      runtimes[1].lease,
      runtimes[0].lease,
      profile + " production lease renewal and unbounded scan command",
    );
    assert.deepEqual(
      runtimes[1].lifecycle,
      runtimes[0].lifecycle,
      profile + " serialized discovery/import lifecycle and shutdown recovery",
    );
    assert.deepEqual(
      runtimes[1].expiry,
      runtimes[0].expiry,
      profile + " stale completion, real lease expiry and recovery fencing",
    );
    assert.deepEqual(
      runtimes[1].lifetimes,
      runtimes[0].lifetimes,
      profile +
        " admitted workspace writes survive caller disconnect and shutdown",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
} finally {
  await pg?.close();
  if (option("--report")) {
    await mkdir(path.dirname(path.resolve(option("--report"))), {
      recursive: true,
    });
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    databaseMode,
    passed: report.passed,
    profiles: report.profiles.map(({ profile, runtimes }) => ({
      profile,
      runtimes: runtimes.map((r) => ({
        kind: r.kind,
        http: r.observations.length,
        commands: r.commands.length,
        events: r.events.length,
      })),
    })),
  }),
);
