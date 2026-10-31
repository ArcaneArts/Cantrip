import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { literal, stamp } from "./project-target-state.mjs";
export async function runManagedQueueImportCases(h) {
  const {
    call,
    setup,
    seed,
    owner,
    assertUnchanged,
    managedQueueImportSchema,
    managedQueueImportAckSchema,
  } = h;
  const session = { ...h.read.session, threadId: "thread" };
  async function prepare() {
    await setup();
    await seed(
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('queue-import-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    );
  }
  const item = (changes = {}) => ({
    nativeItemId: "native-item",
    sourceDigest: "a".repeat(64),
    protectedSource: retainedPrompt().protectedNativeInput,
    prompt: retainedPrompt(),
    attachments: [],
    ...changes,
  });
  const input = (changes = {}) =>
    managedQueueImportSchema.parse({
      workerId: "alpha",
      session,
      runnerGeneration: "runner-one",
      items: [item()],
      ...changes,
    });
  const ack = (id, changes = {}) =>
    managedQueueImportAckSchema.parse({
      workerId: "alpha",
      session,
      runnerGeneration: "runner-one",
      importId: id,
      sourceDigest: "a".repeat(64),
      receipt: { deleted: false, conflict: false },
      ...changes,
    });
  await prepare();
  await assertUnchanged("native import requires retained native input", () =>
    call(
      "import",
      "native import requires retained native input",
      {
        content: input({
          items: [
            item({
              prompt: retainedPrompt({ protectedNativeInput: undefined }),
            }),
          ],
        }),
      },
      { error: true, code: "native-queue-input-required" },
    ),
  );
  await assertUnchanged("import rolls back durable admission rejection", () =>
    call(
      "import",
      "import rolls back durable admission rejection",
      {
        content: input({
          items: [item({ prompt: retainedPrompt({ modelId: "absent" }) })],
        }),
      },
      { error: true, code: "queue-model-unavailable" },
    ),
  );
  await assertUnchanged("import batch is atomic", () =>
    call(
      "import",
      "import batch is atomic",
      {
        content: input({
          items: [
            item(),
            item({
              nativeItemId: "second",
              sourceDigest: "b".repeat(64),
              prompt: retainedPrompt({
                id: "456789ab-1234-4234-8234-000000000003",
                idempotencyKey: "second",
                modelId: "absent",
              }),
            }),
          ],
        }),
      },
      { error: true, code: "queue-model-unavailable" },
    ),
  );
  const original = input(),
    created = await call(
      "import",
      "retain one canonical native queue snapshot",
      { content: original },
    );
  const sourceKey = createHash("sha256")
    .update(
      JSON.stringify([
        owner,
        original.workerId,
        { ...original.session, runtimeGeneration: null, connectionId: null },
        original.items[0].nativeItemId,
      ]),
    )
    .digest("hex");
  const importId = createHash("sha256")
    .update(JSON.stringify([sourceKey, original.items[0].sourceDigest]))
    .digest("hex");
  for (const r of created) {
    assert.equal(r.imports[0].importId, importId);
    assert.equal(
      r.imports[0].nativeDeleteOperationId,
      "queue-delete:" + importId,
    );
    assert.equal(r.items.length, 0);
    assert.equal(r.pendingImports.length, 1);
    assert.equal(r.pendingImports[0].prompt.state, "importing");
  }
  await assertUnchanged("duplicate native import reuses retained state", () =>
    call("import", "duplicate native import reuses retained state", {
      content: original,
    }),
  );
  await assertUnchanged("changed source needs conflict acknowledgment", () =>
    call(
      "import",
      "changed source needs conflict acknowledgment",
      { content: input({ items: [item({ sourceDigest: "b".repeat(64) })] }) },
      { error: true, code: "queue-import-conflict" },
    ),
  );
  for (const [name, changes] of [
    ["runner", { runnerGeneration: "old" }],
    ["digest", { sourceDigest: "b".repeat(64) }],
    ["connection", { session: { ...session, connectionId: "changed" } }],
  ])
    await assertUnchanged("stale import " + name, () =>
      call(
        "ack-import",
        "stale import " + name,
        { content: ack(importId, changes) },
        { error: true, code: "stale-queue-import" },
      ),
    );
  const uncertain = await call("ack-import", "native removal is uncertain", {
    content: ack(importId),
  });
  for (const r of uncertain) {
    assert.equal(r.pendingImports[0].status, "uncertain");
    assert.equal(r.items.length, 0);
  }
  await assertUnchanged("duplicate uncertain acknowledgment", () =>
    call("ack-import", "duplicate uncertain acknowledgment", {
      content: ack(importId),
    }),
  );
  await call("import", "new runner refreshes outstanding import", {
    content: input({ runnerGeneration: "runner-two", items: [] }),
  });
  await assertUnchanged("old runner cannot acknowledge refreshed import", () =>
    call(
      "ack-import",
      "old runner cannot acknowledge refreshed import",
      { content: ack(importId) },
      { error: true, code: "stale-queue-import" },
    ),
  );
  await call("ack-import", "native removal conflict is retained", {
    content: ack(importId, {
      runnerGeneration: "runner-two",
      receipt: { deleted: true, conflict: true },
    }),
  });
  const replacement = input({
    runnerGeneration: "runner-two",
    items: [
      item({
        sourceDigest: "b".repeat(64),
        prompt: retainedPrompt({
          id: "456789ab-1234-4234-8234-000000000003",
          idempotencyKey: "replacement",
        }),
      }),
    ],
  });
  const replaced = await call(
    "import",
    "replace conflicted native snapshot in its original position",
    { content: replacement },
  );
  const nextId = replaced[0].imports[0].importId;
  for (const r of replaced) {
    assert.equal(r.pendingImports.length, 1);
    assert.equal(r.pendingImports[0].prompt.position, 0);
    assert.equal(r.pendingImports[0].prompt.id, replacement.items[0].prompt.id);
  }
  const completed = ack(nextId, {
    runnerGeneration: "runner-two",
    sourceDigest: "b".repeat(64),
    receipt: { deleted: true, conflict: false },
  });
  const ready = await call(
    "ack-import",
    "exact native removal releases canonical input",
    { content: completed },
  );
  for (const r of ready) {
    assert.equal(r.pendingImports.length, 0);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].state, "pending");
  }
  await assertUnchanged("successful native import is terminal", () =>
    call("ack-import", "successful native import is terminal", {
      content: { ...completed, receipt: { deleted: false, conflict: true } },
    }),
  );
  const replay = await call(
    "import",
    "completed import returns its durable receipt",
    { content: replacement },
  );
  for (const r of replay) assert.equal(r.imports[0].status, "imported");
  await h.reopen("native queue imports and acknowledgment survive restart");
  await call("read", "read imported canonical queue after restart", {
    worker: "alpha",
    session,
  });
}
