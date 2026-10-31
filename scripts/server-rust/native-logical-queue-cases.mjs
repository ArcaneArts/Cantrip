import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
export async function runLogicalQueueCases({ start, raw, seed, snapshot }) {
  for (const status of [
    "accepted",
    "dispatched",
    "applied",
    "rejected",
    "uncertain",
  ]) {
    const c = await start({
      dispatch: status !== "accepted",
      queueClaim: { id: "logical-claim", promptRevision: 2 },
      beforeAdmission: () =>
        seed([
          `INSERT INTO queued_prompts(id,chat_id,text,model_id,idempotency_key,state,mode,revision,created_at,updated_at) VALUES('logical-prompt','chat','Queue fixture','queue-model','logical-prompt','claimed','default',2,${literal(stamp)},${literal(stamp)})`,
          `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,created_at) VALUES('logical-claim','chat','logical-prompt',2,${literal(stamp)})`,
        ]),
    });
    await seed(`UPDATE native_commands SET status=${literal(status)}`);
    for (const value of await raw(
      "finish",
      "queued logical closure " + status,
      (i) => c.key(i, { status: "idle" }),
    ))
      assert.equal(value, true);
    const states = await snapshot(
      "logical closure and queue settlement atomic " + status,
    );
    const final =
      status === "accepted"
        ? "rejected"
        : status === "dispatched"
          ? "uncertain"
          : status;
    for (const state of states) {
      assert.equal(state.completions.length, 1);
      assert.equal(
        state.claims[0].status,
        final === "applied" ? "dispatched" : final,
      );
      assert.equal(
        state.prompts[0].state,
        final === "rejected" ? "pending" : "claimed",
      );
      assert.equal(state.prompts[0].revision, 2);
    }
  }
}
