// Uses the same protected wire contracts and live history peer as the GUI fixture.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativeCommandDispatchSchema,
  nativeCommandEventSchema,
  nativeCommandSettlementSchema,
  nativeSuspensionExecutionAdmissionSchema,
  nativeSuspensionExecutionAdmissionResultSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../tests/reference-node-worker/src/native-command-content.ts";
import { GuiReceiptPeer } from "./gui-receipt-cases.mjs";

export class RestoredSuspensionPeer extends GuiReceiptPeer {
  constructor(previous, command, workerGeneration, stamp) {
    super(previous.fields, previous.receipt, {
      workerGeneration,
      oracle: previous.oracle,
      workerId: previous.workerId,
    });
    this.previous = previous;
    this.command = command;
    this.stopping = command.type === "chat.suspension.stop";
    this.stamp = stamp;
    this.suspensionControlId = command.controlId;
    this.finished = Promise.withResolvers();
    this.events = [];
    this.admissionAttempts = 0;
  }

  async apply(action, input, response, send) {
    if (action === "suspension-execution") {
      const body = nativeSuspensionExecutionAdmissionSchema.parse(input);
      if (body.controlId !== this.command.controlId) {
        response
          .writeHead(409)
          .end(JSON.stringify({ code: "suspension-control-stale" }));
        return;
      }
      this.admissionAttempts++;
      if (this.admission) {
        assert.deepEqual(body, this.admission);
        send({ ...this.grant, replayed: true });
        return;
      }
      await this.admitRestoration(body);
      // The worker must recover the committed observer using the same sealed
      // request. A second operation would replace the provenance and fail.
      response.destroy();
      return;
    }
    if (input.operationId !== this.receipt.operationId) {
      return this.applyControl(action, input, response, send);
    }
    assert.equal(input.workerId, this.workerId);
    assert.equal(input.operationGeneration, this.receipt.operationGeneration);
    if (action === "dispatch") {
      const body = nativeCommandDispatchSchema.parse(input);
      assert.equal(this.receipt.status, "accepted");
      assert.equal(body.workerGeneration, this.workerGeneration);
      assert.deepEqual(body.session, this.session);
      assert.equal(body.payloadDigest, this.receipt.payloadDigest);
      this.receipt = { ...this.receipt, status: "dispatched" };
      send({
        receipt: this.receipt,
        execution: null,
        computerUseAuthority: null,
      });
      return;
    }
    if (action === "events") {
      assert.equal(this.rootAcknowledged, true);
      this.events.push(nativeCommandEventSchema.parse(input).event);
      send({ applied: true });
      return;
    }
    assert.equal(action, "receipt");
    const body = nativeCommandSettlementSchema.parse(input);
    assert.equal(body.status, "applied");
    assert.equal(
      body.reconciliation.runtimeGeneration,
      this.session.runtimeGeneration,
    );
    assert.equal(
      body.reconciliation.nativeTurnId,
      this.command.checkpoint.suspension.turnId,
    );
    if (!body.executionComplete) {
      assert.equal(this.receipt.status, "dispatched");
      assert.equal(body.reconciliation.terminalStatus, undefined);
      await this.checkPayload(body, "result", {
        restored: this.command.checkpoint.suspension,
      });
      this.result = body;
      this.rootAcknowledged = true;
      this.receipt = { ...this.receipt, status: "applied" };
      send({ receipt: this.receipt });
      return;
    }
    assert.equal(
      body.reconciliation.terminalStatus,
      this.stopping ? "interrupted" : "completed",
    );
    assert.equal(body.protectedResult, null);
    const outcome = await this.checkPayload(
      body.terminalResult,
      "terminal-result",
    );
    if (this.stopping) {
      assert.deepEqual(outcome, { interrupted: true });
    } else {
      assert.equal(outcome.turnId, this.command.checkpoint.suspension.turnId);
      assert.equal(outcome.threadId, this.session.threadId);
    }
    this.terminal = body.reconciliation;
    if (!this.terminalReceipt) {
      this.terminalReceipt = body;
      response.destroy();
    } else {
      assert.deepEqual(body, this.terminalReceipt);
      send({ receipt: this.receipt });
      this.finished.resolve(outcome);
    }
  }

  async checkPayload(body, direction, expected) {
    const context = {
      chatId: this.receipt.chatId,
      operationId: this.receipt.operationId,
      direction,
    };
    const content = await openNativeCommandContent({
      service: this.oracle,
      context,
      envelope: body.protectedResult,
    });
    if (expected) assert.deepEqual(content, expected);
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
    return content;
  }

  async admitRestoration(body) {
    const { command, workerGeneration, stamp } = this;
    const old = this.previous;
    const { session } = body;
    assert.equal(body.workerId, this.workerId);
    assert.equal(body.workerGeneration, workerGeneration);
    assert.notEqual(session.runtimeGeneration, old.session.runtimeGeneration);
    assert.deepEqual(session, {
      ...old.session,
      runtimeGeneration: session.runtimeGeneration,
      connectionId: `suspension:${command.controlId}:${session.runtimeGeneration}`,
    });
    assert.deepEqual(body.checkpoint, command.checkpoint);
    assert.equal(body.action, this.stopping ? "stop" : undefined);
    const context = {
      chatId: session.chatId,
      operationId: body.operationId,
      direction: "request",
    };
    const frame = {
      method: "thread/resume",
      params: {
        threadId: session.threadId,
        expectedSuspension: command.checkpoint.suspension,
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
    const source = {
      operationId: old.receipt.operationId,
      operationGeneration: old.receipt.operationGeneration,
    };
    const receipt = {
      ...old.receipt,
      operationId: body.operationId,
      operationGeneration: randomUUID(),
      previousOperationId: source.operationId,
      logicalOperationId: source.operationId,
      activationGeneration: randomUUID(),
      method: "thread/resume",
      payloadDigest: body.payloadDigest,
      status: "accepted",
    };
    const executionOwner = {
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      workerGeneration,
      runtimeGeneration: session.runtimeGeneration,
    };
    const target = {
      workerId: this.workerId,
      contextKind: session.contextKind,
      projectId: session.projectId,
      placementId: session.placementId,
      placementRevision: 1,
      cantripOsBindingId: null,
      executionLaneId: receipt.executionLaneId,
      modelRouteId: session.modelRouteId,
      providerAccountId: session.providerAccountId,
      threadId: session.threadId,
      originalOperationId: source.operationId,
    };
    this.grant = nativeSuspensionExecutionAdmissionResultSchema.parse({
      receipt,
      computerUseAuthority: null,
      replayed: false,
      source,
      logicalRoot: source,
      suspension: {
        version: 1,
        action: this.stopping ? "stop" : "resume",
        phase: this.stopping ? "stopping" : "resuming",
        controlId: command.controlId,
        target,
        active: {
          threadId: session.threadId,
          turnId: command.checkpoint.suspension.turnId,
        },
        checkpoint: command.checkpoint,
        executionOwner,
        actor: executionOwner,
        actorControlId: command.controlId,
        error: null,
        requestedAt: stamp,
        updatedAt: stamp,
        pausedAt: stamp,
        pausedMilliseconds: 0,
      },
      execution: {
        ...command.session,
        chatId: session.chatId,
        workerId: this.workerId,
        threadId: session.threadId,
        executionLaneId: receipt.executionLaneId,
        cwd: command.cwd,
        experience: "agent",
        status: "running",
        automationPaused: true,
        isPrimary: true,
        modelId: command.model.id,
        reasoningEffort: null,
        modelRouteId: session.modelRouteId,
        providerAccountId: session.providerAccountId,
        permissionProfileId: command.permissionProfileId,
        modelConfiguration: { modelId: command.model.id },
        planMode: command.planMode,
        worktreeMode: "agent-managed",
        worktreePolicy: "direct",
      },
    });
    this.receipt = this.grant.receipt;
    this.session = body.session;
    this.controlSession = body.session;
    this.admission = body;
  }
}
