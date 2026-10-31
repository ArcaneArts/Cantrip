import assert from "node:assert/strict";
import { nativeSettingsEvidenceSchema } from "../../packages/protocol/dist/index.js";
import { settingsSnapshot } from "./native-settings-fixtures.mjs";
import { literal, stamp, otherOwner } from "./project-target-state.mjs";
import { runEvidenceRevisionCases } from "./native-command-evidence-revision-cases.mjs";
export async function runEvidenceCases({
  seed,
  observe,
  snapshot,
  reset,
  command,
}) {
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  const event = (n) =>
    "12345678-1234-4234-8234-" + n.toString(16).padStart(12, "0");
  const claim = (
    effectiveId = ":read-only",
    epoch = "epoch",
    revision = "5",
  ) => ({ effectiveId, settingsVersion: { epoch, revision } });
  const refresh = (name, snapshot = settingsSnapshot) =>
    observe(
      name,
      { chat: "chat", snapshot },
      { op: "native-command-settings-refresh", shape: "raw" },
    );
  const record = (name, input, options = {}) =>
    observe(
      name,
      typeof input === "function" ? (i) => ({ input: input(i) }) : { input },
      { op: "native-command-evidence", shape: "raw", ...options },
    );
  async function setup({ permission = false, selected = ":read-only" } = {}) {
    await reset();
    await seed(
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('evidence-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    );
    const published = await refresh("publish evidence fixture native read");
    const bindings = published.map((v) => v.state.binding.bindingId);
    const intent = {
      nativeSettingsOperationId: "native-settings",
      settingKeys: [permission ? "permissions" : "model"],
      ...(permission
        ? {
            permissionTransition: {
              selectedId: selected,
              resolvedSelectedId: selected,
              effectiveId: selected,
              expectedRevision: "0",
            },
          }
        : {}),
    };
    const admitted = await observe("admit evidence fixture settings", (i) =>
      command({
        session,
        method: "thread/settings/update",
        intent: { ...intent, settingsBindingId: bindings[i] },
      }),
    );
    const dispatchInput = (i) => ({
      workerId: "alpha",
      operationId: "request",
      operationGeneration: admitted[i].receipt.operationGeneration,
      payloadDigest: "a".repeat(64),
      session,
    });
    await observe("dispatch evidence fixture settings", dispatchInput, {
      op: "native-command-dispatch",
      status: "dispatched",
    });
    const evidence = (i, extra = {}) =>
      nativeSettingsEvidenceSchema.parse({
        workerId: "alpha",
        operationId: "request",
        operationGeneration: admitted[i].receipt.operationGeneration,
        eventId: event(1),
        threadId: "thread",
        runtimeGeneration: "runtime",
        nativeOperationId: "native-settings",
        submissionId: "submission",
        kind: "applied",
        resultDigest: "a".repeat(64),
        protectedResult: command().protectedPayload,
        ...extra,
      });
    return { bindings, admitted, evidence, intent, dispatchInput };
  }
  async function unchanged(name, input, options = {}) {
    const before = await snapshot("before " + name);
    await record(name, input, { error: true, ...options });
    assert.deepEqual(await snapshot("rollback " + name), before, name);
  }
  for (const sequence of [
    [
      ["queued", "pending"],
      ["applied", "applied"],
      ["transport-lost", "applied"],
    ],
    [
      ["transport-lost", "uncertain"],
      ["queued", "uncertain"],
      ["applied", "applied"],
    ],
    [
      ["rejected", "rejected"],
      ["applied", "uncertain"],
    ],
    [
      ["applied", "applied"],
      ["correlation-conflict", "uncertain"],
    ],
  ]) {
    const c = await setup();
    for (const [n, [kind, status]] of sequence.entries()) {
      const values = await record(
        "native evidence order " +
          sequence.map((s) => s[0]).join("/") +
          " " +
          n,
        (i) => c.evidence(i, { kind, eventId: event(n + 1) }),
      );
      for (const value of values) {
        assert.equal(value.application.status, status);
        assert.equal(value.application.evidenceCount, n + 1);
        assert.equal(value.permissionPolicyPublished, false);
      }
      const state = await snapshot("evidence status " + kind + " " + n);
      for (const value of state) {
        assert.equal(
          value.commands[0].status,
          "dispatched",
          "application and transport are independent",
        );
        assert.equal(value.evidence.length, n + 1);
        assert.deepEqual(
          value.evidence.at(-1).protected_result,
          command().protectedPayload,
        );
      }
    }
  }
  let c = await setup();
  await record("first application evidence", (i) => c.evidence(i));
  const beforeReplay = await snapshot("before exact immutable evidence replay");
  const replay = await record("exact immutable evidence replay", (i) =>
    c.evidence(i),
  );
  const afterReplay = await snapshot("after exact immutable evidence replay");
  for (const [i, value] of afterReplay.entries()) {
    assert.equal(replay[i].application.evidenceCount, 1);
    const expected = structuredClone(beforeReplay[i]);
    expected.commands[0].updated_at = value.commands[0].updated_at;
    assert.deepEqual(value, expected);
  }
  for (const changes of [
    { resultDigest: "b".repeat(64) },
    {
      protectedResult: {
        ...command().protectedPayload,
        ciphertext: Buffer.alloc(32, 4).toString("base64url"),
      },
    },
    { submissionId: "another-submission" },
  ])
    await unchanged(
      "reused evidence content " + JSON.stringify(changes),
      (i) => c.evidence(i, changes),
      { code: "native-settings-evidence-conflict" },
    );
  await record("different native submissions are uncertain", (i) =>
    c.evidence(i, { eventId: event(2), submissionId: "other-submission" }),
  );
  let state = await snapshot("contradictory submission facts retained");
  for (const value of state) {
    assert.equal(value.commands[0].settings_application.status, "uncertain");
    assert.equal(value.commands[0].settings_application.submissionId, null);
    assert.equal(value.evidence.length, 2);
  }
  for (const [name, changes, code] of [
    ["wrong worker", { workerId: "beta" }, "operation-not-found"],
    [
      "wrong generation",
      { operationGeneration: "wrong" },
      "operation-not-found",
    ],
    ["wrong thread", { threadId: "wrong" }, "native-settings-evidence-scope"],
    [
      "wrong runtime",
      { runtimeGeneration: "wrong" },
      "native-settings-evidence-scope",
    ],
    [
      "wrong native operation",
      { nativeOperationId: "wrong" },
      "native-settings-evidence-scope",
    ],
    [
      "recovery without transition",
      { recoveryBindingId: "binding", permissionPolicy: claim() },
      "native-settings-evidence-scope",
    ],
  ])
    await unchanged(
      name,
      (i) => c.evidence(i, { eventId: event(3), ...changes }),
      { code },
    );
  await unchanged("foreign owner evidence", (i) => c.evidence(i), {
    code: "operation-not-found",
    requestOwner: otherOwner,
  });

  for (const [name, permissionPolicy, status, published] of [
    ["missing permission claim", undefined, "uncertain", false],
    ["mismatched permission claim", claim(":workspace"), "uncertain", false],
    ["confirmed permission claim", claim(), "applied", true],
  ]) {
    c = await setup({ permission: true });
    const results = await record(name, (i) =>
      c.evidence(i, permissionPolicy ? { permissionPolicy } : {}),
    );
    for (const value of results) {
      assert.equal(value.application.status, status);
      assert.equal(value.permissionPolicyPublished, published);
    }
    state = await snapshot("permission publication " + name);
    for (const value of state) {
      const chat = value.chats.find((v) => v.id === "chat");
      assert.equal(chat.permission_profile_id, published ? ":read-only" : null);
      assert.equal(
        value.settings[0].state.permissionPolicy?.revision,
        published ? "1" : undefined,
      );
    }
    if (published) {
      const prior = state;
      const repeated = await record("confirmed permission fact replay", (i) =>
        c.evidence(i, { permissionPolicy }),
      );
      state = await snapshot("permission replay preserves revisions");
      for (const [i, value] of state.entries()) {
        assert.equal(repeated[i].permissionPolicyPublished, true);
        assert.deepEqual(value.settings, prior[i].settings);
        assert.deepEqual(value.chats, prior[i].chats);
      }
      await record("conflicting original native versions", (i) =>
        c.evidence(i, {
          eventId: event(2),
          permissionPolicy: claim(":read-only", "epoch", "6"),
        }),
      );
      state = await snapshot(
        "conflicting permission facts do not erase confirmed policy",
      );
      for (const [i, value] of state.entries()) {
        assert.equal(
          value.commands[0].settings_application.status,
          "uncertain",
        );
        assert.deepEqual(
          value.settings[0].state.permissionPolicy,
          prior[i].settings[0].state.permissionPolicy,
        );
      }
    }
  }
  c = await setup({ permission: true });
  await seed(
    "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='chat'",
  );
  const historical = await record(
    "historical permission fact cannot alter replacement placement",
    (i) => c.evidence(i, { permissionPolicy: claim() }),
  );
  for (const value of historical) {
    assert.equal(value.application.status, "applied");
    assert.equal(value.permissionPolicyPublished, false);
  }
  await snapshot(
    "historical evidence retained without current permission publication",
  );
  c = await setup({ permission: true, selected: ":yolo" });
  await seed(
    "UPDATE projects SET worktree_policy='required-for-writes' WHERE id='github'",
  );
  const prohibited = await record(
    "historical write permission cannot defeat primary policy",
    (i) => c.evidence(i, { permissionPolicy: claim(":yolo") }),
  );
  for (const value of prohibited) {
    assert.equal(value.application.status, "applied");
    assert.equal(value.permissionPolicyPublished, false);
  }
  await snapshot("forced read-only policy keeps historical evidence only");

  c = await setup({ permission: true });
  const replacement = {
    ...settingsSnapshot,
    context: {
      ...settingsSnapshot.context,
      runtimeGeneration: "replacement-runtime",
      settingsVersion: { epoch: "replacement-epoch", revision: "0" },
    },
  };
  const rotated = await refresh("actual replacement native read", replacement);
  const old = await record("old runtime evidence stays historical", (i) =>
    c.evidence(i, { permissionPolicy: claim() }),
  );
  for (const value of old) assert.equal(value.permissionPolicyPublished, false);
  for (const changes of [
    {
      recoveryBindingId: "stale-binding",
      permissionPolicy: claim(":read-only", "replacement-epoch", "0"),
    },
    { permissionPolicy: claim(":read-only", "wrong-epoch", "0") },
  ])
    await unchanged(
      "permission recovery binding fence " + JSON.stringify(changes),
      (i) =>
        c.evidence(i, {
          eventId: event(2),
          recoveryBindingId: rotated[i].state.binding.bindingId,
          ...changes,
        }),
      { code: "native-permission-recovery-binding" },
    );
  const recovered = await record(
    "permission recovery from actual replacement read",
    (i) =>
      c.evidence(i, {
        eventId: event(2),
        recoveryBindingId: rotated[i].state.binding.bindingId,
        permissionPolicy: claim(":read-only", "replacement-epoch", "0"),
      }),
  );
  for (const value of recovered) {
    assert.equal(value.application.status, "applied");
    assert.equal(value.permissionPolicyPublished, true);
  }
  state = await snapshot("replacement permission source published");
  for (const value of state) {
    assert.equal(
      value.settings[0].state.permissionPolicy.source.runtimeGeneration,
      "replacement-runtime",
    );
    assert.equal(
      value.settings[0].state.permissionPolicy.settingsVersion.epoch,
      "replacement-epoch",
    );
    assert.equal(value.evidence.length, 2);
    assert.equal(
      value.evidence[0].permission_policy.settingsVersion.epoch,
      "epoch",
    );
  }

  for (const table of [
    "native_settings_evidence",
    "native_commands",
    "native_settings_states",
    "chats",
  ]) {
    c = await setup({ permission: true });
    await seed(
      "CREATE FUNCTION fail_evidence() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'evidence fixture failure'; END$$",
    );
    await seed(
      `CREATE TRIGGER fail_evidence BEFORE ${table === "native_settings_evidence" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_evidence()`,
    );
    await unchanged(
      "evidence transaction failure on " + table,
      (i) => c.evidence(i, { permissionPolicy: claim() }),
      { sqlstate: "P0001" },
    );
    await seed(`DROP TRIGGER fail_evidence ON ${table}`);
    await seed("DROP FUNCTION fail_evidence()");
  }
  await runEvidenceRevisionCases({
    seed,
    observe,
    snapshot,
    command,
    setup,
    record,
    unchanged,
    claim,
    event,
    session,
  });
}
