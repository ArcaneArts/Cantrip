// Independent databases allocate distinct queue claims. Verify the exact
// production hash and its immutable input before comparing those identities.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export function outcomeQueueAdmissions(value, expected) {
  const admissions = value.result.snapshots.flatMap(
    (s) => s.queueAdmissions ?? [],
  );
  assert.equal(admissions.length, 1, "actual retained queue admission");
  return admissions.map(({ claim, input }) => {
    assert.equal(claim.chat_id, expected.chatId);
    assert.equal(claim.prompt_id, expected.promptId);
    assert.deepEqual(
      input.pendingMessage,
      expected.pendingMessage,
      "admission retains exact protected input",
    );
    const operationId =
      "gui:" +
      createHash("sha256")
        .update(
          JSON.stringify([
            expected.ownerId,
            claim.chat_id,
            input.pendingMessage.idempotencyKey,
            claim.id,
          ]),
        )
        .digest("hex");
    assert.equal(
      claim.operation_id,
      operationId,
      "durable queue operation hashes actual claim and protected input",
    );
    const command = value.commands.find(
      (c) =>
        c.command.type === "chat.turn" &&
        c.command.clientMessageId === input.pendingMessage.id,
    )?.command;
    assert.ok(command, "actual queued worker turn");
    assert.equal(command.nativeCommandReceipt.operationId, operationId);
    assert.equal(command.nativeCommandReceipt.logicalOperationId, operationId);
    assert.equal(
      command.nativeCommandReceipt.operationGeneration,
      claim.operation_generation,
    );
    return { claimId: claim.id, operationId };
  });
}
