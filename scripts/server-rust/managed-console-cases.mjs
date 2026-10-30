// Reference helper vectors plus real repository/service composition scenarios.
import assert from "node:assert/strict";
import { projectLabel } from "./security-fixtures.mjs";
export async function managedConsoleCases({
  seed,
  observe,
  snapshot,
  owner,
  other,
  literal,
  json,
  standalone,
  stamp,
}) {
  const check = async (label, fields, options) =>
    (await observe(label, fields, options))?.result;
  for (const balance of [
    null,
    "",
    " ",
    "0",
    "100",
    "100.00",
    "100.0000000000000001",
    "100.00000000000001",
    "100.01",
    "101",
    "00101",
    "1e3",
    "+200",
    "-200",
    ".101",
    "101.",
    "0x101",
    "Infinity",
    "NaN",
    "１２３",
    "101\n",
    "\uFEFF101\u00a0",
    "9".repeat(400),
  ])
    for (const hasCredits of [false, true])
      for (const unlimited of [false, true])
        await check(
          `credit decimal ${JSON.stringify(balance)} ${hasCredits}/${unlimited}`,
          {
            op: "console-credits",
            credits: { balance, hasCredits, unlimited },
          },
        );
  for (const credits of [
    null,
    {},
    { hasCredits: false, unlimited: true, balance: "200" },
  ])
    await check("absent credit fields", { op: "console-credits", credits });
  const root = {
    routeId: "root-route",
    model: {
      id: "root-model",
      name: "Root model",
      providerModelId: "discovered",
      reasoningEffort: null,
      catalog: null,
    },
    provider: {
      id: "provider",
      name: "Provider",
      kind: "chatgpt",
      accountId: null,
      credentialHomeKey: null,
      credits: null,
      weeklyUsageReservePercent: 20,
      baseUrl: "https://example.invalid",
    },
  };
  for (const kind of ["chatgpt", "grok", "ollama", "openai-compatible"])
    for (const providerModelId of [null, "discovered"])
      for (const baseUrl of [
        "https://openrouter.ai/api/v1",
        "https://OPENROUTER.AI:443/api/v1",
        "https://sub.openrouter.ai",
        "https://openrouter.ai.evil.invalid",
        "https://openrouter.ai./",
        "invalid",
      ])
        for (const state of ["available", "unavailable", null]) {
          const runtime = {
            ...root,
            model: { ...root.model, providerModelId },
            provider: { ...root.provider, kind, baseUrl },
          };
          await check(
            `route availability ${kind}/${providerModelId}/${baseUrl}/${state}`,
            {
              op: "console-eligibility",
              runtime,
              worker: "alpha",
              availability: [
                { workerId: "beta", scopeKey: "other", state: "available" },
                { workerId: "alpha", scopeKey: "openrouter:global", state },
              ],
            },
          );
        }
  const baseAccount = {
    accountId: "one",
    enabled: true,
    credentialState: "signed-in",
    credentialHomeKey: "home-one",
    legacyWorkerAuthenticated: false,
    modelAvailability: "available",
    position: 0,
    weeklyUsageUsedPercent: null,
    credits: null,
  };
  for (const kind of ["chatgpt", "grok"])
    for (const credentialState of [
      "signed-in",
      "migration-needed",
      "signed-out",
      "reauth-required",
      "conflict",
    ])
      for (const weeklyUsageUsedPercent of [null, 0, 79.99, 80, 100])
        for (const credits of [
          null,
          { hasCredits: true, unlimited: false, balance: "100" },
          { hasCredits: true, unlimited: false, balance: "101" },
          { hasCredits: true, unlimited: true, balance: null },
        ]) {
          const runtime = { ...root, provider: { ...root.provider, kind } };
          const accounts = [
            {
              ...baseAccount,
              accountId: "preferred",
              position: 4,
              credentialState,
              weeklyUsageUsedPercent,
              credits,
            },
            {
              ...baseAccount,
              accountId: "legacy",
              position: 1,
              credentialState: "migration-needed",
              legacyWorkerAuthenticated: true,
            },
            {
              ...baseAccount,
              accountId: "disabled",
              enabled: false,
              position: 2,
            },
            {
              ...baseAccount,
              accountId: "unavailable",
              modelAvailability: "unavailable",
              position: 3,
            },
            { ...baseAccount, accountId: "healthy", position: 5 },
          ];
          await check(
            `account admission ${kind}/${credentialState}/${weeklyUsageUsedPercent}/${JSON.stringify(credits)}`,
            {
              op: "console-accounts",
              runtime,
              accounts,
              worker: "alpha",
              preferred: "preferred",
            },
          );
        }
  for (const accounts of [
    [],
    [{ ...baseAccount, enabled: false }],
    [{ ...baseAccount, modelAvailability: "unavailable" }],
  ])
    for (const providerModelId of [null, "discovered"])
      await check("account empty and custom-ID eligibility", {
        op: "console-accounts",
        runtime: { ...root, model: { ...root.model, providerModelId } },
        accounts,
        worker: "alpha",
      });
  for (const isPrimary of [false, true])
    for (const worktreePolicy of ["direct", "required-for-writes"])
      for (const permissionProfileId of [null, ":workspace", ":yolo"])
        for (const nativePermissionPolicy of [
          null,
          {},
          {
            resolvedSelectedId: ":danger-full-access",
            effectiveId: ":read-only",
            selectedId: null,
          },
        ]) {
          const context = {
            chatId: "chat",
            contextKind: "project",
            experience: "agent",
            projectId: "github",
            worktreeId: "github-alpha-main",
            rootKind: "worktree",
            computerUseEnabled: true,
            isPrimary,
            worktreePolicy,
            permissionProfileId,
            defaultPermissionProfileId: null,
            nativePermissionPolicy,
          };
          await check("effective console permission", {
            op: "console-permission",
            context,
          });
        }
  for (const experience of ["agent", "chat"])
    for (const contextKind of ["project", "standalone"])
      await check("managed session scope", {
        op: "console-permission",
        context: {
          chatId: "chat",
          contextKind,
          experience,
          projectId: "github",
          worktreeId: "github-alpha-main",
          rootKind: "worktree",
          permissionProfileId: null,
          isPrimary: false,
          worktreePolicy: "direct",
        },
      });

  await seed("DELETE FROM native_runtime_handoffs WHERE chat_id='chat';");
  await seed("DELETE FROM native_settings_states WHERE chat_id='chat';");
  await seed(
    "UPDATE model_providers SET weekly_usage_reserve_percent=20 WHERE id='console-provider';",
  );
  await seed(
    "UPDATE model_provider_accounts SET credential_state='signed-in',weekly_usage_used_basis_points=NULL,credits=NULL WHERE provider_id='console-provider';",
  );
  const context = {
    workerId: "alpha",
    providerAccountId: "account-two",
    modelId: "console-model",
    modelRouteId: null,
    reasoningEffort: null,
  };
  let available = await check(
    "actual account preference and global repository projection",
    { op: "console-available", context, model: "console-model" },
  );
  assert.deepEqual(
    available.map((r) => r.provider.accountId),
    ["account-two", "account-one"],
  );
  await check(
    "actual missing model route error",
    { op: "console-available", context, model: "missing" },
    { rejected: true },
  );
  await check(
    "foreign owner cannot load a route",
    { op: "console-available", owner: other, context, model: "console-model" },
    { rejected: true },
  );
  await seed(
    "UPDATE user_settings SET default_model_id='console-model' WHERE user_id=" +
      literal(owner),
  );
  assert.equal(
    await check("configured default resolves missing model", {
      op: "console-model",
      context: { ...context, modelId: null },
    }),
    "console-model",
  );
  assert.equal(
    await check("requested model wins over context", {
      op: "console-model",
      context,
      requested: "console-model-two",
    }),
    "console-model-two",
  );
  await check(
    "explicit empty model is not a default fallback",
    { op: "console-model", context, requested: "" },
    { rejected: true },
  );
  await seed(
    "UPDATE user_settings SET default_model_id=NULL WHERE user_id=" +
      literal(owner),
  );
  await check(
    "missing model has setup-specific message",
    { op: "console-model", context: { ...context, modelId: null } },
    { rejected: true },
  );
  await check("cooldown of preferred account admits another", {
    op: "console-available",
    context,
    model: "console-model",
    now: 1000,
    cooldowns: [["console-route:account:account-two", 1001]],
  });
  await check("cooldown exact boundary is eligible", {
    op: "console-available",
    context,
    model: "console-model",
    now: 1000,
    cooldowns: [["console-route:account:account-two", 1000]],
  });
  await check(
    "all account cooldowns retain ordered diagnostics",
    {
      op: "console-available",
      context,
      model: "console-model",
      now: 1000,
      cooldowns: [
        ["console-route:account:account-two", 1001],
        ["console-route:account:account-one", 1001],
      ],
    },
    { rejected: true },
  );
  for (const [state, used, credits] of [
    ["signed-out", null, null],
    ["conflict", null, null],
    ["migration-needed", null, null],
    ["signed-in", 8000, null],
    ["signed-in", 10000, null],
    [
      "signed-in",
      10000,
      { hasCredits: true, unlimited: false, balance: "101" },
    ],
  ]) {
    await seed(
      `UPDATE model_provider_accounts SET credential_state=${literal(state)},weekly_usage_used_basis_points=${literal(used)},credits=${json(credits)} WHERE provider_id='console-provider';`,
    );
    await check(
      `actual persisted account admission ${state}/${used}/${!!credits}`,
      { op: "console-available", context, model: "console-model" },
      { rejected: !credits },
    );
  }
  await check("ChatGPT credits bypass account cooldown", {
    op: "console-available",
    context,
    model: "console-model",
    now: 1000,
    cooldowns: [
      ["console-route:account:account-two", 1001],
      ["console-route:account:account-one", 1001],
    ],
  });
  await seed(
    "UPDATE model_providers SET kind='grok' WHERE id='console-provider';",
  );
  await check(
    "Grok credits do not bypass account cooldown",
    {
      op: "console-available",
      context,
      model: "console-model",
      now: 1000,
      cooldowns: [
        ["console-route:account:account-two", 1001],
        ["console-route:account:account-one", 1001],
      ],
    },
    { rejected: true },
  );
  await seed(
    "UPDATE model_providers SET kind='chatgpt' WHERE id='console-provider';",
  );
  await seed(
    "UPDATE model_provider_accounts SET credential_state='signed-in',weekly_usage_used_basis_points=NULL,credits=NULL WHERE provider_id='console-provider';",
  );
  const configuration = {
    modelId: "console-model",
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
  };
  await check(
    "offline pair failure precedes model resolution",
    { op: "console-pairs", context, configuration, connected: false },
    { rejected: true },
  );
  await check(
    "root route failure becomes structured configuration failure",
    {
      op: "console-pairs",
      context,
      configuration: { ...configuration, modelId: "missing" },
    },
    { rejected: true },
  );
  await check(
    "subagent capability checked before supplied root",
    {
      op: "console-pairs",
      context,
      configuration: { ...configuration, customSubagentModel: true },
      roots: available,
    },
    { rejected: true },
  );
  for (const capability of [
    { available: true, protocolVersion: 2, reason: null },
    {
      available: false,
      protocolVersion: null,
      reason: "Worker fixture declines subagents",
    },
  ]) {
    await seed(
      `UPDATE workers SET codex_runtime=jsonb_set(codex_runtime,'{nativeSubagents}',${json(capability)}) WHERE id='alpha';`,
    );
    await check(
      "actual subagent report diagnostics",
      {
        op: "console-pairs",
        context,
        configuration: { ...configuration, customSubagentModel: true },
        roots: available,
      },
      { rejected: true },
    );
  }
  await seed(
    `UPDATE workers SET codex_runtime=jsonb_set(codex_runtime,'{nativeSubagents}',${json({ available: true, protocolVersion: 1, reason: null })}) WHERE id='alpha';`,
  );
  const custom = {
    ...configuration,
    customSubagentModel: true,
    subagentModelId: "console-model-two",
  };
  await check("actual compatible root and child account topology", {
    op: "console-pairs",
    context,
    configuration: custom,
  });
  await check(
    "missing child is a structured retryable failure",
    {
      op: "console-pairs",
      context,
      configuration: { ...custom, subagentModelId: "missing" },
    },
    { rejected: true },
  );
  await check(
    "unselected child retains its configuration failure",
    {
      op: "console-pairs",
      context,
      configuration: { ...custom, subagentModelId: null },
    },
    { rejected: true },
  );
  await check(
    "supplied root retains exact child provider identity",
    {
      op: "console-pairs",
      context,
      configuration: custom,
      roots: [
        {
          ...available[0],
          provider: { ...available[0].provider, id: "different-provider" },
        },
      ],
    },
    { rejected: true },
  );
  await check("actual default pair topology", {
    op: "console-pairs",
    context,
    configuration,
  });
  await check(
    "unsupported reasoning is rejected",
    {
      op: "console-pairs",
      context,
      configuration: { ...configuration, reasoningEffort: "high" },
    },
    { rejected: true },
  );
  await check("bound route resolves its current preferred account", {
    op: "console-context",
  });

  await seed(
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('api-provider',${literal(owner)},'API provider','ollama','http://127.0.0.1:11434');`,
  );
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('api-model',${literal(owner)},'API model');`,
  );
  await seed(
    `INSERT INTO provider_models(id,provider_id,native_model_id,display_name,metadata_source,last_seen_at,created_at,updated_at) VALUES('api-catalog','api-provider','api-native','API catalog','ollama',${literal(stamp)},${literal(stamp)},${literal(stamp)});`,
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,provider_model_id,position,enabled) VALUES('api-route','api-model','api-provider','api-native','api-catalog',0,true);",
  );
  await check(
    "actual Ollama route requires worker-scoped availability",
    { op: "console-available", context, model: "api-model" },
    { rejected: true },
  );
  await seed(
    "INSERT INTO provider_model_availability(id,provider_model_id,scope_key,worker_id,state) VALUES('api-availability','api-catalog','worker:alpha','alpha','available');",
  );
  await check("actual Ollama route reads current worker scope", {
    op: "console-available",
    context,
    model: "api-model",
  });
  await check(
    "other worker cannot inherit Ollama scope",
    {
      op: "console-available",
      context: { ...context, workerId: "beta" },
      model: "api-model",
    },
    { rejected: true },
  );
  await check(
    "nonaccount route cooldown",
    {
      op: "console-available",
      context,
      model: "api-model",
      now: 1000,
      cooldowns: [["api-route", 1001]],
    },
    { rejected: true },
  );
  const hydrated = await check(
    "catalog hydration triggers an actual repository reload",
    {
      op: "console-available",
      context,
      model: "api-model",
      hydrateSql:
        "UPDATE model_routes SET model_name='hydrated-id' WHERE id='api-route';",
    },
  );
  assert.equal(hydrated[0].model.name, "hydrated-id");
  await seed(
    "UPDATE model_providers SET kind='openai-compatible',base_url='https://example.invalid/api' WHERE id='api-provider';",
  );
  await check("custom compatible provider has no discovery gate", {
    op: "console-available",
    context: { ...context, workerId: "beta" },
    model: "api-model",
  });
  await seed(
    "UPDATE model_providers SET base_url='https://openrouter.ai/api/v1' WHERE id='api-provider';",
  );
  await check(
    "OpenRouter requires actual global account scope",
    { op: "console-available", context, model: "api-model" },
    { rejected: true },
  );
  await seed(
    "INSERT INTO provider_model_availability(id,provider_model_id,scope_key,state) VALUES('api-global','api-catalog','openrouter:global','available');",
  );
  await check("OpenRouter actual global availability admits route", {
    op: "console-available",
    context,
    model: "api-model",
  });
  await seed(
    "UPDATE provider_model_availability SET state='stale' WHERE id='api-global';",
  );
  await check(
    "stale OpenRouter scope is unavailable",
    { op: "console-available", context, model: "api-model" },
    { rejected: true },
  );

  const blind = Buffer.alloc(32, 71).toString("base64url"),
    opaque = projectLabel.protectedLabel;
  await seed(
    `INSERT INTO mcp_servers(id,owner_id,name_blind_index,protected_configuration,audience) VALUES('88888888-8888-4888-8888-888888888881',${literal(owner)},${literal(blind)},${json(opaque)},'both');`,
  );
  await seed(
    `INSERT INTO mcp_servers(id,owner_id,project_id,worker_id,name_blind_index,protected_configuration,audience) VALUES('88888888-8888-4888-8888-888888888882',${literal(owner)},'github','alpha',${literal(blind)},${json(opaque)},'ide');`,
  );
  await seed(
    "UPDATE chats SET custom_subagent_model=true,subagent_model_id='console-model-two' WHERE id='chat';",
  );

  let before = await snapshot("before existing-thread launch");
  let launch = await check(
    "existing thread composes actual console configuration",
    { op: "console-launch" },
  );
  assert.equal(launch.type, "codex");
  assert.equal(
    launch.subagentDefaults.provider.accountId,
    launch.provider.accountId,
  );
  assert.deepEqual(launch.mcpServers, [
    {
      id: "88888888-8888-4888-8888-888888888882",
      enabled: true,
      nameBlindIndex: blind,
      protectedConfiguration: opaque,
    },
  ]);
  assert.deepEqual(
    await snapshot("existing thread launch performs no binding writes"),
    before,
  );
  await seed(
    "UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id='chat';",
  );
  for (const ensureResult of [{}, { threadId: "" }, { threadId: 42 }, null]) {
    before = await snapshot("before invalid ensure result");
    await check(
      "invalid actual console thread return",
      { op: "console-launch", ensureResult },
      { rejected: true },
    );
    assert.deepEqual(
      await snapshot("invalid ensure has no binding writes"),
      before,
    );
  }
  await check(
    "missing ensure result preserves property diagnostic",
    { op: "console-launch", ensureOmitted: true },
    { rejected: true },
  );
  await check(
    "ensure error propagates before binding",
    { op: "console-launch", ensureError: "Fixture worker rejected console" },
    { rejected: true },
  );
  const unicodeThread = "\ud800console-thread";
  const unicodeLaunch = await check(
    "ensure thread keeps wire UTF16 and stores Node UTF8 replacement",
    { op: "console-launch", ensureResult: { threadId: unicodeThread } },
  );
  assert.equal(unicodeLaunch.threadId, unicodeThread);
  const unicodeState = await snapshot(
    "surrogate thread identity storage boundary",
  );
  assert.equal(
    unicodeState.runtimes.find((r) => r.chat_id === "chat").codex_thread_id,
    "�console-thread",
  );
  await seed(
    "UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id='chat';",
  );
  launch = await check("new thread persists model then canonical runtime", {
    op: "console-launch",
  });
  assert.equal(launch.threadId, "fixture-console-thread");
  const after = await snapshot("ensured console is durably bound");
  assert.equal(
    after.runtimes.find((r) => r.chat_id === "chat").codex_thread_id,
    "fixture-console-thread",
  );
  await check(
    "standalone console is rejected by actual launch service",
    { op: "console-launch", chat: standalone },
    { rejected: true },
  );

  await seed(
    "UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id='chat';",
  );
  const handoff = `INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,phase,source,target_model_route_id) VALUES('console-handoff',${literal(owner)},'chat','alpha','preparing','{}','console-route');`;
  await check(
    "handoff introduced during ensure prevents model and binding",
    { op: "console-launch", ensureSql: handoff },
    { rejected: true },
  );
  let fenced = await snapshot("ensure handoff retains unbound runtime");
  assert.equal(
    fenced.runtimes.find((r) => r.chat_id === "chat").codex_thread_id,
    null,
  );
  await seed(
    "DELETE FROM native_runtime_handoffs WHERE operation_id='console-handoff';",
  );
  await seed("UPDATE chats SET model_id='console-model-two' WHERE id='chat';");
  const replacement = {
    workerId: "alpha",
    threadId: "fixture-console-thread",
    placementId: "github-alpha-main",
    modelRouteId: "console-route-two",
    providerAccountId: "account-two",
  };
  await check(
    "canonical binding conflict occurs after model selection commits",
    {
      op: "console-launch",
      ensureSql: `INSERT INTO native_settings_states(chat_id,state) VALUES('chat',${json({ binding: replacement })});`,
    },
    { rejected: true },
  );
  fenced = await snapshot("model commit survives rejected canonical binding");
  assert.equal(
    fenced.chats.find((c) => c.id === "chat").model_id,
    "console-model",
  );
  assert.equal(
    fenced.runtimes.find((r) => r.chat_id === "chat").codex_thread_id,
    null,
  );
  await seed("DELETE FROM native_settings_states WHERE chat_id='chat';");
  await check("canonical binding succeeds after conflict removed", {
    op: "console-launch",
  });
}
