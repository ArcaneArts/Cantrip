// Execute the reference and native Live authorization read paths on real,
// independently migrated databases. HTTP/transport acceptance is separate.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { projectLabel } from "./security-fixtures.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const binary = await buildRustExample("project-repository-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-live-repository-"));
const owner = "00000000-0000-0000-0000-000000000001",
  other = "11111111-1111-4111-8111-111111111111";
const stamp = "2026-10-25T00:00:00.123Z";
const literal = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const pair = [],
  report = {
    suite: "live-repository-differential",
    databaseMode,
    completeReplacement: false,
    cases: [],
    databaseCases: [],
  };
let postgresOwner, failure;
async function seed(sql) {
  for (const fixture of pair) await fixture.seed(sql);
}
async function transaction(statements) {
  for (const fixture of pair) {
    const result = await fixture.request({ op: "transaction", statements });
    assert.equal(
      result.rejected,
      false,
      `Fixture transaction: ${result.diagnostic}`,
    );
  }
}
async function compare(label, operation, value, rejected = false) {
  const expected = await pair[0].request(operation),
    actual = await pair[1].request(operation);
  const observation = (result) =>
    result.rejected
      ? { rejected: true }
      : { rejected: false, value: result.value };
  try {
    assert.deepEqual(
      observation(expected),
      rejected ? { rejected: true } : { rejected: false, value },
      `Reference must exercise intended outcome: ${label}`,
    );
    assert.deepEqual(observation(actual), observation(expected), label);
  } catch (error) {
    report.failure = { label, operation, actual, expected };
    throw error;
  }
  report.cases.push({
    label,
    operation,
    rejected: expected.rejected,
    value: expected.value,
  });
}
const scope = (label, principal, resource, value, rejected = false) =>
  compare(
    label,
    { op: "scope", owner: principal, scope: resource },
    value,
    rejected,
  );
const project = (id = "project-one") => ({ kind: "project", projectId: id });
const chat = (id = "chat-project") => ({ kind: "chat", chatId: id });
const session = (label, id, principal, value) =>
  compare(
    label,
    { op: "session-active", owner: principal, session: id },
    value,
  );
async function negative(label, sql) {
  const expected = await pair[0].request({ op: "sql", sql }),
    actual = await pair[1].request({ op: "sql", sql });
  assert.equal(
    expected.rejected,
    true,
    `Reference must reject invalid database mutation: ${label}`,
  );
  assert.equal(
    actual.rejected,
    true,
    `Native must reject invalid database mutation: ${label}`,
  );
  report.databaseCases.push({ label, rejected: true });
}
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const kind of ["node", "rust"])
    pair.push(
      await repositoryFixture({
        kind,
        executable: binary,
        root,
        databaseMode,
        databaseUrl:
          postgresOwner && (kind === "node" || databaseMode === "postgres")
            ? await postgresOwner.database()
            : undefined,
      }),
    );
  await scope(
    "current user does not require resource reads",
    owner,
    { kind: "current-user" },
    true,
  );
  await scope("missing project", owner, project(), false);
  await scope("missing chat", owner, chat(), false);
  await session("missing session", "session", owner, false);
  await seed(
    `INSERT INTO users(id,kind,display_name,role,status,email,normalized_email) VALUES (${literal(other)},'account','Other fixture owner','member','active','other@example.invalid','other@example.invalid');`,
  );
  for (const [id, principal] of [
    ["project-one", owner],
    ["project-two", owner],
    ["project-other", other],
  ])
    await seed(
      `INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES (${literal(id)},${literal(principal)},${json(projectLabel)},${literal("fixture-index-" + id)});`,
    );
  await scope("owned project", owner, project(), true);
  await scope("foreign project", other, project(), false);
  await scope(
    "unknown principal cannot access project",
    "unowned",
    project(),
    false,
  );
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('worker',${literal(owner)},'Fixture worker','linux','x64',${literal(stamp)},${literal(stamp)});`,
  );
  await seed(
    "INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES ('source','project-one','worker','/fixture','/fixture');",
  );
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES ('worktree','source','worker','main','/fixture','/fixture',true,'cantrip','ready');",
  );
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label) VALUES ('chat-project',${literal(owner)},'project-one','worktree','worker',${json(projectLabel)});`,
  );
  await scope("project chat without runtime session", owner, chat(), true);
  await scope("foreign project chat", other, chat(), false);
  await scope("unknown principal project chat", "unowned", chat(), false);
  await seed(
    `UPDATE chats SET archived_at=${literal(stamp)} WHERE id='chat-project';`,
  );
  await scope("archived project chat", owner, chat(), false);
  await seed("UPDATE chats SET archived_at=NULL WHERE id='chat-project';");
  await seed(
    "UPDATE projects SET protected_label='{}'::jsonb WHERE id='project-two';",
  );
  await scope(
    "unrelated malformed owned project rejects project authorization",
    owner,
    project(),
    undefined,
    true,
  );
  await scope(
    "malformed catalog does not affect current-user scope",
    owner,
    { kind: "current-user" },
    true,
  );
  await scope(
    "chat authorization uses execution context rather than project summary",
    owner,
    chat(),
    true,
  );
  await scope(
    "another owner catalog remains usable",
    other,
    project("project-other"),
    true,
  );
  await seed(
    `UPDATE projects SET protected_label=${json(projectLabel)} WHERE id='project-two';`,
  );
  await scope(
    "repaired catalog recovers authorization",
    owner,
    project(),
    true,
  );
  for (const value of ["", " ".repeat(3), "x".repeat(81)]) {
    await seed(
      `UPDATE chats SET reasoning_effort=${literal(value)} WHERE id='chat-project';`,
    );
    await scope(
      "invalid stored model configuration rejects chat context",
      owner,
      chat(),
      undefined,
      true,
    );
  }
  await seed(
    "UPDATE chats SET reasoning_effort='  high  ' WHERE id='chat-project';",
  );
  await scope("model configuration trimming is accepted", owner, chat(), true);
  await seed("UPDATE chats SET reasoning_effort=NULL WHERE id='chat-project';");
  await negative(
    "custom subagent configuration requires a model",
    "UPDATE chats SET custom_subagent_model=true WHERE id='chat-project';",
  );
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES ('',${literal(owner)},'Empty model fixture');`,
  );
  await seed("UPDATE chats SET model_id='' WHERE id='chat-project';");
  await scope(
    "existing but invalid model identity rejects context",
    owner,
    chat(),
    undefined,
    true,
  );
  await seed("UPDATE chats SET model_id=NULL WHERE id='chat-project';");
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label) VALUES ('�',${literal(owner)},'project-one','worktree','worker',${json(projectLabel)});`,
  );
  await scope(
    "database text encoding replaces lone UTF16 surrogates in chat parameters",
    owner,
    chat("\ud800"),
    true,
  );
  await seed(
    "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES ('runtime','chat-project','worker','worktree','thread');",
  );
  const source = {
    threadId: "thread",
    workerId: "worker",
    placementId: "worktree",
    modelRouteId: null,
    providerAccountId: null,
    contextKind: "project",
    projectId: "project-one",
  };
  for (const [label, state, rejected] of [
    ["null native state", null, false],
    ["opaque primitive state", 7, false],
    ["no permission policy", {}, false],
    ["false permission policy", { permissionPolicy: false }, false],
    ["truthy policy without source", { permissionPolicy: {} }, true],
    [
      "primitive truthy policy without source",
      { permissionPolicy: "bad" },
      true,
    ],
    ["null policy source", { permissionPolicy: { source: null } }, true],
    [
      "nonmatching primitive source",
      { permissionPolicy: { source: 7 } },
      false,
    ],
    [
      "incomplete source",
      { permissionPolicy: { source: { threadId: "thread" } } },
      false,
    ],
    [
      "matching source without binding",
      { permissionPolicy: { source } },
      false,
    ],
    [
      "matching source with false binding",
      { permissionPolicy: { source }, binding: false },
      false,
    ],
    [
      "nonmatching generation avoids settings access",
      {
        permissionPolicy: { source: { ...source, runtimeGeneration: 1 } },
        binding: { runtimeGeneration: 2 },
      },
      false,
    ],
    [
      "matching undefined generations require settings version",
      { permissionPolicy: { source }, binding: {} },
      true,
    ],
    [
      "matching null generations require settings version",
      {
        permissionPolicy: { source: { ...source, runtimeGeneration: null } },
        binding: { runtimeGeneration: null },
      },
      true,
    ],
    [
      "null and undefined generations differ",
      {
        permissionPolicy: { source: { ...source, runtimeGeneration: null } },
        binding: {},
      },
      false,
    ],
    [
      "matching generation with null settings version",
      {
        permissionPolicy: {
          source: { ...source, runtimeGeneration: 1 },
          settingsVersion: null,
        },
        binding: { runtimeGeneration: 1 },
      },
      true,
    ],
    [
      "primitive settings version property access remains valid",
      { permissionPolicy: { source, settingsVersion: 7 }, binding: {} },
      false,
    ],
    [
      "objects are not strictly equal generation identities",
      {
        permissionPolicy: {
          source: { ...source, runtimeGeneration: { id: 1 } },
        },
        binding: { runtimeGeneration: { id: 1 } },
      },
      false,
    ],
    [
      "arrays are not strictly equal generation identities",
      {
        permissionPolicy: { source: { ...source, runtimeGeneration: [] } },
        binding: { runtimeGeneration: [] },
      },
      false,
    ],
    [
      "confirmed metadata accepted",
      {
        permissionPolicy: {
          source: { ...source, runtimeGeneration: 1 },
          settingsVersion: { epoch: 4 },
        },
        binding: { runtimeGeneration: 1, nativeEpoch: 4 },
      },
      false,
    ],
  ]) {
    await seed(
      `INSERT INTO native_settings_states(chat_id,state) VALUES ('chat-project',${json(state)}) ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state;`,
    );
    await scope(label, owner, chat(), !rejected, rejected);
  }
  await seed(
    `UPDATE native_settings_states SET state=${json({ permissionPolicy: {} })} WHERE chat_id='chat-project';`,
  );
  await seed(
    "UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE id='runtime';",
  );
  await scope(
    "null thread avoids permission policy source access",
    owner,
    chat(),
    true,
  );
  const standalone = "22222222-2222-4222-8222-222222222222",
    scratch = "33333333-3333-4333-8333-333333333333";
  await transaction([
    `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label) VALUES (${literal(standalone)},${literal(owner)},'standalone','worker',${literal(scratch)},NULL,${json(projectLabel)});`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id) VALUES (${literal(scratch)},${literal(standalone)},${literal(owner)},'worker');`,
  ]);
  for (const status of [
    "provisioning",
    "ready",
    "offline",
    "failed",
    "deleting",
  ]) {
    await seed(
      `UPDATE standalone_chat_roots SET status=${literal(status)},protected_path_handle=${literal("ctrr_" + "a".repeat(43))} WHERE id=${literal(scratch)};`,
    );
    await scope(
      `owned standalone root ${status}`,
      owner,
      chat(standalone),
      true,
    );
    await scope(
      `foreign standalone root ${status}`,
      other,
      chat(standalone),
      false,
    );
  }
  await seed(
    `UPDATE standalone_chat_roots SET archived_at=${literal(stamp)},archive_expires_at='2099-01-01' WHERE id=${literal(scratch)};`,
  );
  await scope(
    "root archive metadata alone does not hide the chat context",
    owner,
    chat(standalone),
    true,
  );
  await seed(
    `UPDATE chats SET archived_at=${literal(stamp)} WHERE id=${literal(standalone)};`,
  );
  await scope(
    "archived standalone chat is denied",
    owner,
    chat(standalone),
    false,
  );
  await seed(
    `UPDATE chats SET archived_at=NULL WHERE id=${literal(standalone)};`,
  );
  await negative(
    "standalone active root identity is enforced",
    `UPDATE chats SET active_scratch_root_id='missing' WHERE id=${literal(standalone)};`,
  );
  await seed(
    `INSERT INTO user_sessions(id,user_id,token_hash,csrf_token_hash,auth_method,expires_at) VALUES ('session',${literal(other)},'token-hash','csrf-hash','account-password','2099-01-01');`,
  );
  await session("active account session", "session", other, true);
  await session("session belongs to another owner", "session", owner, false);
  await seed(
    "UPDATE users SET status='disabled' WHERE id=" + literal(other) + ";",
  );
  await session("disabled account session", "session", other, false);
  await seed(
    "UPDATE users SET status='active' WHERE id=" + literal(other) + ";",
  );
  await seed(
    "UPDATE user_sessions SET expires_at='2000-01-01' WHERE id='session';",
  );
  await session("expired account session", "session", other, false);
  await seed(
    "UPDATE user_sessions SET expires_at='2099-01-01',revoked_at=now() WHERE id='session';",
  );
  await session("revoked account session", "session", other, false);
  await seed("UPDATE user_sessions SET revoked_at=NULL WHERE id='session';");
  await session("restored active account session", "session", other, true);
} catch (error) {
  failure = error;
  report.error = error.message;
} finally {
  const cleanups = await Promise.allSettled(pair.map((f) => f.close()));
  const errors = cleanups
    .filter((v) => v.status === "rejected")
    .map((v) => v.reason);
  try {
    await postgresOwner?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Repository scenario/cleanup failure",
    );
  await rm(root, { recursive: true, force: true });
  if (failure) report.error = failure.message;
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      {
        suite: report.suite,
        databaseMode,
        cases: report.cases.length,
        databaseCases: report.databaseCases.length,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
