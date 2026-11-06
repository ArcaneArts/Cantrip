// Exercise the real usage writer and Task pause on separate connections. Usage
// reaches the project first; pausing must not trap its owner foreign-key check.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

async function waiters(sql, count) {
  const deadline = Date.now() + 20_000;
  let rows = [];
  do {
    rows =
      await sql`SELECT pid,query,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock'`;
    if (rows.length === count) return rows;
    await delay(20);
  } while (Date.now() < deadline);
  assert.equal(rows.length, count, "actual usage/pause SQL lock waiters");
}

export async function runTaskPauseUsageRaces(h, clean) {
  h.report.taskPauseUsageRaces = [];
  for (const [i, kind] of ["node", "rust"].entries()) {
    for (const usageKind of ["node", "rust"]) {
      await clean();
      const usage = await repositoryFixture({
        kind: usageKind,
        executable: h.executable,
        root: path.join(h.root, "task-pause-usage-peer"),
        databaseMode: "postgres",
        databaseUrl: h.urls[i],
      });
      const blocker = postgres(h.urls[i], { max: 1 });
      const observer = postgres(h.urls[i], { max: 1 });
      const pending = [];
      let release, locked, held;
      const gate = new Promise((resolve) => (release = resolve));
      const acquired = new Promise((resolve) => (locked = resolve));
      try {
        held = blocker.begin(async (sql) => {
          await sql`SELECT id FROM projects WHERE id='github' FOR UPDATE`;
          locked();
          await gate;
        });
        await Promise.race([
          acquired,
          held.then(() => {
            throw new Error("Project blocker ended before acquiring its lock");
          }),
        ]);
        const start = (actor, operation) => {
          const request = actor.request(operation);
          request.catch(() => {});
          pending.push(request);
        };
        start(usage, {
          op: "native-command-gui-telemetry",
          owner: h.owner,
          action: "usage",
          record: {
            sourceKey: "task-pause-concurrent-usage",
            projectId: "github",
            chatId: "chat",
            modelRouteId: "tw-root-route",
            usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          },
        });
        const first = await waiters(observer, 1);
        start(h.pair[i], {
          op: "native-command-task-workers",
          owner: h.owner,
          project: "github",
          action: "pause",
          input: { paused: true, rowVersion: 1 },
        });
        const both = await waiters(observer, 2);
        release();
        await held;
        const outcomes = await Promise.all(pending);
        const observation = {
          kind,
          usageKind,
          witnesses: { first, both },
          outcomes,
          passed: false,
        };
        h.report.taskPauseUsageRaces.push(observation);
        for (const outcome of outcomes)
          assert.equal(outcome.rejected, false, outcome.diagnostic);
        assert.equal(outcomes[1].value.value.rowVersion, 2);
        const [project] =
          await observer`SELECT task_scheduling_revision,task_scheduling_paused FROM projects WHERE id='github'`;
        assert.deepEqual(project, {
          task_scheduling_revision: 2,
          task_scheduling_paused: true,
        });
        const records =
          await observer`SELECT source_key,input_tokens,output_tokens FROM token_usage_records WHERE owner_id=${h.owner} AND source_key='task-pause-concurrent-usage'`;
        assert.deepEqual(
          [...records],
          [
            {
              source_key: "task-pause-concurrent-usage",
              input_tokens: "5",
              output_tokens: "3",
            },
          ],
        );
        observation.passed = true;
      } finally {
        release();
        if (held) await held.catch(() => {});
        await Promise.allSettled(pending);
        await usage.close();
        await Promise.all([blocker.end(), observer.end()]);
      }
    }
  }
}
