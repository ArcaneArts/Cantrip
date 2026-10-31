import assert from "node:assert/strict";
import { retainedPrompt, promptId } from "./native-settlement-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";
export async function runManagedQueueFaultCases(h) {
  const { setup, mutate, request, seed, snapshot, assertUnchanged } = h;
  const add = () => ({
    kind: "add",
    prompt: retainedPrompt(),
    attachments: [],
  });
  await setup();
  await mutate("prepare retained-input mismatch", request(add()));
  await seed(
    `UPDATE queued_prompts SET opaque_content=jsonb_set(opaque_content,'{id}',${json("456789ab-1234-4234-8234-000000000099")}) WHERE id=${literal(promptId)}`,
  );
  const rejected = await mutate(
    "typed start rejection preserves its already-created claim",
    request({ kind: "start", id: promptId }, { revision: 1 }),
    { status: "rejected", rejection: "queue-input-snapshot-mismatch" },
  );
  for (const r of rejected) {
    assert.equal(r.revision, 1);
    assert.equal(r.claim.status, "claimed");
    assert.equal(r.items[0].state, "pending");
  }
  const partial = await snapshot(
    "typed rejection retains only the source's partial effects",
  );
  for (const s of partial) {
    assert.equal(s.claims.length, 1);
    assert.equal(s.queueInputs, null);
    assert.equal(s.prompts[0].state, "pending");
  }
  await setup();
  await seed(
    "UPDATE managed_queue_states SET revision=2147483647 WHERE chat_id='chat'",
  );
  await assertUnchanged(
    "SQL failure rolls back prompt and admission together",
    () =>
      mutate(
        "SQL failure rolls back prompt and admission together",
        request(add(), { revision: 2147483647 }),
        { error: true, sqlstate: "22003" },
      ),
  );
  await setup();
}
