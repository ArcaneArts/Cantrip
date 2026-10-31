import assert from "node:assert/strict";
import { command } from "./native-command-admission-cases.mjs";
import { literal, json } from "./project-target-state.mjs";
export async function runManagedQueueReceiptCases(h, claim) {
  const { observe, call, seed, read } = h;
  const operation = "managed-queue-worker-start";
  await observe(
    "actual worker admission acquires explicit queue claim",
    command({
      operationId: operation,
      queueClaim: { id: claim.id, promptRevision: claim.promptRevision },
    }),
  );
  await call("start-receipt", "accepted worker command is awaiting receipt", {
    ...read,
    claimId: claim.id,
  });
  for (const [status, claimStatus, awaitingGoal, error] of [
    ["uncertain", "uncertain", false, "queue-dispatch-uncertain"],
    ["rejected", "rejected", false, "queue-claim-rejected"],
    ["rejected", "accepted", false, "actual-worker-rejection"],
    ["applied", "rejected", false, "queue-claim-rejected"],
    ["applied", "rejected", true, null],
    ["applied", "consumed", false, null],
  ]) {
    await seed([
      `UPDATE native_commands SET status=${literal(status)},rejection_code='actual-worker-rejection',protected_result=${json(command().protectedPayload)},result_digest=${literal("c".repeat(64))} WHERE operation_id=${literal(operation)}`,
      `UPDATE managed_queue_claims SET status=${literal(claimStatus)},awaiting_goal=${awaitingGoal} WHERE id=${literal(claim.id)}`,
    ]);
    const result = await call(
      "start-receipt",
      `worker receipt ${status}/${claimStatus}/${awaitingGoal}`,
      { ...read, claimId: claim.id },
      error ? { error: true, code: error } : {},
    );
    if (!error)
      for (const r of result) {
        assert.equal(r.receipt.operationId, operation);
        assert.equal(r.resultDigest, "c".repeat(64));
      }
  }
  // An original request can retrieve its immutable receipt after current placement
  // changes. Reconciliation of a different session must still authorize it.
  await seed(
    "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='chat'",
  );
  await call(
    "start-receipt",
    "original start identity can retrieve its old result",
    { ...read, claimId: claim.id },
  );
  await call(
    "start-receipt",
    "changed identity must pass current authorization",
    {
      worker: "alpha",
      session: { ...read.session, threadId: "different" },
      claimId: claim.id,
    },
    { error: true, code: "stale-queue-session" },
  );
}
