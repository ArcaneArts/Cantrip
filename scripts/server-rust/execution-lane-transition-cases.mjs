import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
export async function runLaneTransitionCases({
  start,
  call,
  unchanged,
  seed,
  snapshot,
  other,
  standalone,
}) {
  const schedule = (c, name, extra = {}, options = {}) =>
    call(
      "schedule",
      name,
      (i) => ({
        expectedLane: c.ids[i],
        target: "github-alpha-feature",
        ...extra,
      }),
      options,
    );
  let c = await start();
  for (const list of await call("pending-chats", "no pending transitions", {
    worker: "alpha",
  }))
    assert.deepEqual(list, []);
  for (const result of await call("pending", "no current transition"))
    assert.equal(result, null);
  let pending = await schedule(
    c,
    "reserve private destination before changing placement",
  );
  for (const result of pending) {
    assert.equal(result.chat.activeWorktreeId, "github-alpha-main");
    assert.equal(result.lane.state, "delivering");
    assert.equal(result.lane.transitionKind, "switch");
    assert.equal(result.lane.acquiringActor, "agent");
    assert.equal(result.lane.exclusive, true);
    assert.equal(result.worktree.id, "github-alpha-feature");
  }
  let states = await snapshot(
    "destination lease held while original turn runs",
  );
  for (const state of states) {
    assert.equal(state.lanes.length, 2);
    assert.equal(state.leases.filter((l) => l.state === "active").length, 2);
    assert.equal(
      state.chats.find((c) => c.id === "chat").placement_revision,
      1,
    );
  }
  for (const result of await call("pending", "read pending transition"))
    assert.equal(result.lane.worktreeId, "github-alpha-feature");
  for (const list of await call(
    "pending-chats",
    "owner pending transition chat ids",
    { worker: "alpha" },
  ))
    assert.deepEqual(list, ["chat"]);
  for (const extra of [{ owner: other }, { worker: "beta" }])
    for (const list of await call(
      "pending-chats",
      "pending transition scope " + JSON.stringify(extra),
      { worker: "alpha", ...extra },
    ))
      assert.deepEqual(list, []);
  await unchanged("cannot apply transition during active turn", () =>
    call(
      "apply",
      "cannot apply transition during active turn",
      (i) => ({ lane: pending[i].lane.id }),
      { error: true, laneError: "ExecutionLaneConflictError" },
    ),
  );
  await call("finish", "finish original before switch", c.key);
  for (const result of await call(
    "apply",
    "apply destination and chat placement atomically",
    (i) => ({ lane: pending[i].lane.id }),
  )) {
    assert.equal(result.fromWorktreeId, "github-alpha-main");
    assert.equal(result.transitionKind, "switch");
    assert.equal(result.chat.activeWorktreeId, "github-alpha-feature");
    assert.equal(result.lane.state, "suspended");
    assert.equal(result.lane.transitionKind, null);
  }
  for (const result of await unchanged("duplicate transition apply", () =>
    call("apply", "duplicate transition apply", (i) => ({
      lane: pending[i].lane.id,
    })),
  ))
    assert.equal(result, null);
  for (const list of await call(
    "pending-chats",
    "applied transition not pending",
    { worker: "alpha" },
  ))
    assert.deepEqual(list, []);
  const resumed = await call("start", "resume destination after switch");
  assert.deepEqual(
    resumed.map((r) => r.executionLaneId),
    pending.map((r) => r.lane.id),
  );
  c = {
    ids: resumed.map((r) => r.executionLaneId),
    key: (i, extra = {}) => ({ lane: resumed[i].executionLaneId, ...extra }),
  };
  pending = await schedule(c, "release transition reserves Primary", {
    target: "github-alpha-main",
    kind: "release",
  });
  await call("finish", "finish private turn before Primary return", c.key);
  for (const result of await call(
    "apply",
    "release transition releases previous private lane",
    (i) => ({ lane: pending[i].lane.id }),
  )) {
    assert.equal(result.transitionKind, "release");
    assert.equal(result.fromWorktreeId, "github-alpha-feature");
    assert.equal(result.chat.activeWorktreeId, "github-alpha-main");
  }
  states = await snapshot(
    "release transition retires both logical branch leases",
  );
  for (const state of states) {
    assert.equal(
      state.lanes.find((l) => l.worktree_id === "github-alpha-feature").state,
      "released",
    );
    assert.equal(
      state.leases.every((l) => l.state === "released"),
      true,
    );
  }
  for (const kind of ["switch", "release"]) {
    c = await start();
    await unchanged("same destination " + kind, () =>
      schedule(
        c,
        "same destination " + kind,
        { target: "github-alpha-main", kind },
        { error: true, laneError: "ExecutionLaneConflictError" },
      ),
    );
  }
  c = await start();
  await seed([
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,branch,created_at,updated_at) VALUES('�','github-alpha','alpha','Unicode root','/fixture/unicode-root','/fixture/unicode-root',false,'cantrip','ready','main',${literal(stamp)},${literal(stamp)}) ON CONFLICT(id) DO UPDATE SET lifecycle_state='ready',branch='main'`,
    "UPDATE chats SET active_worktree_id='�' WHERE id='chat'",
    "UPDATE chat_execution_lanes SET worktree_id='�' WHERE chat_id='chat'",
    "UPDATE chat_runtime_sessions SET worktree_id='�' WHERE chat_id='chat'",
    "UPDATE project_branch_leases SET worktree_id='�' WHERE project_id='github'",
  ]);
  for (const result of await schedule(
    c,
    "UTF16 transition identity before SQL encoding",
    { target: "\ud800" },
  )) {
    assert.equal(result.lane.state, "delivering");
    assert.equal(result.worktree.id, "�");
  }
  for (const [sql, extra, expected] of [
    [null, { owner: other }, null],
    [null, { chat: "missing" }, null],
    [null, { expectedLane: "wrong" }, "conflict"],
    ["UPDATE chats SET worktree_mode='pinned' WHERE id='chat'", {}, "conflict"],
    ["UPDATE chats SET status='idle' WHERE id='chat'", {}, "conflict"],
    [null, { target: "missing" }, null],
    [
      "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-feature'",
      {},
      null,
    ],
    [null, { target: "github-beta-feature" }, "conflict"],
    [null, { kind: "release" }, "conflict"],
    [
      "UPDATE terminals SET linked_chat_id='chat',kind='chat-console',status='running' WHERE id='terminal'",
      {},
      "conflict",
    ],
  ]) {
    c = await start();
    if (sql) await seed(sql);
    const result = await unchanged(
      "schedule guard " + JSON.stringify([sql, extra]),
      () =>
        schedule(
          c,
          "schedule guard " + JSON.stringify([sql, extra]),
          extra,
          expected
            ? { error: true, laneError: "ExecutionLaneConflictError" }
            : {},
        ),
    );
    if (!expected) for (const value of result) assert.equal(value, null);
  }
  c = await start({ chat: standalone });
  await unchanged("standalone cannot schedule worktree transition", () =>
    schedule(
      c,
      "standalone cannot schedule worktree transition",
      { chat: standalone },
      { error: true, laneError: "ExecutionLaneConflictError" },
    ),
  );
  for (const primary of [false, true]) {
    c = await start({ worktree: primary ? "github-alpha-feature" : undefined });
    pending = await schedule(
      c,
      "cancel fixture destination Primary=" + primary,
      { target: primary ? "github-alpha-main" : "github-alpha-feature" },
    );
    for (const result of await call(
      "cancel",
      "cancel delivering transition Primary=" + primary,
      (i) => ({ lane: pending[i].lane.id }),
    ))
      assert.equal(result, true);
    states = await snapshot(
      "cancel retains private lease and releases Primary lease " + primary,
    );
    for (const [i, state] of states.entries()) {
      const l = state.lanes.find((l) => l.id === pending[i].lane.id);
      assert.equal(l.state, "suspended");
      assert.equal(l.transition_kind, null);
      assert.equal(
        state.leases.find((b) => b.chat_execution_lane_id === l.id).state,
        primary ? "released" : "active",
      );
    }
    for (const result of await unchanged(
      "cancel only applies once " + primary,
      () =>
        call("cancel", "cancel only applies once " + primary, (i) => ({
          lane: pending[i].lane.id,
        })),
    ))
      assert.equal(result, false);
    const again = await schedule(
      c,
      "reuse suspended transition lane Primary=" + primary,
      { target: primary ? "github-alpha-main" : "github-alpha-feature" },
    );
    assert.deepEqual(
      again.map((r) => r.lane.id),
      pending.map((r) => r.lane.id),
    );
  }
  for (const sql of [
    "UPDATE project_worktrees SET lifecycle_state='failed' WHERE id='github-alpha-feature'",
    "UPDATE chats SET active_worker_id='beta' WHERE id='chat'",
  ]) {
    c = await start();
    pending = await schedule(c, "apply guard fixture");
    await call("finish", "apply guard original finished", c.key);
    await seed(sql);
    await unchanged("apply captured target guard " + sql, () =>
      call(
        "apply",
        "apply captured target guard " + sql,
        (i) => ({ lane: pending[i].lane.id }),
        { error: true, laneError: "ExecutionLaneConflictError" },
      ),
    );
  }
  c = await start();
  pending = await schedule(c, "transition rollback fixture");
  await call("finish", "finish before transition rollback fixture", c.key);
  await seed([
    "CREATE FUNCTION transition_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE chat_id=NEW.id AND worktree_id='github-alpha-feature' AND state='suspended' AND transition_kind IS NULL) THEN RAISE EXCEPTION 'target suspension not observed' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'transition placement failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER transition_fault BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION transition_fault()",
  ]);
  await unchanged("apply rollback restores destination and placement", () =>
    call(
      "apply",
      "apply rollback restores destination and placement",
      (i) => ({ lane: pending[i].lane.id }),
      { error: true, sqlstate: "P0001" },
    ),
  );
  await seed([
    "DROP TRIGGER transition_fault ON chats",
    "DROP FUNCTION transition_fault()",
  ]);
  await call("apply", "apply after transition fault removed", (i) => ({
    lane: pending[i].lane.id,
  }));
  c = await start();
  await seed([
    "CREATE FUNCTION schedule_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE id=NEW.chat_execution_lane_id AND state='delivering') THEN RAISE EXCEPTION 'destination not reserved' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'transition lease failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER schedule_fault BEFORE INSERT ON project_branch_leases FOR EACH ROW EXECUTE FUNCTION schedule_fault()",
  ]);
  await unchanged(
    "schedule rollback restores runtime destination and lease",
    () =>
      schedule(
        c,
        "schedule rollback restores runtime destination and lease",
        {},
        { error: true, sqlstate: "P0001" },
      ),
  );
  await seed([
    "DROP TRIGGER schedule_fault ON project_branch_leases",
    "DROP FUNCTION schedule_fault()",
  ]);
  pending = await schedule(c, "persistent transition reserved before reopen");
  await seed(
    `UPDATE chat_execution_lanes SET created_at=${literal(stamp)} WHERE state='delivering'`,
  );
  await snapshot("remaining transition behavior complete");
}
