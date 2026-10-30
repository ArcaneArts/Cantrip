// Actual lock queues distinguish standalone legacy reads from workspace seed
// transactions and retain admitted mutations through disconnect and shutdown.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { eventually } from "./audit-observations.mjs";
import {
  targetStateSql,
  literal,
  json,
  label,
  stamp,
  state,
} from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const reportOption = process.argv.indexOf("--report"),
  reportPath = reportOption < 0 ? undefined : process.argv[reportOption + 1];
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-surface-lifetimes-"),
);
const report = {
  suite: "project-surface-concurrency-and-shutdown",
  completeReplacement: false,
  runtimes: [],
};

let pg, failure;
try {
  const executable = await buildRustServer(),
    repositoryBinary = await buildRustExample("project-repository-fixture");
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl = await pg.database(),
      sql = postgres(databaseUrl, { max: 5 });
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "project-surface-lifetimes",
      databaseMode: "postgres",
      environment: { DATABASE_URL: databaseUrl },
    });
    const result = { kind, races: [], shutdown: {} };
    report.runtimes.push(result);
    let repository, held, pending, closing;
    const call = async (method, url, input, signal) => {
      const response = await fetch(fixture.server.origin + url, {
        method,
        headers: {
          origin: "http://127.0.0.1:5173",
          ...(input === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
        signal: signal ?? AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.json() };
    };
    const lock = async (statement) => {
      held = await sql.reserve();
      await held.unsafe("BEGIN");
      const pid = (await held.unsafe("SELECT pg_backend_pid() pid"))[0].pid;
      await held.unsafe(statement);
      return pid;
    };
    const release = async () => {
      if (held) {
        await held.unsafe("COMMIT");
        held.release();
        held = undefined;
      }
    };
    const blocked = async (pid, pattern, count) => {
      const end = Date.now() + 10000;
      for (;;) {
        const rows =
          await sql`WITH RECURSIVE waiting AS (SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid,a.query,a.wait_event_type FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT * FROM waiting`;
        const matches = rows.filter((row) => pattern.test(row.query));
        if (matches.length === count) {
          for (const row of matches) assert.equal(row.wait_event_type, "Lock");
          return matches;
        }
        assert.ok(
          Date.now() < end,
          `Actual ${count} operations did not wait at ${pattern}`,
        );
        await delay(10);
      }
    };
    const pinInput = {
      titleProtection: label("explorer"),
      stateProtection: state("explorer-state"),
      fileMode: "edit",
      targetRegion: "right",
    };
    try {
      await fixture.start();
      await fixture.observe("session", "GET", "/api/auth/session");
      await fixture.close();
      repository = await repositoryFixture({
        kind,
        executable: repositoryBinary,
        root: path.join(root, fixture.name),
        databaseMode: "postgres",
        databaseUrl,
      });
      for (const statement of targetStateSql())
        await repository.seed(statement);
      await repository.seed(
        `INSERT INTO explorers(id,project_id,active_worker_id,worktree_id,protected_label,protected_state) VALUES('shutdown-explorer','github','alpha','github-alpha-main',${json(label("explorer"))},${json(state("explorer-state"))})`,
      );
      await repository.close();
      repository = undefined;
      await fixture.start();
      for (const race of ["pin", "retarget"]) {
        const pid = await lock(
          race === "pin"
            ? "SELECT id FROM explorers WHERE id='explorer' FOR UPDATE"
            : "SELECT id FROM code_tabs WHERE id='code' FOR UPDATE",
        );
        const pattern =
          race === "pin"
            ? /from "explorers".*for update/iu
            : /update "code_tabs"/iu;
        const requests = [];
        try {
          requests.push(
            call(
              race === "pin" ? "POST" : "PATCH",
              race === "pin"
                ? "/api/explorers/explorer/pin"
                : "/api/code-tabs/code/worktree",
              race === "pin" ? pinInput : { worktreeId: "github-beta-main" },
            ),
          );
          requests[0].catch(() => {});
          const first = await blocked(pid, pattern, 1);
          requests.push(
            call(
              race === "pin" ? "POST" : "PATCH",
              race === "pin"
                ? "/api/explorers/explorer/pin"
                : "/api/code-tabs/code/worktree",
              race === "pin"
                ? {
                    ...pinInput,
                    targetRegion: undefined,
                    paneId: "missing",
                    fileMode: "visual",
                  }
                : { worktreeId: "github-beta-main" },
            ),
          );
          requests[1].catch(() => {});
          const waits = await blocked(pid, pattern, 2);
          assert.ok(waits.some((v) => v.pid === first[0].pid));
          await release();
          const responses = await Promise.all(requests);
          assert.deepEqual(
            responses.map((v) => v.status),
            race === "pin" ? [200, 200] : [200, 404],
          );
          if (race === "pin") {
            assert.deepEqual(responses[1].body, responses[0].body);
            assert.equal(responses[0].body.fileMode, "edit");
            assert.equal(
              (
                await sql`SELECT tab_key FROM tab_group_members WHERE tab_key='explorer:explorer'`
              ).length,
              1,
            );
            assert.equal(
              (
                await sql`SELECT tab_layout_revision FROM projects WHERE id='github'`
              )[0].tab_layout_revision,
              1,
            );
          } else {
            assert.deepEqual(responses[1].body, {
              error: "Code tab or worktree not found.",
            });
            assert.equal(
              (
                await sql`SELECT active_worker_id FROM code_tabs WHERE id='code'`
              )[0].active_worker_id,
              "beta",
            );
          }
          result.races.push({ race, first, waits, responses });
        } finally {
          await release();
          await Promise.allSettled(requests);
        }
      }
      const pid = await lock("LOCK TABLE tab_group_members IN SHARE MODE"),
        abort = new AbortController();
      pending = call(
        "POST",
        "/api/explorers/shutdown-explorer/pin",
        pinInput,
        abort.signal,
      ).catch((error) => ({ error: error.name }));
      const waiting = await blocked(
        pid,
        /insert into "tab_group_members"/iu,
        1,
      );
      abort.abort();
      assert.deepEqual(await pending, { error: "AbortError" });
      const server = fixture.server;
      let settled = false;
      closing = fixture.close().finally(() => {
        settled = true;
      });
      closing.catch(() => {});
      const started = await eventually(
        () =>
          server.events.find(
            (e) =>
              e.event ===
              (kind === "node"
                ? "fixture.shutdown.started"
                : "server.shutdown.started"),
          ),
        (value) => assert.ok(value, "Actual shutdown began"),
      );
      assert.equal(settled, false);
      assert.equal(server.child.exitCode, null);
      const retained =
        await sql`SELECT pid,query FROM pg_stat_activity WHERE pid=${waiting[0].pid} AND ${pid}=ANY(pg_blocking_pids(pid))`;
      assert.equal(
        retained.length,
        1,
        "same admitted pin INSERT survives abort and shutdown",
      );
      await release();
      await closing;
      closing = undefined;
      const members =
        await sql`SELECT tab_key,project_id,tab_kind,tab_id FROM tab_group_members WHERE tab_key='explorer:shutdown-explorer'`;
      assert.equal(members.length, 1);
      assert.equal(members[0].tab_kind, "explorer");
      await fixture.start();
      const retry = await call("POST", "/api/explorers/shutdown-explorer/pin", {
        ...pinInput,
        targetRegion: undefined,
        paneId: "missing",
        fileMode: "visual",
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.fileMode, "edit");
      assert.deepEqual(retry.body.stateProtection, pinInput.stateProtection);
      const revision = (
        await sql`SELECT tab_layout_revision FROM projects WHERE id='github'`
      )[0].tab_layout_revision;
      assert.equal(revision, 2);
      result.shutdown = {
        waiting,
        retained,
        started,
        callerDisconnected: true,
        shutdownWaitedForCommit: true,
        members,
        revision,
      };
    } catch (error) {
      result.diagnostics = fixture.server?.diagnostics();
      throw error;
    } finally {
      await release();
      await pending?.catch(() => {});
      await closing?.catch(() => {});
      await fixture.close();
      await repository?.close();
      await sql.end({ timeout: 5 });
    }
  }
  const normalize = (r) => ({
    races: r.races.map((v) => ({
      race: v.race,
      statuses: v.responses.map((r) => r.status),
    })),
    shutdown: {
      callerDisconnected: r.shutdown.callerDisconnected,
      shutdownWaitedForCommit: r.shutdown.shutdownWaitedForCommit,
      members: r.shutdown.members,
      revision: r.shutdown.revision,
    },
  });
  assert.deepEqual(
    normalize(report.runtimes[1]),
    normalize(report.runtimes[0]),
  );
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
  }
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    runtimes: report.runtimes.map((r) => ({
      kind: r.kind,
      races: r.races.length,
      shutdown: r.shutdown.shutdownWaitedForCommit,
    })),
  }),
);
