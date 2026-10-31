import assert from "node:assert/strict";
import { json } from "./project-target-state.mjs";
export async function runEvidenceRevisionCases({
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
}) {
  for (const status of ["accepted", "uncertain", "rejected"]) {
    const late = await setup();
    await seed(`UPDATE native_commands SET status='${status}'`);
    const values = await record(
      "native application evidence after transport " + status,
      (i) => late.evidence(i),
    );
    for (const value of values)
      assert.equal(value.application.status, "applied");
    const stored = await snapshot(
      "late native application retains transport status " + status,
    );
    for (const value of stored) {
      assert.equal(value.commands[0].status, status);
      assert.equal(value.settings[0].state.desiredStatus, "applied");
    }
  }
  let c = await setup();
  await record("global evidence identity first operation", (i) =>
    c.evidence(i),
  );
  let second = await observe("admit second settings operation", (i) =>
    command({
      operationId: "second",
      session,
      method: "thread/settings/update",
      intent: { ...c.intent, settingsBindingId: c.bindings[i] },
    }),
  );
  await observe(
    "dispatch second settings operation",
    (i) => ({
      ...c.dispatchInput(i),
      operationId: "second",
      operationGeneration: second[i].receipt.operationGeneration,
    }),
    { op: "native-command-dispatch", status: "dispatched" },
  );
  await unchanged(
    "event id cannot be reused by another operation",
    (i) => ({
      ...c.evidence(i),
      operationId: "second",
      operationGeneration: second[i].receipt.operationGeneration,
    }),
    { code: "native-settings-evidence-conflict" },
  );
  c = await setup({ permission: true });
  await record("confirm original native permission version", (i) =>
    c.evidence(i, { permissionPolicy: claim() }),
  );
  let state = await snapshot("confirmed version before recovery replay");
  const original = state;
  const older = await record(
    "older recovered native version is historical only",
    (i) =>
      c.evidence(i, {
        eventId: event(2),
        recoveryBindingId: c.bindings[i],
        permissionPolicy: claim(":read-only", "epoch", "4"),
      }),
  );
  for (const value of older) {
    assert.equal(value.application.status, "applied");
    assert.equal(value.permissionPolicyPublished, false);
  }
  state = await snapshot("older permission proof does not rewind policy");
  for (const [i, value] of state.entries())
    assert.deepEqual(
      value.settings[0].state.permissionPolicy,
      original[i].settings[0].state.permissionPolicy,
    );
  const newer = await record(
    "newer recovery advances native version for same choice",
    (i) =>
      c.evidence(i, {
        eventId: event(3),
        recoveryBindingId: c.bindings[i],
        permissionPolicy: claim(":read-only", "epoch", "6"),
      }),
  );
  for (const value of newer)
    assert.equal(value.permissionPolicyPublished, true);
  state = await snapshot("same operation retains server permission revision");
  for (const value of state) {
    assert.equal(value.settings[0].state.permissionPolicy.revision, "1");
    assert.equal(
      value.settings[0].state.permissionPolicy.settingsVersion.revision,
      "6",
    );
  }
  c = await setup({ permission: true });
  const previous = {
    selectedId: null,
    resolvedSelectedId: ":workspace",
    effectiveId: ":workspace",
    revision: "7",
    operationId: "newer-choice",
    operationGeneration: "newer-generation",
    source: {
      workerId: "alpha",
      threadId: "thread",
      runtimeGeneration: "runtime",
      contextKind: "project",
      projectId: "github",
      placementId: "github-alpha-main",
      modelRouteId: null,
      providerAccountId: null,
    },
    settingsVersion: { epoch: "epoch", revision: "6" },
  };
  await seed(
    `UPDATE native_settings_states SET state=jsonb_set(state,'{permissionPolicy}',${json(previous)})`,
  );
  const stale = await record(
    "stale permission intent cannot replace newer confirmed choice",
    (i) =>
      c.evidence(i, { permissionPolicy: claim(":read-only", "epoch", "7") }),
  );
  for (const value of stale) {
    assert.equal(value.application.status, "applied");
    assert.equal(value.permissionPolicyPublished, false);
  }
  state = await snapshot("newer confirmed policy survives stale applied fact");
  for (const value of state)
    assert.deepEqual(value.settings[0].state.permissionPolicy, previous);
  c = await setup({ permission: true });
  await record("confirm permission before large revision change", (i) =>
    c.evidence(i, { permissionPolicy: claim() }),
  );
  const policyRevision = "184467440737095516160000",
    serverRevision = "999999999999999999999999999";
  await seed(
    `UPDATE native_settings_states SET state=jsonb_set(jsonb_set(state,'{permissionPolicy,revision}',${json(policyRevision)}),'{revision}',${json(serverRevision)})`,
  );
  second = await observe(
    "admit permission at arbitrary precision server revision",
    (i) =>
      command({
        operationId: "second",
        session,
        method: "thread/settings/update",
        intent: {
          ...c.intent,
          settingsBindingId: c.bindings[i],
          permissionTransition: {
            ...c.intent.permissionTransition,
            expectedRevision: policyRevision,
          },
        },
      }),
  );
  await observe(
    "dispatch arbitrary precision permission choice",
    (i) => ({
      ...c.dispatchInput(i),
      operationId: "second",
      operationGeneration: second[i].receipt.operationGeneration,
    }),
    { op: "native-command-dispatch", status: "dispatched" },
  );
  const exact = await record(
    "publish u64 native maximum without losing server precision",
    (i) => ({
      ...c.evidence(i, {
        eventId: event(2),
        permissionPolicy: claim(":read-only", "epoch", "18446744073709551615"),
      }),
      operationId: "second",
      operationGeneration: second[i].receipt.operationGeneration,
    }),
  );
  for (const value of exact)
    assert.equal(value.permissionPolicyPublished, true);
  state = await snapshot(
    "native u64 and unbounded server revisions remain exact",
  );
  for (const value of state) {
    assert.equal(
      value.settings[0].state.permissionPolicy.revision,
      (BigInt(policyRevision) + 1n).toString(),
    );
    assert.equal(
      value.settings[0].state.revision,
      (BigInt(serverRevision) + 4n).toString(),
    );
    assert.equal(
      value.settings[0].state.permissionPolicy.settingsVersion.revision,
      "18446744073709551615",
    );
  }
}
