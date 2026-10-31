import assert from "node:assert/strict";
export async function runLaneReleaseCases({
  start,
  call,
  unchanged,
  seed,
  snapshot,
  other,
}) {
  for (const returnToPrimary of [false, true]) {
    let c = await start({ worktree: "github-alpha-feature", finish: true });
    await seed(
      "UPDATE terminals SET linked_chat_id='chat',kind='chat-console',status='idle',worktree_id='github-alpha-feature' WHERE id='terminal'",
    );
    for (const result of await call(
      "release",
      "release private lane return=" + returnToPrimary,
      (i) => c.key(i, { returnToPrimary }),
    )) {
      assert.equal(result.returnedToPrimary, returnToPrimary);
      assert.equal(result.lane.state, "released");
      assert.equal(
        result.chat.activeWorktreeId,
        returnToPrimary ? "github-alpha-main" : "github-alpha-feature",
      );
    }
    const states = await snapshot(
      "release lease and optional Primary placement " + returnToPrimary,
    );
    for (const [i, state] of states.entries()) {
      assert.equal(
        state.leases.find((l) => l.chat_execution_lane_id === c.ids[i]).state,
        "released",
      );
      const chat = state.chats.find((c) => c.id === "chat");
      assert.equal(chat.placement_revision, returnToPrimary ? 2 : 1);
      if (returnToPrimary) {
        assert.equal(
          state.lanes.find((l) => l.worktree_id === "github-alpha-main").state,
          "suspended",
        );
        assert.equal(
          state.terminals.find((t) => t.id === "terminal").worktree_id,
          "github-alpha-main",
        );
      }
    }
    for (const result of await unchanged(
      "already released lane " + returnToPrimary,
      () =>
        call("release", "already released lane " + returnToPrimary, (i) =>
          c.key(i, { returnToPrimary: true }),
        ),
    )) {
      assert.equal(result.returnedToPrimary, false);
      assert.equal(result.lane.state, "released");
    }
  }
  let c = await start();
  await unchanged("cannot release active lane", () =>
    call("release", "cannot release active lane", c.key, {
      error: true,
      laneError: "ExecutionLaneConflictError",
    }),
  );
  c = await start({ finish: true });
  await seed("UPDATE chats SET status='waiting-for-approval' WHERE id='chat'");
  await unchanged("cannot release executing chat", () =>
    call("release", "cannot release executing chat", c.key, {
      error: true,
      laneError: "ExecutionLaneConflictError",
    }),
  );
  for (const status of ["running", "starting", "idle"]) {
    c = await start({ finish: true });
    await seed(
      `UPDATE terminals SET linked_chat_id='chat',kind='chat-console',status='${status}' WHERE id='terminal'`,
    );
    const action = () =>
      call(
        "release",
        "linked console release status " + status,
        c.key,
        status === "running"
          ? { error: true, laneError: "ExecutionLaneConflictError" }
          : {},
      );
    if (status === "running")
      await unchanged("linked console release " + status, action);
    else await action();
  }
  c = await start({ finish: true });
  for (const extra of [
    { owner: other },
    { chat: "missing" },
    { lane: "missing" },
  ])
    for (const result of await unchanged(
      "release owner scope " + JSON.stringify(extra),
      () =>
        call("release", "release owner scope " + JSON.stringify(extra), (i) =>
          c.key(i, extra),
        ),
    ))
      assert.equal(result, null);
  for (const sql of [
    "UPDATE project_worktrees SET lifecycle_state='failed' WHERE id='github-alpha-main'",
    "UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'",
  ]) {
    c = await start({ worktree: "github-alpha-feature", finish: true });
    await seed(sql);
    await unchanged("release unavailable Primary " + sql, () =>
      call(
        "release",
        "release unavailable Primary " + sql,
        (i) => c.key(i, { returnToPrimary: true }),
        { error: true, laneError: "ExecutionLaneConflictError" },
      ),
    );
  }
  c = await start({ worktree: "github-alpha-feature", finish: true });
  await seed([
    "CREATE FUNCTION release_lane_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE chat_id=NEW.id AND worktree_id='github-alpha-feature' AND state='released') THEN RAISE EXCEPTION 'lane release not observed' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'placement failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER release_lane_fault BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION release_lane_fault()",
  ]);
  await unchanged(
    "release rollback after lease and Primary runtime writes",
    () =>
      call(
        "release",
        "release rollback after lease and Primary runtime writes",
        (i) => c.key(i, { returnToPrimary: true }),
        { error: true, sqlstate: "P0001" },
      ),
  );
  await seed([
    "DROP TRIGGER release_lane_fault ON chats",
    "DROP FUNCTION release_lane_fault()",
  ]);
  await call("release", "release succeeds after rolled back placement", (i) =>
    c.key(i, { returnToPrimary: true }),
  );
}
