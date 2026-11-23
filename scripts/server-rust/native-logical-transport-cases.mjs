import assert from "node:assert/strict";
import { literal, otherOwner, stamp } from "./project-target-state.mjs";

export async function runLogicalTransportCases({
  start,
  next,
  raw,
  unchanged,
  seed,
}) {
  const pending = (c, name, extra = {}, options = {}) =>
    unchanged(name, () =>
      raw("transport-pending", name, (i) => c.key(i, extra), options),
    );
  for (const status of [
    "accepted",
    "dispatched",
    "applied",
    "uncertain",
    "rejected",
  ]) {
    const c = await start({ dispatch: status !== "accepted" });
    await seed(`UPDATE native_commands SET status=${literal(status)}`);
    for (const value of await pending(c, "transport uncertainty " + status))
      assert.equal(
        value,
        ["dispatched", "applied", "uncertain"].includes(status),
      );
  }
  for (const statement of [
    "DELETE FROM native_command_activations",
    "UPDATE native_command_activations SET active=false",
    "UPDATE native_command_activations SET logical_cancelled=true",
    "UPDATE native_command_activations SET generation='replacement'",
    "UPDATE native_command_activations SET worker_id='beta'",
    "UPDATE native_commands SET origin='terminal'",
    "UPDATE native_commands SET kind='control'",
    "UPDATE native_commands SET logical_operation_id=NULL",
    `UPDATE native_commands SET logical_completed_at=${literal(stamp)}`,
    `UPDATE native_commands SET execution_completed_at=${literal(stamp)}`,
    "UPDATE chat_execution_lanes SET state='suspended'",
    "UPDATE chat_execution_lanes SET worker_id='beta'",
  ]) {
    const c = await start();
    await seed(statement);
    for (const value of await pending(c, "retention authority " + statement))
      assert.equal(value, false);
  }
  const c = await start();
  for (const extra of [
    { owner: otherOwner },
    { worker: "beta" },
    { generation: "stale" },
  ])
    await pending(
      c,
      "retention rejects foreign receipt " + JSON.stringify(extra),
      extra,
      { error: true, code: "operation-not-found" },
    );
  await next(
    "transport uncertainty follows logical continuation",
    c.continuation,
  );
  for (const value of await pending(c, "accepted continuation has no dispatch"))
    assert.equal(value, false);
  await seed(
    "UPDATE native_commands SET status='dispatched' WHERE operation_id='logical-next'",
  );
  for (const value of await pending(
    c,
    "dispatched continuation retains original logical root",
  ))
    assert.equal(value, true);
}
