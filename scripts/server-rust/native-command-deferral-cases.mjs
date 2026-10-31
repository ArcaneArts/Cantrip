import assert from "node:assert/strict";
import {
  retainedPrompt,
  deferredAttachment,
  promptId,
  pendingId,
} from "./native-settlement-fixtures.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";
import { settingsSnapshot } from "./native-settings-fixtures.mjs";
export async function runDeferralCases({
  seed,
  observe,
  snapshot,
  command,
  start,
  settle,
  unchanged,
  session,
}) {
  const deferred = (extra = {}) => ({
    reason: "pendingSettings",
    inputConsumed: false,
    threadId: "thread",
    runtimeGeneration: "runtime",
    retainedPrompt: retainedPrompt({ payload: command().protectedPayload }),
    attachments: [],
    ...extra,
  });
  const input = (c, i, extra = {}) =>
    c.input(i, {
      status: "rejected",
      executionComplete: true,
      deferred: deferred(),
      ...extra,
    });
  let c = await start();
  const result = await settle(
    "retain exact GUI input after native deferral",
    (i) => input(c, i),
    { status: "rejected", rejection: "native-settings-pending" },
  );
  let states = await snapshot(
    "deferred GUI input and idle execution commit together",
  );
  for (const [i, state] of states.entries()) {
    assert.equal(result[i].resumeQueue, true);
    assert.equal(state.commands[0].terminal_evidence.kind, "deferred");
    assert.equal(state.commands[0].logical_completed_at, null);
    assert.equal(state.activations[0].active, false);
    assert.equal(state.chats.find((c) => c.id === "chat").status, "idle");
    assert.equal(state.prompts[0].id, promptId);
    assert.equal(state.prompts[0].state, "pending");
    assert.deepEqual(
      state.prompts[0].opaque_content,
      retainedPrompt({ payload: command().protectedPayload }),
    );
    assert.equal(state.queues[0].revision, 1);
  }
  const again = await settle(
    "deferral replay preserves retained input",
    (i) => input(c, i),
    { status: "rejected" },
  );
  for (const [i, value] of again.entries()) assert.deepEqual(value, result[i]);
  assert.deepEqual(
    await snapshot("deferral replay no duplicate queue rows"),
    states,
  );
  const bindings = await observe(
    "publish permission source while input is deferred",
    { chat: "chat", snapshot: settingsSnapshot },
    { op: "native-command-settings-refresh", shape: "raw" },
  );
  await observe("admit permission choice blocking deferred queue", (i) =>
    command({
      operationId: "policy",
      session,
      method: "thread/settings/update",
      intent: {
        settingsBindingId: bindings[i].state.binding.bindingId,
        nativeSettingsOperationId: "native-policy",
        settingKeys: ["permissions"],
        permissionTransition: {
          selectedId: null,
          resolvedSelectedId: ":workspace",
          effectiveId: ":workspace",
          expectedRevision: "0",
        },
      },
    }),
  );
  for (const value of await settle(
    "deferral replay waits for pending permission choice",
    (i) => input(c, i),
    { status: "rejected" },
  ))
    assert.equal(value.resumeQueue, false);
  for (const outcome of ["applied", "rejected"])
    await observe(
      "conflicting permission outcome " + outcome,
      { chat: "chat", operation: "policy", outcome },
      { op: "native-command-settings-settle", shape: "raw" },
    );
  states = await snapshot(
    "terminal permission ambiguity has no pending entries",
  );
  for (const state of states) {
    assert.equal(state.settings[0].state.pending.length, 0);
    assert.equal(state.settings[0].state.desiredStatus, "uncertain");
  }
  for (const value of await settle(
    "deferral replay waits for uncertain permission choice",
    (i) => input(c, i),
    { status: "rejected" },
  ))
    assert.equal(value.resumeQueue, false);

  for (const origin of ["gui", "terminal", "autonomous"]) {
    c = await start({ origin });
    if (origin === "autonomous") {
      const value = await settle(
        "autonomous no-input deferral needs no retained GUI prompt",
        (i) =>
          input(c, i, {
            deferred: deferred({
              retainedPrompt: undefined,
              attachments: undefined,
            }),
          }),
        { status: "rejected" },
      );
      for (const receipt of value) assert.equal(receipt.resumeQueue, true);
    } else {
      await unchanged(
        origin + " deferral requires retained input",
        (i) =>
          input(c, i, {
            deferred: deferred({
              retainedPrompt: undefined,
              attachments: undefined,
            }),
          }),
        { code: "deferred-prompt-required" },
      );
      await settle(
        origin + " deferral retains encrypted input",
        (i) => input(c, i),
        { status: "rejected" },
      );
    }
    await snapshot("deferral origin " + origin);
  }
  for (const [name, extra] of [
    ["not complete", { executionComplete: false }],
    ["wrong outcome", { status: "applied" }],
    ["missing result digest", { resultDigest: null }],
    ["missing captured result", { protectedResult: null }],
    ["wrong deferred thread", { deferred: deferred({ threadId: "other" }) }],
    [
      "wrong deferred runtime",
      { deferred: deferred({ runtimeGeneration: "old" }) },
    ],
    [
      "mixed terminal result",
      { terminalResult: { resultDigest: null, protectedResult: null } },
    ],
    [
      "mixed reconciliation",
      {
        reconciliation: {
          nativeTurnId: "turn-one",
          runtimeGeneration: "runtime",
        },
      },
    ],
    [
      "mixed decline",
      {
        decline: {
          nativeTurnId: "turn-one",
          runtimeGeneration: "runtime",
          runnerGeneration: "runner",
          attemptId: "attempt",
        },
      },
    ],
  ]) {
    c = await start();
    await unchanged("deferral fence " + name, (i) => input(c, i, extra), {
      code: "stale-native-deferral",
    });
  }
  c = await start({ dispatch: false });
  await unchanged(
    "not-dispatched input cannot be deferred",
    (i) => input(c, i),
    { code: "stale-native-deferral" },
  );
  c = await start({ intent: { expectedTurnId: "proposed-turn" } });
  await unchanged(
    "deferral cannot discard an assigned turn",
    (i) => input(c, i),
    { code: "stale-native-deferral" },
  );

  const prompt = retainedPrompt({ payload: command().protectedPayload });
  const otherPayload = {
    ...command().protectedPayload,
    ciphertext: Buffer.alloc(32, 8).toString("base64url"),
  };
  for (const [name, changes] of [
    [
      "pending message identity",
      {
        pendingMessage: {
          ...prompt.pendingMessage,
          id: "456789ab-1234-4234-8234-000000000009",
        },
      },
    ],
    ["native user identity", { nativeClientUserMessageId: "other-client" }],
    [
      "pending ciphertext",
      {
        pendingMessage: {
          ...prompt.pendingMessage,
          protectedContent: {
            ...prompt.pendingMessage.protectedContent,
            envelope: otherPayload,
          },
        },
      },
    ],
    [
      "non-user pending message",
      {
        pendingMessage: {
          ...prompt.pendingMessage,
          classification: {
            ...prompt.pendingMessage.classification,
            role: "assistant",
          },
        },
      },
    ],
    ["wrong native action", { nativeAction: "plain" }],
    ["wrong execution method", { executionMethod: "thread/goal/set" }],
    ["missing native payload", { protectedNativeInput: undefined }],
  ]) {
    c = await start();
    await unchanged(
      "retained input fence " + name,
      (i) =>
        input(c, i, {
          deferred: deferred({ retainedPrompt: { ...prompt, ...changes } }),
        }),
      { code: "invalid-deferred-prompt" },
    );
  }
  const attachments = [
    deferredAttachment("attachment-one"),
    deferredAttachment("attachment-two"),
  ];
  c = await start();
  const withAttachments = retainedPrompt({
    payload: command().protectedPayload,
    attachments,
  });
  for (const bad of [
    [...attachments].reverse(),
    attachments.map((a) => ({ ...a, chatId: "other-chat" })),
  ])
    await unchanged(
      "attachment identity/scope fence " +
        JSON.stringify(bad.map((a) => [a.id, a.chatId])),
      (i) =>
        input(c, i, {
          deferred: deferred({
            retainedPrompt: withAttachments,
            attachments: bad,
          }),
        }),
      { code: "invalid-deferred-prompt" },
    );
  await settle(
    "retain encrypted attachment metadata with deferred input",
    (i) =>
      input(c, i, {
        deferred: deferred({ retainedPrompt: withAttachments, attachments }),
      }),
    { status: "rejected" },
  );
  states = await snapshot("retained attachment order and ciphertext preserved");
  for (const state of states)
    assert.deepEqual(state.prompts[0].attachments, attachments);

  const seedPrompt = async (opaque, id = promptId) =>
    seed(
      `INSERT INTO queued_prompts(id,chat_id,text,opaque_content,model_id,idempotency_key,position,created_at,updated_at) VALUES(${literal(id)},'chat',NULL,${json(opaque)},'queue-model',${literal(opaque.idempotencyKey)},0,${literal(stamp)},${literal(stamp)})`,
    );
  for (const [name, existing, code] of [
    ["exact existing queue input", prompt, null],
    [
      "same queue key different ID",
      { ...prompt, id: "456789ab-1234-4234-8234-000000000008" },
      "deferred-prompt-conflict",
    ],
    [
      "same queue ID different payload",
      { ...prompt, protectedNativeInput: otherPayload },
      "deferred-prompt-conflict",
    ],
    [
      "existing queue metadata follows Source retained-field contract",
      { ...prompt, modelId: "old-logical-model" },
      null,
    ],
  ]) {
    c = await start();
    await seedPrompt(existing, existing.id);
    if (code) await unchanged(name, (i) => input(c, i), { code });
    else {
      await settle(name, (i) => input(c, i), { status: "rejected" });
      const state = await snapshot(name);
      for (const value of state) assert.equal(value.prompts.length, 1);
    }
  }
  c = await start();
  await seed("DELETE FROM managed_queue_states WHERE chat_id='chat'");
  await settle("deferral initializes missing queue state", (i) => input(c, i), {
    status: "rejected",
  });
  states = await snapshot("missing queue state created atomically");
  for (const state of states) assert.equal(state.queues[0].revision, 1);

  c = await start();
  await observe(
    "administrative retirement before no-input proof",
    (i) => ({
      worker: "alpha",
      operation: "request",
      generation: c.admitted[i].receipt.operationGeneration,
      status: "failed",
    }),
    { op: "native-command-finish-execution", shape: "raw" },
  );
  await settle(
    "captured deferral after administrative retirement",
    (i) => input(c, i),
    { status: "rejected" },
  );
  states = await snapshot("only the retired idle attempt is corrected");
  for (const state of states)
    assert.equal(state.chats.find((c) => c.id === "chat").status, "idle");

  for (const observed of [false, true]) {
    c = await start();
    if (observed)
      await settle(
        "observe old root before retirement",
        (i) =>
          c.input(i, {
            status: "uncertain",
            resultDigest: null,
            protectedResult: null,
            rejectionCode: "missing-native-receipt",
            reconciliation: {
              nativeTurnId: "observed-turn",
              runtimeGeneration: "runtime",
            },
          }),
        { status: "uncertain" },
      );
    await observe(
      "retire old root before successor",
      (i) => ({
        worker: "alpha",
        operation: "request",
        generation: c.admitted[i].receipt.operationGeneration,
        status: "failed",
      }),
      { op: "native-command-finish-execution", shape: "raw" },
    );
    const successor = await observe(
      "admit successor after retirement",
      command({ operationId: "successor", session }),
    );
    if (observed)
      await unchanged(
        "observed native turn cannot be deferred after replacement",
        (i) => input(c, i),
        { code: "stale-native-deferral" },
      );
    else
      await settle(
        "captured old deferral preserves active successor",
        (i) => input(c, i),
        { status: "rejected" },
      );
    states = await snapshot(
      "successor remains active after late deferral observed=" + observed,
    );
    for (const [i, state] of states.entries()) {
      assert.equal(
        state.activations[0].generation,
        successor[i].receipt.activationGeneration,
      );
      assert.equal(state.activations[0].active, true);
      assert.equal(state.chats.find((c) => c.id === "chat").status, "running");
    }
  }
  for (const table of ["queued_prompts", "managed_queue_states"]) {
    c = await start();
    await seed(
      "CREATE FUNCTION fail_deferral() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'deferral fixture failure'; END$$",
    );
    await seed(
      `CREATE TRIGGER fail_deferral BEFORE ${table === "queued_prompts" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_deferral()`,
    );
    await unchanged("deferred input rollback on " + table, (i) => input(c, i), {
      sqlstate: "P0001",
    });
    await seed(`DROP TRIGGER fail_deferral ON ${table}`);
    await seed("DROP FUNCTION fail_deferral()");
  }
}
