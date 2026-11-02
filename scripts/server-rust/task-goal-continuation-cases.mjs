// Run the actual Source/native Goal coordinators against their real Task and
// lease repositories. Worker replies are controlled opaque fixtures; worker
// crypto separately proves the same failure projection preserves the plan.
import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
import { taskMessage } from "./task-wire-fixtures.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";

export async function goalContinuationCases({
  ok,
  bad,
  seed,
  owner,
  finalized,
  reply,
  operation,
  snapshot,
}) {
  const cycle = "77777777-7777-4777-8777-000000000341";
  const message = taskMessage(
    "system",
    "goal",
    "77777777-7777-4777-8777-000000000342",
  );
  async function started() {
    const relay = await finalized();
    await ok("prepare launched Goal for canonical continuation", {
      action: "launch",
      operation,
      goalReply: { ...reply(), task: relay.task },
    });
    await seed(
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,lease_owner,lease_expires_at,fencing_token,started_at,worktree_id,codex_thread_id,created_at,updated_at) VALUES('${cycle}',${literal(owner)},'task','${operation}','finalize','running',${literal(stamp)},'goal-owner','2099-01-01T00:00:00.000Z',1,${literal(stamp)},'github-alpha-main','goal-thread',${literal(stamp)},${literal(stamp)})`,
    );
    return relay;
  }
  const fields = (goalReply) => ({
    action: "continue",
    turn: {
      text: "Continue the saved approved Goal.",
      idempotencyKey: "goal-resume-control",
    },
    protectedMessage: retainedPrompt().pendingMessage,
    taskMessage: message,
    goalReply,
  });
  let relay = await started();
  await ok(
    "started Goal continuation carries explicit existing resume marker",
    fields({ ...reply(), task: relay.task }),
    (value) => {
      assert.equal(value.result, true);
      const created = value.commands.find(
        ({ command }) => command.type === "chat.goal.create",
      ).command;
      assert.equal(created.taskContext.message.kind, "resume");
      assert.match(created.taskContext.message.id, /^[0-9a-f-]{36}$/);
      assert.notEqual(created.taskContext.message.id, message.id);
      assert.equal(
        created.taskContext.message.idempotencyKey,
        `task-goal-resume:${created.taskContext.message.id}`,
      );
      assert.equal(
        value.trace.find((entry) => entry.kind === "begin").options.messageRole,
        "system",
      );
    },
  );
  const failureKinds = [
    "runtime",
    "timeout",
    "capacity",
    "rate-limit",
    "connection",
    "needs-input",
    "configuration",
    "usage-limit",
    "budget-limit",
  ];
  for (const kind of failureKinds) {
    relay = await started();
    const failed = structuredClone(relay.task);
    failed.classification.state = "failed";
    failed.classification.stableStateBeforeFailure = null;
    failed.classification.lastError = {
      code: `implementation-${kind}-failed`,
      operationKind: "implementation",
      occurredAt: stamp,
    };
    await bad(
      `sealed ${kind} continuation failure passes unchanged planning guard`,
      fields({ goal: null, task: failed, message: null }),
      `implementation-${kind}-failed`,
    );
    for (const row of await snapshot(
      `durable ${kind} continuation failure retains approved plan`,
    )) {
      assert.equal(row.task.state, "failed");
      assert.equal(row.task.stable_state_before_failure, null);
      assert.equal(row.task.planning_round, 2);
      assert.equal(row.task.has_final_plan, true);
      assert.equal(row.task.has_goal_prompt, true);
      assert.equal(row.task.last_error.operationKind, "implementation");
      assert.equal(row.task.last_error.code, `implementation-${kind}-failed`);
      assert.equal(row.cycles[0].state, "failed");
      assert.equal(row.cycles[0].fencing_token, 1);
      assert.equal(row.cycles[0].lease_owner, "goal-owner");
      assert.equal(
        Date.parse(row.cycles[0].lease_expires_at) -
          Date.parse(row.cycles[0].last_heartbeat_at),
        120000,
      );
    }
  }
  for (const kind of failureKinds) {
    relay = await finalized();
    const initialFailure = structuredClone(relay.goal.failureTask);
    const code =
      kind === "runtime" ? "task-goal-start-failed" : `task-goal-start-${kind}`;
    initialFailure.classification.lastError.code = code;
    await bad(
      `initial protected ${kind} failure retains typed startup recovery`,
      {
        action: "launch",
        operation,
        goalReply: { goal: null, task: initialFailure, message: null },
      },
      code,
    );
  }
}
