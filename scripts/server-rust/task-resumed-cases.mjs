import assert from "node:assert/strict";
import {
  taskContent,
  taskEnvelope,
  taskMessage,
} from "./task-wire-fixtures.mjs";
export async function runTaskResumedCases({
  observe,
  seed,
  reopen,
  clean,
  run,
  rows,
  getClaims,
  setClaims,
}) {
  const now = "2099-01-01T00:00:00.000Z";
  async function paused(kind = "direct") {
    await clean(
      kind,
      [],
      kind === "finalize"
        ? [
            "UPDATE tasks SET state='review',planning_round=1,has_plan=true WHERE chat_id='task'",
          ]
        : [],
    );
    const claims = getClaims();
    await observe(
      "pause real fenced Task before resumed execution " + kind,
      (i) => ({
        action: "pause",
        fence: claims[i].lease,
        affinity: { threadId: "stream-thread", turnId: "retained-turn" },
        options: { now },
      }),
      { op: "native-command-task-scheduler", shape: "raw" },
    );
    await seed("UPDATE chats SET automation_paused=true WHERE id='task'");
    const resumed = await observe(
      "resume real paused Task claim " + kind,
      {
        action: "resume",
        leaseOwner: "resumed-server",
        options: { now },
        resolution: { eligible: true },
      },
      { op: "native-command-task-scheduler", shape: "raw" },
    );
    const values = resumed.map((v) => v.value);
    for (const c of values) {
      assert.equal(c.cycle.state, "running");
      assert.equal(c.cycle.attemptCount, 2);
    }
    setClaims(values);
  }
  const active = {
    paused: false,
    active: { threadId: "stream-thread", turnId: "retained-turn" },
  };
  for (const detached of [false, true]) {
    await paused();
    for (const v of await run(
      "resumed active Task retains exact worker affinity, detached=" + detached,
      { action: "resume", detached, pauseReplies: [active] },
    )) {
      assert.equal(v.beginError, null);
      assert.deepEqual(
        v.commands.map((c) => c.command.type),
        ["chat.pause.set"],
      );
      assert.equal(v.commands[0].command.paused, false);
      assert.equal(v.events.length, 3);
    }
    for (const r of await rows(
      "active resumed Task retains running dispatch " + detached,
    )) {
      assert.equal(r.cycles[0].state, "running");
      assert.equal(r.cycles[0].codex_thread_id, "stream-thread");
      assert.equal(r.rounds, null);
    }
  }
  for (const field of ["threadId", "turnId"]) {
    await paused();
    for (const v of await run("resumed Task rejects changed " + field, {
      action: "resume",
      pauseReplies: [
        { paused: false, active: { ...active.active, [field]: "different" } },
      ],
    })) {
      assert.equal(v.beginError, "The paused Task runtime affinity changed.");
      assert.deepEqual(
        v.commands.map((c) => c.command.paused),
        [false, true],
      );
      assert.equal(v.events.length, 4);
    }
    for (const r of await rows(
      "failed runtime affinity keeps original dispatch " + field,
    )) {
      assert.equal(r.cycles[0].state, "paused");
      assert.equal(r.cycles[0].codex_thread_id, "stream-thread");
      assert.equal(r.cycles[0].turn_id, "retained-turn");
    }
  }
  await paused();
  await seed(
    "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='task'",
  );
  for (const v of await run(
    "resumed Task refuses a changed durable worker placement",
    { action: "resume" },
  )) {
    assert.equal(
      v.beginError,
      "The paused Task placement is no longer available.",
    );
    assert.deepEqual(
      v.commands.map((c) => [c.worker, c.command.paused]),
      [["beta", true]],
    );
  }
  await seed(
    "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-main' WHERE id='task'",
  );
  await paused();
  for (const v of await run("offline resumed Task stays durably paused", {
    action: "resume",
    connected: false,
  })) {
    assert.equal(
      v.beginError,
      "The project worker is offline. This chat remains paused so its next action is not lost.",
    );
    assert.equal(v.commands.length, 0);
  }
  for (const r of await rows("offline resumed claim restored to pause"))
    assert.equal(r.cycles[0].state, "paused");
  await paused();
  for (const v of await run(
    "inactive resumed Task invokes actual claimed execution",
    { action: "resume" },
  )) {
    assert.equal(v.beginError, null);
    assert.equal(
      v.commands.filter((c) => c.command.type === "task.operation.prepare")
        .length,
      1,
    );
    assert.equal(
      v.commands.filter((c) => c.command.type === "chat.turn").length,
      1,
    );
  }
  for (const r of await rows(
    "resumed claimed launcher reaches durable completion",
  )) {
    assert.equal(r.cycles[0].state, "succeeded");
    assert.equal(r.tasks[0].state, "complete");
    assert.equal(r.rounds[0].status, "completed");
  }
  await paused();
  for (const v of await run(
    "resumed claimed launcher owns its actual preparation failure",
    { action: "resume", failCommand: "task.operation.prepare" },
  ))
    assert.equal(v.beginError, null);
  for (const r of await rows(
    "resumed launch failure retains failure receipt",
  )) {
    assert.equal(r.cycles[0].state, "failed");
    assert.equal(r.tasks[0].automatic_retry.status, "scheduled");
  }
  await paused();
  await seed("UPDATE task_dispatch_cycles SET fencing_token=fencing_token+1");
  for (const v of await run(
    "stale cleanup fence preserves original affinity error",
    {
      action: "resume",
      pauseReplies: [
        { paused: false, active: { ...active.active, turnId: "changed" } },
      ],
    },
  ))
    assert.equal(v.beginError, "The paused Task runtime affinity changed.");
  for (const r of await rows("stale cleanup cannot rewrite new fence"))
    assert.equal(r.cycles[0].state, "running");
  await paused();
  await seed([
    "CREATE OR REPLACE FUNCTION fixture_resumed_pause_corrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='paused' THEN NEW.model_configuration='[]'::jsonb; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER fixture_resumed_pause_corrupt BEFORE UPDATE ON task_dispatch_cycles FOR EACH ROW EXECUTE FUNCTION fixture_resumed_pause_corrupt()",
  ]);
  for (const v of await run(
    "actual pause projection failure takes precedence over original resume error",
    {
      action: "resume",
      pauseReplies: [
        { paused: false, active: { ...active.active, turnId: "changed" } },
      ],
    },
  )) {
    assert.ok(v.beginError.includes('"modelConfiguration"'));
    assert.ok(!v.beginError.includes("affinity changed"));
    assert.equal(v.events.length, 2);
  }
  await seed(
    "DROP TRIGGER fixture_resumed_pause_corrupt ON task_dispatch_cycles",
  );
  for (const r of await rows(
    "failed cleanup projection preserves actual committed SQL state",
  )) {
    assert.equal(r.cycles[0].state, "paused");
    assert.deepEqual(r.cycles[0].model_configuration, []);
  }
  await paused("finalize");
  for (const v of await run(
    "active resumed finalizer retains actual Goal lease",
    { action: "resume", pauseReplies: [active] },
  ))
    assert.equal(v.beginError, null);
  for (const r of await rows(
    "retained resumed finalization heartbeat persisted",
  )) {
    assert.equal(r.cycles[0].state, "running");
    assert.ok(Date.parse(r.cycles[0].lease_expires_at) < Date.parse(now));
  }
  await paused("finalize");
  await seed(
    "UPDATE tasks SET state='implementing',planning_round=1,has_plan=true,has_final_plan=true,has_goal_prompt=true WHERE chat_id='task'",
  );
  const goalReply = {
    goal: {
      chatId: "task",
      threadId: "stream-thread",
      status: "active",
      protectedObjective: structuredClone(taskEnvelope),
      tokenBudget: null,
      tokensUsed: 1,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    },
    task: taskContent("implementing", 1, {
      hasPlan: true,
      hasFinalPlan: true,
      hasGoalPrompt: true,
    }),
    message: null,
  };
  const goalControlReply = {
    ...goalReply,
    message: taskMessage("user", "goal", "<goal-message-id>"),
  };
  goalControlReply.message.idempotencyKey = "<goal-message-key>";
  for (const v of await run(
    "inactive implementing finalizer resumes actual retained Goal execution",
    {
      action: "resume",
      goalReply,
      goalControlReply,
      attempts: [
        {
          templateResult: true,
          result: {
            threadId: "stream-thread",
            turnId: "resumed-goal-turn",
            text: "",
            status: "completed",
            structuredResult: {
              message: {
                ...taskMessage("assistant", "goal", "<task-response-id>"),
                idempotencyKey: "<task-response-key>",
              },
            },
          },
        },
      ],
    },
  )) {
    assert.equal(v.beginError, null);
    assert.ok(!v.logs.some((l) => l.level === "error"));
    assert.ok(v.commands.some((c) => c.command.type === "chat.goal.get"));
    assert.ok(
      !v.commands.some((c) => c.command.type === "task.operation.prepare"),
    );
  }
  for (const r of await rows(
    "resumed Goal turn keeps encrypted message pair and retained dispatch",
  )) {
    assert.equal(r.tasks[0].state, "implementing");
    assert.equal(r.cycles[0].state, "running");
    assert.deepEqual(
      r.messages.map((m) => m.role),
      ["user", "assistant"],
    );
  }
  const before = await rows(
    "resumed finalization exact durable state before restart",
  );
  await reopen("resumed finalization restart");
  assert.deepEqual(
    await rows("resumed finalization exact durable state after restart"),
    before,
  );
}
