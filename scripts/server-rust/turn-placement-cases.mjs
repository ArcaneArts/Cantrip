// Actual Source helper + actual repositories on both sides. Inventories are
// controlled worker responses; all placement, lane and runtime writes are real.
import assert from "node:assert/strict";
import { literal, stamp, otherOwner } from "./project-target-state.mjs";
import { runTurnPlacementRaces } from "./turn-placement-races.mjs";
export async function runTurnPlacementCases(h) {
  const { seed, reset, observe, snapshot, owner } = h;
  const old = "gui-task-old",
    primary = "github-alpha-main",
    path = "/fixture/github-alpha";
  const item = (treePath, isPrimary = false, fields = {}) => ({
    path: treePath,
    isPrimary,
    managed: !isPrimary,
    branch: isPrimary ? "main" : "task-followup",
    head: "abc",
    detached: false,
    locked: false,
    lockReason: null,
    missing: false,
    prunable: false,
    pruneReason: null,
    ...fields,
  });
  const inventory = (items = []) => ({
    sourcePath: path,
    gitCommonDir: path + "/.git",
    managedRoot: "/fixture/worktrees",
    repositoryFingerprint: "c".repeat(64),
    primaryPath: path,
    worktrees: [item(path, true), ...items],
  });
  async function setup() {
    await reset();
    await seed([
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,branch,head,created_at,updated_at) VALUES('${old}','github-alpha','alpha','Task follow-up','/fixture/task-followup','/fixture/task-followup',false,'cantrip','missing','task-followup','abc',${literal(stamp)},${literal(stamp)}) ON CONFLICT(id) DO UPDATE SET project_source_id='github-alpha',worker_id='alpha',is_primary=false,lifecycle_state='missing',branch='task-followup'`,
      `UPDATE chats SET active_worker_id='alpha',active_worktree_id='${old}',worktree_mode='agent-managed',placement_revision=1,experience='task' WHERE id='task'`,
      `UPDATE terminals SET kind='chat-console',linked_chat_id='task',active_worker_id='alpha',worktree_id='${old}',status='idle',updated_at=${literal(stamp)} WHERE id='terminal'`,
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('task-old-runtime','task','alpha','${old}','task-old-thread'),('task-primary-runtime','task','alpha','${primary}','task-primary-thread')`,
    ]);
  }
  const run = (name, fields = {}, options = {}) =>
    observe(
      name,
      { chat: "task", inventory: inventory(), ...fields },
      { op: "native-command-gui-placement", shape: "raw", ...options },
    );
  const select = (name, fields = {}, options = {}) =>
    observe(
      name,
      {
        chat: "task",
        input: { worktreeId: primary, mode: "agent-managed" },
        ...fields,
      },
      { op: "native-command-gui-worktree", shape: "raw", ...options },
    );
  async function state(name) {
    const values = await snapshot(name + " durable execution state");
    const details = await observe(
      name + " actual worktrees and linked console",
      {
        sql: "SELECT jsonb_build_object('trees',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM project_worktrees w),'terminals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM terminals t)) result",
      },
      { op: "query-json", shape: "raw" },
    );
    return { values, details };
  }
  await setup();
  const moved = await run("Task follow-up returns to its own source Primary");
  for (const result of moved) {
    assert.equal(result.context.chatId, "task");
    assert.equal(result.context.worktreeId, primary);
    assert.equal(result.context.threadId, "task-primary-thread");
    assert.deepEqual(result.calls, [
      {
        worker: "alpha",
        command: { type: "worktree.reconcile", sourcePath: path },
      },
    ]);
  }
  const movedState = await state(
    "Task identity and existing Primary runtime survive recovery",
  );
  for (const result of movedState.details) {
    const console = result.terminals.find((t) => t.id === "terminal");
    assert.equal(console.linked_chat_id, "task");
    assert.equal(console.worktree_id, primary);
  }
  for (const lifecycle of ["missing", "prunable"]) {
    await setup();
    await seed(
      `UPDATE project_worktrees SET lifecycle_state='${lifecycle}' WHERE id='${old}'`,
    );
    const result = await run("actually removed Task checkout " + lifecycle);
    for (const value of result) assert.equal(value.context.worktreeId, primary);
  }
  await setup();
  const restored = await run("worker truth restores a stale missing checkout", {
    inventory: inventory([item("/fixture/task-followup")]),
  });
  for (const value of restored) assert.equal(value.context.worktreeId, old);
  const restoredState = await state(
    "existing checkout is reconciled without relocation",
  );
  for (const value of restoredState.details)
    assert.equal(
      value.trees.find((t) => t.id === old).lifecycle_state,
      "ready",
    );
  for (const scenario of [
    "pinned",
    "running",
    "waiting-for-approval",
    "offline",
    "creating",
    "error",
    "ready",
    "agent",
    "folder-root",
    "standalone",
    "wrong-source-worker",
  ]) {
    await setup();
    const fields = {};
    if (scenario === "pinned")
      await seed("UPDATE chats SET worktree_mode='pinned' WHERE id='task'");
    if (["running", "waiting-for-approval"].includes(scenario))
      await seed(`UPDATE chats SET status='${scenario}' WHERE id='task'`);
    if (["creating", "error", "ready"].includes(scenario))
      await seed(
        `UPDATE project_worktrees SET lifecycle_state='${scenario}' WHERE id='${old}'`,
      );
    if (scenario === "agent")
      await seed("UPDATE chats SET experience='agent' WHERE id='task'");
    if (scenario === "offline") fields.connected = false;
    if (
      ["folder-root", "standalone", "wrong-source-worker"].includes(scenario)
    ) {
      const contexts = await observe(
        "capture placement context for " + scenario,
        { chat: "task" },
        { op: "chat-context", shape: "raw" },
      );
      if (scenario === "wrong-source-worker")
        await seed(
          `UPDATE project_worktrees SET project_source_id='github-beta' WHERE id='${old}'`,
        );
      fields.contexts = contexts.map((context) => ({
        ...context,
        ...(scenario === "folder-root"
          ? { rootKind: "managed-folder" }
          : scenario === "standalone"
            ? { contextKind: "standalone" }
            : {}),
      }));
    }
    const results = await observe(
      "Task follow-up preserves " + scenario,
      (i) => ({
        chat: "task",
        inventory: inventory(),
        ...fields,
        ...(fields.contexts ? { context: fields.contexts[i] } : {}),
      }),
      { op: "native-command-gui-placement", shape: "raw" },
    );
    for (const result of results) {
      assert.equal(result.context.worktreeId, old, scenario);
      if (!["pinned", "creating", "error"].includes(scenario))
        assert.deepEqual(result.calls, [], scenario);
    }
  }
  await setup();
  const before = await state("before failed worker inventory");
  await run(
    "worker failure does not prove a checkout was removed",
    { failRequest: true },
    { error: true },
  );
  assert.deepEqual(await state("after failed worker inventory"), before);
  await run(
    "malformed inventory is rejected by the actual wire parser",
    { inventory: {} },
    { error: true },
  );
  await setup();
  await run(
    "recovery refuses a mode change during the worker request",
    { inventorySql: "UPDATE chats SET worktree_mode='pinned' WHERE id='task'" },
    { error: true },
  );
  const interrupted = await state("concurrent pinned placement remains intact");
  for (const result of interrupted.values) {
    const task = result.chats.find((c) => c.id === "task");
    assert.equal(task.active_worktree_id, old);
    assert.equal(task.worktree_mode, "pinned");
    assert.equal(result.lanes, null);
  }
  await setup();
  await select("direct placement reuses the target runtime");
  await state("direct selection persists a suspended lane");
  await select(
    "same worktree can change mode while retaining placement revision",
    { input: { worktreeId: primary, mode: "pinned" } },
  );
  const same = await state("same placement revision is stable");
  for (const result of same.values)
    assert.equal(
      result.chats.find((c) => c.id === "task").placement_revision,
      2,
    );
  for (const [name, fields] of [
    ["missing chat", { chat: "missing" }],
    ["foreign owner", { owner: otherOwner }],
    ["missing target", { input: { worktreeId: "missing", mode: "pinned" } }],
    [
      "foreign target",
      { input: { worktreeId: "other-foreign-main", mode: "pinned" } },
    ],
  ]) {
    const values = await select(
      "direct placement returns no result for " + name,
      fields,
    );
    for (const value of values) assert.equal(value, null);
  }
  for (const scenario of [
    "stale-expected",
    "stale-mode",
    "other-worker",
    "running",
    "waiting-for-approval",
    "active-lane",
    "reserved-target",
    "running-console",
    "unready-target",
  ]) {
    await setup();
    const fields = {};
    if (scenario === "stale-expected") fields.expected = primary;
    if (scenario === "stale-mode") {
      fields.expected = old;
      fields.input = { worktreeId: primary, mode: "pinned" };
    }
    if (scenario === "other-worker")
      fields.input = { worktreeId: "github-beta-main", mode: "agent-managed" };
    if (["running", "waiting-for-approval"].includes(scenario))
      await seed(`UPDATE chats SET status='${scenario}' WHERE id='task'`);
    if (scenario === "active-lane")
      await seed(
        `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state) VALUES('existing-active-task','task','${old}','alpha','user',true,'Active Task','active')`,
      );
    if (scenario === "reserved-target")
      await seed(
        `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state) VALUES('reserved-target','chat','${primary}','alpha','user',true,'Reserved','suspended')`,
      );
    if (scenario === "running-console")
      await seed("UPDATE terminals SET status='running' WHERE id='terminal'");
    if (scenario === "unready-target")
      await seed(
        `UPDATE project_worktrees SET lifecycle_state='missing' WHERE id='${primary}'`,
      );
    const before = await state("before direct placement " + scenario);
    await select("direct placement preserves " + scenario, fields, {
      error: scenario !== "unready-target",
    });
    assert.deepEqual(await state("after direct placement " + scenario), before);
  }
  await setup();
  const crossProject = await select(
    "same-worker target in another project is unavailable",
    { input: { worktreeId: "local-git-alpha-main", mode: "agent-managed" } },
  );
  for (const value of crossProject) assert.equal(value, null);
  if (h.databaseMode === "postgres")
    await runTurnPlacementRaces({ ...h, setup, state });
  // A target in another project is unavailable; no invented cross-project move.
  await reset();
  await seed([
    "UPDATE terminals SET kind='interactive',linked_chat_id=NULL,worktree_id='github-alpha-main',status='idle' WHERE id='terminal'",
    "UPDATE chats SET active_worktree_id='github-alpha-main',active_worker_id='alpha',worktree_mode='agent-managed',experience='task',placement_revision=1 WHERE id='task'",
    "DELETE FROM project_worktrees WHERE id='gui-task-old'",
  ]);
}
