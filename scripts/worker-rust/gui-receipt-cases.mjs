import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chatMessageOpaqueContentSchema,
  nativeCommandDispatchSchema,
  nativeCommandReceiptSchema,
  nativeCommandSettlementSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../cantrip_worker/src/native-command-content.ts";

export function admit(fields, stamp) {
  const operationId = "gui:" + randomUUID();
  return nativeCommandReceiptSchema.parse({
    operationId,
    logicalOperationId: operationId,
    previousOperationId: null,
    operationGeneration: randomUUID(),
    activationGeneration: randomUUID(),
    chatId: fields.chatId,
    startsExecution: true,
    executionLaneId: fields.executionLaneId,
    status: "accepted",
    method: "turn/start",
    payloadDigest: createHash("sha256")
      .update(
        JSON.stringify(
          chatMessageOpaqueContentSchema.parse(fields.protectedPrompt),
        ),
      )
      .digest("hex"),
    rejectionCode: null,
    threadId: fields.threadId,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

export function logical(receipt, type = "chat.native-logical.complete") {
  return {
    type,
    chatId: receipt.chatId,
    rootOperationId: receipt.operationId,
    rootOperationGeneration: receipt.operationGeneration,
  };
}

// Record transactions at the worker's HTTP boundary. The first encrypted RPC
// receipt commits before the peer drops its response, just like a lost ACK.
export class GuiReceiptPeer {
  constructor(fields, receipt, { oracle, workerGeneration, workerId }) {
    this.fields = fields;
    this.receipt = receipt;
    this.oracle = oracle;
    this.workerGeneration = workerGeneration;
    this.workerId = workerId;
    this.steps = [];
  }

  async apply(action, input, response, send) {
    this.steps.push(action);
    const body = (
      action === "receipt"
        ? nativeCommandSettlementSchema
        : nativeCommandDispatchSchema
    ).parse(input);
    assert.equal(body.workerId, this.workerId);
    assert.equal(body.operationId, this.receipt.operationId);
    assert.equal(body.operationGeneration, this.receipt.operationGeneration);

    if (action === "bind-preparation" || action === "dispatch") {
      const fields = this.fields;
      const { session } = body;
      assert.equal(body.payloadDigest, this.receipt.payloadDigest);
      assert.deepEqual(session, {
        chatId: fields.chatId,
        threadId: this.receipt.threadId ?? session.threadId,
        contextKind: fields.contextKind,
        projectId: fields.policyProjectId,
        placementId: fields.worktreeId,
        runtimeGeneration: session.runtimeGeneration,
        connectionId: "gui:" + this.receipt.operationGeneration,
        modelRouteId: "fixture-route",
        providerAccountId: null,
      });
      assert.ok(session.threadId && session.runtimeGeneration);
      if (action === "bind-preparation") {
        assert.equal(this.receipt.status, "accepted");
        assert.equal(body.workerGeneration, undefined);
        this.session = session;
        this.receipt = { ...this.receipt, threadId: session.threadId };
        send({ receipt: this.receipt });
      } else {
        assert.equal(this.receipt.status, "accepted");
        assert.equal(body.workerGeneration, this.workerGeneration);
        assert.deepEqual(session, this.session);
        this.receipt = { ...this.receipt, status: "dispatched" };
        if (this.loseDispatchResponse) {
          response.destroy();
          return;
        }
        send({
          receipt: this.receipt,
          execution: null,
          computerUseAuthority: null,
        });
      }
      return;
    }

    assert.equal(action, "receipt");
    assert.equal(body.status, "applied");
    assert.equal(body.executionComplete, false);
    assert.equal(body.rejectionCode, null);
    assert.equal(
      body.reconciliation.runtimeGeneration,
      this.session.runtimeGeneration,
    );
    if (body.protectedResult) {
      assert.equal(body.reconciliation.terminalStatus, undefined);
      if (this.result) {
        assert.deepEqual(body, this.result);
      } else {
        assert.equal(this.receipt.status, "dispatched");
        const context = {
          chatId: this.receipt.chatId,
          operationId: this.receipt.operationId,
          direction: "result",
        };
        const content = await openNativeCommandContent({
          service: this.oracle,
          context,
          envelope: body.protectedResult,
        });
        assert.equal(content.turn.id, body.reconciliation.nativeTurnId);
        const expected = await protectNativeCommandContent({
          service: this.oracle,
          context,
          content,
        });
        assert.equal(body.resultDigest, expected.digest);
        this.result = body;
        this.receipt = { ...this.receipt, status: "applied" };
        response.destroy();
        return;
      }
    } else {
      assert.equal(body.resultDigest, null);
      assert.equal(
        body.reconciliation.nativeTurnId,
        this.result.reconciliation.nativeTurnId,
      );
      this.terminal = body.reconciliation;
    }
    send({ receipt: this.receipt });
  }
}
