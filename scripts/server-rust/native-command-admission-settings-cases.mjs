import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
import {
  settingsSnapshot,
  settingsScope,
} from "./native-settings-fixtures.mjs";

export async function runAdmissionSettingsCases({
  pair,
  seed,
  observe,
  snapshot,
  reset,
  command,
  owner,
  report,
  register,
}) {
  const session = {
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  async function setup({ publish = true } = {}) {
    await reset();
    await seed(
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('runtime-session','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    );
    if (!publish) return;
    const outcomes = [],
      bindings = [];
    for (const [i, r] of pair.entries()) {
      const result = await r.request({
        op: "native-command-settings-refresh",
        owner,
        chat: "chat",
        snapshot: settingsSnapshot,
      });
      outcomes.push(result);
      assert.equal(result.rejected, false, result.diagnostic);
      assert.deepEqual(result.value.reads, [settingsScope]);
      const binding = result.value.state.binding.bindingId;
      register(binding, "binding", i);
      bindings.push(binding);
    }
    report.cases.push({
      name: "publish settings through actual repository",
      outcomes,
    });
    await snapshot("published settings write bindings");
    return bindings;
  }
  const transition = {
    selectedId: null,
    resolvedSelectedId: ":workspace",
    effectiveId: ":workspace",
    expectedRevision: "0",
  };
  const input = (binding, extra = {}) =>
    command({
      session,
      method: "thread/settings/update",
      intent: {
        nativeSettingsOperationId: "native-settings",
        settingsBindingId: binding,
        settingKeys: ["model"],
        ...extra,
      },
    });
  const dispatchInput = (admitted, i) => ({
    workerId: "alpha",
    operationId: admitted[i].receipt.operationId,
    operationGeneration: admitted[i].receipt.operationGeneration,
    payloadDigest: "a".repeat(64),
    session: { ...command().session, ...session },
  });
  const dispatchOptions = {
    op: "native-command-dispatch",
    status: "dispatched",
  };
  let bindings = await setup();
  const results = await observe(
    "settings admission updates actual state",
    (i) => input(bindings[i]),
  );
  let state = await snapshot("journal and settings commit together");
  for (const [i, value] of state.entries()) {
    const settings = value.settings[0].state;
    assert.equal(settings.revision, "2");
    assert.equal(settings.desiredStatus, "accepted");
    assert.equal(settings.desired.operationId, "request");
    assert.equal(
      settings.desired.operationGeneration,
      results[i].receipt.operationGeneration,
    );
    assert.deepEqual(
      settings.desired.protectedContent,
      command().protectedPayload,
    );
    assert.equal(settings.pending.length, 1);
  }
  await observe("settings admission replay", (i) => input(bindings[i]));
  assert.deepEqual(await snapshot("settings replay no writes"), state);
  const dispatched = await observe(
    "dispatch settings with application evidence placeholder",
    (i) => dispatchInput(results, i),
    dispatchOptions,
  );
  state = await snapshot(
    "settings journal and pending state dispatched together",
  );
  for (const [i, value] of state.entries()) {
    assert.deepEqual(dispatched[i].receipt.settingsApplication, {
      nativeOperationId: "native-settings",
      submissionId: null,
      status: "pending",
      evidenceCount: 0,
    });
    assert.equal(value.settings[0].state.revision, "3");
    assert.equal(value.settings[0].state.desiredStatus, "dispatched");
    assert.equal(value.settings[0].state.pending[0].status, "dispatched");
  }
  for (const [name, extra, sql, code] of [
    ["binding replaced", {}, null, "settings-binding-replaced"],
    [
      "permission policy replaced",
      {
        permissionTransition: { ...transition, effectiveId: ":read-only" },
        settingKeys: ["permissions"],
      },
      null,
      "permission-policy-replaced",
    ],
    [
      "permission revision replaced",
      {
        permissionTransition: { ...transition, expectedRevision: "1" },
        settingKeys: ["permissions"],
      },
      null,
      "permission-revision-conflict",
    ],
    [
      "permission transition wrong keys",
      { permissionTransition: transition, settingKeys: ["model"] },
      null,
      "invalid-permission-transition",
    ],
    [
      "forced read-only placement",
      { permissionTransition: transition, settingKeys: ["permissions"] },
      "UPDATE projects SET worktree_policy='required-for-writes' WHERE id='github'",
      "permission-policy-replaced",
    ],
  ]) {
    bindings = await setup();
    if (sql) await seed(sql);
    await observe(
      name,
      (i) => input(name === "binding replaced" ? "stale" : bindings[i], extra),
      { status: "rejected", rejection: code },
    );
    const value = await snapshot(
      "rejected settings keeps published state " + name,
    );
    for (const s of value) {
      assert.equal(s.settings[0].state.revision, "1");
      assert.equal(s.settings[0].state.pending.length, 0);
      assert.equal(
        s.commands[0].kind,
        name === "binding replaced" ? "unknown" : "settings",
      );
    }
  }
  bindings = await setup();
  const permissionCommand = await observe(
    "permission transition accepted",
    (i) =>
      input(bindings[i], {
        permissionTransition: transition,
        settingKeys: ["permissions"],
      }),
  );
  state = await snapshot("pending permission transition");
  for (const value of state)
    assert.deepEqual(
      value.settings[0].state.desired.permissionTransition,
      transition,
    );
  await observe(
    "other permission transition blocked",
    (i) => ({
      ...input(bindings[i], {
        permissionTransition: transition,
        settingKeys: ["permissions"],
      }),
      operationId: "second",
    }),
    { status: "rejected", rejection: "permission-transition-pending" },
  );
  await snapshot("pending permission transition survives rejection");
  await observe(
    "dispatch own pending permission transition",
    (i) => dispatchInput(permissionCommand, i),
    dispatchOptions,
  );
  await snapshot("own permission transition survives dispatch fences");

  await setup({ publish: false });
  await observe(
    "permission binding required",
    command({
      session,
      method: "thread/settings/update",
      intent: {
        nativeSettingsOperationId: "native-settings",
        settingKeys: ["permissions"],
        permissionTransition: transition,
      },
    }),
    { status: "rejected", rejection: "permission-binding-required" },
  );
  await snapshot("missing permission binding persists rejection only");

  bindings = await setup();
  await seed(
    "CREATE FUNCTION fail_settings_admission() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'settings admission failure'; END$$",
  );
  await seed(
    "CREATE TRIGGER fail_settings_admission BEFORE UPDATE ON native_settings_states FOR EACH ROW EXECUTE FUNCTION fail_settings_admission()",
  );
  const before = await snapshot("before post-journal settings failure");
  await observe("post-journal settings failure", (i) => input(bindings[i]), {
    error: true,
    sqlstate: "P0001",
  });
  assert.deepEqual(
    await snapshot("post-journal failure rolls back everything"),
    before,
  );
  await seed("DROP TRIGGER fail_settings_admission ON native_settings_states");
  await seed("DROP FUNCTION fail_settings_admission()");

  bindings = await setup();
  const pendingDispatch = await observe(
    "admit settings before failed settlement",
    (i) => input(bindings[i]),
  );
  await seed(
    "CREATE FUNCTION fail_settings_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'settings dispatch failure'; END$$",
  );
  await seed(
    "CREATE TRIGGER fail_settings_dispatch BEFORE UPDATE ON native_settings_states FOR EACH ROW EXECUTE FUNCTION fail_settings_dispatch()",
  );
  const beforeDispatch = await snapshot(
    "before post-dispatch settings failure",
  );
  await observe(
    "post-dispatch settings failure",
    (i) => dispatchInput(pendingDispatch, i),
    { ...dispatchOptions, error: true, sqlstate: "P0001" },
  );
  assert.deepEqual(
    await snapshot("settings settlement failure restores command"),
    beforeDispatch,
  );
  await seed("DROP TRIGGER fail_settings_dispatch ON native_settings_states");
  await seed("DROP FUNCTION fail_settings_dispatch()");

  await setup();
  const attach = await observe(
    "admit attach before runtime handoff",
    command({ session, method: "thread/resume" }),
  );
  await seed(
    `INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,phase,source,target_model_route_id,created_at,updated_at) VALUES('attach-handoff',${literal(owner)},'chat','alpha','preparing','{}','unused',${literal(stamp)},${literal(stamp)})`,
  );
  await observe(
    "current attachment allowed during runtime handoff",
    (i) => dispatchInput(attach, i),
    dispatchOptions,
  );
  await snapshot("attach preserves handoff boundary");
}
