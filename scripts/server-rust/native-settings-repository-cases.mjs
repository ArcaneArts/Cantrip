import assert from "node:assert/strict";
import { nativeCommandIntentSchema } from "../../packages/protocol/dist/index.js";
import { literal, json, stamp } from "./project-target-state.mjs";
import {
  settingsSnapshot,
  settingsScope,
  resolvedAttribution,
} from "./native-settings-fixtures.mjs";

export async function runNativeSettingsCases({
  seed,
  observe,
  snapshot,
  owner,
  other,
  standalone,
  identity,
  dispatch,
}) {
  const op = (name) => "native-command-settings-" + name;
  const native = {
    ...settingsSnapshot,
    context: {
      ...settingsSnapshot.context,
      runtimeGeneration: "runtime-generation",
    },
  };
  const refresh = (snapshot = native, extra = {}) => ({
    op: op("refresh"),
    snapshot,
    ...extra,
  });
  const state = (
    await observe("owned empty settings state", { op: op("get") })
  )[0];
  for (const extra of [{ owner: other }, { chat: "missing" }])
    for (const value of await observe(
      "settings owner isolation " + JSON.stringify(extra),
      { op: op("get"), ...extra },
    ))
      assert.equal(value, null);
  for (const chat of ["task", standalone]) {
    const values = await observe("empty contextual settings " + chat, {
      op: op("get"),
      chat,
    });
    for (const value of values) assert.equal(value.chatId, chat);
    await observe(
      "unbound contextual settings read " + chat,
      refresh(native, { chat }),
      { error: { code: "settings-thread-unbound", status: 409 } },
    );
  }
  for (const value of [
    null,
    false,
    0,
    [],
    { ...state, chatId: "another-chat" },
  ]) {
    await seed(
      `INSERT INTO native_settings_states(chat_id,state,updated_at) VALUES('chat',${json(value)},${literal(stamp)}) ON CONFLICT(chat_id) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`,
    );
    const invalid = Array.isArray(value) || value?.chatId;
    await observe(
      "stored settings parse " + JSON.stringify(value),
      { op: op("get") },
      invalid ? { error: {} } : {},
    );
  }
  await seed("DELETE FROM native_settings_states WHERE chat_id='chat'");
  const bound = await observe("publish actual native settings read", refresh());
  for (const value of bound) {
    assert.deepEqual(value.reads, [settingsScope]);
    assert.deepEqual(value.state.effective, native);
    assert.equal(value.state.revision, "1");
    assert.match(
      value.state.binding.bindingId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  }
  const ids = bound.map((v) => v.state.binding.bindingId);
  const request =
    (name, extra = {}) =>
    (i) => ({ op: op(name), bindingId: ids[i], ...extra });
  const rejected = async (name, request, error) => {
    const before = await snapshot("before settings " + name);
    await observe(name, request, { error });
    assert.deepEqual(await snapshot("settings rollback " + name), before);
  };
  let before = await snapshot("before same-source settings replay");
  const replayed = await observe(
    "same native settings source retains write binding",
    refresh({
      ...native,
      protectedContent: {
        ...native.protectedContent,
        ciphertext: Buffer.alloc(32, 7).toString("base64url"),
      },
    }),
  );
  for (const [i, value] of replayed.entries()) {
    assert.equal(value.state.binding.bindingId, ids[i]);
    assert.deepEqual(value.state.effective, native);
  }
  assert.deepEqual(
    await snapshot("settings read replay does not rewrite storage"),
    before,
  );
  await observe("resolve canonical settings write binding", request("resolve"));
  await observe(
    "assert exact settings write source",
    request("assert-source", {
      source: { workerId: "alpha", session: dispatch.session },
    }),
  );
  await rejected(
    "replaced settings binding token",
    { op: op("resolve"), bindingId: "stale" },
    { code: "settings-binding-replaced", status: 409 },
  );
  await rejected(
    "replaced settings worker source",
    request("assert-source", {
      source: { workerId: "beta", session: dispatch.session },
    }),
    { code: "settings-binding-replaced", status: 409 },
  );
  await rejected(
    "replaced settings runtime source",
    request("assert-source", {
      source: {
        workerId: "alpha",
        session: { ...dispatch.session, runtimeGeneration: "different" },
      },
    }),
    { code: "settings-binding-replaced", status: 409 },
  );
  for (const field of ["chatId", "workerId", "threadId"])
    await rejected(
      "worker read returned other " + field,
      refresh({
        ...native,
        context: { ...native.context, [field]: "another" },
      }),
      { code: "settings-read-scope", status: 409 },
    );
  await rejected(
    "worker settings read failure",
    refresh(native, { readFailure: "Actual read failed" }),
    {},
  );
  await rejected(
    "settings refresh ownership precedes worker read",
    refresh(native, { owner: other, readFailure: "must not run" }),
    { code: "chat-not-found", status: 404 },
  );
  await rejected(
    "active runtime owns settings publication",
    refresh({
      ...native,
      context: { ...native.context, runtimeGeneration: "replaced" },
    }),
    { code: "settings-read-replaced", status: 409 },
  );
  const observation =
    (snapshot = native, extra = {}) =>
    (i) => ({
      op: op("observe"),
      input: { workerId: "alpha", bindingId: ids[i], snapshot, ...extra },
    });
  before = await snapshot("before stale settings observation");
  await observe(
    "older native settings observation is read-only",
    observation({
      ...native,
      context: {
        ...native.context,
        settingsVersion: { epoch: "epoch", revision: "3" },
      },
    }),
  );
  assert.deepEqual(
    await snapshot("stale observation preserves exact stored state"),
    before,
  );
  const newer = {
    ...native,
    context: {
      ...native.context,
      settingsVersion: { epoch: "epoch", revision: "5" },
    },
  };
  const observed = await observe(
    "newer native settings observation",
    observation(newer),
  );
  for (const value of observed) {
    assert.equal(value.revision, "2");
    assert.deepEqual(value.settingsVersion, { epoch: "epoch", revision: "5" });
  }
  await rejected(
    "same settings version cannot rotate encryption key",
    observation({
      ...newer,
      protectedContent: { ...newer.protectedContent, keyRevision: 2 },
    }),
    { code: "settings-binding-replaced", status: 409 },
  );
  await rejected(
    "same settings version cannot change content",
    observation({ ...newer, contentFingerprint: "f".repeat(64) }),
    {},
  );
  await rejected(
    "observation uses current binding token",
    observation(newer, { bindingId: "old" }),
    { code: "settings-binding-replaced", status: 409 },
  );
  await rejected(
    "observation worker is canonical",
    observation(newer, { workerId: "beta" }),
    { code: "settings-binding-replaced", status: 409 },
  );
  await rejected(
    "observation requires same native epoch",
    observation({
      ...newer,
      context: {
        ...newer.context,
        settingsVersion: { epoch: "new-epoch", revision: "5" },
      },
    }),
    { code: "settings-binding-replaced", status: 409 },
  );
  const rotated = {
    ...newer,
    protectedContent: { ...newer.protectedContent, keyRevision: 2 },
  };
  const rotation = await observe(
    "fresh authorized read rotates settings binding",
    refresh(rotated),
  );
  for (const [i, value] of rotation.entries()) {
    assert.notEqual(value.state.binding.bindingId, ids[i]);
    ids[i] = value.state.binding.bindingId;
    assert.equal(value.state.revision, "3");
    assert.equal(value.state.effective.protectedContent.keyRevision, 2);
  }
  const current = rotation.map((v) => v.state);
  before = await snapshot("before same-revision settings callback");
  await observe("same revision ignores attempted state replacement", (i) => ({
    op: op("change"),
    state: { ...current[i], desiredStatus: "uncertain" },
  }));
  assert.deepEqual(
    await snapshot("same-revision callback leaves exact state"),
    before,
  );
  await rejected(
    "changed state must remain in owned Chat",
    (i) => ({
      op: op("change"),
      state: { ...current[i], chatId: "other-chat", revision: "4" },
    }),
    {},
  );
  await rejected(
    "invalid next state fails before same-revision no-op",
    (i) => ({ op: op("change"), state: { ...current[i], pending: null } }),
    {},
  );
  await seed(
    "UPDATE chats SET archived_at='2026-10-25T00:00:00.123Z' WHERE id='chat'",
  );
  for (const value of await observe(
    "owned archived Chat retains settings read",
    { op: op("get") },
  ))
    assert.equal(value.effective.protectedContent.keyRevision, 2);
  await rejected("archived Chat has no refreshable thread", refresh(rotated), {
    code: "settings-thread-unbound",
    status: 409,
  });
  await seed("UPDATE chats SET archived_at=NULL WHERE id='chat'");
  const commandIntent = nativeCommandIntentSchema.parse({
    scope: "thread",
    settingKeys: ["model"],
    nativeSettingsOperationId: "settings-operation",
    settingsBindingId: "binding",
  });
  await seed(
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,created_at,updated_at) SELECT 'settings-command',owner_id,worker_id,chat_id,'settings-generation','gui','thread/settings/update','settings',payload_digest,protected_payload,${json(dispatch.session)},${json(commandIntent)},'accepted',created_at,updated_at FROM native_commands WHERE operation_id='command'`,
  );
  await observe("admit settings intent in command transaction", {
    op: op("admit"),
    operation: "settings-command",
  });
  before = await snapshot("before exact settings admission replay");
  await observe("repeat settings admission is idempotent", {
    op: op("admit"),
    operation: "settings-command",
  });
  assert.deepEqual(
    await snapshot("settings admission replay preserves exact rows"),
    before,
  );
  for (const [sql, name] of [
    [
      "UPDATE native_commands SET status='rejected',intent='null'::jsonb WHERE operation_id='settings-command'",
      "rejected command ignores malformed settings intent",
    ],
    [
      "UPDATE native_commands SET status='accepted',method='skills/list',intent='null'::jsonb WHERE operation_id='settings-command'",
      "unrelated command ignores malformed settings intent",
    ],
  ]) {
    await seed(sql);
    before = await snapshot("before " + name);
    await observe(name, { op: op("admit"), operation: "settings-command" });
    assert.deepEqual(await snapshot("no-op " + name), before);
  }
  await seed(
    `UPDATE native_commands SET status='accepted',method='thread/settings/update',intent=${json(commandIntent)} WHERE operation_id='settings-command'`,
  );
  for (const outcome of ["dispatched", "uncertain", "applied", "rejected"]) {
    await observe("durable settings settlement " + outcome, {
      op: op("settle"),
      operation: "settings-command",
      outcome,
    });
    before = await snapshot("before repeated settings settlement " + outcome);
    await observe("repeat durable settings settlement " + outcome, {
      op: op("settle"),
      operation: "settings-command",
      outcome,
    });
    assert.deepEqual(
      await snapshot("settlement replay exact state " + outcome),
      before,
    );
  }
  await seed(
    "UPDATE native_commands SET operation_generation='wrong-generation' WHERE operation_id='settings-command'",
  );
  await rejected(
    "settings settlement command generation conflict",
    { op: op("settle"), operation: "settings-command", outcome: "applied" },
    {},
  );
  await seed(
    "UPDATE native_commands SET operation_generation='settings-generation',status='uncertain',settings_application='null'::jsonb WHERE operation_id='settings-command'",
  );
  await observe(
    "uncertain transport cannot reverse terminal settings ambiguity",
    { op: op("transport"), operation: "settings-command" },
  );
  await seed(
    "INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,created_at,updated_at) SELECT 'settings-command-two',owner_id,worker_id,chat_id,'settings-generation-two',origin,method,kind,payload_digest,protected_payload,identity,intent,'accepted',created_at,updated_at FROM native_commands WHERE operation_id='settings-command'",
  );
  await observe("admit second independently correlated settings intent", {
    op: op("admit"),
    operation: "settings-command-two",
  });
  await seed(
    'UPDATE native_commands SET status=\'uncertain\',settings_application=\'{"nativeOperationId":"settings-operation","submissionId":"submission","status":"applied","evidenceCount":1}\'::jsonb WHERE operation_id=\'settings-command-two\'',
  );
  await observe("correlated application facts win over transport uncertainty", {
    op: op("transport"),
    operation: "settings-command-two",
  });
  for (const value of await observe(
    "confirmed settings application survives transport uncertainty",
    { op: op("get") },
  )) {
    assert.equal(value.desiredStatus, "applied");
    assert.equal(
      value.pending.some(
        (entry) => entry.intent.operationId === "settings-command-two",
      ),
      false,
    );
  }
  await seed([
    `CREATE FUNCTION settings_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled settings write failure' USING ERRCODE='P0001'; END $$`,
    "CREATE TRIGGER settings_fail BEFORE UPDATE ON native_settings_states FOR EACH ROW EXECUTE FUNCTION settings_fail()",
  ]);
  const stored = await observe("settings before storage failure", {
    op: op("get"),
  });
  await rejected(
    "settings persistence database error rolls back",
    (i) => ({
      op: op("change"),
      state: {
        ...stored[i],
        revision: (BigInt(stored[i].revision) + 1n).toString(),
      },
    }),
    { sqlstate: "P0001" },
  );
  await seed([
    "DROP TRIGGER settings_fail ON native_settings_states",
    "DROP FUNCTION settings_fail()",
  ]);
  before = await snapshot(
    "before real placement change during native settings read",
  );
  await observe(
    "placement changes while worker settings read is outstanding",
    refresh(rotated, {
      afterReadSql: [
        "UPDATE chat_runtime_sessions SET codex_thread_id='changed-thread' WHERE id='runtime'",
      ],
    }),
    { error: { code: "settings-read-replaced", status: 409 } },
  );
  let after = await snapshot(
    "late read cannot publish after real placement change",
  );
  for (const [i, value] of after.entries()) {
    assert.deepEqual(value.settings, before[i].settings);
    assert.equal(
      value.runtimes.find((r) => r.id === "runtime").codex_thread_id,
      "changed-thread",
    );
  }
  await seed(
    "UPDATE chat_runtime_sessions SET codex_thread_id='thread' WHERE id='runtime'",
  );
  before = await snapshot("before concurrent newer settings read publication");
  await observe(
    "newer authorized read wins while earlier worker read is outstanding",
    refresh(rotated, {
      publishDuringRead: {
        ...rotated,
        protectedContent: { ...rotated.protectedContent, keyRevision: 3 },
      },
    }),
    { error: { code: "settings-read-replaced", status: 409 } },
  );
  const latest = await observe(
    "state after concurrent authorized publication",
    { op: op("get") },
  );
  for (const [i, value] of latest.entries()) {
    assert.notEqual(value.binding.bindingId, ids[i]);
    ids[i] = value.binding.bindingId;
    assert.equal(value.effective.protectedContent.keyRevision, 3);
    assert.equal(
      value.revision,
      (BigInt(before[i].settings[0].state.revision) + 1n).toString(),
    );
  }
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url,created_at,updated_at) VALUES('settings-provider',${literal(owner)},'Settings provider','ollama','http://fixture.invalid',${literal(stamp)},${literal(stamp)}),('settings-foreign-provider',${literal(other)},'Foreign settings provider','ollama','http://fixture.invalid',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO model_profiles(id,owner_id,name,created_at,updated_at) VALUES('settings-model',${literal(owner)},'Settings model',${literal(stamp)},${literal(stamp)}),('settings-foreign-model',${literal(other)},'Foreign settings model',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled,created_at,updated_at) VALUES('settings-route','settings-model','settings-provider','native',0,true,${literal(stamp)},${literal(stamp)}),('settings-disabled-route','settings-model','settings-provider','native',1,false,${literal(stamp)},${literal(stamp)}),('settings-foreign-route','settings-foreign-model','settings-foreign-provider','native',0,true,${literal(stamp)},${literal(stamp)})`,
  ]);
  const attribution = {
    ...resolvedAttribution,
    selection: {
      ...resolvedAttribution.selection,
      providerId: "settings-provider",
      modelId: "settings-model",
      routeId: "settings-route",
    },
  };
  const scope = { ...settingsScope, modelRouteId: "settings-route" };
  for (const [name, changedScope, selection, retain] of [
    ["owned route", scope, attribution.selection, true],
    [
      "disabled catalog route still carries public immutable attribution",
      scope,
      { ...attribution.selection, routeId: "settings-disabled-route" },
      true,
    ],
    ["no physical route", settingsScope, attribution.selection, false],
    [
      "another worker",
      scope,
      { ...attribution.selection, workerId: "beta" },
      false,
    ],
    [
      "another account",
      scope,
      { ...attribution.selection, providerAccountId: "other-account" },
      false,
    ],
    [
      "another provider",
      scope,
      {
        ...attribution.selection,
        providerId: "settings-foreign-provider",
        routeId: "settings-foreign-route",
        modelId: "settings-foreign-model",
      },
      false,
    ],
    [
      "another model",
      scope,
      { ...attribution.selection, modelId: "wrong-model" },
      false,
    ],
    [
      "missing model route",
      scope,
      { ...attribution.selection, routeId: "missing" },
      false,
    ],
    [
      "foreign anchor route",
      { ...scope, modelRouteId: "settings-foreign-route" },
      attribution.selection,
      false,
    ],
    ["unmapped selection", scope, { status: "unmapped" }, true],
  ]) {
    const input = {
      ...rotated,
      modelAttribution: { ...attribution, selection },
    };
    const values = await observe("scoped settings attribution " + name, {
      op: op("scope-model"),
      scope: changedScope,
      snapshot: input,
    });
    for (const value of values) {
      assert.deepEqual(value.protectedContent, rotated.protectedContent);
      assert.equal("modelAttribution" in value, retain);
    }
  }
  await rejected(
    "observation validates before ownership lookup",
    { op: op("observe"), owner: other, input: null },
    {},
  );
  await seed(
    "UPDATE chat_runtime_sessions SET model_route_id='settings-route' WHERE id='runtime'",
  );
  const attributed = {
    ...rotated,
    protectedContent: { ...rotated.protectedContent, keyRevision: 3 },
    modelAttribution: attribution,
  };
  const published = await observe(
    "canonical route retains authenticated model attribution on refresh",
    refresh(attributed),
  );
  for (const [i, value] of published.entries()) {
    assert.deepEqual(value.state.effective.modelAttribution, attribution);
    assert.notEqual(value.state.binding.bindingId, ids[i]);
    ids[i] = value.state.binding.bindingId;
  }
  before = await snapshot("before encrypted model attribution replay");
  await observe(
    "scoped model observation preserves immutable attribution",
    observation({
      ...attributed,
      protectedContent: {
        ...attributed.protectedContent,
        ciphertext: Buffer.alloc(32, 12).toString("base64url"),
      },
    }),
  );
  assert.deepEqual(
    await snapshot("model attribution replay leaves exact storage unchanged"),
    before,
  );
  await seed(
    `INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,phase,source,target_model_route_id,created_at,updated_at) VALUES('settings-handoff',${literal(owner)},'chat','alpha','preparing','{}','settings-route',${literal(stamp)},${literal(stamp)})`,
  );
  for (const [sql, name, code] of [
    [
      "UPDATE native_runtime_handoffs SET phase='preparing' WHERE operation_id='settings-handoff'",
      "handoff preparing",
      "native-runtime-handoff-pending",
    ],
    [
      "UPDATE native_runtime_handoffs SET phase='completed',retired_runtime_generations='[\"runtime-generation\"]'::jsonb WHERE operation_id='settings-handoff'",
      "retired runtime generation",
      "native-runtime-retired",
    ],
    [
      'UPDATE native_runtime_handoffs SET retired_runtime_generations=\'[]\'::jsonb,retired_native_epochs=\'[{"runtimeGeneration":"runtime-generation","nativeEpoch":"epoch"}]\'::jsonb WHERE operation_id=\'settings-handoff\'',
      "retired native epoch",
      "native-runtime-retired",
    ],
  ]) {
    await seed(sql);
    await rejected("settings refresh fenced by " + name, refresh(attributed), {
      code,
      status: 409,
    });
    await rejected(
      "settings observation fenced by " + name,
      observation(attributed),
      { code, status: 409 },
    );
    await observe(
      "binding lookup preserves Source access during " + name,
      request("resolve"),
    );
  }
  await seed(
    "DELETE FROM native_runtime_handoffs WHERE operation_id='settings-handoff'",
  );
  for (const [chat, thread, scratch] of [
    [standalone, "standalone-thread", true],
    ["task", "task-thread", false],
  ]) {
    await seed(
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,scratch_root_id,codex_thread_id,created_at,updated_at) SELECT ${literal("settings-runtime-" + chat)},id,active_worker_id,${scratch ? "NULL" : "active_worktree_id"},${scratch ? "active_scratch_root_id" : "NULL"},${literal(thread)},${literal(stamp)},${literal(stamp)} FROM chats WHERE id=${literal(chat)}`,
    );
    const input = {
      ...native,
      context: {
        ...native.context,
        chatId: chat,
        threadId: thread,
        runtimeGeneration: "contextual-runtime",
      },
    };
    const values = await observe(
      "actual contextual native settings refresh " + chat,
      refresh(input, { chat }),
    );
    for (const value of values) {
      assert.equal(
        value.state.binding.contextKind,
        scratch ? "standalone" : "project",
      );
      assert.equal(value.state.binding.projectId, scratch ? null : "github");
      assert.deepEqual(value.state.effective, input);
    }
    const results = await observe(
      "actual contextual native settings observation " + chat,
      (i) => ({
        op: op("observe"),
        chat,
        input: {
          workerId: "alpha",
          bindingId: values[i].state.binding.bindingId,
          snapshot: {
            ...input,
            context: {
              ...input.context,
              settingsVersion: { epoch: "epoch", revision: "5" },
            },
          },
        },
      }),
    );
    for (const value of results) assert.equal(value.revision, "2");
  }
}
