import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { retainedPrompt, promptId } from "./native-settlement-fixtures.mjs";
import { otherOwner } from "./project-target-state.mjs";
export async function runGuiQueueCases(h) {
  const { setup, call, seed, assertUnchanged, report } = h;
  const add = (extra = {}) => ({
    kind: "add",
    prompt: retainedPrompt(extra),
    attachments: [],
  });
  const options = (operationId, extra = {}) => ({ operationId, ...extra });
  const invoke = (
    action,
    name,
    mutation,
    operation,
    extra = {},
    expected = {},
  ) =>
    call(
      "gui-" + action,
      "GUI queue " + name,
      { content: mutation, options: operation, ...extra },
      expected,
    );
  await setup();
  for (const action of ["mutate", "lookup"])
    await assertUnchanged("GUI empty " + action, () =>
      invoke(
        action,
        "empty " + action,
        { kind: "delete", id: promptId, expectedItemRevision: 0 },
        options("gui-empty-" + action),
        {},
        { error: true, code: "queue-item-unavailable" },
      ),
    );
  const mutation = add({ idempotencyKey: "GUI-😀-é" });
  const first = await invoke(
    "mutate",
    "add with original JSON digest",
    mutation,
    options("gui-add"),
  );
  for (const value of first) {
    assert.equal(value.receipt.status, "applied");
    assert.equal(value.revision, 2);
  }
  for (const state of report.snapshots.at(-1).values) {
    const command = state.commands.find((c) => c.operation_id === "gui-add");
    assert.equal(
      command.payload_digest,
      createHash("sha256").update(JSON.stringify(mutation)).digest("hex"),
    );
    assert.equal(command.intent.resumeAutonomy, true);
    assert.equal(command.identity.runtimeGeneration, null);
    assert.equal(command.identity.connectionId, null);
    assert.deepEqual(
      command.protected_payload,
      mutation.prompt.protectedContent.envelope,
    );
  }
  await assertUnchanged("GUI add replay", () =>
    invoke("mutate", "immutable add replay", mutation, options("gui-add")),
  );
  const found = await invoke(
    "lookup",
    "lookup prior add",
    mutation,
    options("gui-add"),
  );
  for (const value of found) assert.equal(value.found, true);
  const absent = await invoke(
    "lookup",
    "lookup unknown add",
    mutation,
    options("gui-unknown"),
  );
  assert.deepEqual(absent, [null, null]);
  await assertUnchanged("GUI digest identity conflict", () =>
    invoke(
      "lookup",
      "conflicting digest",
      mutation,
      options("gui-add", { payloadDigest: "f".repeat(64) }),
      {},
      { error: true, code: "operation-id-conflict" },
    ),
  );
  const update = {
    kind: "update",
    id: promptId,
    expectedItemRevision: 0,
    prompt: retainedPrompt({ modelId: "queue-model-two" }),
    attachments: [],
  };
  await invoke(
    "mutate",
    "explicit optimistic revision rejects durably",
    update,
    options("gui-revision-rejected", { expectedRevision: 999 }),
    {},
    { error: true, code: "queue-revision-conflict" },
  );
  for (const state of report.snapshots.at(-1).values)
    assert.equal(
      state.commands.find((c) => c.operation_id === "gui-revision-rejected")
        .status,
      "rejected",
    );
  await invoke(
    "lookup",
    "lookup retains typed rejection",
    update,
    options("gui-revision-rejected"),
    {},
    { error: true, code: "queue-revision-conflict" },
  );
  const updated = await invoke(
    "mutate",
    "update with explicit digest",
    update,
    options("gui-update", {
      expectedRevision: 2,
      payloadDigest: "e".repeat(64),
    }),
  );
  for (const state of report.snapshots.at(-1).values) {
    const command = state.commands.find((c) => c.operation_id === "gui-update");
    assert.equal(command.payload_digest, "e".repeat(64));
    assert.equal(Object.hasOwn(command.intent, "resumeAutonomy"), false);
  }
  const remove = {
    kind: "delete",
    id: promptId,
    expectedItemRevision: updated[0].items.find((item) => item.id === promptId)
      .revision,
  };
  await invoke(
    "mutate",
    "delete resolves stored protected input",
    remove,
    options("gui-delete"),
  );
  const removed = await invoke(
    "lookup",
    "deleted item supports immutable lookup",
    remove,
    options("gui-delete"),
  );
  for (const value of removed) assert.equal(value.found, true);
  const reordered = await invoke(
    "lookup",
    "reorder uses retained first id",
    { kind: "reorder", ids: [promptId] },
    options("gui-reorder-unknown"),
  );
  assert.deepEqual(reordered, [null, null]);

  await setup();
  const captured = await call("gui-context", "GUI captured context");
  await seed(
    "UPDATE chats SET managed_input_revision=managed_input_revision+1 WHERE id='chat'",
  );
  await invoke(
    "mutate",
    "fresh context after administrative revision",
    add(),
    options("gui-after-admin"),
  );
  // Use the actual earlier context, as a GUI request that was prepared before
  // the administrative input revision advanced would do.
  await invoke(
    "mutate",
    "stale captured input revision",
    add({
      id: "456789ab-1234-4234-8234-000000000003",
      idempotencyKey: "stale-gui",
    }),
    options("gui-stale-input"),
    { context: captured[0] },
    { error: true, code: "cancelled-before-admission" },
  );
  for (const state of report.snapshots.at(-1).values)
    assert.equal(
      state.commands.find((c) => c.operation_id === "gui-stale-input").status,
      "rejected",
    );

  await setup();
  await assertUnchanged("GUI foreign owner cannot reuse context", () =>
    invoke(
      "mutate",
      "tenant isolation",
      add(),
      options("gui-foreign"),
      { context: captured[0] },
      {
        requestOwner: otherOwner,
        error: true,
        code: "managed-session-ineligible",
      },
    ),
  );
  await assertUnchanged("GUI stale worker cannot mutate", () =>
    invoke(
      "mutate",
      "stale worker",
      add(),
      options("gui-stale-worker"),
      { context: { ...captured[0], workerId: "beta" } },
      { error: true, code: "stale-queue-session" },
    ),
  );
  for (const chat of ["task", h.standalone])
    await assertUnchanged("GUI ineligible context " + chat, () =>
      invoke(
        "mutate",
        "ineligible " + chat,
        add(),
        options("gui-ineligible-" + chat),
        { chat },
        { error: true, code: "managed-session-ineligible" },
      ),
    );
  await setup();
}
