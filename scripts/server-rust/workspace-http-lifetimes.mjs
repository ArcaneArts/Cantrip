// Real concurrent requests and a disconnected caller held at receipt commit.
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
import {
  targetStateSql,
  localOwner,
  literal,
  json,
} from "./project-target-state.mjs";
import { workspaceState } from "./workspace-wire-fixtures.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = await mkdtemp(path.join(tmpdir(), "cantrip-workspace-lifetimes-")),
  reportPath = option("--report");
const report = {
  suite: "workspace-http-concurrency-and-shutdown",
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
      sql = postgres(databaseUrl, { max: 3 });
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "workspace-lifetimes",
      databaseMode: "postgres",
      environment: { DATABASE_URL: databaseUrl },
    });
    const result = { kind, races: [], shutdown: {} };
    report.runtimes.push(result);
    let repository, held, pending, closing;
    const base = "/api/projects/github/workspace-layouts/workspace";
    const call = async (url, input, signal) => {
      const response = await fetch(fixture.server.origin + url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify(input),
        signal: signal ?? AbortSignal.timeout(15000),
      });
      assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
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
          `actual ${count} HTTP operations wait at ${pattern}`,
        );
        await delay(10);
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
        `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(localOwner)},'github','workspace',${json(workspaceState())})`,
      );
      await repository.close();
      repository = undefined;
      await fixture.start();
      let layout = workspaceState(),
        sequence = 0;
      const command = (action, changes = {}) => ({
        operationId: "race-" + sequence++,
        projectId: "github",
        workspaceId: "workspace",
        windowId: "main",
        attachmentGeneration: layout.windows[0].attachmentGeneration,
        expectedRevision: layout.revision,
        action,
        ...changes,
      });
      const compete = async (name, commands, codes) => {
        const pid = await lock(
          "SELECT owner_id FROM workspace_layouts WHERE workspace_id='workspace' FOR UPDATE",
        );
        const requests = commands.map((input) =>
          call(base + "/commands", input),
        );
        for (const r of requests) r.catch(() => {});
        try {
          const waits = await blocked(pid, /workspace_layouts.*for update/i, 2);
          await release();
          const responses = await Promise.all(requests);
          assert.deepEqual(responses.map((r) => r.status).sort(), codes);
          result.races.push({ name, waits, responses });
          return responses;
        } finally {
          await release();
          await Promise.allSettled(requests);
        }
      };
      const same = command({ type: "select", tabId: "b" });
      const retried = await compete(
        "same operation executes exactly once",
        [same, same],
        [200, 200],
      );
      assert.deepEqual(retried.map((r) => r.body.replayed).sort(), [
        false,
        true,
      ]);
      assert.deepEqual(retried[0].body.layout, retried[1].body.layout);
      layout = retried[0].body.layout;
      assert.equal(layout.revision, 5);
      const distinct = await compete(
        "competing revisions admit one operation",
        [command({ type: "home" }), command({ type: "home" })],
        [200, 409],
      );
      assert.deepEqual(distinct.find((r) => r.status === 409).body, {
        error: "Workspace revision changed; rebase the pending operation.",
        code: "revision",
      });
      layout = distinct.find((r) => r.status === 200).body.layout;
      assert.equal(layout.revision, 6);
      const replacements = await compete(
        "renderer generation fences the other contender before revision",
        [
          command({ type: "replace-attachment", rendererId: "replacement" }),
          command({ type: "replace-attachment", rendererId: "replacement" }),
        ],
        [200, 409],
      );
      assert.deepEqual(replacements.find((r) => r.status === 409).body, {
        error: "The window attachment is no longer current.",
        code: "attachment",
      });
      layout = replacements.find((r) => r.status === 200).body.layout;
      assert.equal(layout.revision, 7);
      assert.equal(layout.windows[0].attachmentGeneration, 2);
      for (const different of [false, true]) {
        const workspace = different ? "different-seeds" : "same-seeds",
          url = `/api/projects/folder/workspace-layouts/${workspace}/seed`;
        const inputs = [
          { mainWindowId: "first-main" },
          { mainWindowId: different ? "second-main" : "first-main" },
        ];
        const pid = await lock("LOCK TABLE workspace_layouts IN SHARE MODE");
        const requests = inputs.map((input) => call(url, input));
        for (const r of requests) r.catch(() => {});
        try {
          const waits = await blocked(
            pid,
            /insert into "workspace_layouts"/i,
            2,
          );
          await release();
          const responses = await Promise.all(requests);
          assert.deepEqual(
            responses.map((r) => r.status).sort(),
            different ? [200, 409] : [200, 200],
          );
          const stored = (
            await sql`SELECT layout FROM workspace_layouts WHERE workspace_id=${workspace}`
          )[0].layout;
          for (const [i, response] of responses.entries()) {
            if (response.status === 200) {
              assert.equal(response.body.mainWindowId, inputs[i].mainWindowId);
              assert.deepEqual(response.body, stored);
            } else
              assert.deepEqual(response.body, {
                error: "This workspace already has a different main window.",
                code: "scope",
              });
          }
          result.races.push({
            name: different
              ? "different seeds retain first committed identity"
              : "same seeds converge",
            waits,
            responses,
            stored,
          });
        } finally {
          await release();
          await Promise.allSettled(requests);
        }
      }
      const pid = await lock(
        "LOCK TABLE workspace_command_receipts IN SHARE MODE",
      );
      const input = command(
          { type: "home" },
          { operationId: "disconnected-command" },
        ),
        abort = new AbortController();
      pending = call(base + "/commands", input, abort.signal).catch(
        (error) => ({ error: error.name }),
      );
      const waiting = await blocked(
        pid,
        /insert into "workspace_command_receipts"/i,
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
      await delay(150);
      assert.equal(settled, false, "shutdown retains the admitted command");
      assert.equal(server.child.exitCode, null);
      const retained =
        await sql`SELECT pid FROM pg_stat_activity WHERE pid=${waiting[0].pid} AND ${pid}=ANY(pg_blocking_pids(pid))`;
      assert.equal(
        retained.length,
        1,
        "same receipt INSERT survives caller disconnect and shutdown",
      );
      await release();
      await closing;
      closing = undefined;
      const rows =
        await sql`SELECT layout FROM workspace_layouts WHERE workspace_id='workspace'`;
      layout = rows[0].layout;
      assert.equal(layout.revision, 8);
      const receipts =
        await sql`SELECT command,applied_revision FROM workspace_command_receipts WHERE operation_id='disconnected-command'`;
      assert.equal(receipts.length, 1);
      assert.deepEqual(receipts[0].command, input);
      assert.equal(Number(receipts[0].applied_revision), 8);
      await fixture.start();
      const read = await fixture.observe("restart", "GET", base);
      assert.deepEqual(fixture.records.get("restart"), layout);
      const replay = await call(base + "/commands", input);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.appliedRevision, 8);
      assert.deepEqual(replay.body.layout, layout);
      result.shutdown = {
        waiting,
        callerDisconnected: true,
        shutdownWaitedForCommit: true,
        receipt: receipts[0],
        read,
        replay,
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
  // Scheduling may choose either contender. Assert each winner/loser relationship
  // above and compare the permitted outcome, retaining every raw response.
  assert.deepEqual(
    report.runtimes[1].races.map((r) => ({
      name: r.name,
      statuses: r.responses.map((v) => v.status).sort(),
    })),
    report.runtimes[0].races.map((r) => ({
      name: r.name,
      statuses: r.responses.map((v) => v.status).sort(),
    })),
  );
  assert.deepEqual(
    report.runtimes[1].shutdown.receipt,
    report.runtimes[0].shutdown.receipt,
  );
  assert.deepEqual(
    report.runtimes[1].shutdown.replay,
    report.runtimes[0].shutdown.replay,
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
