// Observe real row/advisory waits before changing authority or releasing commit.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceState, workspaceTab } from "./workspace-wire-fixtures.mjs";
import { literal, json, state, stamp } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
async function blocked(observer, pid, pattern) {
  const end = Date.now() + 10000;
  for (;;) {
    const rows =
      await observer`SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))`;
    const matches = rows.filter((r) => pattern.test(r.query));
    if (matches.length) {
      assert.equal(matches.length, 1);
      // pg_blocking_pids and the activity wait event are sampled separately.
      // Require both observations before releasing the held transaction.
      if (matches[0].wait_event_type === "Lock") return matches[0];
    }
    assert.ok(
      Date.now() < end,
      "actual workspace operation waits at " + pattern,
    );
    await delay(10);
  }
}
export async function workspaceRepositoryLocks({
  pair,
  urls,
  owner,
  other,
  report,
}) {
  const document = "eeeeeeee-eeee-4eee-8eee-000000000501",
    workspace = "authority-locks";
  const layout = workspaceState(workspace);
  layout.windows[0].panes[0].tabs[0] = workspaceTab(
    "a",
    "code",
    "project.code",
  );
  const folderLayout = { ...workspaceState(workspace), projectId: "folder" };
  for (const repository of pair) {
    await repository.seed(
      `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(owner)},'github',${literal(workspace)},${json(layout)})`,
    );
    await repository.seed(
      `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(owner)},'folder',${literal(workspace)},${json(folderLayout)})`,
    );
    await repository.seed(
      `INSERT INTO file_documents(id,project_id,worker_id,worktree_id,protected_state,created_at) VALUES(${literal(document)},'github','alpha','github-alpha-main',${json(state("file-document-state"))},${literal(stamp)})`,
    );
  }
  const command = (operationId) => ({
    operationId,
    projectId: "github",
    workspaceId: workspace,
    windowId: "main",
    attachmentGeneration: 1,
    expectedRevision: 4,
    action: {
      type: "migrate-code-files",
      tabId: "a",
      codeId: "code",
      expectedWorkerId: "alpha",
      expectedWorktreeId: "github-alpha-main",
      views: [{ tabId: "locked-file", documentId: document, mode: "edit" }],
    },
  });
  const scenarios = [
    {
      name: "project owner changes before authority read",
      table: "projects",
      id: "folder",
      project: "folder",
      query: /select.*projects.*for share/i,
      read: true,
      change: `UPDATE projects SET owner_id=${literal(other)} WHERE id='folder'`,
      restore: `UPDATE projects SET owner_id=${literal(owner)} WHERE id='folder'`,
    },
    {
      name: "legacy binding changes under source lock",
      table: "code_tabs",
      id: "code",
      query: /select.*code_tabs.*for share/i,
      code: "invalid",
      change:
        "UPDATE code_tabs SET active_worker_id='beta',worktree_id='github-beta-main' WHERE id='code'",
      restore:
        "UPDATE code_tabs SET active_worker_id='alpha',worktree_id='github-alpha-main' WHERE id='code'",
    },
    {
      name: "worker unlinked during migration authority selection",
      table: "workers",
      id: "alpha",
      query: /select.*file_documents.*for share/i,
      code: "missing",
      change: "UPDATE workers SET unlinked_at=now() WHERE id='alpha'",
      restore: "UPDATE workers SET unlinked_at=NULL WHERE id='alpha'",
    },
    {
      name: "source removed during migration authority selection",
      table: "project_sources",
      id: "github-alpha",
      query: /select.*file_documents.*for share/i,
      code: "missing",
      change:
        "UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'",
      restore:
        "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
    },
    {
      name: "checkout becomes unready during migration authority selection",
      table: "project_worktrees",
      id: "github-alpha-main",
      query: /select.*file_documents.*for share/i,
      code: "missing",
      change:
        "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
      restore:
        "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
    },
    {
      name: "immutable document binding changes during migration selection",
      table: "file_documents",
      id: document,
      query: /select.*file_documents.*for share/i,
      code: "missing",
      change: `UPDATE file_documents SET worker_id='beta' WHERE id=${literal(document)}`,
      restore: `UPDATE file_documents SET worker_id='alpha' WHERE id=${literal(document)}`,
    },
  ];
  report.lockRaces = [];
  for (const [index, scenario] of scenarios.entries()) {
    const outcomes = [];
    for (let i = 0; i < pair.length; i++) {
      const observer = postgres(urls[i], { max: 1 }),
        locker = postgres(urls[i], { max: 1 });
      const held = deferred(),
        release = deferred();
      let transaction, pending, pid;
      try {
        transaction = locker.begin(async (sql) => {
          pid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
          await sql.unsafe(
            `SELECT id FROM ${scenario.table} WHERE id=${literal(scenario.id)} FOR UPDATE`,
          );
          held.resolve();
          await release.promise;
          await sql.unsafe(scenario.change);
        });
        transaction.catch(held.reject);
        await held.promise;
        pending = pair[i].request(
          scenario.read
            ? {
                op: "workspace-get",
                owner,
                project: scenario.project,
                workspace,
              }
            : {
                op: "workspace-execute",
                owner,
                input: command("lock-race-" + index),
              },
        );
        const waiting = await blocked(observer, pid, scenario.query);
        release.resolve();
        await transaction;
        const response = await pending;
        if (scenario.read) {
          assert.equal(response.rejected, false, response.diagnostic);
          assert.equal(response.value, null);
        } else {
          assert.equal(response.rejected, true);
          assert.equal(response.code, scenario.code);
        }
        const rows =
          await observer`SELECT layout FROM workspace_layouts WHERE owner_id=${owner} AND project_id=${scenario.project ?? "github"} AND workspace_id=${workspace}`;
        assert.deepEqual(
          rows[0].layout,
          scenario.read ? folderLayout : layout,
          "failed authority leaves layout untouched",
        );
        const receipts =
          await observer`SELECT operation_id FROM workspace_command_receipts WHERE workspace_id=${workspace}`;
        assert.equal(receipts.length, 0);
        outcomes.push({ response, waiting });
      } finally {
        release.resolve();
        await transaction?.catch(() => {});
        await pending?.catch(() => {});
        await observer.unsafe(scenario.restore);
        await observer.end({ timeout: 5 });
        await locker.end({ timeout: 5 });
      }
    }
    const comparable = outcomes.map(
      ({ response: { id, ...response } }) => response,
    );
    assert.deepEqual(comparable[1], comparable[0], scenario.name);
    report.lockRaces.push({ name: scenario.name, outcomes });
  }
  const commitScenarios = scenarios.map((scenario) =>
    scenario.read
      ? {
          ...scenario,
          change:
            "UPDATE projects SET preferred_worker_id='beta' WHERE id='github'",
          restore:
            "UPDATE projects SET preferred_worker_id='alpha' WHERE id='github'",
        }
      : scenario,
  );
  const outcomes = [];
  for (let i = 0; i < pair.length; i++) {
    const observer = postgres(urls[i], { max: 1 }),
      locker = postgres(urls[i], { max: 1 }),
      mutator = postgres(urls[i], { max: 6 });
    const held = deferred(),
      release = deferred();
    let transaction, pending, pid;
    const mutations = [];
    try {
      await observer.unsafe(
        "CREATE FUNCTION workspace_lock_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(83215231); RETURN NEW; END $$",
      );
      await observer.unsafe(
        "CREATE TRIGGER workspace_lock_receipt BEFORE INSERT ON workspace_command_receipts FOR EACH ROW EXECUTE FUNCTION workspace_lock_receipt()",
      );
      transaction = locker.begin(async (sql) => {
        pid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
        await sql`SELECT pg_advisory_xact_lock(83215231)`;
        held.resolve();
        await release.promise;
      });
      transaction.catch(held.reject);
      await held.promise;
      pending = pair[i].request({
        op: "workspace-execute",
        owner,
        input: command("held-receipt"),
      });
      const receipt = await blocked(
        observer,
        pid,
        /insert into "workspace_command_receipts"/i,
      );
      const waits = [];
      for (const scenario of commitScenarios) {
        const mutation = Promise.resolve(mutator.unsafe(scenario.change));
        mutation.catch(() => {});
        mutations.push(mutation);
        waits.push(
          await blocked(
            observer,
            receipt.pid,
            new RegExp("UPDATE " + scenario.table, "i"),
          ),
        );
      }
      release.resolve();
      await transaction;
      const response = await pending;
      await Promise.all(mutations);
      assert.equal(response.rejected, false, response.diagnostic);
      assert.equal(response.value.layout.revision, 5);
      assert.equal(response.value.replayed, false);
      const rows =
        await observer`SELECT layout FROM workspace_layouts WHERE project_id='github' AND workspace_id=${workspace}`;
      assert.deepEqual(rows[0].layout, response.value.layout);
      const receipts =
        await observer`SELECT operation_id,applied_revision FROM workspace_command_receipts WHERE workspace_id=${workspace}`;
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].operation_id, "held-receipt");
      assert.equal(Number(receipts[0].applied_revision), 5);
      outcomes.push({ response, receipt, authorityChanges: waits });
    } finally {
      release.resolve();
      await transaction?.catch(() => {});
      await pending?.catch(() => {});
      await Promise.allSettled(mutations);
      await observer.unsafe(
        "DROP TRIGGER IF EXISTS workspace_lock_receipt ON workspace_command_receipts",
      );
      await observer.unsafe("DROP FUNCTION IF EXISTS workspace_lock_receipt()");
      for (const scenario of commitScenarios)
        await observer.unsafe(scenario.restore);
      await observer.end({ timeout: 5 });
      await locker.end({ timeout: 5 });
      await mutator.end({ timeout: 5 });
    }
  }
  const comparable = outcomes.map(
    ({ response: { id, ...response } }) => response,
  );
  assert.deepEqual(comparable[1], comparable[0]);
  report.lockRaces.push({
    name: "all six authority rows remain locked through layout and receipt commit",
    outcomes,
  });
}
