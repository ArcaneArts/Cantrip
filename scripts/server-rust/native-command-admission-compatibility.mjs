// Calls both actual repositories against isolated, migrated databases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { runAdmissionCases } from "./native-command-admission-cases.mjs";
import { runAdmissionRaces } from "./native-command-admission-races.mjs";
import { runEvidenceRaces } from "./native-command-evidence-races.mjs";
import { runLogicalRaces } from "./native-logical-races.mjs";
import { runQueuedPromptRaces } from "./queued-prompt-races.mjs";
import { runQueuedPromptCases } from "./queued-prompt-cases.mjs";
import { runManagedQueueCases } from "./managed-queue-cases.mjs";
import { runManagedQueueRaces } from "./managed-queue-races.mjs";
import { runNativeEventContextCases } from "./native-event-context-cases.mjs";
import { runNativeEventRaces } from "./native-event-races.mjs";
import { runAgentInteractionRaces } from "./agent-interaction-races.mjs";
import { runAgentInteractionCases } from "./agent-interaction-cases.mjs";
import { runNativeModelInventoryCases } from "./native-model-inventory-cases.mjs";
import {
  targetStateSql,
  localOwner as owner,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-native-admission-")),
  standalone = "99999999-9999-4999-8999-000000000001",
  scratch = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()],
  counts = [{}, {}];
const startedAt = Date.now();
let executable, pg, failure;
const report = {
  suite: "actual-native-command-admission-repositories",
  databaseMode,
  completeReplacement: false,
  lifecycleComplete: false,
  domain: option("--domain") ?? "all",
  cases: [],
  snapshots: [],
};
function register(value, kind, i) {
  if (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    ) &&
    !aliases[i].has(value)
  ) {
    const n = counts[i][kind] ?? 0;
    counts[i][kind] = n + 1;
    aliases[i].set(value, `<${kind}-${n}>`);
  }
}
function normalized(value, i, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalized(v, i));
  if (
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "next_attempt_milliseconds")
  ) {
    const { next_attempt_milliseconds: milliseconds, ...row } = value;
    const time = Number(milliseconds);
    assert.ok(
      Number.isSafeInteger(time),
      "database completion due milliseconds",
    );
    value = { ...row, next_attempt_at: new Date(time).toISOString() };
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalized(v, i, k)]),
    );
  if (typeof value === "string") {
    if (aliases[i].has(value)) return aliases[i].get(value);
    if (key === "next_attempt_at") {
      const time = Date.parse(value);
      assert.ok(Number.isFinite(time), "valid completion due clock");
      return time >= startedAt - 1000 && time <= Date.now() + 1000
        ? "<clock>"
        : new Date(time).toISOString();
    }
    if (
      [
        "resolvedAt",
        "resolved_at",
        "createdAt",
        "updatedAt",
        "created_at",
        "updated_at",
        "activated_at",
        "released_at",
        "logical_completed_at",
        "execution_completed_at",
        "notification_due_at",
        "executionLaneActivatedAt",
      ].includes(key)
    ) {
      assert.ok(
        Number.isFinite(Date.parse(value)),
        `valid clock: ${key}=${value}`,
      );
      if (Date.parse(value) === Date.parse(stamp)) return "<seed-clock>";
      assert.ok(
        Date.parse(value) >= startedAt - 1000 &&
          Date.parse(value) <=
            Date.now() + (key === "notification_due_at" ? 6000 : 1000),
        `live database clock: ${key}=${value}`,
      );
      return "<clock>";
    }
  }
  return value;
}
async function seed(statements) {
  for (const [i, r] of pair.entries()) {
    const items = typeof statements === "function" ? statements(i) : statements;
    for (const sql of Array.isArray(items) ? items : [items]) await r.seed(sql);
  }
}
async function snapshot(name) {
  const values = [];
  for (const [i, r] of pair.entries()) {
    const result = await r.request({
      op: "query-json",
      sql: "SELECT jsonb_build_object('commands',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_commands n),'activations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY chat_id) FROM native_command_activations a),'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY chat_id,created_at) FROM chat_execution_lanes l),'runtimes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id,worktree_id,scratch_root_id) FROM chat_runtime_sessions r),'leases',(SELECT jsonb_agg(to_jsonb(b) ORDER BY project_id,branch_name,created_at) FROM project_branch_leases b),'queues',(SELECT jsonb_agg(to_jsonb(q) ORDER BY chat_id) FROM managed_queue_states q),'claims',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM managed_queue_claims q),'interactions',(SELECT jsonb_agg(to_jsonb(i) ORDER BY request_key) FROM agent_interaction_requests i),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'queueInputs',(SELECT jsonb_agg(to_jsonb(q) ORDER BY claim_id) FROM managed_queue_input_snapshots q),'queueImports',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM managed_queue_imports q),'prompts',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM queued_prompts q),'pending',(SELECT jsonb_agg(to_jsonb(n) ORDER BY chat_id,runtime_generation,native_request_id) FROM native_pending_requests n),'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY chat_id) FROM native_settings_states s),'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM native_settings_evidence e),'turns',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_id) FROM native_command_turns t),'completions',(SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('next_attempt_milliseconds',floor(extract(epoch FROM c.next_attempt_at)*1000)::text) ORDER BY root_operation_id) FROM native_logical_completions c)) result",
    });
    assert.equal(result.rejected, false, result.diagnostic);
    const value = result.value;
    for (const [key, kind] of [
      ["lanes", "lane"],
      ["runtimes", "runtime"],
      ["leases", "lease"],
    ])
      for (const row of value[key] ?? []) register(row.id, kind, i);
    for (const row of value.interactions ?? [])
      register(row.id, "interaction", i);
    for (const row of value.commands ?? [])
      register(row.operation_generation, "operation", i);
    for (const row of value.activations ?? [])
      register(row.generation, "activation", i);
    for (const row of value.claims ?? []) register(row.id, "claim", i);
    values.push(value);
  }
  report.snapshots.push({ name, values });
  const canonical = (value, i) => {
    const result = normalized(value, i);
    // These raw relational tables are queried by random UUID. Compare every
    // row/field using the already-established identity aliases, then sort by
    // that canonical identity. Public repository/API list order is untouched.
    for (const [table, key] of [
      ["claims", "id"],
      ["queueInputs", "claim_id"],
    ]) {
      result[table]?.sort((a, b) =>
        a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0,
      );
    }
    return result;
  };
  assert.deepEqual(canonical(values[1], 1), canonical(values[0], 0), name);
  return values;
}
async function observe(
  name,
  input,
  {
    options = {},
    op = "native-command-admit",
    shape = "admission",
    requestOwner = owner,
    error = false,
    code,
    sqlstate,
    status = "accepted",
    rejection,
  } = {},
) {
  report.lastOperation = { name };
  const outcomes = [],
    requests = [];
  for (const [i, r] of pair.entries()) {
    const actual = typeof input === "function" ? input(i) : input;
    const request =
      shape === "raw"
        ? { op, owner: requestOwner, ...actual }
        : {
            op,
            owner: requestOwner,
            input: actual,
            options: typeof options === "function" ? options(i) : options,
          };
    requests.push(request);
    const from = Date.now(),
      result = await r.request(request);
    outcomes.push(result);
    if (op === "native-command-interaction" && result.value?.id)
      register(result.value.id, "interaction", i);
    if (
      op.startsWith("native-command-prompt-") &&
      request.action === "create-visible"
    )
      register(result.value?.id, "prompt", i);
    if (
      op.startsWith("native-command-managed-queue-") &&
      request.action === "claim-next"
    )
      register(result.value?.id, "claim", i);
    if (
      op === "native-command-event-context" &&
      request.action?.startsWith("interaction") &&
      result.value?.saved?.id
    )
      register(result.value.saved.id, "interaction", i);
    if (result.value?.state?.binding?.bindingId)
      register(result.value.state.binding.bindingId, "binding", i);
    const receipt = shape === "receipt" ? result.value : result.value?.receipt;
    if (receipt) {
      register(receipt.operationGeneration, "operation", i);
      register(receipt.activationGeneration, "activation", i);
      register(receipt.executionLaneId, "lane", i);
      if (!result.value.replayed)
        for (const key of ["createdAt", "updatedAt"]) {
          assert.equal(
            new Date(receipt[key]).toISOString(),
            receipt[key],
            name,
          );
          if (
            op === "native-command-admit" ||
            (op === "native-command-dispatch" && key === "updatedAt")
          )
            assert.ok(
              Date.parse(receipt[key]) >= from - 1000 &&
                Date.parse(receipt[key]) <= Date.now() + 1000,
              name + " admission clock",
            );
        }
    }
  }
  report.cases.push({ name, requests, outcomes });
  for (const result of outcomes) {
    assert.equal(result.rejected, error, name + ": " + result.diagnostic);
    if (code) assert.equal(result.commandError, code, name);
    if (sqlstate) assert.equal(result.databaseCode, sqlstate, name);
    if (!error && shape !== "raw") {
      const receipt = shape === "receipt" ? result.value : result.value.receipt;
      assert.equal(receipt.status, status, name);
      if (rejection) assert.equal(receipt.rejectionCode, rejection, name);
    }
  }
  if (!error)
    assert.deepEqual(
      normalized(outcomes[1].value, 1),
      normalized(outcomes[0].value, 0),
      name,
    );
  else if (!sqlstate)
    assert.deepEqual(
      {
        code: outcomes[1].commandError,
        status: outcomes[1].commandStatus,
        message: outcomes[1].diagnostic,
        interactionError: outcomes[1].interactionError,
      },
      {
        code: outcomes[0].commandError,
        status: outcomes[0].commandStatus,
        message: outcomes[0].diagnostic,
        interactionError: outcomes[0].interactionError,
      },
      name,
    );
  return outcomes.map((r) => r.value);
}
async function reset() {
  await seed([
    "DELETE FROM native_pending_requests",
    "DELETE FROM native_command_activations",
    "DELETE FROM managed_queue_claims",
    "DELETE FROM native_runtime_handoffs",
    "DELETE FROM native_commands",
    "DELETE FROM chat_execution_lanes",
    "DELETE FROM chat_runtime_sessions",
    "DELETE FROM native_settings_states",
    "DELETE FROM queued_prompts",
    "DELETE FROM chat_relocation_jobs",
    "DELETE FROM chat_import_jobs",
    `UPDATE chats SET status='idle',automation_paused=false,managed_autonomy_stopped=false,has_unread_completion=false,managed_input_revision=0,archived_at=NULL,reasoning_effort=NULL,permission_profile_id=NULL,updated_at=${literal(stamp)},last_used_at=${literal(stamp)}`,
    "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-main' WHERE id='chat'",
    "UPDATE project_worktrees SET branch='main',detached=false,lifecycle_state='ready'",
    "UPDATE project_sources SET removed_at=NULL",
    "UPDATE projects SET worktree_policy='agent-managed' WHERE id='github'",
    "UPDATE managed_queue_states SET revision=0",
    "UPDATE user_settings SET default_chat_permission_profile_id=':workspace'",
  ]);
}
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
async function reopen(name) {
  const before = await snapshot("before " + name);
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  const after = await snapshot(name);
  assert.deepEqual(after, before, name);
  (report.reopens ??= []).push({ name, passed: true });
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
  await seed([
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label,created_at,updated_at,last_used_at) VALUES('task',${literal(owner)},'github','alpha','github-alpha-main','task',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO managed_queue_states(chat_id,notification_due_at) VALUES('chat',${literal(stamp)})`,
  ]);
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
  await reset();
  const runCases =
    report.domain === "prompts"
      ? runQueuedPromptCases
      : report.domain === "managed-queue"
        ? runManagedQueueCases
        : report.domain === "events"
          ? runNativeEventContextCases
          : report.domain === "models"
            ? runNativeModelInventoryCases
            : report.domain === "interactions"
              ? runAgentInteractionCases
              : runAdmissionCases;
  await runCases({
    pair,
    seed,
    snapshot,
    observe,
    reset,
    owner,
    standalone,
    scratch,
    report,
    register,
    reopen,
  });
  if (
    databaseMode === "postgres" &&
    report.domain !== "prompts" &&
    report.domain !== "managed-queue" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions"
  )
    await runAdmissionRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      snapshot,
      report,
      register,
      normalized,
    });
  if (
    databaseMode === "postgres" &&
    report.domain !== "prompts" &&
    report.domain !== "managed-queue" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions"
  )
    await runEvidenceRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      seed,
      observe,
      snapshot,
      report,
      normalized,
    });
  await reopen("actual admission backend reopen");
  if (
    databaseMode === "postgres" &&
    report.domain !== "prompts" &&
    report.domain !== "managed-queue" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions"
  )
    await runLogicalRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      seed,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
  if (
    databaseMode === "postgres" &&
    report.domain !== "managed-queue" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions"
  )
    await runQueuedPromptRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
  if (
    databaseMode === "postgres" &&
    report.domain !== "prompts" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions"
  )
    await runManagedQueueRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      seed,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
  if (
    databaseMode === "postgres" &&
    ["all", "interactions"].includes(report.domain)
  )
    await runAgentInteractionRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      seed,
      observe,
      snapshot,
      report,
      normalized,
    });
  report.passed = true;
  if (databaseMode === "postgres" && ["all", "events"].includes(report.domain))
    await runNativeEventRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      seed,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
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
