// Hold the chat row while each real repository reaches its final UPDATE. Change
// the captured placement under that lock; its failed CAS must roll back every
// earlier runtime/lane/console write in the same transaction.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
export async function runTurnPlacementRaces({
  pair,
  urls,
  owner,
  seed,
  setup,
  state,
  report,
}) {
  report.taskPlacementRaces = [];
  for (const [scenario, mutation] of [
    ["mode", "worktree_mode='pinned'"],
    ["revision", "placement_revision=placement_revision+1"],
    ["pause", "automation_paused=true"],
    ["status", "status='running'"],
    ["worktree", "active_worktree_id='github-alpha-main'"],
    ["new-runtime", "status='running'"],
  ]) {
    await setup();
    if (scenario === "new-runtime")
      await seed(
        "DELETE FROM chat_runtime_sessions WHERE id='task-primary-runtime'",
      );
    const outcomes = [],
      witnesses = [];
    for (const [i, fixture] of pair.entries()) {
      const blocker = postgres(urls[i], { max: 1 }),
        observer = postgres(urls[i], { max: 1 });
      let release, held, pending;
      const gate = new Promise((resolve) => (release = resolve));
      let locked;
      const acquired = new Promise((resolve) => (locked = resolve));
      try {
        held = blocker.begin(async (sql) => {
          // Leave foreign-key key-share checks free to insert the lane. The
          // conflict must occur at the final placement UPDATE itself.
          await sql`SELECT id FROM chats WHERE id='task' FOR NO KEY UPDATE`;
          locked();
          await gate;
          await sql.unsafe("UPDATE chats SET " + mutation + " WHERE id='task'");
        });
        await Promise.race([
          acquired,
          held.then(() => {
            throw new Error("Placement blocker ended before acquiring the row");
          }),
        ]);
        pending = fixture.request({
          op: "native-command-gui-worktree",
          owner,
          chat: "task",
          expected: "gui-task-old",
          input: { worktreeId: "github-alpha-main", mode: "agent-managed" },
        });
        pending.catch(() => {});
        const deadline = Date.now() + 20000;
        let rows = [];
        while (Date.now() < deadline) {
          rows =
            await observer`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ~* 'update[[:space:]]+"?chats"?[[:space:]]+set' AND wait_event_type='Lock'`;
          if (rows.length === 1) break;
          await sleep(20);
        }
        assert.equal(
          rows.length,
          1,
          `${scenario}: actual ${i ? "Rust" : "Node"} final chat UPDATE lock witness`,
        );
        witnesses.push(rows);
        release();
        await held;
        const result = await pending;
        assert.equal(result.rejected, true, scenario);
        assert.equal(result.laneError, "ExecutionLaneConflictError", scenario);
        assert.equal(
          result.diagnostic,
          "The Task placement changed during recovery. Please retry.",
          scenario,
        );
        outcomes.push(result);
      } finally {
        release();
        if (held) await held.catch(() => {});
        if (pending) await pending.catch(() => {});
        await Promise.all([blocker.end(), observer.end()]);
      }
    }
    const after = await state(
      "actual concurrent Task placement CAS " + scenario,
    );
    for (const value of after.values) {
      assert.equal(
        value.lanes,
        null,
        "failed placement rolls back its suspended lane",
      );
      assert.equal(
        value.runtimes.filter((r) => r.chat_id === "task").length,
        scenario === "new-runtime" ? 1 : 2,
        "original runtimes remain",
      );
    }
    for (const value of after.details)
      assert.equal(
        value.terminals.find((t) => t.id === "terminal").worktree_id,
        "gui-task-old",
        "failed placement rolls back its console move",
      );
    report.taskPlacementRaces.push({
      scenario,
      witnesses,
      outcomes,
      passed: true,
    });
  }
}
