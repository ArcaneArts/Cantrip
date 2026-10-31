import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { projectLabel } from "./security-fixtures.mjs";
import { streamingHttpRequest } from "./streaming-http-request.mjs";

const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

// Hold real database locks at production HTTP admission boundaries. Lifecycle
// state is only changed by the server and its existing worker transport.
export async function conversionLifetimeCases({
  fixture,
  databaseUrl,
  visit,
  read,
  until,
  ids,
  startInput,
  commands,
  releases,
  workerId,
  setMode,
  connectWorker,
  stopWorker,
}) {
  const sql = postgres(databaseUrl, { max: 3 });
  const evidence = (fixture.conversionLifetimeEvidence = {
    races: [],
    disconnects: [],
    commands,
    stages: [],
  });
  const mark = (phase, details = {}) =>
    evidence.stages.push({
      phase,
      at: Date.now(),
      serverPid: fixture.server?.child.pid,
      origin: fixture.server?.origin,
      ...details,
    });
  mark("started");
  const result = { races: [], disconnects: [], shutdown: {} };
  const route = (n) => `/api/projects/${ids[n]}/github-conversion`;
  let held, closing, pending;
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
        return rows.filter((r) => pattern.test(r.query));
      },
      (rows) => {
        assert.equal(
          rows.length,
          count,
          "actual admissions blocked at " + pattern,
        );
        for (const row of rows) assert.equal(row.wait_event_type, "Lock");
      },
    );
  const call = async (n, input, signal) => {
    const client = fixture.client();
    // This controlled caller owns one socket. Aborting global fetch can open
    // an unused replacement connection to the process being shut down.
    const response = await streamingHttpRequest(
      fixture.server.origin + route(n),
      {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        },
        body: JSON.stringify(input),
        signal: signal ?? AbortSignal.timeout(30000),
      },
    );
    const body = await response.json();
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    if (response.status === 500) {
      assert.equal(body.requestId, requestId);
      body.requestId = "<request-id>";
    }
    return { status: response.status, body };
  };
  const finish = async (job) => {
    await until(
      () => releases.has(job.id),
      (v) => assert.equal(v, true),
    );
    releases.get(job.id)();
    const completed = await until(
      () => read(`/api/projects/${job.projectId}/github-conversion`),
      (j) => assert.equal(j.state, "succeeded", JSON.stringify(j)),
    );
    assert.equal(completed.id, job.id);
    assert.equal(completed.attempt, 1);
    assert.equal(completed.stateRevision, 3);
    assert.equal(commands.filter((c) => c.jobId === job.id).length, 1);
    return completed;
  };
  const insertion = "LOCK TABLE project_github_conversion_jobs IN SHARE MODE";
  const insertPattern = /insert into ["\s]*project_github_conversion_jobs/i;
  try {
    for (let n = 9; n < 14; n++) {
      await visit(
        "admission folder " + n,
        "POST",
        "/api/projects/from-folder",
        {
          status: 202,
          json: { id: ids[n], workerId, nameProtection: projectLabel },
        },
      );
      await until(
        () => read(`/api/projects/${ids[n]}/folder-setup`),
        (j) => assert.equal(j.state, "succeeded"),
      );
    }
    setMode("capacity-held");
    const admittedRaces = [];
    for (const scenario of [
      {
        name: "same-project",
        ns: [9, 9],
        input: startInput(9),
        statement: `SELECT id FROM projects WHERE id='${ids[9]}' FOR UPDATE`,
        pattern: /projects/i,
        statuses: [202, 409],
        error: {
          error: "A GitHub conversion is already active for this project.",
        },
      },
      {
        name: "same-repository-distinct-projects",
        ns: [10, 11],
        input: startInput(10),
        statement: insertion,
        pattern: insertPattern,
        statuses: [202, 500],
        error: { error: "Internal server error.", requestId: "<request-id>" },
      },
    ]) {
      const pid = await lock(scenario.statement);
      const requests = scenario.ns.map((n) => call(n, scenario.input));
      for (const request of requests) request.catch(() => {});
      try {
        const waits = await waiting(pid, scenario.pattern, 2);
        await release();
        const responses = await Promise.all(requests);
        assert.deepEqual(
          responses.map((r) => r.status).sort(),
          scenario.statuses,
        );
        assert.deepEqual(
          responses.find((r) => r.status !== 202).body,
          scenario.error,
        );
        const winner = responses.find((r) => r.status === 202).body;
        const rows =
          await sql`SELECT id,project_id,state,attempt,state_revision FROM project_github_conversion_jobs WHERE repository_blind_index=${scenario.input.repositoryBlindIndex}`;
        assert.equal(
          rows.length,
          1,
          "one durable job for the contending repository",
        );
        assert.equal(rows[0].id, winner.id);
        assert.equal(rows[0].project_id, winner.projectId);
        assert.ok(scenario.ns.map((n) => ids[n]).includes(winner.projectId));
        const raceEvidence = {
          name: scenario.name,
          waits,
          responses,
          rows,
        };
        evidence.races.push(raceEvidence);
        const compared = {
          name: scenario.name,
          statuses: responses.map((r) => r.status).sort(),
          error: scenario.error,
          rows: 1,
        };
        result.races.push(compared);
        admittedRaces.push({ winner, raceEvidence, compared });
      } finally {
        await release();
        await Promise.allSettled(requests);
      }
    }
    // Both implementations use a joined SKIP LOCKED claim. The losing
    // admission may briefly retain the project row as the winner queues its
    // dispatcher. A following admission is the real production wake-up; do
    // not assume that the first dispatch necessarily claimed the winner.
    for (const { winner, raceEvidence, compared } of admittedRaces) {
      const completed = await finish(winner);
      raceEvidence.completed = completed;
      compared.attempt = completed.attempt;
      compared.revision = completed.stateRevision;
    }
    for (const shutdown of [false, true]) {
      mark("disconnect-admission", { shutdown });
      const n = shutdown ? 13 : 12;
      const pid = await lock(insertion);
      const abort = new AbortController();
      pending = call(n, startInput(n), abort.signal).catch((error) => ({
        error: error.name,
      }));
      const waits = await waiting(pid, insertPattern, 1);
      abort.abort();
      assert.deepEqual(await pending, { error: "AbortError" });
      const server = fixture.server;
      const port = Number(new URL(server.origin).port);
      if (shutdown) {
        mark("closing-with-blocked-insert");
        closing = fixture.close();
        closing.catch(() => {});
        await until(
          () => server.events,
          (events) =>
            assert.ok(
              events.some(
                (e) =>
                  e.event ===
                  (fixture.kind === "rust"
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
        "same INSERT survives disconnected caller and admitted shutdown",
      );
      assert.equal(server.child.exitCode, null);
      await release();
      if (shutdown) {
        await closing;
        mark("closed", { previousServerPid: server.child.pid });
        closing = undefined;
        stopWorker();
        const rows =
          await sql`SELECT id,state,attempt,state_revision FROM project_github_conversion_jobs WHERE project_id=${ids[n]}`;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].state, "queued");
        assert.equal(rows[0].attempt, 0);
        assert.equal(rows[0].state_revision, 1);
        await fixture.start({ port });
        mark("restarted");
        const blocked = await until(
          () => read(route(n)),
          (j) => {
            assert.equal(j.state, "blocked");
            assert.equal(j.attempt, 1);
            assert.equal(j.stateRevision, 3);
            assert.deepEqual(j.error, {
              code: "worker-offline",
              retryable: true,
            });
          },
        );
        mark("blocked-state-read");
        assert.equal(blocked.id, rows[0].id);
        setMode("ready");
        await connectWorker();
        const completed = await until(
          () => read(route(n)),
          (j) => {
            assert.equal(j.state, "succeeded");
            assert.equal(j.attempt, 2);
            assert.equal(j.stateRevision, 6);
          },
        );
        mark("recovered-state-read");
        assert.equal(completed.id, blocked.id);
        assert.deepEqual(
          commands
            .filter((c) => c.jobId === completed.id)
            .map((c) => c.attempt),
          [2],
        );
        result.shutdown = fixture.normalize({
          blocked,
          completed,
          initialState: rows[0].state,
          initialAttempt: rows[0].attempt,
          initialRevision: rows[0].state_revision,
        });
        evidence.disconnects.push({
          shutdown,
          waits,
          retained,
          rows,
          blocked,
          completed,
          shutdownEvents: server.events,
        });
      } else {
        await until(
          () =>
            sql`SELECT id FROM project_github_conversion_jobs WHERE project_id=${ids[n]}`,
          (rows) => assert.equal(rows.length, 1),
        );
        const admitted = await until(
          () => read(route(n)),
          (j) => assert.equal(j.state, "running"),
        );
        const completed = await finish(admitted);
        evidence.disconnects.push({ shutdown, waits, retained, completed });
        result.disconnects.push(fixture.normalize(completed));
      }
    }
    return result;
  } catch (error) {
    mark("failed", { name: error.name, causeCode: error.cause?.code });
    throw error;
  } finally {
    await release();
    await pending?.catch(() => {});
    await closing?.catch(() => {});
    for (const resume of releases.values()) resume();
    await sql.end({ timeout: 5 });
  }
}
