// Production routes/executor over HTTP, App Live and the existing worker transport.
import { conversionLifecycleCases } from "./conversion-lifecycle-cases.mjs";
import { conversionLeaseCases } from "./conversion-lease-cases.mjs";
import { conversionLifetimeCases } from "./conversion-lifetime-cases.mjs";
import assert from "node:assert/strict";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { heartbeat, password, projectLabel } from "./security-fixtures.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-conversion-http-"));
const report = {
  suite: "conversion-http-worker-live",
  databaseMode,
  completeReplacement: false,
  profiles: [],
  lifecycle: process.argv.includes("--lifecycle"),
  leases: process.argv.includes("--leases"),
  lifetimes: process.argv.includes("--lifetimes"),
  observationShutdown: process.argv.includes("--observation-shutdown"),
};
if (report.lifetimes)
  assert.equal(
    databaseMode,
    "postgres",
    "independent PostgreSQL sessions are required for lock scenarios",
  );
const profiles = option("--profile")
  ? [option("--profile")]
  : ["none", "password", "accounts"];
for (const profile of profiles)
  assert.ok(
    ["none", "password", "accounts"].includes(profile),
    "known auth profile",
  );
const ids = Array.from(
  { length: 14 },
  (_, i) => `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
);
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
const until = async (read, check, timeoutMs = 20000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    try {
      check(v);
      return v;
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
  const repositoryBinary = await buildRustExample("project-repository-fixture");
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
          ...(report.leases ? { CANTRIP_SESSION_TTL_SECONDS: "900" } : {}),
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
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
      const result = { kind, observations: [], commands: [], events: [] };
      runtimes.push(result);
      const releases = new Map(),
        observationReleases = new Set(),
        lifecycleCommands = [],
        leaseCommands = [],
        lifetimeCommands = [];
      let lifecyclePhase = false,
        leasePhase = false,
        lifetimePhase = false;
      let worker,
        live,
        connected = false,
        preflightMode = "ready",
        executionMode = "ready",
        held;
      const visit = async (label, method, url, options = {}) => {
        result.observations.push({
          label,
          ...(await fixture.observe(label, method, url, {
            csrf: method === "POST" && !!fixture.client(options.client).csrf,
            ...options,
          })),
        });
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
        assert.equal(response.status, 200);
        return response.json();
      };
      const route = (id) => `/api/projects/${id}/github-conversion`;
      const waitJob = (id, state) =>
        until(
          () => read(route(id)),
          (j) => assert.equal(j.state, state, JSON.stringify(j)),
        );
      const repository = (n) => ({
        repositoryId: handle(10 + n),
        nameWithOwner: handle(20 + n),
        url: handle(30 + n),
      });
      const preflightInput = (n) => ({
        repository: repository(n),
        repositoryBlindIndex: Buffer.alloc(32, 40 + n).toString("base64url"),
      });
      const startInput = (n) => ({
        ...preflightInput(n),
        confirmationToken: "a".repeat(64),
        initialCommit: null,
      });
      const workerHeartbeat = {
        ...heartbeat,
        workerId: "conversion-worker",
        managedFolders: {
          ...heartbeat.managedFolders,
          create: true,
          attachExisting: true,
          convertToGithub: true,
          convertExternalGitToGithub: true,
          workspaceScopedRoots: true,
        },
      };
      try {
        await fixture.start();
        if (profile === "accounts")
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: client + "-conversion@example.invalid",
                displayName: client,
                password,
              },
            });
        else if (profile === "password")
          await visit("password sign-in", "POST", "/api/auth/login", {
            json: { password },
          });
        else await visit("session", "GET", "/api/auth/session");
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 201, json: { label: "Conversion worker" } },
        );
        await visit("enroll", "POST", "/api/internal/workers/enroll", {
          status: 201,
          client: "worker",
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: workerHeartbeat,
          },
        });
        const config = {
          dataDirectory: path.join(root, profile, kind, "worker"),
          name: "Conversion worker",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("enroll").credential,
          tokenSource: "persisted",
          workerId: "conversion-worker",
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
            async (command) => {
              if (
                command.type === "worktree.observation.configure" &&
                report.observationShutdown
              ) {
                await new Promise((resolve) =>
                  observationReleases.add(resolve),
                );
                return { accepted: true, paths: [] };
              }
              if (command.type === "project.folder.materialize") {
                const n = ids.indexOf(command.projectId);
                return {
                  status: "ready",
                  jobId: command.jobId,
                  attempt: command.attempt,
                  path: handle(60 + n),
                  displayPath: handle(70 + n),
                  reused: !!command.existingPath,
                  repositoryFingerprint: command.existingPath
                    ? "e".repeat(64)
                    : null,
                  github: null,
                };
              }
              if (!command.type.startsWith("project.folder-conversion."))
                return { accepted: true, paths: [] };
              (lifetimePhase
                ? lifetimeCommands
                : leasePhase
                  ? leaseCommands
                  : lifecyclePhase
                    ? lifecycleCommands
                    : result.commands
              ).push(command);
              if (command.type === "project.folder-conversion.preflight") {
                if (preflightMode === "error")
                  throw new Error("Controlled preflight failure");
                if (preflightMode === "invalid") return { status: "ready" };
                if (preflightMode === "blocked")
                  return {
                    status: "blocked",
                    projectId: command.projectId,
                    repository: command.repository,
                    error: {
                      code: "repository-not-empty",
                      message: "Controlled preflight rejection.",
                      retryable: false,
                    },
                  };
                return {
                  status: "ready",
                  projectId: command.projectId,
                  repository: command.repository,
                  projectSourceId: "99999999-9999-4999-8999-999999999999",
                  workerId: "wrong-response-worker",
                  confirmationToken: "a".repeat(64),
                  localState: command.sourcePath
                    ? "committed"
                    : "not-initialized",
                  branch: command.sourcePath ? "main" : null,
                  head: command.sourcePath ? "b".repeat(40) : null,
                  dirty: false,
                  originUrl: null,
                  requiresInitialCommit: !command.sourcePath,
                  warnings: [],
                };
              }
              if (
                ["held", "capacity-held"].includes(executionMode) ||
                (executionMode === "lease" && command.projectId === ids[7])
              )
                await new Promise((resolve) => {
                  held = resolve;
                  releases.set(command.jobId, resolve);
                }).finally(() => releases.delete(command.jobId));
              if (executionMode === "error")
                throw new Error("Controlled execution failure");
              if (
                executionMode === "blocked" ||
                executionMode === "nonretryable"
              )
                return {
                  status: "blocked",
                  jobId: command.jobId,
                  attempt: command.attempt,
                  error: {
                    code: "push-failed",
                    retryable: executionMode === "blocked",
                  },
                };
              const n = ids.indexOf(command.projectId);
              return {
                status: "ready",
                jobId: command.jobId,
                attempt:
                  executionMode === "lease" &&
                  command.projectId === ids[8] &&
                  command.attempt === 1
                    ? command.attempt + 1
                    : command.attempt,
                repository: command.repository,
                path: handle(60 + n),
                displayPath: handle(80 + n),
                repositoryFingerprint: "f".repeat(64),
                branch: "main",
                head: "b".repeat(40),
                worktreePolicy: "agent-managed",
              };
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
        for (let n = 0; n < 3; n++) {
          await visit(
            "create folder " + n,
            "POST",
            "/api/projects/from-folder",
            {
              status: 202,
              json: {
                id: ids[n],
                workerId: config.workerId,
                nameProtection: projectLabel,
                ...(n === 1 ? { existingPath: handle(90) } : {}),
              },
            },
          );
          await until(
            () => read(`/api/projects/${ids[n]}/folder-setup`),
            (j) => assert.equal(j.state, "succeeded"),
          );
        }
        // Existing workspace-discovery imports have user/direct ownership.
        // Legacy from-folder attachment still defaults to Cantrip ownership in
        // the reference. Prepare that existing-installation source while both
        // servers are stopped; conversion itself uses real routes and executor.
        worker.close();
        worker = undefined;
        const port = Number(new URL(fixture.server.origin).port);
        await fixture.close();
        const repo = await repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
        try {
          await repo.seed(
            `UPDATE project_sources SET ownership_kind='user',placement_mode='direct',requested_path=absolute_path WHERE project_id='${ids[1]}'`,
          );
        } finally {
          await repo.close();
        }
        result.externalSourceFixture =
          "Stopped-server existing workspace-discovery ownership metadata; actual folder setup remains independently exercised.";
        await fixture.start({ port });
        await connectWorker();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("conversions", [
          currentUser,
          ...ids
            .slice(0, 3)
            .map((projectId) => ({ kind: "project", projectId })),
        ]);
        for (const [suffix, input] of [
          ["preflight", preflightInput(0)],
          ["", startInput(0)],
          ["retry", { stateRevision: 1 }],
        ]) {
          const url = route(ids[0]) + (suffix ? "/" + suffix : "");
          await visit("invalid " + suffix, "POST", url, {
            status: 400,
            json: {},
          });
          await visit("malformed " + suffix, "POST", url, {
            status: 400,
            raw: "{",
            headers: { "content-type": "application/json" },
          });
          await visit(
            "missing " + suffix,
            "POST",
            route(ids[3]) + (suffix ? "/" + suffix : ""),
            { status: 404, json: input },
          );
        }
        await visit("missing status", "GET", route(ids[3]), { status: 404 });
        await visit("no job yet", "GET", route(ids[0]), { status: 404 });
        for (const suffix of ["preflight", ""]) {
          const input = suffix ? preflightInput(0) : startInput(0),
            url = route(ids[0]) + (suffix ? "/" + suffix : "");
          await visit("source pair " + suffix, "POST", url, {
            status: 400,
            json: { ...input, workerId: config.workerId },
          });
          await visit("unknown field " + suffix, "POST", url, {
            status: 400,
            json: { ...input, unknown: true },
          });
        }
        const original = await visit(
          "projects before conversion",
          "GET",
          "/api/projects",
        );
        const managed = original.find((p) => p.id === ids[0]),
          external = original.find((p) => p.id === ids[1]);
        assert.equal(managed.folderManagement, "managed");
        assert.equal(external.folderManagement, "external");
        assert.equal(external.capabilities.git, true);
        const exact = {
          projectSourceId: external.replicas[0].id,
          workerId: config.workerId,
        };
        await visit(
          "external requires source preflight",
          "POST",
          route(ids[1]) + "/preflight",
          { status: 409, json: preflightInput(1) },
        );
        await visit("external requires source start", "POST", route(ids[1]), {
          status: 409,
          json: startInput(1),
        });
        await visit(
          "wrong explicit source",
          "POST",
          route(ids[1]) + "/preflight",
          {
            status: 409,
            json: { ...preflightInput(1), ...exact, workerId: "wrong-worker" },
          },
        );
        if (profile === "accounts") {
          const before = result.commands.length;
          for (const [suffix, input] of [
            ["preflight", preflightInput(0)],
            ["", startInput(0)],
            ["retry", { stateRevision: 1 }],
          ])
            await visit(
              "foreign " + suffix,
              "POST",
              route(ids[0]) + (suffix ? "/" + suffix : ""),
              { client: "other", status: 404, json: input },
            );
          await visit("foreign status", "GET", route(ids[0]), {
            client: "other",
            status: 404,
          });
          assert.equal(result.commands.length, before);
        }
        await sendHeartbeat(config, {
          ...workerHeartbeat,
          managedFolders: {
            ...workerHeartbeat.managedFolders,
            convertToGithub: false,
          },
        });
        await visit(
          "capability missing preflight",
          "POST",
          route(ids[0]) + "/preflight",
          { status: 409, json: preflightInput(0) },
        );
        await visit("capability missing start", "POST", route(ids[0]), {
          status: 409,
          json: startInput(0),
        });
        await sendHeartbeat(config, workerHeartbeat);
        preflightMode = "blocked";
        await visit(
          "worker blocked preflight",
          "POST",
          route(ids[0]) + "/preflight",
          { json: preflightInput(0) },
        );
        preflightMode = "error";
        await visit(
          "worker preflight error",
          "POST",
          route(ids[0]) + "/preflight",
          { status: 502, json: preflightInput(0) },
        );
        preflightMode = "invalid";
        await visit(
          "malformed worker preflight result",
          "POST",
          route(ids[0]) + "/preflight",
          { status: 502, json: preflightInput(0) },
        );
        preflightMode = "ready";
        const ready = await visit(
          "managed preflight",
          "POST",
          route(ids[0]) + "/preflight",
          { json: preflightInput(0) },
        );
        assert.equal(ready.projectSourceId, managed.replicas[0].id);
        assert.equal(ready.workerId, config.workerId);
        assert.equal(ready.remoteAction, "push");
        const externalReady = await visit(
          "external preflight",
          "POST",
          route(ids[1]) + "/preflight",
          { json: { ...preflightInput(1), ...exact } },
        );
        assert.equal(externalReady.projectSourceId, exact.projectSourceId);
        executionMode = "held";
        const start = await visit("managed admission", "POST", route(ids[0]), {
          status: 202,
          json: { ...startInput(0), initialCommit: { message: handle(91) } },
        });
        await until(
          () => held,
          (v) => assert.equal(typeof v, "function"),
        );
        await visit("held running status", "GET", route(ids[0]));
        assert.equal(
          fixture.records.get("held running status").state,
          "running",
        );
        await visit(
          "active preflight rejected",
          "POST",
          route(ids[0]) + "/preflight",
          { status: 409, json: preflightInput(0) },
        );
        await visit("active start collision rejected", "POST", route(ids[0]), {
          status: 409,
          json: startInput(0),
        });
        executionMode = "blocked";
        held();
        held = undefined;
        let blocked = await waitJob(ids[0], "blocked");
        assert.deepEqual(blocked.error, {
          code: "push-failed",
          retryable: true,
        });
        assert.equal(blocked.attempt, 1);
        await visit("blocked status", "GET", route(ids[0]));
        await visit("stale retry", "POST", route(ids[0]) + "/retry", {
          status: 409,
          json: { stateRevision: blocked.stateRevision + 1 },
        });
        executionMode = "ready";
        await visit("retry", "POST", route(ids[0]) + "/retry", {
          json: { stateRevision: blocked.stateRevision },
        });
        const done = await waitJob(ids[0], "succeeded");
        assert.equal(done.id, start.id);
        assert.equal(done.attempt, 2);
        assert.equal(done.stateRevision, 6);
        await visit("completed status", "GET", route(ids[0]));
        await visit(
          "converted preflight rejected",
          "POST",
          route(ids[0]) + "/preflight",
          { status: 409, json: preflightInput(0) },
        );
        await visit("converted start rejected", "POST", route(ids[0]), {
          status: 409,
          json: startInput(0),
        });
        await visit(
          "converted retry rejected",
          "POST",
          route(ids[0]) + "/retry",
          { status: 409, json: { stateRevision: done.stateRevision } },
        );
        await visit(
          "bound repository collision preflight",
          "POST",
          route(ids[2]) + "/preflight",
          { status: 409, json: preflightInput(0) },
        );
        await visit("bound repository collision start", "POST", route(ids[2]), {
          status: 409,
          json: startInput(0),
        });
        await visit("external admission", "POST", route(ids[1]), {
          status: 202,
          json: { ...startInput(1), ...exact },
        });
        await waitJob(ids[1], "succeeded");
        await visit("external completion", "GET", route(ids[1]));
        executionMode = "error";
        await visit("error admission", "POST", route(ids[2]), {
          status: 202,
          json: startInput(2),
        });
        const failed = await waitJob(ids[2], "failed");
        assert.deepEqual(failed.error, {
          code: "reconciliation-failed",
          retryable: false,
        });
        await visit("failed completion", "GET", route(ids[2]));
        await visit("failed not retryable", "POST", route(ids[2]) + "/retry", {
          status: 409,
          json: { stateRevision: failed.stateRevision },
        });
        const projects = await visit(
          "projects after conversion",
          "GET",
          "/api/projects",
        );
        for (let n = 0; n < 2; n++) {
          const p = projects.find((p) => p.id === ids[n]),
            old = original.find((p) => p.id === ids[n]);
          assert.equal(p.originKind, "github");
          assert.equal(p.folderManagement, null);
          assert.equal(p.replicas[0].id, old.replicas[0].id);
          assert.equal(
            p.replicas[0].primaryWorktreeId,
            old.replicas[0].primaryWorktreeId,
          );
          assert.equal(
            p.replicas[0].ownershipKind,
            old.replicas[0].ownershipKind,
          );
          assert.equal(p.replicas[0].sourceKind, "git");
          assert.deepEqual(p.nameProtection, old.nameProtection);
        }
        await live.ping("conversion final barrier");
        const events = live.history.filter(
          (e) =>
            e.type === "event" &&
            e.resource === "project-github-conversion-job",
        );
        assert.deepEqual(
          events.filter((e) => e.entityId === start.id).map((e) => e.revision),
          [1, 3, 4, 6],
        );
        result.events = events.map(
          ({ resource, scope, entityId, revision, action }) =>
            fixture.normalize({ resource, scope, entityId, revision, action }),
        );
        result.commands = fixture.normalize(result.commands);
        const externalCommand = result.commands.find(
          (c) =>
            c.type === "project.folder-conversion.execute" &&
            c.projectId === ids[1],
        );
        assert.equal(externalCommand.sourcePath, handle(61));
        assert.equal(externalCommand.sourceDisplayPath, handle(71));
        assert.equal(
          result.commands.find(
            (c) =>
              c.type === "project.folder-conversion.execute" &&
              c.projectId === ids[0],
          ).sourcePath,
          undefined,
        );
        if (report.lifecycle) {
          lifecyclePhase = true;
          result.lifecycle = await conversionLifecycleCases({
            fixture,
            visit,
            read,
            until,
            ids,
            startInput,
            commands: lifecycleCommands,
            releases,
            setMode: (mode) => (executionMode = mode),
            connectWorker,
            stopWorker: () => {
              worker?.close();
              worker = undefined;
            },
            createFolder: async (n) => {
              await visit(
                "lifecycle folder " + n,
                "POST",
                "/api/projects/from-folder",
                {
                  status: 202,
                  json: {
                    id: ids[n],
                    workerId: config.workerId,
                    nameProtection: projectLabel,
                  },
                },
              );
              await until(
                () => read(`/api/projects/${ids[n]}/folder-setup`),
                (job) => assert.equal(job.state, "succeeded"),
              );
            },
          });
          assert.ok(result.lifecycle.shutdown.completed);
        }
        if (report.leases) {
          leasePhase = true;
          result.leases = await conversionLeaseCases({
            fixture,
            visit,
            read,
            until,
            ids,
            startInput,
            commands: leaseCommands,
            releases,
            setMode: (mode) => (executionMode = mode),
            workerId: config.workerId,
          });
          assert.ok(result.leases.recovered);
        }
        if (report.lifetimes) {
          lifetimePhase = true;
          result.lifetimes = await conversionLifetimeCases({
            fixture,
            databaseUrl,
            visit,
            read,
            until,
            ids,
            startInput,
            commands: lifetimeCommands,
            releases,
            workerId: config.workerId,
            setMode: (mode) => (executionMode = mode),
            connectWorker,
            stopWorker: () => {
              worker?.close();
              worker = undefined;
            },
          });
          assert.ok(result.lifetimes.shutdown.completed);
        }
      } catch (error) {
        result.diagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        result.shutdownStages = fixture.conversionShutdownStages;
        if (report.observationShutdown) {
          result.pendingObservationCommands = observationReleases.size;
          assert.ok(
            observationReleases.size > 0,
            "actual observation commands remain pending across shutdown",
          );
          for (const release of observationReleases) release();
        }
        result.lifetimeEvidence = fixture.conversionLifetimeEvidence;
        held?.();
        for (const release of releases.values()) release();
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
      profile + " exact worker commands",
    );
    assert.deepEqual(
      runtimes[1].events,
      runtimes[0].events,
      profile + " ordered conversion Live invalidations",
    );
    assert.deepEqual(
      runtimes[1].lifecycle,
      runtimes[0].lifecycle,
      profile + " capacity and shutdown recovery",
    );
    assert.deepEqual(
      runtimes[1].leases,
      runtimes[0].leases,
      profile + " real lease renewal and expiry",
    );
    assert.deepEqual(
      runtimes[1].lifetimes,
      runtimes[0].lifetimes,
      profile + " actual admission races and disconnected request lifetimes",
    );
  }
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
