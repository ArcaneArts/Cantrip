import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chatMessageOpaqueContentSchema,
  nativeCommandAdmissionSchema,
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
    this.controls = new Map();
  }

  async apply(action, input, response, send) {
    if (input.operationId !== this.receipt.operationId) {
      await this.applyControl(action, input, response, send);
      return;
    }
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
        await this.holdRootAcknowledgment;
        this.rootAcknowledged = true;
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

  async applyControl(action, input, response, send) {
    assert.equal(input.workerId, this.workerId);
    if (action === "admit") {
      const body = nativeCommandAdmissionSchema.parse(input);
      assert.equal(this.rootAcknowledged, true);
      assert.equal(this.controls.has(body.operationId), false);
      assert.equal(body.method, "turn/interrupt");
      assert.equal(body.origin, "gui");
      assert.equal(
        body.expectedActivationGeneration,
        this.receipt.activationGeneration,
      );
      assert.deepEqual(body.session, {
        ...this.session,
        connectionId: "gui-control:" + this.session.runtimeGeneration,
      });
      assert.deepEqual(body.intent, {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: this.result.reconciliation.nativeTurnId,
        permissionProfileId: this.fields.permissionProfileId ?? ":read-only",
        pathsWithinPlacement: true,
      });
      const context = {
        chatId: this.receipt.chatId,
        operationId: body.operationId,
        direction: "request",
      };
      const frame = {
        id: body.operationId,
        method: "turn/interrupt",
        params: {
          threadId: this.session.threadId,
          turnId: body.intent.expectedTurnId,
        },
      };
      assert.deepEqual(
        await openNativeCommandContent({
          service: this.oracle,
          context,
          envelope: body.protectedPayload,
        }),
        frame,
      );
      assert.equal(
        (
          await protectNativeCommandContent({
            service: this.oracle,
            context,
            content: frame,
          })
        ).digest,
        body.payloadDigest,
      );
      const receipt = nativeCommandReceiptSchema.parse({
        ...this.receipt,
        operationId: body.operationId,
        operationGeneration: randomUUID(),
        logicalOperationId: null,
        payloadDigest: body.payloadDigest,
        startsExecution: false,
        method: "turn/interrupt",
        status: "accepted",
      });
      this.controls.set(body.operationId, {
        receipt,
        session: body.session,
        steps: [action],
      });
      send({ receipt, execution: null, computerUseAuthority: null });
      return;
    }
    const control = this.controls.get(input.operationId);
    assert.ok(control);
    const { receipt } = control;
    assert.equal(input.operationGeneration, receipt.operationGeneration);
    control.steps.push(action);
    if (action === "dispatch") {
      const body = nativeCommandDispatchSchema.parse(input);
      assert.deepEqual(body.session, control.session);
      assert.equal(body.payloadDigest, receipt.payloadDigest);
      assert.equal(body.workerGeneration, this.workerGeneration);
      assert.equal(receipt.status, "accepted");
      receipt.status = "dispatched";
      const lost = this.loseNextControlDispatch;
      this.loseNextControlDispatch = false;
      if (lost) {
        control.dispatchLost = true;
        response.destroy();
      } else {
        send({ receipt, execution: null, computerUseAuthority: null });
      }
      return;
    }

    assert.equal(action, "receipt");
    const body = nativeCommandSettlementSchema.parse(input);
    assert.equal(body.executionComplete, false);
    assert.equal(body.reconciliation, undefined);
    if (control.settlement) {
      assert.deepEqual(body, control.settlement);
      send({ receipt });
      return;
    }
    const context = {
      chatId: receipt.chatId,
      operationId: receipt.operationId,
      direction: "result",
    };
    const content = await openNativeCommandContent({
      service: this.oracle,
      context,
      envelope: body.protectedResult,
    });
    assert.equal(
      (
        await protectNativeCommandContent({
          service: this.oracle,
          context,
          content,
        })
      ).digest,
      body.resultDigest,
    );
    if (control.dispatchLost) {
      assert.equal(body.status, "rejected");
      assert.equal(body.rejectionCode, "native-request-rejected");
      assert.deepEqual(content, {
        error: { code: -32000, message: "Native dispatch did not complete." },
      });
    } else {
      assert.equal(body.status, "applied");
      assert.equal(body.rejectionCode, null);
      assert.deepEqual(content, { result: {} });
    }
    control.settlement = body;
    receipt.status = body.status;
    if (body.status === "applied") response.destroy();
    else send({ receipt });
  }
}
