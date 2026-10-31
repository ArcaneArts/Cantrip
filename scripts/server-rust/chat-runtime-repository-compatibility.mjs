// Real Source/native transactions, canonical bindings and complete durable state.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { managedConsoleCases } from "./managed-console-cases.mjs";
import { chatRuntimeLocks } from "./chat-runtime-locks.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  label,
  json,
  literal,
  stamp,
} from "./project-target-state.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report"),
  started = Date.now();
const root = await mkdtemp(path.join(tmpdir(), "cantrip-chat-runtime-"));
const report = {
  suite: "chat-runtime-repository",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
const standalone = "55555555-5555-4555-8555-555555555551",
  scratch = "55555555-5555-4555-8555-555555555552";
const fixed = new Set([owner, other, standalone, scratch]);
let postgres, executable, failure;
const open = (kind, index) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[index],
  });
const seed = async (sql) => {
  for (const fixture of pair) await fixture.seed(sql);
};
const seedTransaction = async (statements) => {
  for (const fixture of pair) {
    const result = await fixture.request({ op: "transaction", statements });
    assert.equal(result.rejected, false, result.diagnostic);
  }
};
function normalize(value, index, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v, index));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, index, k)]),
    );
  if (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    ) &&
    !fixed.has(value)
  ) {
    if (!aliases[index].has(value))
      aliases[index].set(value, `<generated-runtime:${aliases[index].size}>`);
    return aliases[index].get(value);
  }
  if (
    typeof value === "string" &&
    ["created_at", "updated_at", "createdAt", "updatedAt"].includes(key)
  ) {
    const at = Date.parse(value);
    assert.ok(Number.isFinite(at));
    if (at === Date.parse(stamp)) return "<fixture-time>";
    assert.ok(
      at >= started - 1000 && at <= Date.now() + 1000,
      "Actual write timestamp must belong to this run",
    );
    return "<write-time>";
  }
  return value;
}
async function observe(
  label,
  input,
  { rejected = false, code, diagnostic = true } = {},
) {
  const request = { owner, chat: "chat", ...input };
  const values = await Promise.all(pair.map((repo) => repo.request(request)));
  report.cases.push({ label, request, values });
  assert.equal(values[0].rejected, rejected, "Actual Source outcome: " + label);
  if (code !== undefined)
    assert.equal(values[0].code, code, "Actual Source fence: " + label);
  const observable = (v, index) =>
    v.rejected
      ? {
          rejected: true,
          ...(v.code === undefined ? {} : { code: v.code }),
          ...(v.failure === undefined ? {} : { failure: v.failure }),
          ...(v.trace === undefined ? {} : { trace: v.trace }),
          ...(diagnostic ? { diagnostic: v.diagnostic } : {}),
        }
      : { rejected: false, value: normalize(v.value, index) };
  assert.deepEqual(observable(values[1], 1), observable(values[0], 0), label);
  return values[0].value;
}
async function snapshot(label) {
  const sql =
    "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM chats c),'runtimes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.chat_id,r.worker_id,r.worktree_id,r.scratch_root_id) FROM chat_runtime_sessions r),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM chat_execution_lanes l),'native',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.chat_id) FROM native_settings_states n)) AS result";
  const raw = await Promise.all(
    pair.map((repo) => repo.request({ op: "query-json", sql })),
  );
  raw.forEach((v) => assert.equal(v.rejected, false));
  const values = raw.map((v, i) => normalize(v.value, i));
  report.snapshots.push({ label, raw, values });
  assert.deepEqual(values[1], values[0], label);
  return values[0];
}
const runtime = (label, fields = {}, options) =>
  observe(
    label,
    {
      op: "chat-runtime",
      worker: "alpha",
      worktree: "github-alpha-main",
      thread: "console-thread",
      route: "console-route",
      ...fields,
    },
    options,
  );
const guard = (label, fields = {}, options) =>
  observe(label, { op: "chat-guard", ...fields }, options);
const model = (label, fields = {}, options) =>
  observe(
    label,
    { op: "chat-model", model: "console-model", ...fields },
    options,
  );
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    if (postgres && (kind === "node" || databaseMode === "postgres"))
      urls[i] = await postgres.database();
    pair.push(await open(kind, i));
  }
  for (const sql of targetStateSql()) await seed(sql);
  await seed(
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('console-provider',${literal(owner)},'Console provider','chatgpt','https://api.openai.com/v1'),('other-console-provider',${literal(other)},'Foreign provider','chatgpt','https://api.openai.com/v1');`,
  );
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('console-model',${literal(owner)},'Console'),('console-model-two',${literal(owner)},'Second'),('disabled-model',${literal(owner)},'Disabled'),('foreign-model',${literal(other)},'Foreign');`,
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('console-route','console-model','console-provider','gpt-5',0,true),('console-route-two','console-model-two','console-provider','gpt-5',0,true),('disabled-route','disabled-model','console-provider','gpt-5',0,false),('foreign-route','foreign-model','other-console-provider','gpt-5',0,true);",
  );
  const opaque = label("chat").protectedLabel;
  await seed(
    `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position) VALUES('account-one','console-provider',${json(opaque)},'home-one',0),('account-two','console-provider',${json(opaque)},'home-two',1);`,
  );
  await seedTransaction([
    `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at) VALUES(${literal(standalone)},${literal(owner)},'standalone','alpha',${literal(scratch)},NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)});`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle) VALUES(${literal(scratch)},${literal(standalone)},${literal(owner)},'alpha','ready',${literal("ctrr_" + "a".repeat(43))});`,
  ]);
  await seed(
    `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,worktree_id,scratch_root_id,acquiring_actor,state,created_at,updated_at) VALUES('lane','chat','alpha','github-alpha-main',NULL,'fixture','active',${literal(stamp)},${literal(stamp)}),('scratch-lane',${literal(standalone)},'alpha',NULL,${literal(scratch)},'fixture','active',${literal(stamp)},${literal(stamp)});`,
  );
  // Migration 0235 gives this field a live default. Both isolated stores must
  // start with the same input; retain exact snapshot comparisons of the field.
  await seed(`UPDATE chats SET last_used_at=${literal(stamp)}`);
  for (const id of ["missing", "disabled-model", "foreign-model"])
    assert.equal(await model("unavailable model " + id, { model: id }), null);
  assert.equal(await model("missing chat", { chat: "missing" }), null);
  assert.equal(
    await model("foreign chat owner", { owner: other, model: "foreign-model" }),
    null,
  );
  assert.equal((await model("select model")).modelId, "console-model");
  await model("explicit reasoning", { reasoningEffort: "high" });
  assert.equal(
    (await model("missing reasoning retains selection")).reasoningEffort,
    "high",
  );
  assert.equal(
    (await model("explicit null clears reasoning", { reasoningEffort: null }))
      .reasoningEffort,
    null,
  );
  await model("standalone model selection", { chat: standalone });
  await snapshot("selected model state");
  await seed(
    `UPDATE chats SET protected_label=${json(label("terminal"))} WHERE id='chat';`,
  );
  const before = await snapshot("before rejected summary");
  await model(
    "failed summary rolls back model selection",
    { model: "console-model-two" },
    { rejected: true },
  );
  assert.deepEqual(await snapshot("after rejected summary"), before);
  await seed(
    `UPDATE chats SET protected_label=${json(label("chat"))} WHERE id='chat';`,
  );
  await runtime("create project runtime", { providerAccountId: "account-one" });
  await snapshot(
    "project binding and active lane share the actual generated runtime",
  );
  await runtime("omitted account retains existing account", {
    thread: "second-thread",
  });
  let state = await snapshot("retained account");
  assert.equal(state.runtimes[0].provider_account_id, "account-one");
  await runtime("explicit null clears account", { providerAccountId: null });
  state = await snapshot("cleared account");
  assert.equal(state.runtimes[0].provider_account_id, null);
  await runtime("replace account", {
    providerAccountId: "account-two",
    route: "console-route-two",
  });
  await runtime("create standalone runtime", {
    chat: standalone,
    worktree: null,
    scratchRoot: scratch,
    thread: "scratch-thread",
    providerAccountId: "account-one",
  });
  await snapshot("both canonical runtime roots persist");
  await runtime(
    "neither root is rejected",
    { worktree: null },
    { rejected: true },
  );
  await runtime(
    "two roots are rejected",
    { scratchRoot: scratch },
    { rejected: true },
  );
  await runtime(
    "missing runtime chat",
    { chat: "missing" },
    { rejected: true },
  );
  await guard(
    "foreign lock is rejected",
    { owner: other },
    { rejected: true, code: "chat-not-found" },
  );
  const binding = {
    workerId: "alpha",
    threadId: "console-thread",
    placementId: "github-alpha-main",
    modelRouteId: "console-route-two",
    providerAccountId: "account-two",
  };
  await seed(
    `INSERT INTO native_settings_states(chat_id,state) VALUES('chat',${json({ binding })});`,
  );
  const canonical = await snapshot("before canonical route conflicts");
  await runtime(
    "same native binding cannot replace route",
    { route: "console-route" },
    { rejected: true, code: "native-runtime-route-replaced" },
  );
  await runtime(
    "same native binding cannot replace account",
    { route: "console-route-two", providerAccountId: null },
    { rejected: true, code: "native-runtime-route-replaced" },
  );
  assert.deepEqual(await snapshot("canonical conflicts roll back"), canonical);
  await runtime("omitted native account does not conflict", {
    route: "console-route-two",
  });
  await runtime("new thread can bind a route", {
    thread: "new-thread",
    route: "console-route",
  });
  await seed(
    "UPDATE native_settings_states SET state='null'::jsonb WHERE chat_id='chat';",
  );
  await runtime(
    "null stored binding state preserves property failure",
    { thread: "other-thread" },
    { rejected: true },
  );
  await seed(
    `UPDATE native_settings_states SET state=${json({ binding: { runtimeGeneration: "canonical" } })} WHERE chat_id='chat';`,
  );
  await seed(
    `INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,phase,source,target_model_route_id) VALUES('handoff',${literal(owner)},'chat','alpha','preparing','{"runtimeGeneration":"source-generation"}','console-route');`,
  );
  for (const phase of ["preparing", "prepared", "committed"]) {
    await seed(
      `UPDATE native_runtime_handoffs SET phase=${literal(phase)} WHERE operation_id='handoff';`,
    );
    const previous = await snapshot("before " + phase + " fences");
    await model(
      "model blocked by " + phase,
      {},
      { rejected: true, code: "native-runtime-handoff-pending" },
    );
    await runtime(
      "runtime blocked by " + phase,
      {},
      { rejected: true, code: "native-runtime-handoff-pending" },
    );
    await guard(
      "unknown attachment blocked by " + phase,
      { generation: "other", access: "attach" },
      { rejected: true, code: "native-runtime-handoff-pending" },
    );
    await guard("canonical attachment remains admitted during " + phase, {
      generation: "canonical",
      access: "attach",
    });
    assert.deepEqual(await snapshot("after " + phase + " fences"), previous);
  }
  await seed(
    "UPDATE native_runtime_handoffs SET phase='completed' WHERE operation_id='handoff';",
  );
  await guard(
    "completed source generation is retired",
    { generation: "source-generation" },
    { rejected: true, code: "native-runtime-retired" },
  );
  await guard("different completed generation is writable", {
    generation: "canonical",
  });
  await seed(
    `UPDATE native_runtime_handoffs SET retired_runtime_generations='["retired"]',retired_native_epochs='[{"runtimeGeneration":"canonical","nativeEpoch":"retired-epoch"}]' WHERE operation_id='handoff';`,
  );
  await guard(
    "retained generation retirement",
    { generation: "retired" },
    { rejected: true, code: "native-runtime-retired" },
  );
  await guard(
    "retained epoch retirement",
    { generation: "canonical", epoch: "retired-epoch" },
    { rejected: true, code: "native-runtime-retired" },
  );
  await guard("new epoch is writable", {
    generation: "canonical",
    epoch: "current",
  });
  await seed(
    "UPDATE native_runtime_handoffs SET phase='cancelled' WHERE operation_id='handoff';",
  );
  await guard(
    "cancelled handoff retains retirement",
    { generation: "retired" },
    { rejected: true, code: "native-runtime-retired" },
  );
  await guard("cancelled handoff permits current binding", {
    generation: "canonical",
    epoch: "current",
  });
  await model("completed handoff permits model writes");
  await runtime("completed handoff permits runtime writes");
  await managedConsoleCases({
    seed,
    observe,
    snapshot,
    owner,
    other,
    literal,
    json,
    standalone,
    stamp,
  });
  if (databaseMode === "postgres")
    await chatRuntimeLocks({ pair, urls, owner, report, standalone });
  const retained = await snapshot("final durable bindings");
  for (let i = 0; i < pair.length; i++) {
    await pair[i].close();
    pair[i] = await open(i === 0 ? "node" : "rust", i);
  }
  assert.deepEqual(
    await snapshot("reopen retains model runtime lane and native state"),
    retained,
  );
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  const outcomes = await Promise.allSettled(pair.map((p) => p.close()));
  const errors = outcomes
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);
  try {
    await postgres?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Runtime repository scenario/cleanup failed",
    );
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    error: report.error?.message,
  }),
);
if (failure) throw failure;
