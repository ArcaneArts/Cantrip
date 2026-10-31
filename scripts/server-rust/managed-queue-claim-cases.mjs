import assert from "node:assert/strict";
import { retainedPrompt, promptId } from "./native-settlement-fixtures.mjs";
import { runManagedQueueReceiptCases } from "./managed-queue-receipt-cases.mjs";
export async function runManagedQueueClaimCases(h) {
  const { call, request, mutate, read, setup, assertUnchanged } = h;
  const prompt = (changes = {}) => retainedPrompt(changes);
  const add = (changes = {}) => ({
    kind: "add",
    prompt: prompt(changes),
    attachments: [],
  });
  await setup();
  await mutate("cancelled GUI queue input", request(add()), {
    status: "rejected",
    rejection: "cancelled-before-admission",
    options: { expectedInputRevision: 99 },
  });
  await mutate("create prompt for claim", request(add()));
  const claimed = await call("claim-item", "claim exact input revision", {
    prompt: promptId,
    revision: 0,
    claimId: "explicit-claim",
  });
  for (const r of claimed) assert.equal(r.promptRevision, 0);
  await assertUnchanged("claim replay", () =>
    call("claim-item", "claim replay", {
      prompt: promptId,
      revision: 0,
      claimId: "explicit-claim",
    }),
  );
  await call("claim", "get claim", { claimId: "explicit-claim" });
  await call("start-receipt", "unadmitted claim has no receipt", {
    ...read,
    claimId: "explicit-claim",
  });
  await call("pending-dispatches", "claimed prompt remains dispatchable");
  await call("release", "release an unadmitted claim", {
    claimId: "explicit-claim",
  });
  await call("release", "released claim is terminal", {
    claimId: "explicit-claim",
  });
  const next = await call(
    "claim-next",
    "same-revision rejection prevents redispatch",
  );
  for (const r of next) assert.equal(r, null);
  await mutate(
    "editing rejected input permits a fresh claim",
    request(
      {
        kind: "update",
        id: promptId,
        expectedItemRevision: 0,
        prompt: prompt(),
        attachments: [],
      },
      { revision: 3 },
    ),
  );
  await call("claim-next", "claim edited queue input");
  await mutate(
    "claimed item cannot be reordered",
    request({ kind: "reorder", ids: [promptId] }, { revision: 5 }),
    { status: "rejected", rejection: "queue-item-claimed" },
  );
  await setup();
  await mutate("prepare explicit start", request(add()));
  const start = request({ kind: "start" }, { revision: 1 });
  const started = await mutate("durable explicit start request", start);
  for (const r of started) assert.ok(r.claim.id.startsWith("queue:"));
  await call("gui-operation", "start is excluded from GUI edit lookup", {
    operation: start.admission.operationId,
  });
  await call("start-receipt", "start waits for worker receipt", {
    ...read,
    claimId: started[0].claim.id,
  });
  await h.reopen("managed queue claims and retained inputs survive restart");
  await call("lookup", "reopened start lookup", { content: start.admission });
  await runManagedQueueReceiptCases(h, started[0].claim);
}
