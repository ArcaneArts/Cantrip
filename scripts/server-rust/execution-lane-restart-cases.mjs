import assert from "node:assert/strict";
import { literal, json, label, stamp } from "./project-target-state.mjs";
export async function runLaneRestartCases({
  start,
  call,
  unchanged,
  seed,
  snapshot,
  standalone,
  owner,
}) {
  async function fixture() {
    const c = await start();
    await seed(
      "UPDATE chats SET active_worktree_id='github-beta-feature' WHERE id='contender'",
    );
    await call("start", "restart private contender active", {
      chat: "contender",
    });
    await call("start", "restart standalone active", { chat: standalone });
    await seed([
      "UPDATE chats SET experience='task' WHERE id='chat'",
      "UPDATE chats SET automation_paused=true WHERE context_kind='standalone'",
      "UPDATE chats SET status='waiting-for-approval' WHERE id='other-chat'",
      `INSERT INTO tasks(chat_id,state,plan_goal_enabled,protected_content,implementation_started_at,created_at,updated_at) VALUES('chat','implementing',true,${json(label("chat").protectedLabel)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO agent_interaction_requests(id,request_key,owner_id,project_id,chat_id,worker_id,thread_id,kind,status,created_at,updated_at) VALUES('restart-pending','restart-pending',${literal(owner)},'github','chat','alpha','thread','approval','pending',${literal(stamp)},${literal(stamp)}),('restart-resolved','restart-resolved',${literal(owner)},'github','chat','alpha','thread','approval','resolved',${literal(stamp)},${literal(stamp)})`,
      "UPDATE chat_runtime_sessions SET status='running' WHERE chat_id='chat'",
      "UPDATE chat_runtime_sessions SET status='starting' WHERE chat_id='contender'",
    ]);
    return c;
  }
  await fixture();
  const before = await snapshot("before interruption reset");
  await call("reset", "reset interrupted executions atomically");
  const states = await snapshot(
    "recover Goal offline preserve private leases interrupt approvals",
  );
  for (const [i, state] of states.entries()) {
    const chats = Object.fromEntries(state.chats.map((c) => [c.id, c]));
    assert.equal(chats.chat.status, "offline");
    assert.equal(chats.chat.has_unread_completion, false);
    assert.equal(chats.contender.status, "failed");
    assert.equal(chats.contender.has_unread_completion, true);
    assert.equal(chats[standalone].status, "idle");
    assert.equal(chats[standalone].has_unread_completion, true);
    assert.equal(chats["other-chat"].status, "failed");
    assert.ok(state.lanes.every((l) => l.state === "suspended"));
    assert.ok(state.runtimes.every((r) => r.status === "detached"));
    assert.equal(
      state.leases.find(
        (l) =>
          l.chat_id === "chat" ||
          state.lanes.find((n) => n.id === l.chat_execution_lane_id)
            ?.chat_id === "chat",
      ).state,
      "released",
    );
    assert.equal(
      state.leases.find(
        (l) =>
          state.lanes.find((n) => n.id === l.chat_execution_lane_id)
            ?.chat_id === "contender",
      ).state,
      "active",
    );
    assert.equal(
      state.interactions.find((r) => r.id === "restart-pending").status,
      "interrupted",
    );
    assert.ok(
      state.interactions.find((r) => r.id === "restart-pending").resolved_at,
    );
    assert.deepEqual(
      state.interactions.find((r) => r.id === "restart-resolved"),
      before[i].interactions.find((r) => r.id === "restart-resolved"),
    );
    assert.deepEqual(
      state.tasks,
      before[i].tasks,
      "restart does not claim native Goal execution failure",
    );
  }
  await unchanged("repeated interruption reset", () =>
    call("reset", "repeated interruption reset"),
  );
  for (const planGoalEnabled of [false, true])
    for (const started of [false, true]) {
      await fixture();
      await seed(
        `UPDATE tasks SET plan_goal_enabled=${planGoalEnabled},implementation_started_at=${started ? literal(stamp) : "NULL"}`,
      );
      await call(
        "reset",
        `Task reset Goal enabled=${planGoalEnabled} started=${started}`,
      );
      const after = await snapshot(
        `Task reset branch ${planGoalEnabled}${started}`,
      );
      for (const state of after)
        assert.equal(
          state.chats.find((c) => c.id === "chat").status,
          planGoalEnabled && started ? "offline" : "failed",
        );
    }
  await fixture();
  await seed([
    "CREATE FUNCTION restart_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM agent_interaction_requests WHERE id='restart-pending' AND status='interrupted') OR EXISTS(SELECT 1 FROM chat_execution_lanes WHERE state='active') THEN RAISE EXCEPTION 'preceding restart writes absent' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'restart failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER restart_fault BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION restart_fault()",
  ]);
  await unchanged(
    "restart fault rolls back approvals lanes leases and chats",
    () =>
      call(
        "reset",
        "restart fault rolls back approvals lanes leases and chats",
        {},
        { error: true, sqlstate: "P0001" },
      ),
  );
  await seed([
    "DROP TRIGGER restart_fault ON chats",
    "DROP FUNCTION restart_fault()",
  ]);
  await call("reset", "restart succeeds after rollback");
}
