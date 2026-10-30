// Force real admissions to their SQL boundaries; never mutate job lifecycle state.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { SocketProbe } from "./worker-sockets.mjs";
import { heartbeat, password, projectLabel } from "./security-fixtures.mjs";
import { projectReplicaJobSummarySchema } from "../../packages/protocol/dist/index.js";

const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = await mkdtemp(path.join(tmpdir(), "cantrip-replica-lifetimes-"));
const report = {
  suite: "replica-http-concurrency-and-shutdown",
  databaseMode: "postgres",
  completeReplacement: false,
  profiles: [],
};
const projectId = "33333333-3333-4333-8333-000000000001";
const replicasPath = `/api/projects/${projectId}/replicas`;
const jobsPath = `/api/projects/${projectId}/replica-jobs`;
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
const repository = handle(1);
const until = async (read, check) => {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (error) {
      if (Date.now() >= end) throw error;
    }
    await delay(20);
  }
};
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const databaseUrl = await pg.database();
      const sql = postgres(databaseUrl, { max: 3 });
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode: "postgres",
        environment: {
          DATABASE_URL: databaseUrl,
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
        },
      });
      const result = {
        kind,
        races: [],
        disconnects: [],
        resumed: [],
        shutdown: {},
      };
      runtimes.push(result);
      let held, worker, closing, pending, connectAlpha, alphaCredential;
      const closeAlpha = async () => {
        alphaCredential = worker.rotations.at(-1) ?? alphaCredential;
        await worker.close();
        worker = undefined;
      };
      const call = async (url, input, signal) => {
        const client = fixture.client();
        const response = await fetch(fixture.server.origin + url, {
          method: input === undefined ? "GET" : "POST",
          headers: {
            origin: "http://127.0.0.1:5173",
            cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            ...(input === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(input !== undefined && client.csrf
              ? { "x-cantrip-csrf": client.csrf }
              : {}),
          },
          body: input === undefined ? undefined : JSON.stringify(input),
          signal: signal ?? AbortSignal.timeout(30000),
        });
        assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
        const body = await response.json();
        if (response.status === 202 && url !== "/api/projects/from-github")
          projectReplicaJobSummarySchema.parse(body);
        return { status: response.status, body };
      };
      const read = async (url) => {
        const response = await call(url);
        assert.equal(response.status, 200, JSON.stringify(response));
        return response.body;
      };
      const jobPath = (id) => `/api/project-replica-jobs/${id}`;
      const blockedJob = (id) =>
        until(
          () => read(jobPath(id)),
          (job) => {
            assert.equal(job.state, "blocked");
            assert.equal(job.attempt, 1);
            assert.deepEqual(job.error, {
              code: "worker-offline",
              retryable: true,
            });
          },
        );
      const cancel = async (id) => {
        const job = await blockedJob(id);
        const response = await call(jobPath(id) + "/cancel", {
          stateRevision: job.stateRevision,
        });
        if (job.cancellationUnsafeAt !== null) {
          assert.deepEqual(response, {
            status: 409,
            body: {
              error:
                "The job changed or has crossed the safe cancellation boundary.",
            },
          });
          await connectAlpha();
          const completed = await until(
            () => read(jobPath(id)),
            (value) => {
              assert.equal(value.state, "succeeded", JSON.stringify(value));
              assert.equal(value.attempt, 2);
              assert.equal(value.error, null);
            },
          );
          result.resumed.push({ refusedCancellation: response, completed });
          await closeAlpha();
          return;
        }
        assert.equal(response.status, 200, JSON.stringify(response));
        assert.equal(response.body.state, "cancelled");
      };
      const lock = async (statement) => {
        held = await sql.reserve();
        await held.unsafe("BEGIN");
        const pid = (await held.unsafe("SELECT pg_backend_pid() pid"))[0].pid;
        await held.unsafe(statement);
        return pid;
      };
      const release = async () => {
        if (!held) return;
        await held.unsafe("COMMIT");
        held.release();
        held = undefined;
      };
      const waiting = (pid, pattern, count) =>
        until(
          async () => {
            const rows = await sql`WITH RECURSIVE waiting AS (
              SELECT pid,query,wait_event_type FROM pg_stat_activity
              WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))
              UNION SELECT a.pid,a.query,a.wait_event_type FROM pg_stat_activity a
              JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
              WHERE a.datname=current_database()) SELECT * FROM waiting`;
            return rows.filter((row) => pattern.test(row.query));
          },
          (rows) => {
            assert.equal(rows.length, count, `actual admissions at ${pattern}`);
            for (const row of rows) assert.equal(row.wait_event_type, "Lock");
          },
        );
      const provision = (key, workerId = "beta") => ({
        workerId,
        repository,
        idempotencyKey: key,
      });
      const compete = async (
        name,
        route,
        inputs,
        statement,
        pattern,
        statuses,
        error,
      ) => {
        const pid = await lock(statement);
        const requests = inputs.map((input) => call(route, input));
        for (const request of requests) request.catch(() => {});
        try {
          const waits = await waiting(pid, pattern, 2);
          await release();
          const responses = await Promise.all(requests);
          assert.deepEqual(responses.map((r) => r.status).sort(), statuses);
          for (const response of responses.filter((r) => r.status === 409))
            assert.deepEqual(response.body, { error });
          const successes = responses.filter((r) => r.status === 202);
          const winner = successes[0].body;
          for (const response of successes)
            assert.equal(response.body.id, winner.id);
          const stored = await blockedJob(winner.id);
          const replayInput = inputs.find(
            (input) =>
              input.idempotencyKey === stored.idempotencyKey &&
              (!input.workerId || input.workerId === stored.workerId),
          );
          assert.ok(
            replayInput,
            "persisted winner matches an actual contender",
          );
          const replay = await call(route, replayInput);
          assert.deepEqual(replay, { status: 202, body: stored });
          const keys = [
            ...new Set(inputs.map((input) => input.idempotencyKey)),
          ];
          const rows =
            await sql`SELECT id,idempotency_key,worker_id,state,attempt
            FROM project_replica_jobs WHERE idempotency_key IN ${sql(keys)}`;
          assert.equal(
            rows.length,
            1,
            "one durable admission after both reach SQL",
          );
          assert.equal(rows[0].id, stored.id);
          assert.equal(rows[0].worker_id, stored.workerId);
          result.races.push({
            name,
            waits,
            inputs,
            responses,
            stored,
            replay,
            rows,
          });
          await cancel(stored.id);
        } finally {
          await release();
          const settled = await Promise.allSettled(requests);
          result.lastRace = {
            name,
            settled: settled.map((outcome) =>
              outcome.status === "fulfilled"
                ? outcome
                : { status: outcome.status, reason: outcome.reason.stack },
            ),
          };
        }
      };
      try {
        await fixture.start();
        await fixture.observe(
          "session",
          profile === "accounts" ? "POST" : "GET",
          profile === "accounts" ? "/api/auth/register" : "/api/auth/session",
          profile === "accounts"
            ? {
                status: 201,
                json: {
                  email: "lifetimes@example.invalid",
                  displayName: "Lifetimes",
                  password,
                },
              }
            : {},
        );
        for (const workerId of ["alpha", "beta", "gamma"]) {
          await fixture.observe(
            workerId + " code",
            "POST",
            "/api/workers/enrollment-codes",
            {
              status: 201,
              csrf: !!fixture.client().csrf,
              json: { label: workerId },
            },
          );
          await fixture.observe(
            workerId + " enroll",
            "POST",
            "/api/internal/workers/enroll",
            {
              status: 201,
              client: "worker",
              json: {
                code: fixture.records.get(workerId + " code").code,
                heartbeat: {
                  ...heartbeat,
                  workerId,
                  projectReplicas: {
                    ...heartbeat.projectReplicas,
                    provision: true,
                    synchronize: true,
                    exactRevision: true,
                  },
                },
              },
            },
          );
        }
        alphaCredential = fixture.records.get("alpha enroll").credential;
        connectAlpha = async () => {
          worker = await new SocketProbe(fixture, {
            query:
              "workerId=alpha&connectionGeneration=99999999-9999-4999-8999-999999999999",
            credential: alphaCredential,
            onRequest(frame, socket) {
              const command = frame.command;
              if (
                ![
                  "project.replica.provision",
                  "project.replica.synchronize",
                ].includes(command.type)
              )
                return false;
              socket.send(
                JSON.stringify({
                  kind: "response",
                  requestId: frame.requestId,
                  ok: true,
                  result:
                    command.type === "project.replica.synchronize"
                      ? {
                          status: "ready",
                          jobId: command.jobId,
                          attempt: command.attempt,
                          path: command.sourcePath,
                          previousRevision: "a".repeat(40),
                          resolvedRevision: "a".repeat(40),
                          branch: "main",
                          changed: false,
                        }
                      : {
                          status: "ready",
                          jobId: command.jobId,
                          attempt: command.attempt,
                          path: handle(2),
                          displayPath: handle(3),
                          repositoryFingerprint: "f".repeat(64),
                          resolvedRevision: "a".repeat(40),
                          branch: "main",
                          reused: false,
                          placement: null,
                        },
                }),
              );
              return true;
            },
          }).open();
          assert.equal((await worker.message()).state, "pending");
          assert.equal((await worker.message()).state, "ready");
          alphaCredential = worker.rotations.at(-1) ?? alphaCredential;
          await fixture.observe(
            "alpha heartbeat",
            "POST",
            "/api/internal/workers/heartbeat",
            {
              status: 202,
              client: "worker",
              headers: { authorization: `Bearer ${alphaCredential}` },
              json: {
                ...heartbeat,
                workerId: "alpha",
                projectReplicas: {
                  ...heartbeat.projectReplicas,
                  provision: true,
                  synchronize: true,
                  exactRevision: true,
                },
              },
            },
          );
        };
        await connectAlpha();
        const imported = await call("/api/projects/from-github", {
          id: projectId,
          workerId: "alpha",
          nameProtection: projectLabel,
          repositoryBlindIndex: Buffer.alloc(32, 4).toString("base64url"),
          repositoryId: repository,
          nameWithOwner: repository,
          url: repository,
        });
        assert.equal(imported.status, 202, JSON.stringify(imported));
        await until(
          () => read(jobsPath),
          (jobs) => {
            assert.equal(jobs.length, 1);
            assert.equal(jobs[0].state, "succeeded", JSON.stringify(jobs));
          },
        );
        const [source] = await read(replicasPath);
        assert.ok(source);
        await closeAlpha();

        const insertion = "LOCK TABLE project_replica_jobs IN SHARE MODE";
        const insertPattern = /insert into ["\s]*project_replica_jobs/i;
        const activeProvision =
          "A replica provision job is already active for this worker.";
        const reusedKey =
          "This idempotency key is already attached to a different replica request.";
        await compete(
          "same provision key replays the committed winner",
          replicasPath,
          [provision("same-provision"), provision("same-provision")],
          insertion,
          insertPattern,
          [202, 202],
        );
        await compete(
          "different provision keys share one active worker slot",
          replicasPath,
          [provision("distinct-left"), provision("distinct-right")],
          insertion,
          insertPattern,
          [202, 409],
          activeProvision,
        );
        await compete(
          "reused provision key rejects a different worker payload",
          replicasPath,
          [
            provision("different-payload", "beta"),
            provision("different-payload", "gamma"),
          ],
          insertion,
          insertPattern,
          [202, 409],
          reusedKey,
        );
        const synchronizePath = `${replicasPath}/${source.id}/synchronize`;
        const sync = (key) => ({
          repository,
          expectedRevision: "a".repeat(40),
          idempotencyKey: key,
        });
        const rowLock = `SELECT id FROM project_sources WHERE id='${source.id}' FOR UPDATE`;
        // pg_stat_activity may truncate Drizzle's long projection before its
        // FOR UPDATE suffix. The held source-row lock and actual blocker PID
        // prove the boundary; match the relation visible in both projections.
        const selectPattern = /project_sources/i;
        const activeOperation =
          "Another operation is already active for this replica.";
        await compete(
          "same synchronization key after both pre-reads preserves active conflict",
          synchronizePath,
          [sync("same-sync"), sync("same-sync")],
          rowLock,
          selectPattern,
          [202, 409],
          activeOperation,
        );
        await compete(
          "different synchronization keys admit one operation",
          synchronizePath,
          [sync("sync-left"), sync("sync-right")],
          rowLock,
          selectPattern,
          [202, 409],
          activeOperation,
        );

        for (const shutdown of [false, true]) {
          const input = provision(
            shutdown ? "disconnect-shutdown" : "disconnect-only",
          );
          const pid = await lock(insertion);
          const abort = new AbortController();
          pending = call(replicasPath, input, abort.signal).catch((error) => ({
            error: error.name,
          }));
          const waits = await waiting(pid, insertPattern, 1);
          abort.abort();
          assert.deepEqual(await pending, { error: "AbortError" });
          const server = fixture.server;
          if (shutdown) {
            closing = fixture.close();
            closing.catch(() => {});
            await until(
              () => server.events,
              (events) =>
                assert.ok(
                  events.some(
                    (event) =>
                      event.event ===
                      (kind === "rust"
                        ? "server.shutdown.started"
                        : "fixture.shutdown.started"),
                  ),
                ),
            );
          }
          const retained = await waiting(pid, insertPattern, 1);
          assert.equal(
            retained[0].pid,
            waits[0].pid,
            "same INSERT survives caller disconnect and shutdown",
          );
          assert.equal(server.child.exitCode, null);
          await release();
          if (shutdown) {
            await closing;
            closing = undefined;
            const rows =
              await sql`SELECT id,state,attempt,state_revision FROM project_replica_jobs
              WHERE idempotency_key=${input.idempotencyKey}`;
            assert.equal(rows.length, 1);
            assert.equal(rows[0].state, "queued");
            assert.equal(rows[0].attempt, 0);
            assert.equal(rows[0].state_revision, 1);
            result.shutdown = { waits, retained, rows, events: server.events };
            await fixture.start();
          }
          const jobs = await until(
            () => read(jobsPath),
            (jobs) =>
              assert.equal(
                jobs.filter(
                  (job) => job.idempotencyKey === input.idempotencyKey,
                ).length,
                1,
              ),
          );
          const job = await blockedJob(
            jobs.find((job) => job.idempotencyKey === input.idempotencyKey).id,
          );
          const replay = await call(replicasPath, input);
          assert.deepEqual(replay, { status: 202, body: job });
          result.disconnects.push({ shutdown, waits, retained, job, replay });
          await cancel(job.id);
        }
      } catch (error) {
        result.diagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        await release();
        await pending?.catch(() => {});
        await closing?.catch(() => {});
        await worker?.close();
        await fixture.close();
        await sql.end({ timeout: 5 });
      }
    }
    assert.deepEqual(
      runtimes[1].races.map((race) => ({
        name: race.name,
        statuses: race.responses.map((response) => response.status).sort(),
        errors: race.responses
          .filter((response) => response.status === 409)
          .map((response) => response.body),
      })),
      runtimes[0].races.map((race) => ({
        name: race.name,
        statuses: race.responses.map((response) => response.status).sort(),
        errors: race.responses
          .filter((response) => response.status === 409)
          .map((response) => response.body),
      })),
    );
    assert.deepEqual(
      runtimes[1].disconnects.map(({ shutdown, job }) => ({
        shutdown,
        state: job.state,
        revision: job.stateRevision,
        attempt: job.attempt,
        error: job.error,
      })),
      runtimes[0].disconnects.map(({ shutdown, job }) => ({
        shutdown,
        state: job.state,
        revision: job.stateRevision,
        attempt: job.attempt,
        error: job.error,
      })),
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
    suite: report.suite,
    profiles: report.profiles.map(({ profile, runtimes }) => ({
      profile,
      runtimes: runtimes.map(({ kind, races, disconnects }) => ({
        kind,
        races: races.length,
        disconnects: disconnects.length,
      })),
    })),
  }),
);
