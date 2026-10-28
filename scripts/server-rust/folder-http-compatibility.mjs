// Production routes/executor and actual Node transport with controlled command outcomes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import {
  folderCreationShutdown,
  folderLeaseRenewal,
} from "./folder-creation-shutdown.mjs";
import { heartbeat, projectLabel, password } from "./security-fixtures.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-folder-http-"));
const report = {
  suite: "actual-folder-http-executor",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const ids = Array.from(
  { length: 12 },
  (_, i) => `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
);
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
async function eventually(read, check, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (e) {
      if (Date.now() >= until) throw e;
    }
    await delay(20);
  }
}
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const outputs = [];
    report.profiles.push({ profile, runtimes: outputs });
    for (const kind of ["node", "rust"]) {
      const url =
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
          ...(url ? { DATABASE_URL: url } : {}),
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
        repositoryCommands: [],
        events: [],
        connections: 0,
      };
      outputs.push(result);
      let worker, live, foreignLive;
      let repositoryMode = "success";
      const repositoryInput = {
        scopeId: "folder-private-scope",
        operationId: "55555555-5555-4555-8555-555555555555",
        protectedRequest: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: projectLabel.protectedLabel.envelope,
        },
      };
      const modes = new Map(),
        gates = new Map();
      const watchedProjects = [];
      const watchProject = async (projectId) => {
        watchedProjects.push(projectId);
        await live.subscribed("watch " + projectId, [
          currentUser,
          ...watchedProjects.map((projectId) => ({
            kind: "project",
            projectId,
          })),
        ]);
      };
      const visit = async (label, method, url, options = {}) => {
        const value = await fixture.observe(label, method, url, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ label, ...value });
        return fixture.records.get(label);
      };
      const read = async (id) => {
        const response = await fetch(
          fixture.server.origin + `/api/projects/${id}/folder-setup`,
          {
            headers: {
              origin: "http://127.0.0.1:5173",
              cookie: [...fixture.client().cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            },
          },
        );
        assert.equal(response.status, 200);
        return response.json();
      };
      const status = async (id, state) =>
        eventually(
          () => read(id),
          (r) => assert.equal(r.state, state),
        );
      try {
        await fixture.start();
        if (kind === "rust")
          result.nativeStackLimits = fixture.server.events.filter(
            (event) => event.event === "test.native.stack-limit",
          );
        if (profile === "accounts")
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `folder-${client}@example.invalid`,
                displayName: "Folder " + client,
                password,
              },
            });
        else await visit("session", "GET", "/api/auth/session");
        await visit("link code", "POST", "/api/workers/enrollment-codes", {
          status: 201,
          json: { label: "Folder transport" },
        });
        await visit("enrollment", "POST", "/api/internal/workers/enroll", {
          status: 201,
          client: "worker",
          json: {
            code: fixture.records.get("link code").code,
            heartbeat: {
              ...heartbeat,
              workerId: "folder-worker",
              managedFolders: {
                ...heartbeat.managedFolders,
                create: true,
                attachExisting: true,
                workspaceScopedRoots: true,
              },
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
        const create = (index, extra = {}) =>
          visit("create " + index, "POST", "/api/projects/from-folder", {
            status: 202,
            json: {
              id: ids[index],
              workerId: "folder-worker",
              nameProtection: projectLabel,
              ...extra,
            },
          });
        await create(0);
        await status(ids[0], "blocked");
        const blocked = await visit(
          "offline blocked status",
          "GET",
          `/api/projects/${ids[0]}/folder-setup`,
        );
        assert.deepEqual(blocked.error, {
          code: "worker-offline",
          retryable: true,
        });
        await watchProject(ids[0]);
        await visit(
          "status HEAD",
          "HEAD",
          `/api/projects/${ids[0]}/folder-setup`,
          { compareContentLength: true },
        );
        await visit(
          "missing status",
          "GET",
          `/api/projects/${ids[11]}/folder-setup`,
          { status: 404 },
        );
        if (profile === "accounts") {
          await visit(
            "foreign status hidden",
            "GET",
            `/api/projects/${ids[0]}/folder-setup`,
            { client: "other", status: 404 },
          );
          await visit(
            "foreign retry hidden",
            "POST",
            `/api/projects/${ids[0]}/folder-setup/retry`,
            {
              client: "other",
              status: 404,
              json: { stateRevision: blocked.stateRevision },
            },
          );
        }
        for (const body of [
          null,
          {},
          [],
          {
            id: ids[2],
            workerId: "folder-worker",
            nameProtection: projectLabel,
            extra: 1,
          },
        ])
          await visit(
            "invalid create " + JSON.stringify(body),
            "POST",
            "/api/projects/from-folder",
            { status: 400, json: body },
          );
        await visit("missing worker", "POST", "/api/projects/from-folder", {
          status: 404,
          json: {
            id: ids[2],
            workerId: "missing",
            nameProtection: projectLabel,
          },
        });
        await visit(
          "duplicate folder project",
          "POST",
          "/api/projects/from-folder",
          {
            status: 500,
            json: {
              id: ids[0],
              workerId: "folder-worker",
              nameProtection: projectLabel,
            },
          },
        );
        await visit(
          "missing folder workspace",
          "POST",
          "/api/projects/from-folder",
          {
            status: 400,
            json: {
              id: ids[10],
              workerId: "folder-worker",
              workspaceId: "missing",
              nameProtection: projectLabel,
            },
          },
        );
        await visit(
          "invalid retry",
          "POST",
          `/api/projects/${ids[0]}/folder-setup/retry`,
          { status: 400, json: { stateRevision: 0 } },
        );
        await visit(
          "stale retry",
          "POST",
          `/api/projects/${ids[0]}/folder-setup/retry`,
          { status: 409, json: { stateRevision: 1 } },
        );
        await visit(
          "offline repository operation",
          "POST",
          "/api/workers/folder-worker/repository-operation",
          { status: 503, json: repositoryInput },
        );
        await visit(
          "invalid offline repository operation",
          "POST",
          "/api/workers/folder-worker/repository-operation",
          { status: 400, json: {} },
        );
        await visit(
          "missing repository worker",
          "POST",
          "/api/workers/missing/repository-operation",
          { status: 404, json: repositoryInput },
        );
        if (profile === "accounts")
          await visit(
            "foreign repository worker",
            "POST",
            "/api/workers/folder-worker/repository-operation",
            { client: "other", status: 404, json: repositoryInput },
          );
        const config = {
          dataDirectory: path.join(root, profile, kind, "controlled-worker"),
          name: "Folder transport",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("enrollment").credential,
          tokenSource: "persisted",
          workerId: "folder-worker",
        };
        const connectWorker = () => {
          config.serverUrl = fixture.server.origin;
          saveWorkerCredential({
            credential: config.token,
            dataDirectory: config.dataDirectory,
            serverUrl: config.serverUrl,
            workerId: config.workerId,
          });
          worker = new WorkerConnection(
            config,
            async (command) => {
              if (command.type === "repository.operation") {
                result.repositoryCommands.push(command);
                if (repositoryMode === "error")
                  throw new Error("Controlled repository rejection");
                return {
                  operationId: command.operationId,
                  protectedResponse:
                    repositoryMode === "invalid"
                      ? null
                      : command.protectedRequest,
                };
              }
              if (command.type !== "project.folder.materialize")
                throw new Error("Controlled metadata command is unsupported");
              result.commands.push(command);
              const mode = modes.get(command.projectId);
              if (mode === "held")
                await new Promise((resolve) =>
                  gates.set(command.projectId, resolve),
                );
              if (modes.get(command.projectId) === "fail")
                throw Object.assign(
                  new Error("Controlled attachment is missing"),
                  { code: "existing-path-missing" },
                );
              const index = ids.indexOf(command.projectId);
              return {
                status: "ready",
                jobId: command.jobId,
                attempt: command.attempt,
                path: handle(30 + index),
                displayPath: handle(60 + index),
                reused: !!command.existingPath,
                repositoryFingerprint: null,
                github: null,
              };
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
        await status(ids[0], "succeeded");
        await visit(
          "reconnected completion",
          "GET",
          `/api/projects/${ids[0]}/folder-setup`,
        );
        await live.ping("before repository operations");
        const beforeRepository = live.history.length;
        await visit(
          "opaque repository write",
          "POST",
          "/api/workers/folder-worker/repository-operation",
          { json: repositoryInput },
        );
        await eventually(
          () =>
            live.history
              .slice(beforeRepository)
              .filter(
                (event) =>
                  event.type === "event" &&
                  event.resource === "worker" &&
                  event.entityId === "folder-worker",
              ).length,
          (count) =>
            assert.equal(
              count,
              1,
              "successful repository write invalidates worker after response",
            ),
        );
        await visit(
          "opaque repository read",
          "POST",
          "/api/workers/folder-worker/repository-operation",
          { json: { ...repositoryInput, access: "read" } },
        );
        await visit(
          "agent requires worktree",
          "POST",
          "/api/workers/folder-worker/repository-operation",
          { status: 400, json: { ...repositoryInput, agent: true } },
        );
        await visit(
          "model requires agent",
          "POST",
          "/api/workers/folder-worker/repository-operation",
          { status: 400, json: { ...repositoryInput, modelId: "model" } },
        );
        repositoryMode = "error";
        await visit(
          "repository worker rejection",
          "POST",
          "/api/workers/folder-worker/repository-operation",
          { status: 502, json: repositoryInput },
        );
        repositoryMode = "invalid";
        await visit(
          "repository invalid response",
          "POST",
          "/api/workers/folder-worker/repository-operation",
          { status: 502, json: repositoryInput },
        );
        repositoryMode = "success";
        await live.ping("after repository operations");
        assert.equal(
          live.history
            .slice(beforeRepository)
            .filter(
              (event) =>
                event.type === "event" &&
                event.resource === "worker" &&
                event.entityId === "folder-worker",
            ).length,
          1,
          "reads and rejected writes do not invalidate worker",
        );
        assert.equal(
          result.repositoryCommands.length,
          4,
          "invalid, foreign, offline and agent calls do not dispatch",
        );
        modes.set(ids[1], "held");
        await create(1, { existingPath: handle(1) });
        await watchProject(ids[1]);
        await eventually(
          () => gates.has(ids[1]),
          (held) => assert.equal(held, true),
        );
        modes.set(ids[1], "fail");
        gates.get(ids[1])();
        gates.delete(ids[1]);
        await status(ids[1], "failed");
        const failed = await visit(
          "actual worker failure",
          "GET",
          `/api/projects/${ids[1]}/folder-setup`,
        );
        assert.deepEqual(failed.error, {
          code: "existing-path-missing",
          retryable: false,
        });
        modes.set(ids[1], "held");
        await visit(
          "explicit retry",
          "POST",
          `/api/projects/${ids[1]}/folder-setup/retry`,
          { json: { stateRevision: failed.stateRevision } },
        );
        await eventually(
          () =>
            live.history.filter(
              (event) =>
                event.type === "event" && event.scope?.projectId === ids[1],
            ).length,
          (count) =>
            assert.equal(
              count,
              5,
              "failed, retried and response-completion notifications",
            ),
        );
        await eventually(
          () => gates.has(ids[1]),
          (held) => assert.equal(held, true),
        );
        modes.set(ids[1], "success");
        gates.get(ids[1])();
        gates.delete(ids[1]);
        await status(ids[1], "succeeded");
        await visit(
          "retry completed",
          "GET",
          `/api/projects/${ids[1]}/folder-setup`,
        );
        await visit(
          "success cannot retry",
          "POST",
          `/api/projects/${ids[1]}/folder-setup/retry`,
          { status: 409, json: { stateRevision: 999 } },
        );
        const concurrent = ids.slice(2, 8);
        for (let n = 2; n < 8; n++) {
          modes.set(ids[n], "held");
          await create(n);
          const committedJob = await read(ids[n]);
          assert.equal(committedJob.projectId, ids[n]);
          fixture.ids.set(committedJob.id, `<folder-job:${n}>`);
          await watchProject(ids[n]);
        }
        await eventually(
          () =>
            result.commands.filter((c) => concurrent.includes(c.projectId))
              .length,
          (n) => assert.equal(n, 4),
        );
        await delay(100);
        assert.equal(
          result.commands.filter((c) => concurrent.includes(c.projectId))
            .length,
          4,
          "four durable jobs maximum",
        );
        assert.deepEqual(
          new Set(
            result.commands
              .filter((c) => concurrent.includes(c.projectId))
              .map((c) => c.projectId),
          ),
          new Set(ids.slice(2, 6)),
          "first claim window contains the earliest four queued projects",
        );
        gates.get(ids[2])();
        gates.delete(ids[2]);
        await eventually(
          () =>
            result.commands.filter((c) => concurrent.includes(c.projectId))
              .length,
          (n) => assert.equal(n, 5),
        );
        assert.deepEqual(
          new Set(
            result.commands
              .filter((c) => concurrent.includes(c.projectId))
              .map((c) => c.projectId),
          ),
          new Set(ids.slice(2, 7)),
          "one released job admits the next queued project",
        );
        for (const id of concurrent) {
          modes.set(id, "success");
          gates.get(id)?.();
          gates.delete(id);
        }
        for (const id of concurrent) await status(id, "succeeded");
        await visit("ready project list", "GET", "/api/projects");
        await live.ping("folder events barrier");
        result.currentUserEvents = live.history.filter(
          (event) =>
            event.type === "event" &&
            event.resource === "project" &&
            event.scope.kind === "current-user",
        );
        assert.equal(
          result.currentUserEvents.length,
          8,
          "each creation publishes after its response",
        );
        for (const event of result.currentUserEvents) {
          assert.equal(event.entityId, null);
          assert.equal(event.revision, null);
          assert.equal(event.payload, null);
        }
        const rawEvents = live.history
          .filter(
            (f) =>
              f.type === "event" &&
              ["project-folder-setup-job", "project", "worktree"].includes(
                f.resource,
              ) &&
              ids.includes(f.scope?.projectId),
          )
          .map(({ resource, action, entityId, revision, payload, scope }) => ({
            resource,
            action,
            entityId,
            revision,
            payload,
            scope,
          }));
        result.rawEvents = fixture.normalize(rawEvents);
        result.events = [];
        for (let index = 0; index < 8; index++) {
          const projectId = ids[index];
          const job = await read(projectId);
          let events = rawEvents.filter(
            (event) => event.scope.projectId === projectId,
          );
          // The first subscription starts after the offline state is committed.
          // Its publication can race that subscription; acceptance begins at the
          // reconnect completion, whose dispatch cannot start earlier. Source
          // requeueing does not itself publish an intermediate queued event.
          if (index === 0) {
            const start = events.findIndex(
              (event) =>
                event.resource === "project-folder-setup-job" &&
                event.revision === 6,
            );
            assert.ok(start >= 0, "reconnect completion must be observed");
            const prefix = events.slice(0, start);
            assert.ok(
              prefix.length === 0 || prefix.length === 2,
              "only the initial blocked publication may race subscription",
            );
            if (prefix.length)
              assert.deepEqual(
                prefix.map(({ resource, revision, entityId }) => ({
                  resource,
                  revision,
                  entityId,
                })),
                [
                  {
                    resource: "project-folder-setup-job",
                    revision: 3,
                    entityId: job.id,
                  },
                  { resource: "project", revision: null, entityId: projectId },
                ],
                "reconnect requeueing must not add a queued publication",
              );
            events = events.slice(start);
          }
          for (const command of result.commands.filter(
            (command) => command.projectId === projectId,
          ))
            assert.equal(
              command.jobId,
              job.id,
              "dispatch keeps its committed job identity",
            );
          const revisions = index === 0 ? [6] : index === 1 ? [3, 4, 6] : [3];
          const expected = revisions.flatMap((revision, i) => [
            {
              resource: "project-folder-setup-job",
              action: "invalidated",
              entityId: job.id,
              revision,
              payload: null,
              scope: { kind: "project", projectId },
            },
            {
              resource: "project",
              action: "invalidated",
              entityId: projectId,
              revision: null,
              payload: null,
              scope: { kind: "project", projectId },
            },
            ...(index === 1 && revision === 4
              ? [
                  {
                    resource: "project",
                    action: "invalidated",
                    entityId: projectId,
                    revision: null,
                    payload: null,
                    scope: { kind: "project", projectId },
                  },
                ]
              : []),
            ...(i === revisions.length - 1
              ? [
                  {
                    resource: "worktree",
                    action: "invalidated",
                    entityId: projectId,
                    revision: null,
                    payload: null,
                    scope: { kind: "project", projectId },
                  },
                ]
              : []),
          ]);
          assert.deepEqual(
            events,
            expected,
            `${kind}: nonempty ordered folder publications ${index}`,
          );
          result.events.push(...fixture.normalize(events));
        }
        if (foreignLive) {
          await foreignLive.ping("foreign folder barrier");
          assert.deepEqual(
            foreignLive.history.filter(
              (f) => f.type === "event" && ids.includes(f.scope?.projectId),
            ),
            [],
          );
        }
        result.repositoryCommands = fixture.normalize(
          result.repositoryCommands,
        );
        await live.close();
        live = undefined;
        await foreignLive?.close();
        foreignLive = undefined;
        modes.set(ids[8], "held");
        await create(8);
        await eventually(
          () => gates.has(ids[8]),
          (held) => assert.equal(held, true),
        );
        if (databaseMode === "postgres" && profile === "accounts") {
          result.leaseRenewal = {};
          await folderLeaseRenewal(fixture, ids[8], result.leaseRenewal);
        }
        await fixture.close();
        worker.close();
        worker = undefined;
        modes.set(ids[8], "success");
        gates.get(ids[8])();
        gates.delete(ids[8]);
        await fixture.start();
        const interrupted = await visit(
          "shutdown retains active job",
          "GET",
          `/api/projects/${ids[8]}/folder-setup`,
        );
        assert.equal(interrupted.state, "blocked");
        assert.equal(interrupted.attempt, 1);
        assert.deepEqual(interrupted.error, {
          code: "worker-offline",
          retryable: true,
        });
        connectWorker();
        await eventually(
          () => result.connections,
          (count) => assert.equal(count, 2),
        );
        await status(ids[8], "succeeded");
        const recovered = await visit(
          "shutdown job resumes",
          "GET",
          `/api/projects/${ids[8]}/folder-setup`,
        );
        assert.equal(recovered.attempt, 2);
        assert.equal(recovered.stateRevision, 6);
        worker.close();
        worker = undefined;
        await visit("retained project list", "GET", "/api/projects");
        await visit(
          "retained setup status",
          "GET",
          `/api/projects/${ids[0]}/folder-setup`,
        );
        for (const [workerId, createSupported, existingPath] of [
          ["without-folder-creation", false, undefined],
          ["without-folder-attachment", true, handle(1)],
        ]) {
          await visit(
            "capability code " + workerId,
            "POST",
            "/api/workers/enrollment-codes",
            {
              status: 201,
              json: { label: workerId },
            },
          );
          await visit(
            "capability enrollment " + workerId,
            "POST",
            "/api/internal/workers/enroll",
            {
              client: "worker",
              status: 201,
              json: {
                code: fixture.records.get("capability code " + workerId).code,
                heartbeat: {
                  ...heartbeat,
                  workerId,
                  managedFolders: {
                    ...heartbeat.managedFolders,
                    create: createSupported,
                    attachExisting: false,
                  },
                },
              },
            },
          );
          await visit(
            "unsupported folder capability " + workerId,
            "POST",
            "/api/projects/from-folder",
            {
              status: 409,
              json: {
                id: ids[10],
                workerId,
                nameProtection: projectLabel,
                ...(existingPath ? { existingPath } : {}),
              },
            },
          );
        }
        await visit(
          "unsupported capabilities create no project",
          "GET",
          `/api/projects/${ids[10]}/folder-setup`,
          { status: 404 },
        );
        result.rawCommands = fixture.normalize(result.commands);
        // Independent jobs perform asynchronous worker lookups concurrently in
        // both implementations. Retain raw arrival order, verify each admission
        // window above, and compare ordered attempts within each project.
        result.commands = fixture.normalize(
          result.commands.toSorted(
            (a, b) =>
              a.projectId.localeCompare(b.projectId) || a.attempt - b.attempt,
          ),
        );
        if (databaseMode === "postgres") {
          result.admittedCreation = {};
          await folderCreationShutdown(
            fixture,
            {
              id: ids[9],
              workerId: "folder-worker",
              nameProtection: projectLabel,
            },
            result.admittedCreation,
          );
          await fixture.start();
          await status(ids[9], "blocked");
          const retained = await visit(
            "disconnected creation retained",
            "GET",
            `/api/projects/${ids[9]}/folder-setup`,
          );
          assert.equal(retained.attempt, 1);
          assert.equal(retained.stateRevision, 3);
        }
      } finally {
        for (const release of gates.values()) release();
        worker?.close();
        await live?.close();
        await foreignLive?.close();
        await fixture.close();
      }
    }
    assert.deepEqual(
      outputs[1].observations,
      outputs[0].observations,
      profile + ": actual HTTP contracts",
    );
    assert.deepEqual(
      outputs[1].commands,
      outputs[0].commands,
      profile + ": actual worker dispatch",
    );
    assert.deepEqual(
      outputs[1].repositoryCommands,
      outputs[0].repositoryCommands,
      profile + ": opaque repository dispatch",
    );
    // Different project jobs can settle concurrently. Compare the exact ordered
    // transitions within each project instead of imposing a global job order.
    for (const id of ids)
      assert.deepEqual(
        outputs[1].events.filter((e) => e.scope.projectId === id),
        outputs[0].events.filter((e) => e.scope.projectId === id),
        profile + ": scoped ordered publications " + id,
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
    runtimes: report.profiles.flatMap((p) =>
      p.runtimes.map((r) => ({
        profile: p.profile,
        kind: r.kind,
        observations: r.observations.length,
        commands: r.commands.length,
        events: r.events.length,
      })),
    ),
  }),
);
