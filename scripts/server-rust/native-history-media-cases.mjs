import assert from "node:assert/strict";
import { nativeHistoryIngestSchema } from "../../packages/protocol/dist/index.js";
import {
  retainedPrompt,
  deferredAttachment,
} from "./native-settlement-fixtures.mjs";
import { literal } from "./project-target-state.mjs";

export async function runHistoryMediaCases(h) {
  const { call, seed, snapshot, unchanged, roots, commandBindings, pair } = h;
  const original = retainedPrompt().pendingMessage,
    envelope = original.protectedContent.envelope;
  const resolve = (name, bindings, thread, identity, worker = "alpha") =>
    call(name, (i) => ({
      op: "native-history-resolve",
      input: {
        workerId: worker,
        chatId: "chat",
        bindingId: bindings[i].id,
        items: [
          {
            identity: { threadId: thread, ...identity },
            association: { kind: "existing" },
          },
        ],
      },
    }));
  let record = 0;
  const factory = (bindings, streamId, sequence, items, worker = "alpha") => {
    const recordId =
      "dddddddd-2222-4222-8222-" + (++record).toString().padStart(12, "0");
    return (i) =>
      nativeHistoryIngestSchema.parse({
        workerId: worker,
        chatId: "chat",
        bindingId: bindings[i].id,
        streamId,
        recordId,
        sequence,
        digest: sequence.toString(16).padStart(64, "0"),
        previousDigest:
          sequence === 1 ? null : (sequence - 1).toString(16).padStart(64, "0"),
        batch: { items: items(i), turns: [] },
      });
  };
  const ingest = (name, request, error) =>
    call(
      name,
      (i) => ({ op: "native-history-ingest", input: request(i) }),
      error,
    );
  const planIdentity = {
    turnId: "native-turn",
    itemId: "gui-output",
    component: "assistant",
    identityKind: "canonical",
  };
  const plan = await resolve(
    "recover provisional live output before canonical Plan commit",
    commandBindings,
    "command-thread",
    planIdentity,
  );
  const planItem = (i, evidence) => ({
    identity: { threadId: "command-thread", ...planIdentity },
    revision: 1,
    expectedRevision: 0,
    state: "completed",
    order: { turn: 0, item: 0, component: 0 },
    message: {
      ...original,
      id: plan[i][0].messageId,
      idempotencyKey: plan[i][0].idempotencyKey,
      classification: { role: "assistant", mode: "plan", attachmentIds: [] },
      protectedContent: {
        ...original.protectedContent,
        envelope: {
          ...envelope,
          ciphertext: Buffer.alloc(32, 7).toString("base64url"),
        },
      },
    },
    attachments: [],
    ...(evidence
      ? {
          evidence: {
            version: 1,
            bindingId: commandBindings[i].id,
            workerId: "alpha",
            revision: 1,
            content: envelope,
          },
        }
      : {}),
  });
  const planStream = "cccccccd-1111-4111-8111-111111111111";
  await unchanged("provisional Plan recovery requires protected evidence", () =>
    ingest(
      "bare mode retag is rejected",
      factory(commandBindings, planStream, 1, (i) => [planItem(i, false)]),
      "item-canonical-message-conflict",
    ),
  );
  await ingest(
    "native evidence replaces provisional Plan classification and ciphertext together",
    factory(commandBindings, planStream, 1, (i) => [planItem(i, true)]),
  );
  for (const [i, r] of pair.entries()) {
    const q = await r.request({
      op: "query-json",
      sql: `SELECT jsonb_build_object('mode',mode,'body',protected_content) result FROM chat_messages WHERE id=${literal(plan[i][0].messageId)}`,
    });
    assert.equal(q.rejected, false, q.diagnostic);
    assert.equal(q.value.mode, "plan");
    assert.deepEqual(q.value.body, planItem(i, true).message.protectedContent);
  }
  const mediaBindings = await call(
    "bind encrypted attachment history",
    (i) => ({
      op: "native-history-binding-open",
      input: {
        workerId: "alpha",
        chatId: "chat",
        threadId: "media-thread",
        provenance: { kind: "child", parentBindingId: roots[i].id },
      },
    }),
  );
  const identity = {
    threadId: "media-thread",
    turnId: "media-turn",
    itemId: "media-input",
    component: "user",
    identityKind: "canonical",
  };
  const media = await call("reserve media transcript identity", (i) => ({
    op: "native-history-resolve",
    input: {
      workerId: "alpha",
      chatId: "chat",
      bindingId: mediaBindings[i].id,
      items: [{ identity, association: { kind: "native" } }],
    },
  }));
  const descriptor = deferredAttachment("canonical-history-media");
  const mediaItem = (
    i,
    bindings,
    worker,
    revision,
    status = "ready",
    size = 3,
  ) => ({
    identity,
    revision,
    expectedRevision: revision - 1,
    state: "completed",
    order: { turn: 0, item: 0, component: 0 },
    message: {
      ...original,
      id: media[i][0].messageId,
      idempotencyKey: media[i][0].idempotencyKey,
      classification: {
        ...original.classification,
        attachmentIds: [descriptor.id],
      },
    },
    attachments: [{ ...descriptor, status, sizeBytes: size }],
    evidence: {
      version: 1,
      bindingId: bindings[i].id,
      workerId: worker,
      revision,
      content: envelope,
    },
  });
  const stream = "eeeeeeee-1111-4111-8111-111111111111";
  await ingest(
    "failed media placeholder is retained with canonical content",
    factory(mediaBindings, stream, 1, (i) => [
      mediaItem(i, mediaBindings, "alpha", 1, "failed"),
    ]),
  );
  let state = await snapshot("failed attachment has no invented file replica");
  for (const s of state) {
    assert.equal(
      s.attachments.find((a) => a.id === descriptor.id).status,
      "failed",
    );
    assert.equal(
      (s.replicas ?? []).some((a) => a.attachment_id === descriptor.id),
      false,
    );
  }
  await ingest(
    "retained protected bytes recover failed media",
    factory(mediaBindings, stream, 2, (i) => [
      mediaItem(i, mediaBindings, "alpha", 2),
    ]),
  );
  state = await snapshot(
    "actual recovery improves status and records owning replica",
  );
  for (const s of state) {
    assert.equal(
      s.attachments.find((a) => a.id === descriptor.id).status,
      "ready",
    );
    assert.deepEqual(
      s.replicas
        .filter((r) => r.attachment_id === descriptor.id)
        .map((r) => r.worker_id),
      ["alpha"],
    );
  }
  await seed([
    "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='chat'",
    "UPDATE chat_runtime_sessions SET codex_thread_id='media-thread' WHERE id='history-reader-runtime'",
  ]);
  const beta = await call("new worker binds retained media history", {
    op: "native-history-binding-open",
    input: {
      workerId: "beta",
      chatId: "chat",
      threadId: "media-thread",
      provenance: { kind: "current" },
    },
  });
  await seed([
    "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-main' WHERE id='chat'",
    "UPDATE chat_runtime_sessions SET codex_thread_id='command-thread' WHERE id='history-reader-runtime'",
  ]);
  await ingest(
    "historical worker retains exact metadata and adds its own replica",
    factory(
      beta,
      "eeeeeeee-2222-4222-8222-222222222222",
      1,
      (i) => [mediaItem(i, beta, "beta", 3)],
      "beta",
    ),
  );
  state = await snapshot(
    "worker migration preserves original media owner and placement",
  );
  for (const s of state) {
    assert.equal(
      s.attachments.find((a) => a.id === descriptor.id).worker_id,
      "alpha",
    );
    assert.deepEqual(
      s.replicas
        .filter((r) => r.attachment_id === descriptor.id)
        .map((r) => r.worker_id),
      ["alpha", "beta"],
    );
    assert.equal(
      s.messages.find((m) => m.attachment_ids.includes(descriptor.id))
        .worktree_id,
      "github-alpha-main",
    );
  }
  await unchanged(
    "conflicting ready media rolls back the canonical batch",
    () =>
      ingest(
        "ready bytes cannot silently change size",
        factory(mediaBindings, stream, 3, (i) => [
          mediaItem(i, mediaBindings, "alpha", 4, "ready", 4),
        ]),
        "attachment-content-conflict",
      ),
  );
  await ingest(
    "late failed media observation cannot downgrade ready replicas",
    factory(mediaBindings, stream, 3, (i) => [
      mediaItem(i, mediaBindings, "alpha", 4, "failed"),
    ]),
  );
  state = await snapshot("ready metadata and replicas remain monotonic");
  for (const s of state) {
    assert.equal(
      s.attachments.find((a) => a.id === descriptor.id).status,
      "ready",
    );
    assert.equal(
      s.attachments.find((a) => a.id === descriptor.id).size_bytes,
      3,
    );
    assert.deepEqual(
      s.replicas
        .filter((r) => r.attachment_id === descriptor.id)
        .map((r) => r.status),
      ["ready", "ready"],
    );
  }
}
