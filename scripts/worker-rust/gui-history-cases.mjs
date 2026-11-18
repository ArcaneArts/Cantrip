import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  nativeHistoryBindingOpenSchema,
  nativeHistoryIngestSchema,
  nativeHistoryResolveSchema,
} from "../../packages/protocol/dist/index.js";
import { nativeHistoryPayloadDigest } from "../../tests/reference-node-server/src/db/repository/native-history-digest.ts";
import { openNativeHistoryItemEvidence } from "../../cantrip_worker/src/native-history-item-content.ts";
import { NativeHistorySourceJournal } from "../../cantrip_worker/src/native-history-source-journal.ts";

// The local peer reserves stable IDs and returns exact commit receipts. The
// running worker owns the actual native capture, encryption, and projection.
export class GuiHistoryPeer {
  constructor({ fields, receipt, workerId, stamp, oracle }) {
    this.fields = fields;
    this.receipt = receipt;
    this.workerId = workerId;
    this.stamp = stamp;
    this.oracle = oracle;
    this.identities = new Map();
    this.commits = new Map();
    this.changed = new Set();
  }

  identity(identity) {
    const key = nativeHistoryPayloadDigest([
      "native-history-item-v1",
      this.fields.chatId,
      identity,
    ]);
    return this.identities.get(key);
  }

  async apply(endpoint, input, response, send) {
    assert.equal(input.workerId, this.workerId);
    assert.equal(input.chatId, this.fields.chatId);
    if (endpoint === "open") {
      const { provenance, threadId } =
        nativeHistoryBindingOpenSchema.parse(input);
      if (!this.binding) {
        assert.deepEqual(provenance, {
          kind: "command",
          operationId: this.receipt.operationId,
          operationGeneration: this.receipt.operationGeneration,
        });
        this.binding = {
          id: randomUUID(),
          chatId: input.chatId,
          workerId: this.workerId,
          threadId,
          projectId: this.fields.policyProjectId,
          worktreeId: this.fields.worktreeId,
          modelRouteId: "fixture-route",
          providerAccountId: null,
          createdFromOperationId: this.receipt.operationId,
          createdAt: this.stamp,
        };
      }
      assert.equal(this.binding.threadId, threadId);
      if (provenance.kind === "binding")
        assert.equal(provenance.bindingId, this.binding.id);
      send({ binding: this.binding });
      return;
    }
    assert.equal(input.bindingId, this.binding.id);
    if (endpoint.startsWith("archive")) {
      const field = {
        archive: "items",
        "archive-turns": "turns",
        "archive-batches": "batches",
      }[endpoint];
      assert.ok(field);
      send({
        binding: this.binding,
        snapshotId: "0".repeat(64),
        [field]: [],
        nextCursor: null,
      });
      return;
    }
    if (endpoint === "resolve") {
      const body = nativeHistoryResolveSchema.parse(input);
      if (
        this.holdResolution &&
        body.items.some(
          ({ identity }) =>
            identity.component === "assistant" &&
            identity.turnId !== this.holdResolution.previousTurn,
        )
      ) {
        this.holdResolution.arrived();
        await this.holdResolution.release;
      }
      const items = body.items.map(({ identity, association }) => {
        const key = nativeHistoryPayloadDigest([
          "native-history-item-v1",
          input.chatId,
          identity,
        ]);
        const existing = this.identities.get(key);
        if (existing) return existing;
        assert.equal(identity.threadId, this.binding.threadId);
        const preservedInput =
          association.kind === "observed-input" &&
          association.clientUserMessageId ===
            "cantrip:" + this.fields.protectedPrompt.id
            ? this.fields.protectedPrompt
            : null;
        const mapping = {
          key,
          identity,
          preservedInput,
          messageId: preservedInput?.id ?? randomUUID(),
          idempotencyKey:
            preservedInput?.idempotencyKey ?? "native-history:" + key,
        };
        this.identities.set(key, mapping);
        return mapping;
      });
      send({ items });
      return;
    }
    assert.equal(endpoint, "ingest");
    const body = nativeHistoryIngestSchema.parse(input);
    const key = body.streamId + ":" + body.sequence;
    let commit = this.commits.get(key);
    if (!commit) {
      const previous = this.commits.get(
        body.streamId + ":" + (body.sequence - 1),
      );
      assert.equal(body.previousDigest, previous?.body.digest ?? null);
      const { streamId, sequence, recordId, digest } = body;
      commit = {
        body,
        receipt: {
          committed: true,
          streamId,
          sequence,
          recordId,
          digest,
          commitId: randomUUID(),
        },
      };
      this.commits.set(key, commit);
      if (this.commits.size === 1) {
        response.destroy();
        return;
      }
    } else {
      assert.deepEqual(body, commit.body);
      this.replayed = true;
    }
    commit.acknowledged = true;
    for (const wake of this.changed) wake();
    send(commit.receipt);
  }

  async verify(turnId, output, privateValues) {
    const committed = () =>
      [...this.commits.values()].flatMap((entry) =>
        entry.acknowledged ? entry.body.batch.items : [],
      );
    let item;
    let wake;
    try {
      for (;;) {
        const items = committed();
        item = items.find(
          (item) =>
            item.identity.turnId === turnId &&
            item.identity.component === "assistant" &&
            item.state === "completed",
        );
        if (item && this.replayed) break;
        await new Promise((resolve) => {
          if (wake) this.changed.delete(wake);
          wake = resolve;
          this.changed.add(wake);
        });
      }
    } finally {
      this.changed.delete(wake);
    }
    assert.equal(item.message.id, output.id);
    assert.equal(item.message.idempotencyKey, output.idempotencyKey);
    assert.equal(item.message.classification.mode, output.classification.mode);
    assert.ok(
      committed().some(
        (entry) =>
          entry.identity.turnId === turnId &&
          entry.identity.component === "user" &&
          entry.message.id === this.fields.protectedPrompt.id,
      ),
      "History retains the original protected GUI input identity.",
    );
    const source = await openNativeHistoryItemEvidence({
      binding: this.binding,
      service: this.oracle,
      identity: item.identity,
      evidence: item.evidence,
    });
    assert.equal(source.body.type, "agentMessage");
    for (const value of privateValues) {
      assert.ok(!JSON.stringify([...this.commits.values()]).includes(value));
    }
    return source.body.text;
  }

  async verifyLocalSource(directory, turnId) {
    const journal = await NativeHistorySourceJournal.open({
      directory: path.join(directory, "native-history-sources"),
      workerId: this.workerId,
      chatId: this.binding.chatId,
      threadId: this.binding.threadId,
      bindingId: this.binding.id,
      service: this.oracle,
    });
    const records = await journal.read();
    assert.ok(
      records.some(
        ({ frame }) =>
          frame.kind === "notification" &&
          frame.method === "turn/completed" &&
          frame.params.turn.id === turnId,
      ),
      "The Node reader reopened the Rust worker's terminal source evidence.",
    );
  }
}
