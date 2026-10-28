// Real repositories and real migrations; fixture resource rows do not port CRUD.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { catalogCases } from "./settings-catalog-cases.mjs";
import { accountCases } from "./settings-account-cases.mjs";
import { zaiCases } from "./settings-zai-cases.mjs";
import { ollamaCases } from "./settings-ollama-cases.mjs";
import { quotaCases } from "./settings-quota-cases.mjs";
import { chatGptCases } from "./settings-chatgpt-cases.mjs";
import { openRouterCases } from "./settings-openrouter-cases.mjs";
import { grokCases } from "./settings-grok-cases.mjs";
import { credentialServiceCases } from "./settings-credential-service-cases.mjs";
import { accountAuthenticationCases } from "./settings-auth-cases.mjs";
import { catalogRuntimeCases } from "./settings-catalog-runtime-cases.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const executable = await buildRustExample("settings-repository-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-settings-repository-"));
const report = {
  suite: "actual-settings-repositories",
  databaseMode,
  completeReplacement: false,
  root,
  cases: [],
};
const pair = [],
  options = [];
let postgresOwner, failure;
const owner = "settings-owner",
  other = "settings-other",
  stamp = "2026-10-25T00:00:00.000Z";
const literal = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const protectedLabel = {
  classification: { recordKind: "project" },
  protectedLabel: policyEnvelope,
};
const identityMaps = [new Map(), new Map()],
  logicalIds = [new Map(), new Map()];
function rememberIdentity(runtime, logical, id) {
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  if (logicalIds[runtime].has(logical))
    assert.equal(
      id,
      logicalIds[runtime].get(logical),
      "identity retained: " + logical,
    );
  if (identityMaps[runtime].has(id))
    assert.equal(
      identityMaps[runtime].get(id),
      logical,
      "identities do not alias unrelated rows",
    );
  logicalIds[runtime].set(logical, id);
  identityMaps[runtime].set(id, logical);
}
function identity(value, runtime, translate = false) {
  const map = identityMaps[0];
  const transform = (id) =>
    translate
      ? map.has(id)
        ? logicalIds[runtime].get(map.get(id))
        : id
      : (identityMaps[runtime].get(id) ?? id);
  for (const prefix of ["discovered:model:", "discovered:route:"])
    if (value.startsWith(prefix))
      return prefix + transform(value.slice(prefix.length));
  return transform(value);
}
function translate(value, runtime) {
  if (typeof value === "string") return identity(value, runtime, true);
  if (Array.isArray(value)) return value.map((v) => translate(v, runtime));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, translate(v, runtime)]),
    );
  return value;
}
function registerCatalog(value, runtime, provider) {
  if (value === null) return;
  if (Array.isArray(value)) {
    for (const row of value)
      rememberIdentity(
        runtime,
        `availability:${identityMaps[runtime].get(row.providerModelId) ?? row.providerModelId}:${row.scopeKey}`,
        row.id,
      );
    return;
  }
  for (const model of value.models)
    rememberIdentity(
      runtime,
      `model:${provider}:${model.nativeModelId}`,
      model.id,
    );
  registerCatalog(value.availability, runtime, provider);
  for (const state of value.syncStates)
    rememberIdentity(runtime, `sync:${provider}:${state.scopeKey}`, state.id);
}
function normalize(
  value,
  key = "",
  rawSql = false,
  runtime = 0,
  fixedDates = [],
) {
  if (Array.isArray(value))
    return value.map((v) => normalize(v, "", rawSql, runtime, fixedDates));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        normalize(v, k, rawSql, runtime, fixedDates),
      ]),
    );
  if (key === "expiresAt") return value;
  if (typeof value === "string" && /(?:At|_at)$/.test(key)) {
    assert.ok(Number.isFinite(Date.parse(value)), key + ": invalid timestamp");
    if (fixedDates.includes(key)) return new Date(value).toISOString();
    if (!rawSql)
      assert.equal(
        new Date(value).toISOString(),
        value,
        key + ": timestamp must use Node ISO format",
      );
    return "<timestamp>";
  }
  return typeof value === "string" ? identity(value, runtime) : value;
}
async function seed(sql) {
  for (const f of pair) await f.seed(sql);
}
async function transaction(statements) {
  for (const f of pair) {
    const r = await f.request({ op: "transaction", statements });
    assert.equal(r.rejected, false, r.diagnostic);
  }
}
async function compare(
  label,
  input,
  { rejected = false, exactError = true, fixedDates = [] } = {},
) {
  const expected = await pair[0].request(input),
    actual = await pair[1].request(translate(input, 1));
  report.cases.push({ label, input, expected, actual });
  assert.equal(
    expected.rejected,
    rejected,
    "reference " + label + ": " + expected.diagnostic,
  );
  assert.equal(
    actual.rejected,
    expected.rejected,
    label + ": " + actual.diagnostic,
  );
  if (!rejected) {
    if (
      ["ollama-get", "chatgpt-get", "grok-get", "openrouter-get"].includes(
        input.op,
      )
    ) {
      registerCatalog(expected.value.result ?? null, 0, input.provider);
      registerCatalog(actual.value.result ?? null, 1, input.provider);
    }
    if (
      input.op === "catalog-get" ||
      input.op === "catalog-availability" ||
      input.op === "openrouter-release" ||
      input.op === "zai-get"
    ) {
      registerCatalog(expected.value, 0, input.provider);
      registerCatalog(actual.value, 1, input.provider);
    }
    const canonical = (value, runtime) => {
      if (input.op === "credential-parallel")
        return [...value].sort(
          (a, b) => Number(Boolean(a.error)) - Number(Boolean(b.error)),
        );
      // Availability has no SQL ORDER BY and the existing client uses a Set.
      // Keep strict sequence comparison for ordered models and sync states.
      const orderedAvailability = (rows) =>
        [...rows].sort((a, b) => {
          const left =
            (identityMaps[runtime].get(a.providerModelId) ??
              a.providerModelId) +
            "\0" +
            a.scopeKey;
          const right =
            (identityMaps[runtime].get(b.providerModelId) ??
              b.providerModelId) +
            "\0" +
            b.scopeKey;
          return left < right ? -1 : left > right ? 1 : 0;
        });
      if (
        ["ollama-get", "chatgpt-get", "grok-get", "openrouter-get"].includes(
          input.op,
        ) &&
        value.result
      )
        return {
          ...value,
          result: {
            ...value.result,
            availability: orderedAvailability(value.result.availability),
          },
        };
      if (
        ["catalog-get", "zai-get", "openrouter-release"].includes(input.op) &&
        value
      )
        return {
          ...value,
          availability: orderedAvailability(value.availability),
        };
      if (input.op === "catalog-availability")
        return orderedAvailability(value);
      return value;
    };
    assert.deepEqual(
      normalize(
        canonical(actual.value, 1),
        "",
        input.op === "query-json",
        1,
        fixedDates,
      ),
      normalize(
        canonical(expected.value, 0),
        "",
        input.op === "query-json",
        0,
        fixedDates,
      ),
      label,
    );
    if (input.op === "credential-parallel")
      report.cases.at(-1).comparison =
        "Unordered outcomes; caller winner is scheduler-dependent. One success and one revision conflict are asserted separately.";
  } else if (exactError) {
    assert.equal(actual.diagnostic, expected.diagnostic, label);
    assert.equal(actual.kind, expected.kind, label);
  }
  return expected.value;
}
const snapshotSQL =
  "SELECT jsonb_build_object('preferences',(SELECT jsonb_agg(to_jsonb(s) ORDER BY user_id) FROM user_settings s),'models',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM model_profiles m),'routes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM model_routes r),'providers',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM model_providers p),'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM model_provider_accounts a),'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY account_id,worker_id) FROM model_provider_account_workers b),'sessions',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chat_runtime_sessions c),'suppressions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY provider_model_id) FROM provider_model_suppressions s),'catalog',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM provider_models c),'availability',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM provider_model_availability a),'sync',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM provider_catalog_sync_states s),'snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM provider_model_catalog_snapshots s)) || jsonb_build_object('quota',(SELECT jsonb_agg(to_jsonb(q) ORDER BY owner_id,event_key) FROM provider_quota_observations q)) AS result";
async function snapshots() {
  return Promise.all(
    pair.map(async (f) => {
      const r = await f.request({ op: "query-json", sql: snapshotSQL });
      assert.equal(r.rejected, false, r.diagnostic);
      return r.value;
    }),
  );
}
async function unchanged(label, input, options) {
  const before = await snapshots();
  const value = await compare(label, input, options);
  const after = await snapshots();
  before.forEach((v, i) =>
    assert.deepEqual(after[i], v, label + ": no writes/runtime " + i),
  );
  report.cases.at(-1).unchangedSnapshots = true;
  return value;
}
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const kind of ["node", "rust"]) {
    const config = {
      kind,
      executable,
      root,
      databaseMode,
      nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
      databaseUrl:
        postgresOwner && (kind === "node" || databaseMode === "postgres")
          ? await postgresOwner.database()
          : undefined,
    };
    options.push(config);
    pair.push(await repositoryFixture(config));
  }
  await seed("DELETE FROM users;");
  for (const id of [owner, other])
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(id)},'account','member','active','Fixture',${literal(id + "@example.invalid")},${literal(id + "@example.invalid")});`,
    );
  await compare(
    "missing preference row",
    { op: "preferences", owner },
    { rejected: true },
  );
  await compare("initialize account", { op: "ensure-account", owner });
  await compare("initial full bundle", { op: "settings", owner });
  await compare("initialize other account", {
    op: "ensure-account",
    owner: other,
  });
  for (const [id, principal, kind, name, url] of [
    ["ollama", owner, "ollama", "A local", "http://localhost:11434"],
    [
      "openrouter",
      owner,
      "openai-compatible",
      "B router",
      "https://openrouter.ai/api/v1",
    ],
    ["chatgpt", owner, "chatgpt", "C ChatGPT", "https://chatgpt.com"],
    ["foreign", other, "ollama", "Foreign", "http://foreign.invalid"],
  ])
    await seed(
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url,protected_api_key,created_at,updated_at) VALUES(${literal(id)},${literal(principal)},${literal(name)},${literal(kind)},${literal(url)},${id === "openrouter" ? literal(JSON.stringify(policyEnvelope)) : "NULL"},${literal(stamp)},${literal(stamp)});`,
    );
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name,created_at,updated_at) VALUES('profile',${literal(owner)},'Configured',${literal(stamp)},${literal(stamp)}),('foreign-profile',${literal(other)},'Foreign',${literal(stamp)},${literal(stamp)}),('empty-profile',${literal(owner)},'No routes',${literal(stamp)},${literal(stamp)});`,
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('route','profile','ollama','gpt-5',0,true),('disabled-route','profile','openrouter','openai/gpt-5',1,false),('foreign-route','foreign-profile','foreign','foreign-model',0,true),('foreign-provider-route','profile','foreign','foreign-model',2,true);",
  );
  for (const [id, principal] of [
    ["worker", owner],
    ["foreign-worker", other],
    ["unlinked-worker", owner],
  ])
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,unlinked_at) VALUES(${literal(id)},${literal(principal)},'Worker','linux','x64',${literal(stamp)},${literal(stamp)},${id === "unlinked-worker" ? literal(stamp) : "NULL"});`,
    );
  for (const [id, position, enabled] of [
    ["account", 0, true],
    ["disabled-account", 1, false],
  ])
    await seed(
      `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,enabled,weekly_usage_used_basis_points,weekly_usage_resets_at,auth_last_synced_at) VALUES(${literal(id)},'chatgpt',${literal(JSON.stringify(policyEnvelope))},${literal(id)},${position},${enabled},1234,${literal(stamp)},${literal(stamp)});`,
    );
  await seed(
    `INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state,weekly_usage_used_basis_points,weekly_usage_resets_at,last_synced_at) VALUES('account','worker','signed-in',5678,${literal(stamp)},${literal(stamp)});`,
  );
  await compare("bundle projections with opaque accounts and route ownership", {
    op: "settings",
    owner,
  });
  await compare("other tenant bundle", { op: "settings", owner: other });
  for (const args of [
    {},
    { includeDisabled: true },
    { model: "profile" },
    { route: "disabled-route" },
    { route: "disabled-route", includeDisabled: true },
    { provider: "ollama" },
    { provider: "foreign" },
    { model: "foreign-profile" },
    { model: "empty-profile" },
    { model: "", provider: "", route: "" },
  ])
    await compare("runtime filters " + JSON.stringify(args), {
      op: "runtimes",
      owner,
      ...args,
    });
  for (const field of [
    "labelingModelId",
    "defaultModelId",
    "defaultChatModelId",
    "defaultSubagentModelId",
  ]) {
    for (const value of ["missing", "foreign-profile", "empty-profile"])
      assert.equal(
        await unchanged(field + " rejects " + value, {
          op: "update",
          owner,
          input: { [field]: value, theme: "dark" },
        }),
        null,
      );
  }
  for (const value of ["missing", "foreign-worker", "unlinked-worker"])
    assert.equal(
      await unchanged("worker preference rejects " + value, {
        op: "update",
        owner,
        input: { defaultWorkerId: value, theme: "dark" },
      }),
      null,
    );
  assert.equal(
    await unchanged("custom subagent requires ID", {
      op: "update",
      owner,
      input: { defaultCustomSubagentModel: true },
    }),
    null,
  );
  let result = await compare("configure model defaults and worker", {
    op: "update",
    owner,
    input: {
      defaultModelId: "profile",
      defaultChatModelId: "profile",
      defaultSubagentModelId: "profile",
      labelingModelId: "profile",
      defaultCustomSubagentModel: true,
      defaultWorkerId: "worker",
      theme: "dark",
      highContrast: true,
      proMode: true,
      proModeOpacity: 73,
      contentGutters: true,
      eliteMode: true,
      workspaceLayoutProfile: "ide",
      defaultReasoningEffort: "high",
      defaultChatReasoningEffort: "none",
      defaultSubagentReasoningEffort: "low",
      defaultPermissionProfileId: ":read-only",
      defaultChatPermissionProfileId: ":yolo",
      desktopFrameRate: 60,
      desktopStreamQuality: "sharp",
      sidebarWidth: 320,
      showChatPromptOverlay: false,
      randomAgentNames: true,
      autoNameTasks: false,
      autoNameChats: false,
      automaticReplicaProvisioning: true,
      automaticReplicaSynchronization: "verify-only",
    },
  });
  assert.equal(result.preferences.defaultCustomSubagentModel, true);
  assert.equal(
    await unchanged("cannot clear active custom subagent", {
      op: "update",
      owner,
      input: { defaultSubagentModelId: null },
    }),
    null,
  );
  await compare("clear nullable defaults", {
    op: "update",
    owner,
    input: {
      defaultCustomSubagentModel: false,
      defaultSubagentModelId: null,
      defaultModelId: null,
      defaultChatModelId: null,
      labelingModelId: null,
      defaultWorkerId: null,
      defaultReasoningEffort: null,
      defaultChatReasoningEffort: null,
      defaultSubagentReasoningEffort: null,
      protectedComputerUseCursor: null,
    },
  });
  await compare("merge mobile tabs initial", {
    op: "update",
    owner,
    input: {
      mobileProjectTabConfigurations: { one: ["chat", null], two: [null] },
    },
  });
  result = await compare("merge mobile tabs replaces one project", {
    op: "update",
    owner,
    input: { mobileProjectTabConfigurations: { one: [null], three: ["new"] } },
  });
  assert.deepEqual(result.preferences.mobileProjectTabConfigurations, {
    one: [null],
    two: [null],
    three: ["new"],
  });
  await compare("empty mobile map retains existing projects", {
    op: "update",
    owner,
    input: { mobileProjectTabConfigurations: {} },
  });
  const before = result.preferences.computerUseEffectsRevision;
  result = await compare("enable computer-use advances effects revision", {
    op: "update",
    owner,
    input: { computerUseEnabled: true },
  });
  assert.equal(result.preferences.computerUseEffectsRevision, before + 1);
  result = await compare(
    "identical computer-use setting does not advance revision",
    { op: "update", owner, input: { computerUseEnabled: true } },
  );
  assert.equal(result.preferences.computerUseEffectsRevision, before + 1);
  await compare("empty scalar patch", { op: "update", owner, input: {} });
  await compare("ensure account does not reset preferences", {
    op: "ensure-account",
    owner,
  });
  await compare("preferences retained after initializer", {
    op: "preferences",
    owner,
  });
  for (const [id, principal] of [
    ["project", owner],
    ["foreign-project", other],
  ])
    await seed(
      `INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy) VALUES(${literal(id)},${literal(principal)},${literal(JSON.stringify(protectedLabel))},'managed-folder','external','direct');`,
    );
  for (const [id, principal] of [
    ["workspace", owner],
    ["foreign-workspace", other],
  ])
    await seed(
      `INSERT INTO project_workspaces(id,owner_id,name_envelope,name_blind_index,name_format_version,name_key_revision) VALUES(${literal(id)},${literal(principal)},${literal(JSON.stringify(policyEnvelope.envelope))},${literal(id)},1,1);`,
    );
  await seed(
    "INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES('source','project','worker','/fixture','/fixture');",
  );
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES('worktree','source','worker','main','/fixture','/fixture',true,'cantrip','ready');",
  );
  let scratchIndex = 1;
  for (const [id, principal, project, archived] of [
    ["standalone", owner, null, false],
    ["foreign-chat", other, null, false],
    ["archived-chat", owner, null, true],
    ["project-chat", owner, "project", false],
  ]) {
    const scratch = `33333333-3333-4333-8333-${String(scratchIndex++).padStart(12, "0")}`;
    const worker = principal === other ? "foreign-worker" : "worker";
    const insertChat = `INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,archived_at,active_worker_id,active_worktree_id,active_scratch_root_id,worktree_mode) VALUES(${literal(id)},${literal(principal)},${literal(project ? "project" : "standalone")},${project ? literal(project) : "NULL"},${literal(JSON.stringify({ ...protectedLabel, classification: { recordKind: "chat" } }))},${archived ? literal(stamp) : "NULL"},${literal(worker)},${project ? "'worktree'" : "NULL"},${project ? "NULL" : literal(scratch)},${project ? "'agent-managed'" : "NULL"});`;
    await transaction([
      insertChat,
      ...(project
        ? []
        : [
            `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id) VALUES(${literal(scratch)},${literal(id)},${literal(principal)},${literal(worker)});`,
          ]),
    ]);
  }
  for (const [field, ids] of [
    ["lastIdeProjectId", ["foreign-project", "missing"]],
    ["lastIdeWorkspaceId", ["foreign-workspace", "missing"]],
    [
      "lastStandaloneChatId",
      ["foreign-chat", "archived-chat", "project-chat", "missing"],
    ],
  ])
    for (const id of ids)
      assert.equal(
        await unchanged("destination rejects " + id, {
          op: "destination",
          owner,
          input: { expectedRevision: 1, [field]: id },
        }),
        null,
      );
  result = await compare("save owned destination", {
    op: "destination",
    owner,
    input: {
      expectedRevision: 1,
      lastAppMode: "ide",
      lastIdeProjectId: "project",
      lastIdeWorkspaceId: "workspace",
      lastStandaloneChatId: "standalone",
    },
  });
  assert.equal(result.revision, 2);
  assert.equal(
    await unchanged("stale destination revision", {
      op: "destination",
      owner,
      input: { expectedRevision: 1, lastAppMode: "chat" },
    }),
    null,
  );
  await compare("clear one destination field", {
    op: "destination",
    owner,
    input: { expectedRevision: 2, lastIdeProjectId: null },
  });
  await compare("destination does not update other tenant", {
    op: "preferences",
    owner: other,
  });
  await seed(
    `INSERT INTO token_usage_records(id,owner_id,source_key,model_id,provider_id,input_tokens,output_tokens,attempt_status,started_at,completed_at) VALUES('usage-1',${literal(owner)},'one','profile','ollama',9007199254740993,7,'completed','2026-10-25T00:00:00Z','2026-10-25T00:00:10Z'),('usage-2',${literal(owner)},'two','profile','ollama',11,13,'completed','2026-10-25T00:00:05Z','2026-10-25T00:00:20Z'),('usage-3',${literal(owner)},'three',NULL,NULL,1,2,'running',NULL,NULL),('foreign-usage',${literal(other)},'one','foreign-profile','foreign',19,23,'completed',NULL,NULL);`,
  );
  await compare("large usage totals and overlapping agent time", {
    op: "settings",
    owner,
  });
  await compare("fixed clock analytics with nullable groups", {
    op: "analytics",
    owner,
    now: "2026-10-25T00:01:00.000Z",
  });
  await seed(
    "INSERT INTO provider_models(id,provider_id,native_model_id,metadata_source,input_modalities,output_modalities,display_name,context_window,supports_vision,supports_tools) VALUES('native-catalog','ollama','gpt-5','ollama','[\"text\"]','[]','Native',NULL,NULL,NULL),('router-catalog','openrouter','gpt-5','openrouter','[\"text\",\"image\"]','[\"text\"]','Router',200000,true,true);",
  );
  await compare("exact OpenRouter enrichment by legacy native name", {
    op: "runtimes",
    owner,
    model: "profile",
  });
  await seed(
    "UPDATE model_routes SET provider_model_id='native-catalog' WHERE id='route';",
  );
  await compare("catalog joined by stable ID", {
    op: "runtimes",
    owner,
    model: "profile",
  });
  await seed(
    "INSERT INTO provider_models(id,provider_id,native_model_id,canonical_model_id,metadata_source,display_name) VALUES('ambiguous','openrouter','alias','gpt-5','openrouter','Ambiguous');",
  );
  await compare("ambiguous catalog aliases do not enrich", {
    op: "runtimes",
    owner,
    model: "profile",
  });
  for (const baseUrl of [
    "https://sub.openrouter.ai/api/v1",
    "https://openrouter.ai.evil.invalid",
    "invalid",
  ]) {
    await seed("DELETE FROM provider_models WHERE id='ambiguous';");
    await seed(
      `UPDATE model_providers SET base_url=${literal(baseUrl)} WHERE id='openrouter';`,
    );
    await compare("OpenRouter host boundary " + baseUrl, {
      op: "runtimes",
      owner,
      model: "profile",
    });
  }
  await compare("default bootstrap", {
    op: "ensure-default",
    owner,
    model: "Default",
    baseUrl: "http://localhost:11434",
  });
  await compare("default bootstrap is idempotent", {
    op: "ensure-default",
    owner,
    model: "Changed",
    baseUrl: "http://changed.invalid",
  });
  await compare("default bootstrap preserves saved preferences", {
    op: "settings",
    owner,
  });
  const providerId = "44444444-4444-4444-8444-444444444444";
  const providerInput = {
    id: providerId,
    name: "Created",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/responses?key=opaque#fragment",
    initialAccount: null,
    protectedApiKey: policyEnvelope,
  };
  result = await compare("create opaque API provider", {
    op: "provider-create",
    owner,
    input: providerInput,
  });
  assert.equal(result.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(result.hasApiKey, true);
  for (const op of ["provider-get", "provider-runtime", "provider-routes"]) {
    await compare(op + " owned", { op, owner, provider: providerId });
    await compare(op + " foreign", { op, owner: other, provider: providerId });
  }
  await compare("update provider omits protected key", {
    op: "provider-update",
    owner,
    provider: providerId,
    input: {
      name: "Renamed",
      kind: "openai-compatible",
      baseUrl: "https://example.com/v1/chat/completions",
      weeklyUsageReservePercent: 27,
    },
  });
  result = await compare("read retained opaque provider key", {
    op: "provider-runtime",
    owner,
    provider: providerId,
  });
  assert.deepEqual(result.protectedApiKey, policyEnvelope);
  await compare("provider explicit key null", {
    op: "provider-update",
    owner,
    provider: providerId,
    input: {
      name: "Cleared",
      kind: "openai-compatible",
      baseUrl: "https://example.com/responses",
      protectedApiKey: null,
    },
  });
  await unchanged(
    "provider kind is immutable",
    {
      op: "provider-update",
      owner,
      provider: providerId,
      input: {
        name: "Wrong kind",
        kind: "ollama",
        baseUrl: "http://localhost:11434",
      },
    },
    { rejected: true },
  );
  const accountProvider = "55555555-5555-4555-8555-555555555555";
  await unchanged(
    "account provider requires protected label and rolls back insert",
    {
      op: "provider-create",
      owner,
      input: {
        id: accountProvider,
        name: "Grok",
        kind: "grok",
        baseUrl: "https://grok.com",
        protectedApiKey: null,
        initialAccount: null,
      },
    },
    { rejected: true },
  );
  result = await compare("create pooled account provider", {
    op: "provider-create",
    owner,
    input: {
      id: accountProvider,
      name: "Grok",
      kind: "grok",
      baseUrl: "https://grok.com",
      protectedApiKey: null,
      initialAccount: {
        id: "66666666-6666-4666-8666-666666666666",
        protectedLabel: policyEnvelope,
      },
    },
  });
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].credentialState, "signed-out");
  await unchanged(
    "one account provider per kind",
    {
      op: "provider-create",
      owner,
      input: {
        id: "77777777-7777-4777-8777-777777777777",
        name: "Other Grok",
        kind: "grok",
        baseUrl: "https://grok.com",
        protectedApiKey: null,
        initialAccount: null,
      },
    },
    { rejected: true },
  );
  await compare("provider delete foreign is false", {
    op: "provider-delete",
    owner: other,
    provider: accountProvider,
  });
  await compare("provider deletion cascades pooled accounts", {
    op: "provider-delete",
    owner,
    provider: accountProvider,
  });
  await unchanged(
    "provider route FK prevents deletion",
    { op: "provider-delete", owner, provider: "ollama" },
    { rejected: true, exactError: false },
  );
  const routes = [
    { providerId: "ollama", modelName: "created-local", enabled: true },
    { providerId: "openrouter", modelName: "created-router", enabled: false },
  ];
  await unchanged("model creation rejects foreign provider", {
    op: "model-create",
    owner,
    input: {
      name: "Invalid",
      routes: [{ providerId: "foreign", modelName: "foreign", enabled: true }],
    },
  });
  await seed(
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('�',${literal(owner)},'UTF16 replacement','ollama','http://localhost:11434');`,
  );
  await unchanged("provider ownership compares original UTF16", {
    op: "model-create",
    owner,
    input: {
      name: "Invalid surrogate",
      routes: [{ providerId: "\ud800", modelName: "gpt", enabled: true }],
    },
  });
  const created = await Promise.all(
    pair.map((f) =>
      f.request({
        op: "model-create",
        owner,
        input: { name: "Created model", routes },
      }),
    ),
  );
  report.cases.push({
    label: "create model and ordered routes with fresh identities",
    input: { name: "Created model", routes },
    expected: created[0],
    actual: created[1],
  });
  for (const r of created) {
    assert.equal(r.rejected, false, r.diagnostic);
    assert.equal(r.value.routes.length, 2);
    const ids = [r.value.id, ...r.value.routes.map((route) => route.id)];
    assert.equal(new Set(ids).size, 3);
    ids.forEach((id) =>
      assert.match(
        id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    );
  }
  const canonical = (r) =>
    normalize({
      ...r.value,
      id: "<model>",
      routes: r.value.routes.map((route, i) => ({
        ...route,
        id: "<route-" + i + ">",
      })),
    });
  assert.deepEqual(canonical(created[1]), canonical(created[0]));
  for (let i = 0; i < pair.length; i++) {
    const deleted = await pair[i].request({
      op: "model-delete",
      owner,
      model: created[i].value.id,
    });
    assert.equal(deleted.rejected, false, deleted.diagnostic);
    assert.equal(deleted.value, true);
  }
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('editable',${literal(owner)},'Editable');`,
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('edit-one','editable','ollama','original',0),('edit-two','editable','openrouter','other',1);",
  );
  await seed(
    "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,model_route_id,codex_thread_id,status) VALUES('edit-runtime','project-chat','worker','worktree','edit-one','thread','attached');",
  );
  const updateRoutes = [
    {
      id: "edit-two",
      providerId: "openrouter",
      modelName: "other",
      enabled: true,
    },
    {
      id: "edit-one",
      providerId: "ollama",
      modelName: "original",
      enabled: false,
    },
  ];
  await compare("model route reorder and enable toggle", {
    op: "model-update",
    owner,
    model: "editable",
    input: { name: "Reordered", routes: updateRoutes },
  });
  result = await compare("enable toggle retains runtime thread", {
    op: "query-json",
    sql: "SELECT jsonb_build_object('thread',codex_thread_id,'status',status) AS result FROM chat_runtime_sessions WHERE id='edit-runtime'",
  });
  assert.equal(result.thread, "thread");
  await unchanged("model route duplicate IDs rejected", {
    op: "model-update",
    owner,
    model: "editable",
    input: { name: "Invalid", routes: [updateRoutes[0], updateRoutes[0]] },
  });
  await unchanged("foreign route cannot be adopted", {
    op: "model-update",
    owner,
    model: "editable",
    input: {
      name: "Invalid",
      routes: [{ ...updateRoutes[0], id: "foreign-route" }],
    },
  });
  await unchanged("model update rejects foreign ownership", {
    op: "model-update",
    owner: other,
    model: "editable",
    input: {
      name: "Foreign",
      routes: [{ providerId: "foreign", modelName: "foreign", enabled: true }],
    },
  });
  await compare("changed route detaches runtime", {
    op: "model-update",
    owner,
    model: "editable",
    input: {
      name: "Changed",
      routes: [
        updateRoutes[0],
        { ...updateRoutes[1], modelName: "changed", enabled: true },
      ],
    },
  });
  result = await compare("runtime detached after model change", {
    op: "query-json",
    sql: "SELECT jsonb_build_object('thread',codex_thread_id,'status',status) AS result FROM chat_runtime_sessions WHERE id='edit-runtime'",
  });
  assert.deepEqual(result, { thread: null, status: "detached" });
  await seed(
    "UPDATE chat_runtime_sessions SET codex_thread_id='again',status='attached' WHERE id='edit-runtime';",
  );
  await compare("provider update detaches every route runtime", {
    op: "provider-update",
    owner,
    provider: "ollama",
    input: {
      name: "A local updated",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
    },
  });
  result = await compare("provider runtime invalidation persisted", {
    op: "query-json",
    sql: "SELECT jsonb_build_object('thread',codex_thread_id,'status',status) AS result FROM chat_runtime_sessions WHERE id='edit-runtime'",
  });
  assert.deepEqual(result, { thread: null, status: "detached" });
  await compare("remove model route", {
    op: "model-update",
    owner,
    model: "editable",
    input: { name: "One route", routes: [updateRoutes[0]] },
  });
  await compare("foreign model delete is false", {
    op: "model-delete",
    owner: other,
    model: "editable",
  });
  await compare("owned model delete", {
    op: "model-delete",
    owner,
    model: "editable",
  });
  await compare("deleted model absent", {
    op: "model-delete",
    owner,
    model: "editable",
  });
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name,discovery_managed) VALUES('managed',${literal(owner)},'Managed',true);`,
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,provider_model_id,model_name,position,discovery_managed) VALUES('managed-route','managed','ollama','native-catalog','gpt-5',0,true);",
  );
  await compare("delete discovered model adds suppression", {
    op: "model-delete",
    owner,
    model: "managed",
  });
  result = await compare("suppression retained", {
    op: "query-json",
    sql: "SELECT jsonb_agg(jsonb_build_object('owner',owner_id,'model',provider_model_id)) AS result FROM provider_model_suppressions",
  });
  assert.deepEqual(result, [{ owner, model: "native-catalog" }]);
  for (const args of [
    { provider: "chatgpt", worker: "worker" },
    { provider: "chatgpt", worker: "foreign-worker" },
    { provider: "chatgpt", worker: "worker", owner: other },
    { provider: "ollama", worker: "worker" },
  ])
    await compare("account runtime " + JSON.stringify(args), {
      op: "account-runtimes",
      owner,
      ...args,
    });
  await seed(
    "INSERT INTO provider_model_availability(id,provider_model_id,scope_key,provider_account_id,worker_id,state) VALUES('specific','native-catalog','specific','account','worker','available'),('global','native-catalog','global','account',NULL,'unavailable');",
  );
  result = await compare("global account availability takes precedence", {
    op: "account-runtimes",
    owner,
    provider: "chatgpt",
    worker: "worker",
    model: "native-catalog",
  });
  assert.equal(result[0].modelAvailability, "unavailable");
  await accountCases({
    seed,
    compare,
    unchanged,
    owner,
    other,
    stamp,
    literal,
    envelope: policyEnvelope,
    pair,
    report,
  });
  await catalogCases({
    seed,
    compare,
    unchanged,
    owner,
    other,
    stamp,
    literal,
    envelope: policyEnvelope,
    pair,
    report,
  });
  await zaiCases({ seed, compare, unchanged, literal });
  await ollamaCases({ seed, compare, unchanged, literal, owner, other });
  await openRouterCases({ seed, compare, unchanged, literal });
  await quotaCases({
    seed,
    compare,
    unchanged,
    literal,
    envelope: policyEnvelope,
  });
  await chatGptCases({
    seed,
    compare,
    unchanged,
    literal,
    envelope: policyEnvelope,
  });
  await grokCases({
    seed,
    compare,
    unchanged,
    literal,
    envelope: policyEnvelope,
  });
  await credentialServiceCases({
    seed,
    compare,
    unchanged,
    literal,
    envelope: policyEnvelope,
  });
  await accountAuthenticationCases({
    seed,
    compare,
    unchanged,
    literal,
    envelope: policyEnvelope,
  });
  await catalogRuntimeCases({ seed, compare, unchanged, literal });
  await seed(
    "ALTER TABLE user_settings ADD CONSTRAINT fixture_settings_theme CHECK(theme<>'light');",
  );
  await unchanged(
    "failed settings update retains all fields",
    { op: "update", owner, input: { theme: "light", sidebarWidth: 400 } },
    { rejected: true, exactError: false },
  );
  await seed(
    "ALTER TABLE user_settings DROP CONSTRAINT fixture_settings_theme;",
  );
  for (let i = 0; i < pair.length; i++) {
    await pair[i].close();
    pair[i] = await repositoryFixture(options[i]);
  }
  await seed(
    `INSERT INTO token_usage_records(id,owner_id,source_key,attempt_status,started_at,completed_at) VALUES('invalid-start',${literal(owner)},'invalid-start','running','infinity',NULL),('invalid-end',${literal(owner)},'invalid-end','completed','2026-10-25T00:00:00Z','infinity'),('bc-date',${literal(owner)},'bc-date','completed','0001-01-01 BC','0001-01-02 BC'),('wide-date',${literal(owner)},'wide-date','completed','294276-01-01','294276-01-02');`,
  );
  await compare("database invalid and extended date analytics", {
    op: "analytics",
    owner,
    now: "2026-10-25T00:01:00.000Z",
  });
  await seed(
    "DELETE FROM token_usage_records WHERE id IN ('invalid-start','invalid-end','bc-date','wide-date');",
  );
  await compare("full bundle after process reopen", { op: "settings", owner });
  await compare("destination after process reopen", {
    op: "preferences",
    owner,
  });
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
} finally {
  const cleanup = await Promise.allSettled(pair.map((f) => f.close()));
  if (postgresOwner)
    cleanup.push(
      await Promise.resolve(postgresOwner.close()).then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ status: "rejected", reason }),
      ),
    );
  report.cleanupFailures = cleanup
    .filter((r) => r.status === "rejected")
    .map((r) => String(r.reason));
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
assert.deepEqual(report.cleanupFailures, []);
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    completeReplacement: false,
    reportPath,
  }),
);
