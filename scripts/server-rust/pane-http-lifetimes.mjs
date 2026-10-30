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
} from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const reportOption = process.argv.indexOf("--report"),
  reportPath = reportOption < 0 ? undefined : process.argv[reportOption + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-pane-lifetimes-"));
const report = {
  suite: "pane-http-concurrency-and-shutdown",
  completeReplacement: false,
  runtimes: [],
};
const base = "/api/projects/github",
  panes = base + "/panes";
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
      name: "pane-lifetimes",
      databaseMode: "postgres",
      environment: { DATABASE_URL: databaseUrl },
    });
    const result = { kind, races: [], readLocks: [], shutdown: {} };
    report.runtimes.push(result);
    let repository,
      held,
      pending,
      closing,
      revision = 8;
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
    const read = async () => {
      const value = await call("GET", panes);
      assert.equal(value.status, 200);
      revision = value.body.revision;
      return value.body;
    };
    const compete = async (name, route, first, second) => {
      const pid = await lock(
        "SELECT id FROM projects WHERE id='github' FOR UPDATE",
      );
      const requests = [];
      try {
        requests.push(
          call(
            route.endsWith("/open") || route.endsWith("/close")
              ? "POST"
              : "PATCH",
            route,
            { revision, ...first },
          ),
        );
        requests[0].catch(() => {});
        const firstWaiter = await blocked(
          pid,
          /update "projects".*returning "id"/iu,
          1,
        );
        requests.push(
          call(
            route.endsWith("/open") || route.endsWith("/close")
              ? "POST"
              : "PATCH",
            route,
            { revision, ...second },
          ),
        );
        requests[1].catch(() => {});
        const waits = await blocked(
          pid,
          /update "projects".*returning "id"/iu,
          2,
        );
        assert.ok(waits.some((w) => w.pid === firstWaiter[0].pid));
        await release();
        const responses = await Promise.all(requests);
        assert.deepEqual(
          responses.map((r) => r.status),
          [200, 409],
          name,
        );
        assert.deepEqual(responses[1].body, {
          error: "The project tab layout changed. Refresh it and try again.",
        });
        const old = revision;
        await read();
        assert.equal(revision, old + 1);
        result.races.push({ name, firstWaiter, waits, responses });
      } finally {
        await release();
        await Promise.allSettled(requests);
      }
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
        `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,protected_label,created_at,updated_at) VALUES('center','github','center',0,'terminal:terminal',${json(label("tab-group"))},${literal(stamp)},${literal(stamp)})`,
      );
      await repository.seed(
        `INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position,created_at,updated_at) VALUES('terminal:terminal','center','github','terminal','terminal',0,${literal(stamp)},${literal(stamp)}),('chat:chat','center','github','chat','chat',1,${literal(stamp)},${literal(stamp)})`,
      );
      await repository.seed(
        `UPDATE projects SET tab_layout_revision=8,center_layout_root=${json({ kind: "pane", paneId: "center" })} WHERE id='github'`,
      );
      await repository.close();
      repository = undefined;
      await fixture.start();
      await compete(
        "same revision pane titles",
        panes + "/center",
        { titleProtection: label("tab-group") },
        { titleProtection: label("tab-group") },
      );
      const open = {
        surfaceRef: { kind: "builtin", definitionId: "git.history" },
        targetPaneId: "center",
      };
      await compete(
        "concurrent first surface opens",
        panes + "/member/open",
        open,
        open,
      );
      const focused = await call("POST", panes + "/member/open", {
        revision: 0,
        ...open,
      });
      assert.equal(focused.status, 200);
      assert.equal(focused.body.disposition, "focused");
      assert.equal(focused.body.layout.revision, revision);
      await compete(
        "concurrent surface closes",
        panes + "/member/close",
        { viewId: "builtin:github:git.history" },
        { viewId: "builtin:github:git.history" },
      );
      const closed = await call("POST", panes + "/member/close", {
        revision: 0,
        viewId: "builtin:github:git.history",
      });
      assert.equal(closed.status, 200);
      assert.equal(closed.body.disposition, "already-closed");
      assert.equal(closed.body.layout.revision, revision);
      // The standalone pre-read commits its lazy cleanup before a later failed
      // revision claim. Wrapping the entire mutation in one transaction loses it.
      await sql.unsafe(
        "INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position) VALUES('builtin:github:project.overview','center','github','builtin','project.overview',2)",
      );
      const previous = revision,
        stale = await call("PATCH", panes + "/center", {
          revision,
          titleProtection: label("tab-group"),
        });
      assert.equal(stale.status, 409);
      const cleaned = await read();
      assert.equal(cleaned.revision, previous + 1);
      assert.equal(cleaned.panes[0].members.length, 2);
      assert.equal(
        (
          await sql`SELECT tab_key FROM tab_group_members WHERE tab_id='project.overview'`
        ).length,
        0,
      );
      result.cleanup = {
        failedClaimStatus: stale.status,
        retainedCleanupRevision: revision,
        retiredOverview: true,
      };
      for (const transactional of [false, true]) {
        const pid = await lock("LOCK TABLE chats IN ACCESS EXCLUSIVE MODE");
        const reader = transactional
          ? call("POST", base + "/workspace-layouts/transaction-proof/seed", {
              mainWindowId: "main",
            })
          : call("GET", panes);
        reader.catch(() => {});
        let contender;
        try {
          const waits = await blocked(pid, /from "chats"/iu, 1),
            waiter = waits[0].pid;
          const locks =
            await sql`SELECT mode,granted FROM pg_locks WHERE pid=${waiter} AND relation='tab_groups'::regclass`;
          if (transactional)
            assert.ok(
              locks.some((l) => l.granted && l.mode === "AccessShareLock"),
            );
          else
            assert.equal(
              locks.length,
              0,
              "Ordinary reads do not retain another query's relation lock",
            );
          contender = await sql.reserve();
          await contender.unsafe("BEGIN");
          let acquired = false,
            code;
          try {
            await contender.unsafe(
              "LOCK TABLE tab_groups IN ACCESS EXCLUSIVE MODE NOWAIT",
            );
            acquired = true;
          } catch (error) {
            code = error.code;
            if (!transactional) throw error;
            assert.equal(code, "55P03");
          }
          assert.equal(
            acquired,
            !transactional,
            "Actual lock attempt proves the transaction boundary",
          );
          assert.equal(
            (await blocked(pid, /from "chats"/iu, 1))[0].pid,
            waiter,
          );
          result.readLocks.push({
            transactional,
            waits,
            locks,
            exclusiveLockAcquired: acquired,
            ...(code ? { code } : {}),
          });
        } finally {
          if (contender) {
            await contender.unsafe("ROLLBACK");
            contender.release();
          }
          await release();
          const response = await reader;
          assert.equal(response.status, 200);
        }
      }
      const pid = await lock("LOCK TABLE tab_group_members IN SHARE MODE"),
        abort = new AbortController();
      const input = {
        revision,
        surfaceRef: { kind: "builtin", definitionId: "git.graph" },
        targetPaneId: "center",
      };
      pending = call("POST", panes + "/member/open", input, abort.signal).catch(
        (error) => ({ error: error.name }),
      );
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
        (value) => assert.ok(value, "Actual server shutdown began"),
      );
      assert.equal(settled, false);
      assert.equal(server.child.exitCode, null);
      const retained =
        await sql`SELECT pid,query FROM pg_stat_activity WHERE pid=${waiting[0].pid} AND ${pid}=ANY(pg_blocking_pids(pid))`;
      assert.equal(
        retained.length,
        1,
        "The same admitted INSERT survives caller abort and actual shutdown",
      );
      await release();
      await closing;
      closing = undefined;
      const members =
        await sql`SELECT tab_key,group_id,project_id,tab_kind,tab_id,position FROM tab_group_members WHERE tab_key='builtin:github:git.graph'`;
      assert.equal(members.length, 1);
      assert.equal(members[0].group_id, "center");
      assert.equal(members[0].tab_kind, "builtin");
      const states =
        await sql`SELECT project_id,definition_id,worktree_id FROM project_builtin_surface_states WHERE definition_id='git.graph'`;
      assert.equal(states.length, 1);
      assert.equal(states[0].worktree_id, null);
      await fixture.start();
      const layout = await read();
      assert.equal(layout.revision, input.revision + 1);
      const replay = await call("POST", panes + "/member/open", {
        ...input,
        revision: 0,
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.disposition, "focused");
      assert.deepEqual(replay.body.layout, layout);
      result.shutdown = {
        waiting,
        retained,
        started,
        callerDisconnected: true,
        shutdownWaitedForCommit: true,
        members,
        states,
        restartRevision: layout.revision,
        focusedAfterRestart: replay.body.disposition,
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
  const summary = (r) => ({
    races: r.races.map((v) => ({
      name: v.name,
      statuses: v.responses.map((x) => x.status),
    })),
    cleanup: r.cleanup,
    readLocks: r.readLocks.map((v) => ({
      transactional: v.transactional,
      exclusiveLockAcquired: v.exclusiveLockAcquired,
      code: v.code,
    })),
    shutdown: {
      callerDisconnected: r.shutdown.callerDisconnected,
      shutdownWaitedForCommit: r.shutdown.shutdownWaitedForCommit,
      members: r.shutdown.members,
      states: r.shutdown.states,
      restartRevision: r.shutdown.restartRevision,
      focusedAfterRestart: r.shutdown.focusedAfterRestart,
    },
  });
  assert.deepEqual(summary(report.runtimes[1]), summary(report.runtimes[0]));
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
      readLocks: r.readLocks.length,
      shutdown: r.shutdown.shutdownWaitedForCommit,
    })),
  }),
);
