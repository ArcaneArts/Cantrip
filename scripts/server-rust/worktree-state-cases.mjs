import assert from "node:assert/strict";
import { assertGeneratedAtInOperation } from "./operation-clock.mjs";

export async function worktreeStateCases({
  pair,
  seed,
  report,
  owner,
  other,
  stamp,
}) {
  const worktree = "github-alpha-main";
  const observed = {
    path: "/fixture/github-alpha",
    branch: "observed",
    head: "new-head",
    detached: true,
    locked: true,
    lockReason: "observed-lock",
    missing: false,
    prunable: false,
  };
  async function run(label, operation, expected, error = null) {
    await seed(
      `UPDATE project_worktrees SET created_at='${stamp}',updated_at='${stamp}',last_scanned_at=NULL`,
    );
    const input = {
      owner,
      project: "github",
      worktree,
      ...operation,
      observeOperationClock: true,
    };
    const start = Date.now(),
      results = [],
      persistedClocks = [];
    for (const repo of pair) {
      const result = await repo.request(input);
      results.push(result);
      if (result.value?.updatedAt) {
        const stored = await repo.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('updatedAt',floor(extract(epoch from updated_at)*1000),'lastScannedAt',floor(extract(epoch from last_scanned_at)*1000)) result FROM project_worktrees WHERE id='github-alpha-main'",
        });
        assert.equal(stored.rejected, false, stored.diagnostic);
        persistedClocks.push(stored.value);
      } else persistedClocks.push(null);
    }
    const end = Date.now();
    report.cases.push({
      label,
      input,
      expected: results[0],
      actual: results[1],
      clockWindow: [start, end],
      persistedClocks,
    });
    const values = results.map((result, index) => {
      assert.equal(result.rejected, error !== null, label);
      if (error) {
        assert.equal(result.diagnostic, error);
        return null;
      }
      const value = structuredClone(result.value);
      if (value?.updatedAt) {
        for (const key of input.op === "worktree-observe"
          ? ["updatedAt", "lastScannedAt"]
          : ["updatedAt"]) {
          assertGeneratedAtInOperation({
            label: `${label}: actual ${key}`,
            kind: index === 0 ? "node" : "rust",
            before: start,
            after: end,
            operationClock: result.operationClock,
            actualGeneratedAt: value[key],
          });
          assert.equal(
            Date.parse(value[key]),
            persistedClocks[index][key],
            `${label}: persisted ${key} matches returned timestamp`,
          );
          value[key] = "verified-operation-clock";
        }
        assert.equal(value.createdAt, stamp);
      }
      return value;
    });
    assert.deepEqual(values[1], values[0], label);
    if (expected !== undefined) assert.deepEqual(values[0], expected, label);
    return values[0];
  }
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
  );
  for (const op of [
    "worktree-set-lifecycle",
    "worktree-observe",
    "worktree-removal-blockers",
  ]) {
    for (const changes of [
      { owner: other },
      { project: "folder" },
      { worktree: "missing" },
    ])
      await run(
        `${op} rejects unrelated context`,
        { op, state: "removing", observed, ...changes },
        null,
      );
  }
  await run(
    "observed path mismatch",
    { op: "worktree-observe", observed: { ...observed, path: "wrong" } },
    undefined,
    "Worker status referred to a different worktree path.",
  );
  const updated = await run("observe ready worktree", {
    op: "worktree-observe",
    observed,
  });
  assert.equal(updated.branch, "observed");
  assert.equal(updated.lockReason, "observed-lock");
  assert.equal(updated.lifecycleState, "ready");
  const removing = await run("set removing", {
    op: "worktree-set-lifecycle",
    state: "removing",
  });
  assert.equal(removing.lifecycleState, "removing");
  assert.equal(removing.lastScannedAt, null);
  for (const op of ["worktree-observe", "worktree-removal-blockers"])
    await run(`${op} requires ready context`, { op, observed }, null);
  for (const changes of [{ owner: other }, { project: "folder" }])
    await run(
      "lifecycle recovery rejects unrelated context",
      { op: "worktree-set-lifecycle", state: "ready", ...changes },
      null,
    );
  await seed(
    "UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'",
  );
  await run(
    "lifecycle recovery rejects removed source",
    { op: "worktree-set-lifecycle", state: "ready" },
    null,
  );
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
  );
  const recovered = await run("restore removing worktree", {
    op: "worktree-set-lifecycle",
    state: "ready",
  });
  assert.equal(recovered.lifecycleState, "ready");
  for (const [missing, prunable, state] of [
    [false, true, "prunable"],
    [true, true, "missing"],
    [true, false, "missing"],
  ]) {
    await seed(
      "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
    );
    const value = await run(`observe ${state} ${prunable}`, {
      op: "worktree-observe",
      observed: {
        ...observed,
        missing,
        prunable,
        branch: null,
        head: null,
        locked: false,
        lockReason: null,
      },
    });
    assert.equal(value.lifecycleState, state);
    assert.equal(value.branch, null);
    assert.equal(value.lockReason, null);
  }
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
  );
  await seed("UPDATE chats SET status='running' WHERE id='chat'");
  await seed(
    "UPDATE terminals SET status='running',kind='interactive' WHERE id='terminal'",
  );
  await seed(
    "INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state) VALUES('state-lane','chat','github-alpha-main','alpha','test','active')",
  );
  const blockers = await run("active removal blockers", {
    op: "worktree-removal-blockers",
  });
  assert.ok(blockers.activeChatIds.includes("chat"));
  assert.deepEqual(blockers.activeLeaseChatIds, ["chat"]);
  assert.ok(blockers.runningTerminalIds.includes("terminal"));
  assert.ok(blockers.boundCodeTabIds.includes("code"));
  await seed("UPDATE chats SET status='waiting-for-approval' WHERE id='chat'");
  await seed(
    "UPDATE chat_execution_lanes SET state='released' WHERE id='state-lane'",
  );
  await seed(
    `INSERT INTO run_configuration_runtimes(id,owner_id,project_id,configuration_id,worktree_id,worker_id,definition_revision,requested_operation_id) VALUES('11111111-1111-4111-8111-111111111111','${owner}','github','22222222-2222-4222-8222-222222222222','github-alpha-main','alpha','${"a".repeat(64)}','33333333-3333-4333-8333-333333333333')`,
  );
  await seed(
    "UPDATE terminals SET kind='run-configuration',protected_label=NULL,protected_state=NULL,run_configuration_id='22222222-2222-4222-8222-222222222222',run_configuration_runtime_id='11111111-1111-4111-8111-111111111111' WHERE id='terminal'",
  );
  const waiting = await run(
    "waiting chat blocks; released lease and run configuration do not",
    { op: "worktree-removal-blockers" },
  );
  assert.ok(waiting.activeChatIds.includes("chat"));
  assert.deepEqual(waiting.activeLeaseChatIds, []);
  assert.ok(!waiting.runningTerminalIds.includes("terminal"));
  await seed("UPDATE chats SET status='idle' WHERE id='chat'");
  await seed(
    "UPDATE chat_execution_lanes SET state='acquiring' WHERE id='state-lane'",
  );
  const acquiring = await run(
    "non-released acquiring lane blocks idle chat worktree",
    { op: "worktree-removal-blockers" },
  );
  assert.deepEqual(acquiring.activeChatIds, []);
  assert.deepEqual(acquiring.activeLeaseChatIds, ["chat"]);
  await seed(
    "UPDATE chat_execution_lanes SET state='released' WHERE id='state-lane'",
  );
  const created = {
    id: "inventory-created",
    origin: "cantrip",
    path: "/inventory-secondary",
  };
  for (const changes of [
    { owner: other },
    { worker: "foreign" },
    { created: { ...created, origin: "external" } },
    { created: { ...created, origin: "agent" } },
    { created: { ...created, path: "wrong" } },
    { created: { ...created, id: worktree, path: observed.path } },
    {
      created: {
        ...created,
        id: "github-beta-main",
        path: "/fixture/github-beta",
      },
    },
  ])
    await run(
      "rollback rejects unrelated creation",
      { op: "worktree-rollback", worker: "alpha", created, ...changes },
      false,
    );
  await run(
    "rollback owned secondary",
    { op: "worktree-rollback", worker: "alpha", created },
    true,
  );
  await run(
    "rollback already absent secondary",
    { op: "worktree-rollback", worker: "alpha", created },
    true,
  );
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('agent-created','github-alpha','alpha','agent','/agent-created','/agent-created',false,'agent','ready')",
  );
  const agentCreated = {
    id: "agent-created",
    origin: "agent",
    path: "/agent-created",
  };
  await seed(
    "UPDATE chat_execution_lanes SET worktree_id='agent-created',state='active' WHERE id='state-lane'",
  );
  const protectedRows = [];
  for (const repo of pair) {
    const snapshot = {
      op: "query-json",
      sql: "SELECT to_jsonb(w) result FROM project_worktrees w WHERE id='agent-created'",
    };
    const before = await repo.request(snapshot);
    assert.equal(before.rejected, false);
    const rejected = await repo.request({
      op: "worktree-rollback",
      owner,
      project: "github",
      worker: "alpha",
      created: agentCreated,
    });
    assert.equal(rejected.rejected, true, "actual foreign key blocks deletion");
    const after = await repo.request(snapshot);
    assert.equal(after.rejected, false);
    assert.deepEqual(
      after.value,
      before.value,
      "failed rollback retains exact row",
    );
    protectedRows.push({ before, rejected, after });
  }
  report.cases.push({
    label: "creation rollback preserves referenced worktree",
    protectedRows,
  });
  await seed("DELETE FROM chat_execution_lanes WHERE id='state-lane'");
  await run(
    "rollback unreferenced agent creation",
    { op: "worktree-rollback", worker: "alpha", created: agentCreated },
    true,
  );
  await seed(
    "UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'",
  );
  await run(
    "rollback removed source",
    { op: "worktree-rollback", worker: "alpha", created },
    false,
  );
  await run(
    "observe removed source",
    { op: "worktree-observe", observed },
    null,
  );
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
  );
}
