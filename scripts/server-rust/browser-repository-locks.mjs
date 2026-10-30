// Observe actual writes waiting on PostgreSQL locks before changing their state.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { label, state, literal, json, stamp } from "./project-target-state.mjs";
import { workspaceState } from "./workspace-wire-fixtures.mjs";
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
export async function browserRepositoryLocks({
  pair,
  urls,
  owner,
  report,
  normalize,
  snapshotSql,
}) {
  report.lockRaces = [];
  const id = "browser-lock",
    workspace = "browser-lock-workspace";
  for (const scenario of [
    "revision-advanced",
    "worker-changed-after-context",
    "deleted-without-revision",
    "deleted-with-revision",
    "delete-row-disappears-after-context",
  ]) {
    const outcomes = [];
    for (let i = 0; i < pair.length; i++) {
      const observer = postgres(urls[i], { max: 1 }),
        locker = postgres(urls[i], { max: 1 });
      const held = deferred(),
        release = deferred();
      let transaction, pending, pid;
      const deleting = scenario === "delete-row-disappears-after-context";
      try {
        await pair[i].seed(
          `INSERT INTO browsers(id,project_id,protected_label,protected_state,created_at,updated_at) VALUES(${literal(id)},'github',${json(label("browser"))},${json(state("browser-state"))},${literal(stamp)},${literal(stamp)})`,
        );
        await pair[i].seed(
          `INSERT INTO remote_surfaces(id,project_id,worker_id,kind,configuration,created_at,updated_at) VALUES(${literal(id)},'github','alpha','browser','{"kind":"browser","profileId":null}',${literal(stamp)},${literal(stamp)})`,
        );
        if (deleting) {
          const layout = workspaceState(workspace, id);
          for (const w of layout.windows)
            for (const p of w.panes)
              for (const t of p.tabs)
                if (t.resource.resourceId === id)
                  t.resource.definitionId = "project.browser";
          await observer`INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${owner},'github',${workspace},${observer.json(layout)})`;
        }
        transaction = locker.begin(async (sql) => {
          pid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
          if (deleting)
            await sql`SELECT id FROM projects WHERE id='github' FOR UPDATE`;
          else await sql`SELECT id FROM browsers WHERE id=${id} FOR UPDATE`;
          held.resolve();
          await release.promise;
          if (scenario === "revision-advanced")
            await sql`UPDATE browsers SET state_revision=2 WHERE id=${id}`;
          if (scenario === "worker-changed-after-context")
            await sql`UPDATE remote_surfaces SET worker_id='beta' WHERE id=${id}`;
          if (scenario.startsWith("deleted-") || deleting)
            await sql`DELETE FROM browsers WHERE id=${id}`;
        });
        transaction.catch(held.reject);
        await held.promise;
        const expected =
          scenario === "revision-advanced" ||
          scenario === "deleted-with-revision";
        pending = pair[i].request({
          op: deleting ? "browser-delete" : "browser-update",
          owner,
          browser: id,
          input: expected
            ? {
                expectedStateRevision: 1,
                stateProtection: state("browser-state"),
              }
            : { titleProtection: label("browser") },
        });
        let blocked;
        const end = Date.now() + 10000;
        do {
          blocked =
            await observer`SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))`;
          if (blocked.length) break;
          assert.ok(
            Date.now() < end,
            "observe actual browser operation blocked on its write",
          );
          await delay(10);
        } while (true);
        assert.equal(blocked.length, 1);
        assert.equal(blocked[0].wait_event_type, "Lock");
        assert.match(
          blocked[0].query,
          deleting ? /projects.*for update/i : /update\s+"?browsers"?/i,
        );
        const locks =
          await observer`SELECT mode FROM pg_locks WHERE pid=${blocked[0].pid} AND NOT granted`;
        assert.ok(locks.length > 0);
        release.resolve();
        await transaction;
        const response = await pending,
          stored = (await observer.unsafe(snapshotSql))[0].result;
        assert.equal(response.rejected, expected);
        if (expected)
          assert.equal(
            response.diagnostic,
            "Browser private state changed before this update.",
          );
        else if (deleting) {
          assert.equal(response.value, false);
          assert.equal(
            stored.surfaces.some((s) => s.id === id),
            false,
            "Source commits surface cleanup even if browser row disappeared",
          );
          const layout = stored.workspaces.find(
            (w) => w.workspace_id === workspace,
          ).layout;
          for (const w of layout.windows)
            for (const p of w.panes)
              assert.ok(p.tabs.every((t) => t.resource.resourceId !== id));
        } else if (scenario === "deleted-without-revision")
          assert.equal(response.value, null);
        else {
          assert.equal(response.value.workerId, "alpha");
          assert.equal(
            stored.surfaces.find((s) => s.id === id).worker_id,
            "beta",
          );
        }
        outcomes.push({
          response,
          stored,
          blocked: blocked[0],
          ungrantedLocks: locks,
        });
      } finally {
        release.resolve();
        await transaction?.catch(() => {});
        await pending?.catch(() => {});
        await observer`DELETE FROM workspace_layouts WHERE workspace_id=${workspace}`;
        await observer`DELETE FROM remote_surfaces WHERE id=${id}`;
        await observer`DELETE FROM browsers WHERE id=${id}`;
        await locker.end();
        await observer.end();
      }
    }
    report.lockRaces.push({ scenario, outcomes });
    assert.deepEqual(
      normalize(
        { response: outcomes[1].response, stored: outcomes[1].stored },
        1,
      ),
      normalize(
        { response: outcomes[0].response, stored: outcomes[0].stored },
        0,
      ),
      scenario + " exact response and committed state",
    );
  }
}
