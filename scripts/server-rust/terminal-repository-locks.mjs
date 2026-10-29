// Observe real blocked DELETE operations before releasing or mutating their rows.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { terminalDeletionFixture } from "./terminal-deletion-fixture.mjs";
import { workspaceState, workspaceTab } from "./workspace-wire-fixtures.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
};

export async function terminalRepositoryLocks({
  pair,
  urls,
  owner,
  report,
  normalize,
  snapshotSql,
  runtime,
  configuration,
}) {
  report.lockRaces = [];
  for (const scenario of [
    "workspace-reads-locked-layout",
    "delete-returns-prelock-context",
    "run-guard-uses-prelock-state",
    "concurrent-terminal-delete",
  ]) {
    const outcomes = [];
    report.lockRaces.push({ scenario, outcomes });
    for (let i = 0; i < pair.length; i++) {
      const observer = postgres(urls[i], { max: 1 }),
        locker = postgres(urls[i], { max: 1 });
      const { prepare, clean } = terminalDeletionFixture({
        seed: (sql) => pair[i].seed(sql),
        owner,
      });
      const held = deferred(),
        release = deferred();
      let transaction, pending, pid;
      try {
        await prepare();
        await observer`UPDATE run_configuration_runtimes SET state='idle',terminal_id=NULL WHERE id=${runtime}`;
        if (scenario === "run-guard-uses-prelock-state") {
          await observer`UPDATE terminals SET kind='run-configuration',protected_label=NULL,protected_state=NULL,run_configuration_id=${configuration},run_configuration_runtime_id=${runtime} WHERE id='sql-terminal'`;
          await observer`UPDATE run_configuration_runtimes SET terminal_id='sql-terminal' WHERE id=${runtime}`;
        }
        transaction = locker.begin(async (sql) => {
          pid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
          if (scenario === "workspace-reads-locked-layout")
            await sql`SELECT workspace_id FROM workspace_layouts WHERE owner_id=${owner} AND project_id='github' AND workspace_id='sql-workspace' FOR UPDATE`;
          else await sql`SELECT id FROM projects WHERE id='github' FOR UPDATE`;
          held.resolve();
          await release.promise;
          if (scenario === "workspace-reads-locked-layout") {
            const layout = workspaceState("sql-workspace", "sql-terminal");
            layout.windows[0].panes[0].tabs[1].resource.resourceId =
              "sql-retained-one";
            layout.windows[0].panes[0].tabs.push(
              workspaceTab("late-view", "sql-terminal"),
            );
            layout.revision++;
            await sql`UPDATE workspace_layouts SET layout=${sql.json(layout)} WHERE workspace_id='sql-workspace'`;
          }
          if (scenario === "delete-returns-prelock-context")
            await sql`UPDATE terminals SET status='running',active_worker_id='beta',worktree_id='github-beta-main' WHERE id='sql-terminal'`;
          if (scenario === "run-guard-uses-prelock-state")
            await sql`UPDATE run_configuration_runtimes SET state='running' WHERE id=${runtime}`;
          if (scenario === "concurrent-terminal-delete")
            await sql`DELETE FROM terminals WHERE id='sql-terminal'`;
        });
        transaction.catch(held.reject);
        await held.promise;
        pending = pair[i].request({
          op: "terminal-delete",
          owner,
          terminal: "sql-terminal",
        });
        let blocked;
        const end = Date.now() + 10000;
        do {
          blocked =
            await observer`SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))`;
          if (blocked.length) break;
          assert.ok(
            Date.now() < end,
            "observe the actual terminal deletion blocked on its owning row",
          );
          await delay(10);
        } while (true);
        assert.equal(blocked.length, 1);
        assert.match(blocked[0].query, /for update/i);
        assert.match(
          blocked[0].query,
          scenario === "workspace-reads-locked-layout"
            ? /workspace_layouts/
            : /projects/,
        );
        release.resolve();
        await transaction;
        const response = await pending;
        const stored = (await observer.unsafe(snapshotSql))[0].result;
        outcomes.push({ response, stored, blockedQuery: blocked[0].query });
        assert.equal(response.rejected, false);
        assert.equal(
          response.value.workerId,
          "alpha",
          "return the context read before the project lock",
        );
        assert.equal(response.value.worktreeId, "github-alpha-main");
        assert.equal(response.value.status, "idle");
        assert.equal(
          stored.terminals.some((t) => t.id === "sql-terminal"),
          false,
        );
        assert.equal(
          stored.members.some((m) => m.tab_id === "sql-terminal"),
          false,
        );
        const layout = stored.workspaces.find(
          (w) => w.workspace_id === "sql-workspace",
        ).layout;
        for (const window of layout.windows)
          for (const pane of window.panes)
            assert.equal(
              pane.tabs.some((t) => t.resource.resourceId === "sql-terminal"),
              false,
            );
        assert.equal(
          layout.revision,
          scenario === "workspace-reads-locked-layout" ? 9 : 7,
        );
        if (scenario === "run-guard-uses-prelock-state") {
          const run = stored.runtimes.find((r) => r.id === runtime);
          assert.equal(
            run.state,
            "running",
            "preserve the source's pre-lock admission check",
          );
          assert.equal(run.terminal_id, null);
        }
      } finally {
        release.resolve();
        await transaction?.catch(() => {});
        await pending?.catch(() => {});
        await clean();
        await observer`UPDATE run_configuration_runtimes SET state='idle',terminal_id=NULL WHERE id=${runtime}`;
        await observer.end();
        await locker.end();
      }
    }
    assert.deepEqual(
      normalize(
        { response: outcomes[1].response, stored: outcomes[1].stored },
        1,
      ),
      normalize(
        { response: outcomes[0].response, stored: outcomes[0].stored },
        0,
      ),
      scenario + " complete concurrent deletion outcome",
    );
  }
}
