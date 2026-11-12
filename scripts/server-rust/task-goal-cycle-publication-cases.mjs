import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { json } from "./project-target-state.mjs";
import { taskMessage } from "./task-wire-fixtures.mjs";

export async function runTaskGoalCyclePublicationCases({
  h,
  clean,
  receipt,
  native,
  rows,
  reopen,
  id,
}) {
  const turn = "autonomous-turn";
  const cycle = {
    cycleId: receipt.dispatch.cycleId,
    goalEpoch: "epoch",
    scopeId: "autonomous-scope",
    gateAttemptId: "gate",
    runnerGeneration: "runner",
    modelRouteId: receipt.modelRouteId,
    providerAccountId: null,
    orderEpoch: 0,
  };
  const source = {
    kind: "goal-cycle",
    sourceKey: "a".repeat(64),
    operationId: `native-inference:${native.threadId}:${turn}:${cycle.scopeId}:${cycle.gateAttemptId}`,
    workerGeneration: id(6),
    runtimeGeneration: id(7),
    threadId: native.threadId,
    turnId: turn,
    cycle,
    parent: receipt,
    publication: { id: id(30), idempotencyKey: "autonomous-assigned-response" },
  };
  const rootKey = `agent-message:${turn}:${native.threadId}:${turn}:item`;
  const response = (key = rootKey) => ({
    ...taskMessage("assistant", "goal", id(31)),
    idempotencyKey: key,
  });
  const notification = (message = response()) => ({
    type: "chat.turn.outcome",
    chatId: receipt.chatId,
    clientMessageId: receipt.clientMessageId,
    executionLaneId: receipt.executionLaneId,
    worktreeId: receipt.worktreeId,
    contextKind: "project",
    scratchRootId: null,
    outcome: {
      ok: true,
      result: {
        threadId: source.threadId,
        turnId: source.turnId,
        status: "completed",
        text: "",
        structuredResult: { message },
      },
    },
  });
  const run = (name, note = notification(), fields = {}, options = {}) =>
    h.observe(
      name,
      {
        chat: receipt.chatId,
        action: "goal-cycle-outcome",
        worker: receipt.workerId,
        delivery: {
          inputKind: "goal-cycle",
          goalCycleSource: source,
          notification: note,
        },
        ...fields,
      },
      { op: "native-command-task", shape: "raw", ...options },
    );
  async function reset() {
    await clean();
    await h.seed(
      `UPDATE task_dispatch_cycles SET goal_cycle_recovery=${json({ suspension: { source, restoration: null, terminal: null } })} WHERE id='${cycle.cycleId}'`,
    );
  }
  for (const key of [rootKey, source.publication.idempotencyKey]) {
    await reset();
    const message =
      key === rootKey
        ? response()
        : { ...response(key), id: source.publication.id };
    const expected = {
      finalizedMessageId: key === rootKey ? message.id : undefined,
      autonomousWake: true,
    };
    const note = notification(message);
    const before = await rows("before autonomous Goal publisher " + key);
    for (const { value } of await run(
      "accept autonomous Goal publisher " + key,
      note,
    )) {
      assert.equal(value.committed, true);
      assert.equal(value.message.id, message.id);
    }
    const accepted = await rows(
      "after autonomous Goal publisher " + key,
      expected,
    );
    for (const [i, row] of accepted.entries()) {
      assert.deepEqual(row.task, before[i].task);
      assert.deepEqual(row.lanes, before[i].lanes);
      assert.equal(row.messages.filter((m) => m.id === message.id).length, 1);
      assert.equal(
        row.cycles[0].goal_cycle_recovery.suspension.terminal.outcomeDigest,
        createHash("sha256").update(JSON.stringify(note)).digest("hex"),
      );
    }
    await run("exact autonomous Goal publisher replay " + key, note);
    assert.deepEqual(
      await rows("autonomous replay preserves exact state " + key, expected),
      accepted,
    );
    for (const changed of [
      { ...message, id: id(32) },
      { ...response(rootKey + "-other"), id: id(32) },
      {
        ...message,
        protectedContent: {
          ...message.protectedContent,
          envelope: {
            ...message.protectedContent.envelope,
            ciphertext: "AQAAAAAAAAAAAAAAAAAAAA",
          },
        },
      },
    ]) {
      for (const { value } of await run(
        "reject changed autonomous Goal reply " + key,
        notification(changed),
      ))
        assert.equal(value.conflict, "stale-lease");
      assert.deepEqual(
        await rows(
          "autonomous changed response rolls back exactly " + key,
          expected,
        ),
        accepted,
      );
    }
  }
  await reset();
  const before = await rows(
    "before autonomous Goal publisher authority rejection",
  );
  for (const [note, fields] of [
    [notification(response(`agent-message:${turn}:child:${turn}:item`)), {}],
    [notification(response(`agent-message:root:${native.turnId}:item`)), {}],
    [
      {
        ...notification(),
        outcome: {
          ok: true,
          result: { ...notification().outcome.result, turnId: native.turnId },
        },
      },
      {},
    ],
    [notification(), { worker: "beta" }],
  ]) {
    for (const { value } of await run(
      "reject wrong autonomous Goal publisher authority",
      note,
      fields,
    ))
      assert.equal(value.conflict, "stale-lease");
    assert.deepEqual(
      await rows("autonomous authority rejection preserves exact state"),
      before,
    );
  }
  await h.seed([
    "CREATE FUNCTION fail_autonomous_publisher_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.goal_cycle_recovery->'suspension'->'terminal' IS NOT NULL AND NEW.goal_cycle_recovery->'suspension'->'terminal' <> 'null'::jsonb THEN RAISE EXCEPTION 'actual autonomous publisher terminal write failure'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER fail_autonomous_publisher_terminal BEFORE UPDATE ON task_dispatch_cycles FOR EACH ROW EXECUTE FUNCTION fail_autonomous_publisher_terminal()",
  ]);
  await run(
    "autonomous Goal terminal SQL failure rolls back reply",
    notification(),
    {},
    { error: true, sqlstate: "P0001" },
  );
  assert.deepEqual(
    await rows("autonomous reply and terminal rolled back together"),
    before,
  );
  await h.seed([
    "DROP TRIGGER fail_autonomous_publisher_terminal ON task_dispatch_cycles",
    "DROP FUNCTION fail_autonomous_publisher_terminal()",
  ]);
  await run("autonomous Goal reply succeeds after actual SQL failure");
  return reopen("autonomous Goal publisher and digest survive restart", {
    finalizedMessageId: response().id,
    autonomousWake: true,
  });
}
