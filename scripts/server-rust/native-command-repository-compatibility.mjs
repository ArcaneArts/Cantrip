// Actual repositories and storage; this grows through the complete command lifecycle.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { runNativeSettingsCases } from "./native-settings-repository-cases.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
import {
  nativeCommandSessionSchema,
  nativeCommandIntentSchema,
  managedNativeServerRequests,
  nativePendingRequestSchema,
} from "../../packages/protocol/dist/index.js";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-native-command-"));
const pair = [],
  urls = [];
let pg, executable, failure;
const standalone = "99999999-9999-4999-8999-000000000001",
  scratch = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const report = {
  suite: "actual-native-command-repositories",
  databaseMode,
  completeReplacement: false,
  lifecycleComplete: false,
  cases: [],
  snapshots: [],
};
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const bindingAliases = [new Map(), new Map()];
function compared(value, index) {
  if (Array.isArray(value)) return value.map((v) => compared(v, index));
  if (value && typeof value === "object") {
    const result = Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, compared(v, index)]),
    );
    if (value.operationId && value.operationGeneration && value.updatedAt) {
      assert.equal(new Date(value.updatedAt).toISOString(), value.updatedAt);
      result.updatedAt = "<receipt-clock>";
    }
    if (value.operation_id && value.operation_generation && value.updated_at)
      result.updated_at = "<receipt-clock>";
    if (value.chat_id && value.state !== undefined && value.updated_at) {
      assert.ok(Number.isFinite(Date.parse(value.updated_at)));
      result.updated_at = "<settings-clock>";
    }
    if (
      typeof value.bindingId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value.bindingId,
      )
    ) {
      const aliases = bindingAliases[index];
      if (!aliases.has(value.bindingId))
        aliases.set(value.bindingId, "<binding-" + aliases.size + ">");
      result.bindingId = aliases.get(value.bindingId);
    }
    return result;
  }
  return value;
}
async function seed(statements) {
  for (const [i, r] of pair.entries()) {
    const actual =
      typeof statements === "function" ? statements(i) : statements;
    for (const sql of Array.isArray(actual) ? actual : [actual])
      await r.seed(sql);
  }
}
async function observe(name, request, { error = null } = {}) {
  report.lastOperation = { name, request };
  const outcomes = [];
  const requests = [];
  for (const [i, r] of pair.entries()) {
    const operation = {
      owner,
      worker: "alpha",
      operation: "command",
      generation: "generation",
      chat: "chat",
      ...(typeof request === "function" ? request(i) : request),
    };
    requests.push(operation);
    const started = Date.now();
    const value = await r.request(operation);
    if (operation.op === "native-command-bind-preparation" && !value.rejected) {
      const at = Date.parse(value.value.updatedAt);
      assert.ok(
        at >= started - 1000 && at <= Date.now() + 1000,
        "actual bind update clock",
      );
    }
    outcomes.push(value);
  }
  report.cases.push({ name, requests, outcomes });
  for (const result of outcomes) {
    assert.equal(result.rejected, !!error, name + ": " + result.diagnostic);
    if (error?.code) {
      assert.equal(result.commandError, error.code);
      assert.equal(result.commandStatus, error.status ?? 404);
    }
    if (error?.sqlstate) assert.equal(result.databaseCode, error.sqlstate);
  }
  if (error && !error.sqlstate)
    assert.equal(outcomes[1].diagnostic, outcomes[0].diagnostic, name);
  else if (!error)
    assert.deepEqual(
      compared(outcomes[1].value, 1),
      compared(outcomes[0].value, 0),
      name,
    );
  return outcomes.map((o) => o.value);
}
async function snapshot(name) {
  const values = [];
  for (const r of pair) {
    const value = await r.request({
      op: "query-json",
      sql: "SELECT jsonb_build_object('commands',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_commands n),'activations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY chat_id) FROM native_command_activations a),'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'runtimes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM chat_runtime_sessions r),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chat_execution_lanes l),'settings',(SELECT jsonb_agg(to_jsonb(n) ORDER BY chat_id) FROM native_settings_states n),'handoffs',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_runtime_handoffs n),'pending',(SELECT jsonb_agg(to_jsonb(n) ORDER BY chat_id,runtime_generation,native_request_id) FROM native_pending_requests n)) result",
    });
    assert.equal(value.rejected, false, value.diagnostic);
    values.push(value.value);
  }
  assert.deepEqual(compared(values[1], 1), compared(values[0], 0), name);
  report.snapshots.push({ name, values });
  return values;
}
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || databaseMode === "postgres")
        ? await pg.database()
        : undefined;
    pair.push(await open(kind, i));
  }
  await seed(targetStateSql());
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label,created_at,updated_at,last_used_at) VALUES('task',${literal(owner)},'github','alpha','github-alpha-main','task',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
  );
  for (const r of pair) {
    const result = await r.request({
      op: "transaction",
      statements: [
        `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(standalone)},${literal(owner)},'standalone','alpha',${literal(scratch)},NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
        `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES(${literal(scratch)},${literal(standalone)},${literal(owner)},'alpha','ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',${literal(stamp)},${literal(stamp)})`,
      ],
    });
    assert.equal(result.rejected, false, result.diagnostic);
  }
  await seed(`UPDATE chats SET last_used_at=${literal(stamp)}`);
  const identity = nativeCommandSessionSchema.parse({
    chatId: "chat",
    threadId: "thread",
    contextKind: "project",
    projectId: "github",
    placementId: "github-alpha-main",
    modelRouteId: null,
    providerAccountId: null,
    runtimeGeneration: null,
    connectionId: null,
  });
  await seed(
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,created_at,updated_at) VALUES('command',${literal(owner)},'alpha','chat','generation','gui','turn/start','start',repeat('a',64),${json(label("chat").protectedLabel.envelope)},${json(identity)},${json(nativeCommandIntentSchema.parse({ scope: "thread" }))},'accepted','2026-10-25T00:00:00.123999Z',${literal(stamp)})`,
  );
  const initial = await snapshot("initial command query state");
  for (const op of ["native-command-lookup", "native-command-get"]) {
    const result = await observe("owned " + op, { op });
    for (const value of result) {
      assert.equal(value.startsExecution, true);
      assert.equal(value.createdAt, stamp);
    }
    await observe(
      "missing " + op,
      { op, operation: "missing" },
      op.endsWith("get") ? { error: { code: "operation-not-found" } } : {},
    );
    for (const extra of [{ owner: other }, { worker: "beta" }])
      await observe(
        "ownership " + op + JSON.stringify(extra),
        { op, ...extra },
        op.endsWith("get") ? { error: { code: "operation-not-found" } } : {},
      );
  }
  await observe(
    "generation fence",
    { op: "native-command-get", generation: "stale" },
    { error: { code: "operation-not-found" } },
  );
  for (const op of ["native-command-context", "native-command-locked-context"])
    for (const chat of ["chat", "task", standalone])
      await observe(op + " " + chat, { op, chat });
  for (const op of ["native-command-context", "native-command-locked-context"])
    for (const extra of [{ chat: "missing" }, { owner: other }])
      await observe(
        "context owner/missing " + op + JSON.stringify(extra),
        { op, ...extra },
        op.includes("locked") ? { error: { code: "chat-not-found" } } : {},
      );
  assert.deepEqual(
    await snapshot("all command reads preserve exact state"),
    initial,
  );
  for (const application of [
    null,
    false,
    {
      nativeOperationId: "settings",
      submissionId: null,
      status: "pending",
      evidenceCount: 0,
    },
  ]) {
    await seed(
      `UPDATE native_commands SET settings_application=${json(application)} WHERE operation_id='command'`,
    );
    const values = await observe(
      "receipt settings projection " + JSON.stringify(application),
      { op: "native-command-get" },
    );
    for (const value of values)
      assert.equal("settingsApplication" in value, !!application);
  }
  for (const identity of [{}, null, 0]) {
    await seed(
      `UPDATE native_commands SET identity=${json(identity)} WHERE operation_id='command'`,
    );
    await observe(
      "invalid stored receipt identity " + JSON.stringify(identity),
      { op: "native-command-get" },
      { error: {} },
    );
  }
  await seed(
    `UPDATE native_commands SET identity=${json(identity)} WHERE operation_id='command'`,
  );
  const input = {
    workerId: "alpha",
    operationId: "command",
    origin: "gui",
    session: identity,
    method: "turn/start",
    payloadDigest: "a".repeat(64),
    protectedPayload: label("chat").protectedLabel.envelope,
    expectedActivationGeneration: null,
    intent: nativeCommandIntentSchema.parse({ scope: "thread" }),
  };
  const replay = (input, extra = {}) => ({
    op: "native-command-existing-admission",
    input,
    ...extra,
  });
  const original = await snapshot("before existing admission replays");
  const accepted = await observe(
    "existing admission returns original receipt",
    replay(input),
  );
  for (const value of accepted) {
    assert.equal(value.replayed, true);
    assert.ok(value.execution);
  }
  await observe(
    "replay ignores replaced caller session and opaque reencryption",
    replay({
      ...input,
      session: {
        ...identity,
        threadId: "new-thread",
        modelRouteId: "new-route",
      },
      expectedActivationGeneration: "stale",
      protectedPayload: {
        ...input.protectedPayload,
        ciphertext: Buffer.alloc(32, 7).toString("base64url"),
      },
    }),
  );
  await observe(
    "replay sorts only outer intent entries",
    replay({
      ...input,
      intent: { expectedTurnId: null, settingKeys: [], scope: "thread" },
    }),
  );
  for (const changed of [
    { workerId: "beta" },
    { payloadDigest: "b".repeat(64) },
    { method: "skills/list" },
    { origin: "terminal" },
    { session: { ...identity, chatId: "task" } },
    { intent: { ...input.intent, settingKeys: ["model"] } },
  ])
    await observe(
      "replay operation identity conflict " + JSON.stringify(changed),
      replay({ ...input, ...changed }),
      { error: { code: "operation-id-conflict", status: 409 } },
    );
  await observe(
    "replay ownership lock precedes receipt identity",
    replay(input, { owner: other }),
    { error: { code: "chat-not-found" } },
  );
  assert.deepEqual(
    await snapshot("replays preserve every stored row"),
    original,
  );
  for (const status of ["running", "waiting-for-approval", "idle"]) {
    await seed(`UPDATE chats SET status=${literal(status)} WHERE id='chat'`);
    const before = await snapshot("before idle/active replay " + status);
    const result = await observe(
      "activation-free replay " + status,
      replay(input),
    );
    for (const value of result)
      assert.equal(value.execution !== null, status === "idle");
    assert.deepEqual(await snapshot("replay is read-only " + status), before);
  }
  await seed(
    "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='chat'",
  );
  for (const value of await observe(
    "replaced placement retains receipt without execution",
    replay(input),
  ))
    assert.equal(value.execution, null);
  await seed(
    "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-main' WHERE id='chat'",
  );
  const nested = nativeCommandIntentSchema.parse({
    scope: "thread",
    settingKeys: ["permissions"],
    nativeSettingsOperationId: "settings",
    settingsBindingId: "binding",
    permissionTransition: {
      selectedId: null,
      resolvedSelectedId: ":workspace",
      effectiveId: ":workspace",
      expectedRevision: "0",
    },
  });
  await seed(
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,created_at,updated_at) SELECT 'nested',owner_id,worker_id,chat_id,'nested-generation',origin,'thread/settings/update','settings',payload_digest,protected_payload,identity,${json(nested)},status,created_at,updated_at FROM native_commands WHERE operation_id='command'`,
  );
  const nestedInput = {
    ...input,
    operationId: "nested",
    method: "thread/settings/update",
    intent: nested,
  };
  await observe(
    "nested JSONB intent order remains Source idempotency behavior",
    replay(nestedInput),
    { error: { code: "operation-id-conflict", status: 409 } },
  );
  const stored = [];
  for (const r of pair) {
    const value = await r.request({
      op: "query-json",
      sql: "SELECT intent result FROM native_commands WHERE operation_id='nested'",
    });
    assert.equal(value.rejected, false, value.diagnostic);
    stored.push(value.value);
  }
  await observe("database ordered nested intent replays", (i) =>
    replay({ ...nestedInput, intent: stored[i] }),
  );
  await seed([
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,runtime_session_id,created_at,updated_at) VALUES('lane','chat','github-alpha-main','alpha','user',false,'Managed native command','active','runtime',${literal(stamp)},${literal(stamp)})`,
    "UPDATE chats SET status='running' WHERE id='chat'",
    "UPDATE native_commands SET activation_generation='activation',execution_lane_id='lane' WHERE operation_id='command'",
    `INSERT INTO native_command_activations(chat_id,generation,operation_id,execution_lane_id,worker_id,runtime_generation,native_turn_id,created_at) VALUES('chat','activation','command','lane','alpha','runtime-generation','turn',${literal(stamp)})`,
  ]);
  for (const value of await observe(
    "exact current activation permits replay",
    replay(input),
  ))
    assert.ok(value.execution);
  for (const [sql, name, repair] of [
    [
      "UPDATE native_command_activations SET active=false WHERE chat_id='chat'",
      "inactive activation",
      "UPDATE native_command_activations SET active=true WHERE chat_id='chat'",
    ],
    [
      "UPDATE native_command_activations SET generation='replaced' WHERE chat_id='chat'",
      "replaced activation",
      "UPDATE native_command_activations SET generation='activation' WHERE chat_id='chat'",
    ],
    [
      "UPDATE chat_execution_lanes SET state='suspended' WHERE id='lane'",
      "missing current lane",
      "UPDATE chat_execution_lanes SET state='active' WHERE id='lane'",
    ],
  ]) {
    await seed(sql);
    for (const value of await observe(name + " retains receipt", replay(input)))
      assert.equal(value.execution, null);
    await seed(repair);
  }
  const dispatch = {
    workerId: "alpha",
    operationId: "command",
    operationGeneration: "generation",
    payloadDigest: "a".repeat(64),
    session: {
      ...identity,
      runtimeGeneration: "runtime-generation",
      connectionId: "connection",
    },
  };
  const bind = (input = dispatch, extra = {}) => ({
    op: "native-command-bind-preparation",
    input,
    ...extra,
  });
  const resetBinding = async () =>
    seed([
      `UPDATE native_commands SET identity=${json(identity)},kind='start',origin='gui',status='accepted',activation_generation='activation',execution_lane_id='lane',updated_at=${literal(stamp)} WHERE operation_id='command'`,
      "UPDATE native_command_activations SET active=true,generation='activation',execution_lane_id='lane',runtime_generation=NULL WHERE chat_id='chat'",
      "UPDATE chats SET status='running' WHERE id='chat'",
    ]);
  const rejectedBinding = async (name, request, error) => {
    const before = await snapshot("before " + name);
    await observe(name, request, { error });
    assert.deepEqual(await snapshot("unchanged after " + name), before);
  };
  await resetBinding();
  for (const value of await observe("bind accepted GUI preparation", bind())) {
    assert.equal(value.status, "accepted");
    assert.equal(value.threadId, "thread");
    assert.equal(value.operationGeneration, "generation");
  }
  const bound = await snapshot(
    "bound identity and activation persist together",
  );
  for (const state of bound) {
    const row = state.commands.find((row) => row.operation_id === "command");
    assert.deepEqual(row.identity, dispatch.session);
    assert.equal(state.activations[0].runtime_generation, "runtime-generation");
    // PostgreSQL's JSON timestamp text may omit trailing zeros, but cannot retain sub-ms precision.
    assert.match(row.updated_at, /:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z)$/);
  }
  await observe("repeat exact preparation binding", bind());
  for (const field of ["runtimeGeneration", "connectionId"])
    await rejectedBinding(
      "bound preparation rejects replacement " + field,
      bind({
        ...dispatch,
        session: { ...dispatch.session, [field]: "replacement" },
      }),
      { code: "stale-session", status: 409 },
    );
  await resetBinding();
  for (const [name, changed, extra, error] of [
    ["foreign owner", {}, { owner: other }, { code: "chat-not-found" }],
    [
      "missing operation",
      { operationId: "missing" },
      {},
      { code: "operation-not-found" },
    ],
    [
      "stale operation generation",
      { operationGeneration: "stale" },
      {},
      { code: "operation-not-found" },
    ],
    ["wrong worker", { workerId: "beta" }, {}, { code: "operation-not-found" }],
    [
      "missing Chat lock",
      { session: { ...dispatch.session, chatId: "missing" } },
      {},
      { code: "chat-not-found" },
    ],
    [
      "other owned Chat",
      { session: { ...dispatch.session, chatId: "task" } },
      {},
      { code: "operation-id-conflict", status: 409 },
    ],
    [
      "payload digest",
      { payloadDigest: "b".repeat(64) },
      {},
      { code: "operation-id-conflict", status: 409 },
    ],
    ...[
      "threadId",
      "placementId",
      "projectId",
      "contextKind",
      "modelRouteId",
      "providerAccountId",
      "runtimeGeneration",
      "connectionId",
    ].map((field) => [
      "stale or absent session " + field,
      {
        session: {
          ...dispatch.session,
          [field]: ["runtimeGeneration", "connectionId", "threadId"].includes(
            field,
          )
            ? null
            : "replaced",
        },
      },
      {},
      { code: "stale-session", status: 409 },
    ]),
  ])
    await rejectedBinding(
      "preparation " + name,
      bind({ ...dispatch, ...changed }, extra),
      error,
    );
  for (const [sql, name, error] of [
    [
      "UPDATE native_commands SET kind='read' WHERE operation_id='command'",
      "wrong kind",
      { code: "preparation-no-longer-accepted", status: 409 },
    ],
    [
      "UPDATE native_commands SET origin='terminal' WHERE operation_id='command'",
      "wrong origin",
      { code: "preparation-no-longer-accepted", status: 409 },
    ],
    [
      "UPDATE native_commands SET status='applied' WHERE operation_id='command'",
      "already applied",
      { code: "preparation-no-longer-accepted", status: 409 },
    ],
    [
      "UPDATE native_commands SET identity='null'::jsonb WHERE operation_id='command'",
      "null prior identity",
      {},
    ],
    [
      "UPDATE native_commands SET identity=identity-'runtimeGeneration' WHERE operation_id='command'",
      "undefined prior runtime generation",
      { code: "stale-session", status: 409 },
    ],
    [
      "UPDATE native_command_activations SET active=false WHERE chat_id='chat'",
      "inactive activation",
      { code: "stale-activation", status: 409 },
    ],
    [
      "UPDATE native_command_activations SET generation='replaced' WHERE chat_id='chat'",
      "replaced activation",
      { code: "stale-activation", status: 409 },
    ],
    [
      "UPDATE native_command_activations SET runtime_generation='replaced' WHERE chat_id='chat'",
      "replaced activation runtime",
      { code: "stale-activation", status: 409 },
    ],
    [
      "UPDATE chats SET status='idle' WHERE id='chat'",
      "idle Chat",
      { code: "stale-activation", status: 409 },
    ],
  ]) {
    await resetBinding();
    await seed(sql);
    await rejectedBinding("preparation " + name, bind(), error);
  }
  await resetBinding();
  await seed("UPDATE chats SET status='waiting-for-approval' WHERE id='chat'");
  await observe("preparation binding during approval", bind());
  for (const [name, body, error] of [
    [
      "database failure after activation update",
      "RAISE EXCEPTION 'controlled second-write failure' USING ERRCODE='P0001';",
      { sqlstate: "P0001" },
    ],
    ["suppressed command update after activation update", "RETURN NULL;", {}],
    [
      "invalid receipt identity after both writes",
      "NEW.identity='null'::jsonb; RETURN NEW;",
      {},
    ],
    [
      "invalid receipt timestamp after both writes",
      "NEW.updated_at='infinity'::timestamptz; RETURN NEW;",
      {},
    ],
  ]) {
    await resetBinding();
    await seed([
      `CREATE FUNCTION command_bind_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT runtime_generation FROM native_command_activations WHERE chat_id=NEW.chat_id) IS DISTINCT FROM 'runtime-generation' THEN RAISE EXCEPTION 'activation update not observed' USING ERRCODE='P0002'; END IF; ${body} END $$`,
      "CREATE TRIGGER command_bind_fault BEFORE UPDATE ON native_commands FOR EACH ROW WHEN (OLD.operation_id='command') EXECUTE FUNCTION command_bind_fault()",
    ]);
    await rejectedBinding("preparation rollback: " + name, bind(), error);
    await seed([
      "DROP TRIGGER command_bind_fault ON native_commands",
      "DROP FUNCTION command_bind_fault()",
    ]);
  }
  await resetBinding();
  await observe("successful bind after rolled-back failures", bind());
  const pendingInput = nativePendingRequestSchema.parse({
    workerId: "alpha",
    session: dispatch.session,
    activationGeneration: "activation",
    nativeRequestId: "request",
    requestMethod: [...managedNativeServerRequests][0],
    turnId: "turn",
  });
  const pending = (input = pendingInput, extra = {}) => ({
    op: "native-command-register-pending",
    input,
    ...extra,
  });
  for (const requestMethod of managedNativeServerRequests) {
    const input = {
      ...pendingInput,
      nativeRequestId: "request:" + requestMethod,
      requestMethod,
    };
    await observe(
      "register managed native request " + requestMethod,
      pending(input),
    );
    const before = await snapshot("registered native request " + requestMethod);
    await observe(
      "repeat exact native request " + requestMethod,
      pending(input),
    );
    assert.deepEqual(
      await snapshot("native request replay is read-only " + requestMethod),
      before,
    );
  }
  await observe(
    "register pending request with null turn",
    pending({ ...pendingInput, turnId: null }),
  );
  await observe(
    "repeat pending request with null turn",
    pending({ ...pendingInput, turnId: null }),
  );
  // Source fences this operation by placement, route and activation, not connection ID or Chat status.
  await observe(
    "native request does not require caller connection identity",
    pending({
      ...pendingInput,
      nativeRequestId: "other-connection",
      session: { ...dispatch.session, connectionId: null },
    }),
  );
  await seed("UPDATE chats SET status='idle' WHERE id='chat'");
  await observe(
    "active native request registration preserves Source status semantics",
    pending({ ...pendingInput, nativeRequestId: "idle-status" }),
  );
  await seed("UPDATE chats SET status='running' WHERE id='chat'");
  for (const [name, changed, extra, code] of [
    ["foreign owner", {}, { owner: other }, "chat-not-found"],
    [
      "missing Chat",
      { session: { ...dispatch.session, chatId: "missing" } },
      {},
      "chat-not-found",
    ],
    ["wrong worker", { workerId: "beta" }, {}, "stale-native-request"],
    [
      "wrong thread",
      { session: { ...dispatch.session, threadId: "replaced" } },
      {},
      "stale-native-request",
    ],
    [
      "wrong route",
      { session: { ...dispatch.session, modelRouteId: "replaced" } },
      {},
      "stale-native-request",
    ],
    [
      "wrong placement",
      { session: { ...dispatch.session, placementId: "replaced" } },
      {},
      "stale-native-request",
    ],
    [
      "wrong runtime",
      { session: { ...dispatch.session, runtimeGeneration: "replaced" } },
      {},
      "stale-native-request",
    ],
    [
      "null runtime",
      { session: { ...dispatch.session, runtimeGeneration: null } },
      {},
      "stale-native-request",
    ],
    [
      "wrong activation",
      { activationGeneration: "replaced" },
      {},
      "stale-native-request",
    ],
    [
      "unsupported method",
      { requestMethod: "unsupported/request" },
      {},
      "stale-native-request",
    ],
    [
      "conflicting turn",
      { turnId: "another-turn" },
      {},
      "native-request-id-conflict",
    ],
    [
      "conflicting method",
      { turnId: null, requestMethod: [...managedNativeServerRequests][1] },
      {},
      "native-request-id-conflict",
    ],
  ])
    await rejectedBinding(
      "pending request " + name,
      pending({ ...pendingInput, ...changed }, extra),
      { code, status: code === "chat-not-found" ? 404 : 409 },
    );
  await seed(
    "UPDATE native_pending_requests SET resolution_operation_id='command' WHERE native_request_id='request'",
  );
  await rejectedBinding(
    "resolved native request cannot register again",
    pending({ ...pendingInput, turnId: null }),
    { code: "native-request-id-conflict", status: 409 },
  );
  await seed(
    "UPDATE native_pending_requests SET resolution_operation_id=NULL WHERE native_request_id='request'",
  );
  await seed(
    "UPDATE native_command_activations SET generation='new-activation' WHERE chat_id='chat'",
  );
  await rejectedBinding(
    "pending request retains original activation identity",
    pending({
      ...pendingInput,
      turnId: null,
      activationGeneration: "new-activation",
    }),
    { code: "native-request-id-conflict", status: 409 },
  );
  await seed(
    "UPDATE native_command_activations SET generation='activation',active=false WHERE chat_id='chat'",
  );
  await rejectedBinding("inactive native request activation", pending(), {
    code: "stale-native-request",
    status: 409,
  });
  await seed(
    "UPDATE native_command_activations SET active=true WHERE chat_id='chat'",
  );
  await runNativeSettingsCases({
    seed,
    observe,
    snapshot,
    owner,
    other,
    standalone,
    identity,
    dispatch,
  });
  const final = await snapshot("final exact query state");
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  assert.deepEqual(await snapshot("actual backend reopen"), final);
  await observe("receipt after actual reopen", { op: "native-command-get" });
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = pair.map((r) => r.diagnostics());
} finally {
  for (const r of pair)
    try {
      await r.close();
    } catch (error) {
      failure ??= error;
      (report.cleanupFailures ??= []).push(String(error));
    }
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    (report.cleanupFailures ??= []).push(String(error));
  }
  if (failure) report.passed = false;
  if (option("--report")) {
    const p = path.resolve(option("--report"));
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    passed: true,
    lifecycleComplete: false,
  }),
);
