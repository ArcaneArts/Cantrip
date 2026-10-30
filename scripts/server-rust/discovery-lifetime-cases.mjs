import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { projectLabel } from "./security-fixtures.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

export async function discoveryLifetimeCases({
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
  workerId,
  setHandler,
  stopWorker,
  connectWorker,
}) {
  const ids = Array.from(
    { length: 5 },
    (_, i) => `77777777-7777-4777-8777-${String(301 + i).padStart(12, "0")}`,
  );
  const commands = [],
    releases = new Map(),
    evidence = { races: [], disconnected: [] };
  const result = { attachment: {}, races: [], disconnected: [] };
  const route = (i) => `/api/workspaces/${ids[i]}/repository-discovery`;
  let holdAttachment = true,
    holdScan = false,
    sql,
    held,
    closing,
    pending;
  const root = (i) => handle(210 + i);
  const input = (i, attached) => ({
    id: ids[i],
    nameProtection: {
      ...name,
      blindIndex: Buffer.alloc(32, 210 + i).toString("base64url"),
    },
    storage: attached ? { kind: "attached", workerId } : { kind: "managed" },
    ...(attached
      ? { operationId: ids[i], protectedRequest: projectLabel.protectedLabel }
      : {}),
  });
  setHandler(async (command) => {
    commands.push(command);
    if (command.type === "repository.operation") {
      const i = ids.indexOf(command.projectId);
      assert.ok(i >= 0);
      if (i === 0 && holdAttachment)
        await new Promise((resolve) => releases.set("attachment", resolve));
      return {
        operationId: command.operationId,
        protectedResponse: projectLabel.protectedLabel,
        workspaceRootAttachment: {
          rootPathHandle: root(i),
          displayHandle: handle(215 + i),
        },
      };
    }
    assert.equal(command.type, "workspace.repositories.discover");
    const i = ids.findIndex((_, i) => root(i) === command.rootPath);
    assert.ok(i >= 0);
    if (i === 1 && holdScan)
      await new Promise((resolve) => releases.set("scan", resolve));
    return {
      jobId: command.jobId,
      attempt: command.attempt,
      counts: counts(1),
      truncated: false,
      diagnosticCode: null,
      candidates: [
        {
          path: handle(220 + i),
          displayPath: handle(225 + i),
          originUrl: null,
          github: null,
          repositoryFingerprint: (i + 10).toString(16).repeat(64),
          classification: "local-git",
          diagnosticCode: null,
        },
      ],
    };
  });
  const call = async (url, body, signal) => {
    const client = fixture.client();
    const response = await fetch(fixture.server.origin + url, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json() };
  };
  const attach = (i) =>
    visit("lifetime attach " + i, "POST", "/api/workspaces/attached", {
      status: 201,
      json: input(i, true),
    });
  const waitScan = async (i, state) => {
    await until(
      () =>
        commands.some(
          (command) =>
            command.type === "workspace.repositories.discover" &&
            command.rootPath === root(i),
        ),
      (dispatched) => assert.equal(dispatched, true),
    );
    return until(
      () => read(route(i)),
      (snapshot) =>
        assert.equal(snapshot.job.state, state, JSON.stringify(snapshot)),
    );
  };
  const live = await new LiveProbe(fixture).open();
  const release = async (rollback = false) => {
    if (!held) return;
    await held.unsafe(rollback ? "ROLLBACK" : "COMMIT");
    held.release();
    held = undefined;
  };
  try {
    await live.initialized();
    await live.subscribed("discovery admission lifetimes", [currentUser]);
    const abort = new AbortController();
    pending = call(
      "/api/workspaces/attached",
      input(0, true),
      abort.signal,
    ).catch((error) => ({ error: error.name }));
    await until(
      () => releases.has("attachment"),
      (ready) => assert.equal(ready, true),
    );
    abort.abort();
    assert.deepEqual(await pending, { error: "AbortError" });
    pending = undefined;
    holdAttachment = false;
    releases.get("attachment")();
    releases.delete("attachment");
    const survived = await waitScan(0, "succeeded");
    assert.equal(survived.job.attempt, 1);
    assert.equal(survived.job.stateRevision, 3);
    const workspaces = await visit(
      "lifetime disconnected attachment retained",
      "GET",
      "/api/workspaces",
    );
    const workspace = workspaces.workspaces.find((w) => w.id === ids[0]);
    assert.ok(workspace);
    assert.equal(workspace.storage.rootPathHandle, root(0));
    assert.equal(
      commands.filter((c) => c.type === "repository.operation").length,
      1,
    );
    assert.equal(
      commands.filter((c) => c.type === "workspace.repositories.discover")
        .length,
      1,
    );
    await live.ping("disconnected attachment completed");
    const events = live.history
      .filter(
        (e) =>
          e.type === "event" &&
          e.resource === "workspace-repository-discovery-job" &&
          e.entityId === ids[0] &&
          e.revision !== null,
      )
      .map(({ resource, scope, action, entityId, revision, payload }) => ({
        resource,
        scope,
        action,
        entityId,
        revision,
        payload,
      }));
    assert.deepEqual(
      events.map((e) => e.revision),
      [1, 2, 3],
    );
    result.attachment = fixture.normalize({
      workspace,
      job: survived.job,
      events,
      commands: commands.slice(),
    });

    if (databaseMode === "postgres") {
      sql = postgres(databaseUrl, { max: 3 });
      const lock = async (statement, params = []) => {
        held = await sql.reserve();
        await held.unsafe("BEGIN");
        const pid = (await held.unsafe("SELECT pg_backend_pid() pid"))[0].pid;
        await held.unsafe(statement, params);
        return pid;
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
            assert.equal(
              rows.length,
              count,
              "actual blocked workspace admissions",
            );
            for (const row of rows) assert.equal(row.wait_event_type, "Lock");
          },
        );
      await attach(1);
      const original = await waitScan(1, "succeeded");
      await visit("lifetime race initial snapshot", "GET", route(1));
      holdScan = true;
      const pid = await lock(
        `SELECT id FROM project_workspaces WHERE id='${ids[1]}' FOR UPDATE`,
      );
      const requests = [
        call(route(1), { expectedStateRevision: original.job.stateRevision }),
        call(route(1), { expectedStateRevision: original.job.stateRevision }),
      ];
      for (const request of requests) request.catch(() => {});
      let responses;
      try {
        const waits = await waiting(pid, /project_workspaces/i, 2);
        await release();
        responses = await Promise.all(requests);
        assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
        assert.deepEqual(responses.find((r) => r.status === 409).body, {
          code: "repository-discovery-stale",
          error:
            "Workspace repository discovery is already running or changed.",
        });
        evidence.races.push({ waits, responses });
      } finally {
        await release();
        await Promise.allSettled(requests);
      }
      // Source's joined SKIP LOCKED may skip the first dispatch while the
      // losing admission holds storage. A real following admission is its wake.
      await attach(2);
      await until(
        () => releases.has("scan"),
        (ready) => assert.equal(ready, true),
      );
      holdScan = false;
      releases.get("scan")();
      releases.delete("scan");
      const completed = await waitScan(1, "succeeded");
      await waitScan(2, "succeeded");
      assert.equal(completed.job.attempt, 2);
      assert.equal(completed.job.stateRevision, 6);
      const raceCommands = commands.filter(
        (c) =>
          c.type === "workspace.repositories.discover" &&
          c.rootPath === root(1),
      );
      assert.deepEqual(
        raceCommands.map((c) => c.attempt),
        [1, 2],
      );
      const jobs =
        await sql`SELECT id,attempt,state_revision FROM workspace_repository_discovery_jobs WHERE workspace_id=${ids[1]}`;
      assert.equal(jobs.length, 1);
      result.races.push({
        statuses: responses.map((r) => r.status).sort(),
        attempt: completed.job.attempt,
        revision: completed.job.stateRevision,
        jobs: jobs.length,
        commands: raceCommands.length,
      });

      for (const shutdown of [false, true]) {
        const i = shutdown ? 4 : 3,
          create = input(i, false);
        // An uncommitted colliding identity blocks the actual target INSERT,
        // after default-workspace/encryption reads. Roll it back to release the
        // production insert without creating fixture state in the catalog.
        const pid = await lock(
          "INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision,position,is_default) VALUES($1,$2,$3::jsonb,$4,1,1,99,false)",
          [
            ids[i],
            ownerId,
            JSON.stringify(create.nameProtection.envelope),
            create.nameProtection.blindIndex,
          ],
        );
        const abort = new AbortController();
        pending = call("/api/workspaces", create, abort.signal).catch(
          (error) => ({ error: error.name }),
        );
        const waits = await waiting(
          pid,
          /insert into ["\s]*project_workspaces/i,
          1,
        );
        abort.abort();
        assert.deepEqual(await pending, { error: "AbortError" });
        pending = undefined;
        const server = fixture.server,
          port = Number(new URL(server.origin).port);
        if (shutdown) {
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
        const retained = await waiting(
          pid,
          /insert into ["\s]*project_workspaces/i,
          1,
        );
        assert.equal(retained[0].pid, waits[0].pid);
        assert.equal(server.child.exitCode, null);
        await release(true);
        await until(
          () =>
            sql`SELECT w.id,s.kind FROM project_workspaces w INNER JOIN project_workspace_storage_profiles s ON s.workspace_id=w.id WHERE w.id=${ids[i]}`,
          (rows) => {
            assert.equal(rows.length, 1);
            assert.equal(rows[0].kind, "managed");
          },
        );
        if (shutdown) {
          await closing;
          closing = undefined;
          stopWorker();
          await fixture.start({ port });
          await connectWorker();
        }
        const catalog = await visit(
          "lifetime retained managed workspace " + i,
          "GET",
          "/api/workspaces",
        );
        const retainedWorkspace = catalog.workspaces.find(
          (w) => w.id === ids[i],
        );
        assert.ok(retainedWorkspace);
        assert.equal(retainedWorkspace.storage.kind, "managed");
        evidence.disconnected.push({
          shutdown,
          waits,
          retained,
          shutdownEvents: shutdown ? server.events : [],
        });
        result.disconnected.push(
          fixture.normalize({ shutdown, workspace: retainedWorkspace }),
        );
      }
    }
    fixture.discoveryLifetimeEvidence = evidence;
    return result;
  } finally {
    holdAttachment = false;
    holdScan = false;
    for (const release of releases.values()) release();
    await release(true);
    await pending?.catch(() => {});
    await closing?.catch(() => {});
    await sql?.end({ timeout: 5 });
    await live.close();
  }
}
