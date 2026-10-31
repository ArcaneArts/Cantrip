import assert from "node:assert/strict";
import { nativeHistoryPayloadDigest } from "../../cantrip_server/src/db/repository/native-history-digest.ts";
import { protectedEventId } from "../../cantrip_server/src/db/repository/native-history-output-alias.ts";
import {
  retainedPrompt,
  deferredAttachment,
} from "./native-settlement-fixtures.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";

export async function runHistoryItemCases(h) {
  const {
    call,
    seed,
    snapshot,
    unchanged,
    binding,
    request,
    roots,
    children,
    admitted,
    commandBindings,
    owner,
  } = h;
  for (const [index, input] of [
    null,
    [],
    {},
    true,
    false,
    1e-7,
    1e21,
    9007199254740991,
    { z: 1, a: 2, 10: "ten", 2: "two" },
    { "\ue000": 1, "😀": 2, "\ud800": "\udfff" },
    { array: [{ b: 2, a: 1 }, null, [], true], empty: {} },
  ].entries()) {
    const digests = await call("stable history payload digest " + index, {
      op: "native-history-digest",
      input,
    });
    for (const d of digests) assert.equal(d, nativeHistoryPayloadDigest(input));
  }
  const identity = (
    threadId = "root",
    turnId = "turn",
    itemId = "item",
    component = "user",
    identityKind = "canonical",
  ) => ({ threadId, turnId, itemId, component, identityKind });
  const item = (identity, association = { kind: "native" }) => ({
    identity,
    association,
  });
  const resolve = (
    name,
    items,
    error,
    bindings = roots,
    worker = "alpha",
    status = 409,
  ) =>
    call(
      name,
      (i) => ({
        op: "native-history-resolve",
        input: {
          workerId: worker,
          chatId: "chat",
          bindingId: bindings[i].id,
          items: typeof items === "function" ? items(i) : items,
        },
      }),
      error,
      status,
    );
  await unchanged("empty reservation does not advance history", () =>
    resolve("empty item list", []),
  );
  await unchanged(
    "reservation failures roll back all prior items",
    async () => {
      await resolve(
        "missing reserved identity",
        [item(identity(), { kind: "existing" })],
        "item-not-reserved",
        roots,
        "alpha",
        404,
      );
      await resolve(
        "wrong item thread",
        [item(identity("wrong"))],
        "item-thread-mismatch",
      );
      await resolve(
        "late wrong thread rolls back first reservation",
        [item(identity()), item(identity("wrong"))],
        "item-thread-mismatch",
      );
      await resolve(
        "observed non-user input",
        [
          item(identity("root", "t", "bad", "activity"), {
            kind: "observed-input",
            clientUserMessageId: "external",
          }),
        ],
        "observed-input-component-mismatch",
      );
      await resolve(
        "observed legacy input",
        [
          item(identity("root", "t", "legacy", "user", "legacy"), {
            kind: "observed-input",
            clientUserMessageId: "external",
          }),
        ],
        "observed-input-component-mismatch",
      );
      await resolve(
        "missing Cantrip input provenance",
        [
          item(identity(), {
            kind: "observed-input",
            clientUserMessageId: "cantrip:missing",
          }),
        ],
        "input-provenance-unavailable",
      );
    },
  );
  const native = identity();
  const reserved = await resolve("fresh native identity", [item(native)]);
  for (const [r] of reserved) {
    assert.equal(
      r.key,
      nativeHistoryPayloadDigest(["native-history-item-v1", "chat", native]),
    );
    assert.equal(r.idempotencyKey, "native-history:" + r.key);
    assert.equal(r.preservedInput, null);
    assert.match(
      r.messageId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  }
  await unchanged("reservation replay has stable identity", async () => {
    for (const association of [
      { kind: "native" },
      { kind: "existing" },
      { kind: "observed-input", clientUserMessageId: "cantrip:retired" },
      { kind: "observed-output" },
      { kind: "output" },
    ]) {
      const replay = await resolve("reserved fast path " + association.kind, [
        item(native, association),
      ]);
      assert.deepEqual(replay, reserved);
    }
  });
  const legacy = await resolve(
    "legacy and canonical identities stay separate",
    [item({ ...native, identityKind: "legacy" })],
  );
  for (let i = 0; i < 2; i++)
    assert.notEqual(legacy[i][0].messageId, reserved[i][0].messageId);
  await resolve("unmanaged client input reserves native identity", [
    item(identity("root", "t", "external"), {
      kind: "observed-input",
      clientUserMessageId: "external",
    }),
  ]);
  await resolve("fresh output needs no GUI command", [
    item(identity("root", "t", "fresh-output", "assistant"), {
      kind: "output",
    }),
  ]);
  await unchanged("output provenance failures grant no identity", async () => {
    await resolve(
      "output rejects legacy identity",
      [
        item(identity("root", "t", "legacy-output", "assistant", "legacy"), {
          kind: "output",
        }),
      ],
      "observed-output-identity-mismatch",
    );
    await resolve(
      "output component rejected",
      [item(identity("root", "t", "bad-output"), { kind: "output" })],
      "output-alias-component-mismatch",
    );
    await resolve(
      "root output rejects another root turn",
      [
        item(identity("root", "t", "bad-root", "assistant"), {
          kind: "output",
          rootTurnId: "other",
        }),
      ],
      "root-output-turn-mismatch",
    );
    await resolve(
      "child output requires explicit root turn",
      [
        item(identity("child", "t", "child-out", "assistant"), {
          kind: "output",
        }),
      ],
      "child-output-root-turn-missing",
      children,
    );
    await resolve(
      "observed output needs historical command",
      [
        item(identity("root", "t", "unbound-output", "assistant"), {
          kind: "observed-output",
        }),
      ],
      "output-provenance-unavailable",
    );
  });
  await resolve(
    "child output retains root scope",
    [
      item(identity("child", "t", "child-out", "assistant"), {
        kind: "output",
        rootTurnId: "root-turn",
      }),
    ],
    undefined,
    children,
  );

  const original = retainedPrompt().pendingMessage;
  const prompt = retainedPrompt({
    pendingMessage: {
      ...original,
      id: "456789ab-1234-4234-8234-000000000003",
      idempotencyKey: "queue-original",
    },
    nativeClientUserMessageId: "cantrip:456789ab-1234-4234-8234-000000000003",
  });
  await seed([
    `UPDATE native_commands SET logical_client_message_id=${literal(original.id)},identity=jsonb_set(identity,'{runtimeGeneration}','"history-runtime-generation"'::jsonb) WHERE operation_id='history-command'`,
    "INSERT INTO native_command_turns(operation_id,chat_id,thread_id,turn_id,runtime_generation) VALUES('history-command','chat','command-thread','native-turn','history-runtime-generation')",
  ]);
  const association = (i) => ({
    kind: "command-input",
    operationId: "history-command",
    operationGeneration: admitted[i].receipt.operationGeneration,
    clientUserMessageId: "cantrip:" + original.id,
  });
  const user = identity("command-thread", "native-turn", "gui-input");
  await unchanged("command inputs require the original protected message", () =>
    resolve(
      "unavailable GUI input",
      (i) => [item(user, association(i))],
      "input-message-unavailable",
      commandBindings,
    ),
  );
  const saveMessage = async (message, attachmentIds = []) =>
    seed(
      `INSERT INTO chat_messages(id,chat_id,role,mode,protected_content,attachment_ids,reasoning_effort,idempotency_key,worktree_id,created_at) VALUES(${literal(message.id)},'chat',${literal(message.classification.role)},${literal(message.classification.mode)},${json(message.protectedContent)},${json(attachmentIds)},${literal(message.reasoningEffort ?? null)},${literal(message.idempotencyKey)},'github-alpha-main',${literal(stamp)})`,
    );
  await saveMessage(original);
  const users = await resolve(
    "preserve actual admitted GUI input",
    (i) => [item(user, association(i))],
    undefined,
    commandBindings,
  );
  for (const [r] of users) {
    assert.equal(r.messageId, original.id);
    assert.deepEqual(r.preservedInput, original);
  }
  await unchanged("GUI input exact ownership fences", async () => {
    await resolve(
      "wrong command generation",
      [
        item(
          { ...user, itemId: "wrong-generation" },
          { ...association(0), operationGeneration: "wrong" },
        ),
      ],
      "input-command-not-bound",
      commandBindings,
    );
    await resolve(
      "wrong GUI input component",
      (i) => [
        item(
          { ...user, itemId: "wrong-component", component: "assistant" },
          association(i),
        ),
      ],
      "input-alias-component-mismatch",
      commandBindings,
    );
    await resolve(
      "wrong observed native turn",
      (i) => [
        item(
          { ...user, itemId: "wrong-turn", turnId: "wrong" },
          association(i),
        ),
      ],
      "input-command-turn-mismatch",
      commandBindings,
    );
    await resolve(
      "wrong client ID",
      (i) => [
        item(
          { ...user, itemId: "wrong-client" },
          { ...association(i), clientUserMessageId: "cantrip:wrong" },
        ),
      ],
      "input-client-id-mismatch",
      commandBindings,
    );
    await resolve(
      "same input cannot claim a second item",
      (i) => [item({ ...user, itemId: "duplicate-input" }, association(i))],
      "input-alias-already-claimed",
      commandBindings,
    );
  });
  const conflict = { ...user, itemId: "native-before-input" };
  await resolve(
    "reserve native identity before alias conflict",
    [item(conflict)],
    undefined,
    commandBindings,
  );
  await unchanged("existing association cannot be replaced", () =>
    resolve(
      "native mapping rejects GUI takeover",
      (i) => [item(conflict, association(i))],
      "item-association-conflict",
      commandBindings,
    ),
  );

  const outputIdentity = identity(
    "command-thread",
    "native-turn",
    "gui-output",
    "assistant",
  );
  const outputAssociation = (i) => ({
    kind: "command-output",
    operationId: "history-command",
    operationGeneration: admitted[i].receipt.operationGeneration,
  });
  const outputMessage = (name, scope = "root", id) => {
    const key = `agent-message:${scope}:native-turn:${name}`;
    return {
      ...original,
      id: id ?? protectedEventId("chat", key),
      idempotencyKey: key,
      classification: { ...original.classification, role: "assistant" },
    };
  };
  const output = outputMessage("gui-output");
  await saveMessage(output);
  const outputs = await resolve(
    "adopt exact protected live output",
    (i) => [item(outputIdentity, outputAssociation(i))],
    undefined,
    commandBindings,
  );
  for (const [r] of outputs) {
    assert.equal(r.messageId, output.id);
    assert.equal(r.idempotencyKey, output.idempotencyKey);
    assert.equal(r.preservedInput, null);
  }
  const observedOutput = outputMessage("observed-output");
  await saveMessage(observedOutput);
  const observed = await resolve(
    "recover observed output without replacing executing worker",
    [
      item(
        { ...outputIdentity, itemId: "observed-output" },
        { kind: "observed-output" },
      ),
    ],
    undefined,
    commandBindings,
  );
  for (const [r] of observed) assert.equal(r.messageId, observedOutput.id);
  await saveMessage(outputMessage("ambiguous"));
  await saveMessage(outputMessage("ambiguous", "native-turn:command-thread"));
  await saveMessage(
    outputMessage("wrong-id", "root", "99999999-9999-4999-8999-999999999999"),
  );
  await unchanged("live output alias fences", async () => {
    await resolve(
      "reserved output cannot claim legacy alias",
      (i) => [
        item(
          { ...outputIdentity, identityKind: "legacy" },
          outputAssociation(i),
        ),
      ],
      "output-alias-already-claimed",
      commandBindings,
    );
    await resolve(
      "two compatible outputs are ambiguous",
      (i) => [
        item({ ...outputIdentity, itemId: "ambiguous" }, outputAssociation(i)),
      ],
      "output-alias-ambiguous",
      commandBindings,
    );
    await resolve(
      "output ID must match encryption namespace",
      (i) => [
        item({ ...outputIdentity, itemId: "wrong-id" }, outputAssociation(i)),
      ],
      "output-message-identity-mismatch",
      commandBindings,
    );
    await resolve(
      "missing command output",
      [
        item(
          { ...outputIdentity, itemId: "missing" },
          {
            kind: "command-output",
            operationId: "missing",
            operationGeneration: "missing",
          },
        ),
      ],
      "output-command-not-bound",
      commandBindings,
    );
  });

  const attachment = deferredAttachment("history-attachment");
  await seed([
    `INSERT INTO chat_attachments(id,chat_id,worker_id,protected_metadata,size_bytes,status,created_at,updated_at) VALUES(${literal(attachment.id)},'chat','alpha',${json(attachment.protectedMetadata)},3,'ready',${literal(stamp)},${literal(stamp)})`,
    `UPDATE chat_messages SET attachment_ids=${json([attachment.id])} WHERE id=${literal(original.id)}`,
  ]);
  const references = await resolve(
    "existing mapping returns exact attachment descriptors",
    [item(user, { kind: "existing" })],
    undefined,
    commandBindings,
  );
  for (const [r] of references) assert.deepEqual(r.attachments, [attachment]);
  await seed(
    `UPDATE chat_messages SET attachment_ids='["missing-attachment"]'::jsonb WHERE id=${literal(original.id)}`,
  );
  await unchanged("missing referenced attachment fails", () =>
    resolve(
      "cannot return dangling attachment",
      [item(user, { kind: "existing" })],
      "referenced-attachment-unavailable",
      commandBindings,
    ),
  );
  await seed(
    `UPDATE chat_messages SET attachment_ids='[]'::jsonb WHERE id=${literal(original.id)}`,
  );

  await seed([
    `INSERT INTO model_profiles(id,owner_id,name,created_at,updated_at) VALUES('queue-model',${literal(owner)},'History queue fixture',${literal(stamp)},${literal(stamp)}) ON CONFLICT DO NOTHING`,
    `INSERT INTO queued_prompts(id,chat_id,opaque_content,model_id,idempotency_key,created_at,updated_at) VALUES(${literal(prompt.id)},'chat',${json(prompt)},'queue-model','history-queue',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,logical_operation_id,logical_client_message_id,operation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,status,protected_result,result_digest) SELECT 'queue-command',owner_id,worker_id,chat_id,'queue-command',${literal(prompt.pendingMessage.id)},'queue-generation',execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,'applied',protected_payload,${literal("b".repeat(64))} FROM native_commands WHERE operation_id='history-command'`,
    "INSERT INTO native_command_turns(operation_id,chat_id,thread_id,turn_id,runtime_generation) VALUES('queue-command','chat','command-thread','queue-turn','history-runtime-generation')",
    `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,status,operation_id,operation_generation,native_turn_id,created_at) VALUES('history-claim','chat',${literal(prompt.id)},0,'consumed','queue-command','queue-generation','queue-turn',${literal(stamp)})`,
  ]);
  const queueIdentity = identity("command-thread", "queue-turn", "queue-input");
  const queueAssociation = {
    kind: "queue-input",
    operationId: "queue-command",
    operationGeneration: "queue-generation",
    claimId: "history-claim",
    promptRevision: 0,
    clientUserMessageId: prompt.nativeClientUserMessageId,
  };
  const queue = await resolve(
    "legacy exact queue revision backfills immutable input",
    [item(queueIdentity, queueAssociation)],
    undefined,
    commandBindings,
  );
  for (const [r] of queue)
    assert.deepEqual(r.preservedInput, prompt.pendingMessage);
  await seed(
    `UPDATE queued_prompts SET revision=1,opaque_content=${json(retainedPrompt({ nativeClientUserMessageId: "changed-mutable-input" }))} WHERE id=${literal(prompt.id)}`,
  );
  await unchanged(
    "retained queue history survives mutable draft changes",
    async () => {
      const replay = await resolve(
        "queue alias retains original input",
        [item(queueIdentity, queueAssociation)],
        undefined,
        commandBindings,
      );
      assert.deepEqual(replay, queue);
      await resolve(
        "claim generation mismatch",
        [
          item(
            { ...queueIdentity, itemId: "wrong-gen" },
            { ...queueAssociation, operationGeneration: "wrong" },
          ),
        ],
        "queue-input-claim-mismatch",
        commandBindings,
      );
      await resolve(
        "queue client ID mismatch",
        [
          item(
            { ...queueIdentity, itemId: "wrong-client" },
            { ...queueAssociation, clientUserMessageId: "wrong" },
          ),
        ],
        "queue-input-client-id-mismatch",
        commandBindings,
      );
    },
  );
  await seed(
    "DELETE FROM native_history_items WHERE alias_operation_id='queue-command'",
  );
  const recovered = await resolve(
    "observed input chooses exact retained queue association",
    [
      item(queueIdentity, {
        kind: "observed-input",
        clientUserMessageId: prompt.nativeClientUserMessageId,
      }),
    ],
    undefined,
    commandBindings,
  );
  for (const [r] of recovered)
    assert.deepEqual(r.preservedInput, prompt.pendingMessage);
  const goalPrompt = retainedPrompt({
    id: "456789ab-1234-4234-8234-000000000004",
    classification: { mode: "goal", attachmentIds: [] },
    executionMethod: "thread/goal/set",
    pendingMessage: {
      ...original,
      id: "456789ab-1234-4234-8234-000000000005",
      idempotencyKey: "goal-original",
      classification: { role: "user", mode: "goal", attachmentIds: [] },
    },
    nativeClientUserMessageId: "cantrip:456789ab-1234-4234-8234-000000000005",
  });
  await seed([
    `INSERT INTO queued_prompts(id,chat_id,opaque_content,model_id,idempotency_key,created_at,updated_at) VALUES(${literal(goalPrompt.id)},'chat',${json(goalPrompt)},'queue-model','history-goal-queue',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,logical_operation_id,operation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,status,protected_result,result_digest) SELECT 'goal-command',owner_id,worker_id,chat_id,'goal-command','goal-generation',execution_lane_id,'autonomous',method,kind,payload_digest,protected_payload,identity,intent,'applied',protected_payload,${literal("c".repeat(64))} FROM native_commands WHERE operation_id='history-command'`,
    "INSERT INTO native_command_turns(operation_id,chat_id,thread_id,turn_id,runtime_generation) VALUES('goal-command','chat','command-thread','goal-turn','history-runtime-generation')",
    `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,status,awaiting_goal,goal_epoch,goal_operation_id,goal_operation_generation,native_turn_id,created_at) VALUES('history-goal-claim','chat',${literal(goalPrompt.id)},0,'consumed',true,'goal-epoch','goal-command','goal-generation','goal-turn',${literal(stamp)})`,
  ]);
  const goalIdentity = identity(
    "command-thread",
    "goal-turn",
    "history-goal-claim",
    "goal-request",
  );
  const goalAssociation = {
    kind: "queue-goal",
    operationId: "goal-command",
    operationGeneration: "goal-generation",
    claimId: "history-goal-claim",
    promptRevision: 0,
  };
  await unchanged(
    "goal aliases require their consumed exact request component",
    async () => {
      await resolve(
        "Goal request cannot masquerade as ordinary user item",
        [item({ ...goalIdentity, component: "user" }, goalAssociation)],
        "queue-input-component-mismatch",
        commandBindings,
      );
      await resolve(
        "Goal request ID must equal retained claim",
        [item({ ...goalIdentity, itemId: "wrong-claim" }, goalAssociation)],
        "queue-input-component-mismatch",
        commandBindings,
      );
    },
  );
  const goals = await resolve(
    "Goal continuation retains exact encrypted requested input",
    [item(goalIdentity, goalAssociation)],
    undefined,
    commandBindings,
  );
  for (const [r] of goals)
    assert.deepEqual(r.preservedInput, goalPrompt.pendingMessage);
  await snapshot(
    "canonical reservations do not ingest content or advance receipts",
  );

  await seed([
    "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='chat'",
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,status,created_at,updated_at) VALUES('history-reader-runtime','chat','beta','github-beta-main','command-thread','ready',${literal(stamp)},${literal(stamp)})`,
  ]);
  const migrated = await binding("new worker binds historical thread", {
    ...request("command-thread"),
    workerId: "beta",
  });
  await unchanged(
    "historical reader does not replace executing identity",
    async () => {
      const read = await resolve(
        "new worker recovers original input alias",
        [
          item(user, {
            kind: "observed-input",
            clientUserMessageId: "cantrip:" + original.id,
          }),
        ],
        undefined,
        migrated,
        "beta",
      );
      for (const [r] of read) assert.deepEqual(r.preservedInput, original);
    },
  );
  await seed(
    "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-main' WHERE id='chat'",
  );
}
