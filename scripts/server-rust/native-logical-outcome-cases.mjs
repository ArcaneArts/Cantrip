import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
export async function runLogicalOutcomeCases({
  start,
  next,
  raw,
  unchanged,
  seed,
  snapshot,
  owner,
}) {
  async function fixture(options = {}) {
    const c = await start(options);
    const states = await snapshot("historical logical outcome input");
    // Bounded pre-existing encrypted history fixture exercises the ownership read
    // contract only. This is not a substitute for canonical history ingestion.
    await seed(
      (i) =>
        `INSERT INTO chat_messages(id,chat_id,worktree_id,execution_lane_id,role,protected_content,idempotency_key,created_at) VALUES('logical-message','chat','github-alpha-main',${literal(states[i].lanes[0].id)},'user',${json(retainedPrompt().pendingMessage.protectedContent)},'historical-key',${literal(stamp)})`,
    );
    const input = (i, extra = {}) => ({
      worker: "alpha",
      input: {
        chatId: "chat",
        executionLaneId: states[i].lanes[0].id,
        clientMessageId: "logical-message",
        worktreeId: "github-alpha-main",
        nativeLogicalRoot: {
          operationId: c.operationId,
          operationGeneration: c.admitted[i].receipt.operationGeneration,
        },
        threadId: "thread",
        turnId: "turn-one",
        ...extra,
      },
    });
    return { ...c, input };
  }
  let c = await fixture();
  for (const result of await unchanged("owning logical GUI outcome root", () =>
    raw("root", "owning logical GUI outcome root", c.input),
  ))
    assert.equal(result.operationId, c.operationId);
  for (const extra of [
    { chatId: "missing" },
    { executionLaneId: "missing" },
    { clientMessageId: "missing" },
    { worktreeId: null },
    { threadId: "other" },
    {
      nativeLogicalRoot: {
        operationId: "missing",
        operationGeneration: "missing",
      },
    },
  ]) {
    const missingChat = extra.chatId === "missing";
    for (const result of await unchanged(
      "outcome identity " + JSON.stringify(extra),
      () =>
        raw(
          "root",
          "outcome identity " + JSON.stringify(extra),
          (i) => c.input(i, extra),
          missingChat ? { error: true, code: "chat-not-found" } : {},
        ),
    ))
      if (!missingChat) assert.equal(result, null);
  }
  for (const result of await raw(
    "root",
    "other owner cannot read outcome root",
    (i) => ({ ...c.input(i), owner: otherOwner }),
    { error: true, code: "chat-not-found" },
  ))
    assert.equal(result, undefined);
  for (const result of await raw(
    "root",
    "other worker cannot read outcome root",
    (i) => ({ ...c.input(i), worker: "beta" }),
  ))
    assert.equal(result, null);
  for (const sql of [
    "UPDATE native_commands SET origin='terminal'",
    "UPDATE native_commands SET kind='control'",
    "UPDATE native_commands SET logical_operation_id=NULL",
    "UPDATE chat_messages SET role='assistant' WHERE id='logical-message'",
    "UPDATE chat_messages SET execution_lane_id=NULL WHERE id='logical-message'",
    "UPDATE native_commands SET logical_client_message_id='wrong'",
    "UPDATE native_command_activations SET worker_id='beta'",
    "INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state,created_at,updated_at) SELECT 'logical-other-lane',chat_id,worktree_id,worker_id,acquiring_actor,'released',created_at,updated_at FROM chat_execution_lanes WHERE state='active'; UPDATE native_command_activations SET execution_lane_id='logical-other-lane'",
    "INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status) SELECT 'logical-other',owner_id,worker_id,chat_id,'other-generation',origin,method,kind,payload_digest,protected_payload,identity,intent,status FROM native_commands WHERE operation_id='logical-root'; UPDATE native_command_activations SET operation_id='logical-other'",
    "UPDATE native_commands SET identity='null'::jsonb",
    "UPDATE native_command_activations SET native_turn_id='wrong'",
  ]) {
    c = await fixture();
    await seed(sql.split("; "));
    for (const result of await unchanged("outcome source scope " + sql, () =>
      raw("root", "outcome source scope " + sql, c.input),
    ))
      assert.equal(result, null);
  }
  c = await fixture();
  await next("outcome follows current logical head", c.continuation);
  for (const result of await raw(
    "root",
    "current child still identifies original GUI root",
    c.input,
  ))
    assert.equal(result.operationId, c.operationId);
  await seed(
    "UPDATE native_command_activations SET active=false,logical_cancelled=true",
  );
  for (const result of await raw(
    "root",
    "historical owning closure not fenced by active flag",
    c.input,
  ))
    assert.equal(result.operationId, c.operationId);
  for (const key of ["historical-key", null]) {
    const operationId =
      "gui:" +
      createHash("sha256")
        .update(JSON.stringify([owner, "chat", key]))
        .digest("hex");
    c = await fixture({ operationId });
    await seed([
      "UPDATE native_commands SET logical_client_message_id=NULL",
      `UPDATE chat_messages SET idempotency_key=${literal(key)} WHERE id='logical-message'`,
    ]);
    for (const result of await raw(
      "root",
      "legacy GUI identity hash " + key,
      c.input,
    ))
      assert.equal(result.operationId, operationId);
    await seed(
      "UPDATE chat_messages SET idempotency_key='wrong' WHERE id='logical-message'",
    );
    for (const result of await raw(
      "root",
      "legacy message mismatch " + key,
      c.input,
    ))
      assert.equal(result, null);
  }
}
