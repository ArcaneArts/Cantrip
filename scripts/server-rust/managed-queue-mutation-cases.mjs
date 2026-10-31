import assert from "node:assert/strict";
import {
  retainedPrompt,
  deferredAttachment,
  promptId,
} from "./native-settlement-fixtures.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";
export async function runManagedQueueMutationCases(h) {
  const { seed, call, request, mutate, setup, assertUnchanged } = h;
  const prompt = (changes = {}) => retainedPrompt(changes);
  const add = (changes = {}) => ({
    kind: "add",
    prompt: prompt(changes),
    attachments: [],
  });
  const { snapshot } = h;
  const first = request(add(), {
    session: { runtimeGeneration: "old", connectionId: "old" },
    expectedActivationGeneration: "stale",
  });
  const added = await mutate(
    "add encrypted item bound to current control",
    first,
  );
  for (const r of added) {
    assert.equal(r.revision, 1);
    assert.equal(r.items.length, 1);
    assert.equal(r.acceptedItem.id, promptId);
  }
  await assertUnchanged("immutable mutation replay", () =>
    mutate("immutable mutation replay", {
      ...first,
      expectedRevision: 999,
      mutation: add({ idempotencyKey: "different-content" }),
      admission: {
        ...first.admission,
        protectedPayload: command({ payloadDigest: "b".repeat(64) })
          .protectedPayload,
      },
    }),
  );
  // Replays still enforce the original method before consulting the old receipt.
  await assertUnchanged("queue method mismatch", () =>
    mutate(
      "queue method mismatch",
      { ...first, admission: { ...first.admission, method: "skills/list" } },
      { error: true, code: "queue-method-mismatch" },
    ),
  );
  await call("lookup", "find old mutation", { content: first.admission });
  await call("gui-operation", "GUI mutation lookup", {
    operation: first.admission.operationId,
  });
  await call("gui-operation", "missing GUI mutation", { operation: "absent" });
  await call("lookup", "unknown queue mutation", {
    content: { ...first.admission, operationId: "absent" },
  });
  for (const [field, value] of [
    ["payloadDigest", "b".repeat(64)],
    ["workerId", "beta"],
  ]) {
    await assertUnchanged("conflicting prior " + field, () =>
      call(
        "lookup",
        "conflicting prior " + field,
        { content: { ...first.admission, [field]: value } },
        {
          error: true,
          code:
            field === "workerId"
              ? "stale-queue-session"
              : "operation-id-conflict",
        },
      ),
    );
  }
  await mutate(
    "stale optimistic queue revision",
    request(
      add({
        id: "456789ab-1234-4234-8234-000000000003",
        idempotencyKey: "second",
      }),
    ),
    { status: "rejected", rejection: "queue-revision-conflict" },
  );
  await mutate("duplicate queue identity", request(add(), { revision: 1 }), {
    status: "rejected",
    rejection: "queue-item-conflict",
  });
  await mutate(
    "update item and SQL model selection",
    request(
      {
        kind: "update",
        id: promptId,
        expectedItemRevision: 0,
        prompt: prompt({ modelId: "queue-model-two" }),
        attachments: [],
      },
      { revision: 1 },
    ),
  );
  await mutate(
    "stale item revision",
    request(
      { kind: "delete", id: promptId, expectedItemRevision: 0 },
      { revision: 2 },
    ),
    { status: "rejected", rejection: "queue-item-revision-conflict" },
  );
  await mutate(
    "reorder active queue",
    request({ kind: "reorder", ids: [promptId] }, { revision: 2 }),
  );
  await mutate(
    "reorder rejects duplicate identities",
    request({ kind: "reorder", ids: [promptId, promptId] }, { revision: 3 }),
    { status: "rejected", rejection: "queue-order-conflict" },
  );
  await mutate(
    "remove item without deleting its history",
    request(
      { kind: "delete", id: promptId, expectedItemRevision: 2 },
      { revision: 3 },
    ),
  );
  await mutate(
    "removed prompt cannot be started",
    request({ kind: "start", id: promptId }, { revision: 4 }),
    { status: "rejected", rejection: "queue-item-unavailable" },
  );
  for (const [name, changes, code] of [
    ["missing model", { modelId: "absent" }, "queue-model-unavailable"],
    [
      "missing subagent",
      { customSubagentModel: true, subagentModelId: "absent" },
      "queue-model-unavailable",
    ],
    [
      "foreign worktree",
      { worktreeId: "absent" },
      "queue-worktree-unavailable",
    ],
  ]) {
    await setup();
    await mutate(name, request(add(changes)), {
      status: "rejected",
      rejection: code,
    });
  }
  await setup();
  const attachment = deferredAttachment();
  await mutate(
    "missing owned attachment",
    request({
      kind: "add",
      prompt: retainedPrompt({ attachments: [attachment] }),
      attachments: [],
    }),
    { status: "rejected", rejection: "queue-attachment-unavailable" },
  );
  await seed(
    `INSERT INTO chat_attachments(id,chat_id,worker_id,protected_metadata,size_bytes,status,created_at) VALUES(${literal(attachment.id)},'chat','alpha',${json(attachment.protectedMetadata)},3,'ready',${literal(stamp)}) ON CONFLICT DO NOTHING`,
  );
  await mutate(
    "owned attachment metadata is opaque",
    request({
      kind: "add",
      prompt: retainedPrompt({ attachments: [attachment] }),
      attachments: [],
    }),
  );
  await setup();
  await mutate(
    "autonomy resume bumps queue twice",
    request(add(), { intent: { resumeAutonomy: true } }),
  );
  const current = await call("snapshot", "resumed queue revision");
  for (const r of current) assert.equal(r.revision, 2);
}
