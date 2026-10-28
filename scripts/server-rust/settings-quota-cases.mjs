import assert from "node:assert/strict";
import { quotaSnapshot } from "./settings-provider-fixtures.mjs";

export async function quotaCases({
  seed,
  compare,
  unchanged,
  literal,
  envelope,
}) {
  const owner = "quota-owner",
    other = "quota-other",
    provider = "quota-provider",
    account = "88888888-8888-4888-8888-888888888883",
    foreignAccount = "88888888-8888-4888-8888-888888888884",
    worker = "quota-worker";
  for (const id of [owner, other]) {
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(id)},'account','member','active','Quota fixture',${literal(id + "@example.invalid")},${literal(id + "@example.invalid")});`,
    );
    await compare("initialize quota owner " + id, {
      op: "ensure-account",
      owner: id,
    });
  }
  for (const [principal, id, initial] of [
    [owner, provider, account],
    [other, "quota-foreign", foreignAccount],
  ])
    await compare("create quota provider " + id, {
      op: "provider-create",
      owner: principal,
      input: {
        id,
        name: id,
        kind: "chatgpt",
        baseUrl: "https://chatgpt.com",
        protectedApiKey: null,
        initialAccount: { id: initial, protectedLabel: envelope },
      },
    });
  for (const [id, principal, unlinked] of [
    [worker, owner, false],
    ["quota-unlinked", owner, true],
    ["quota-foreign-worker", other, false],
  ])
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,unlinked_at) VALUES(${literal(id)},${literal(principal)},'Quota worker','linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z',${unlinked ? "'2026-10-26T00:00:00Z'" : "NULL"});`,
    );
  await seed(
    `UPDATE model_provider_accounts SET plan_type='free' WHERE id=${literal(account)};`,
  );
  await seed(
    `INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state) VALUES(${literal(account)},${literal(worker)},'signed-in');`,
  );
  const scoped = (op, extra = {}) => ({
    op,
    owner,
    provider,
    account,
    worker,
    ...extra,
  });
  const query = (label, sql) =>
    compare(label, scoped("query-json", { sql }), {
      fixedDates: ["observed_at", "resets_at", "credits_observed_at"],
    });
  const projection = () =>
    query(
      "quota account projection",
      `SELECT jsonb_build_object('plan',plan_type,'used',weekly_usage_used_basis_points,'observed_at',weekly_usage_observed_at,'resets_at',weekly_usage_resets_at,'credits',credits,'credits_observed_at',credits_observed_at,'auth_at',auth_last_synced_at,'credential_state',credential_state) AS result FROM model_provider_accounts WHERE id=${literal(account)}`,
    );
  const ledger = () =>
    query(
      "immutable quota ledger dimensions",
      `SELECT coalesce(jsonb_agg(to_jsonb(q)-'id'-'received_at' ORDER BY event_key),'[]'::jsonb) AS result FROM provider_quota_observations q WHERE owner_id=${literal(owner)}`,
    );
  const base = {
    eventKey: "direct",
    observationBatchKey: "direct-batch",
    providerId: provider,
    providerAccountId: account,
    workerId: worker,
    observedAt: "2026-10-26T00:00:00.000Z",
    usedPercent: 1.2345675,
    resetsAt: "2026-11-01T00:00:00.000Z",
    windowDurationMinutes: 10080,
    limitId: "codex",
    windowKind: "secondary",
    planType: "plus",
    reachedType: null,
    observationTrigger: "test-capture",
    isWeeklyProjection: true,
    chatId: null,
    turnId: null,
    executionAttemptId: null,
    workerVersion: "worker",
    serverVersion: "server",
    codexVersion: "codex",
  };
  const observe = (label, patch = {}, options = {}) =>
    compare(
      label,
      scoped("quota-observe", { input: { ...base, ...patch } }),
      options,
    );
  assert.equal(
    await observe("insert immutable quota event with weekly projection"),
    true,
  );
  let state = await projection();
  assert.equal(state.used, 123);
  assert.equal(state.plan, "plus");
  assert.equal(state.auth_at, null);
  let rows = await ledger();
  assert.equal(rows[0].used_percent_micros, 1234568);
  assert.equal(
    await unchanged(
      "duplicate quota event cannot rewrite projections",
      scoped("quota-observe", {
        input: { ...base, usedPercent: 99, planType: "different" },
      }),
    ),
    false,
  );
  assert.equal(
    await observe("independent identical readings remain distinct", {
      eventKey: "independent",
    }),
    true,
  );
  for (const [name, patch] of [
    ["nan-compatible null", { usedPercent: null }],
    ["negative", { usedPercent: -1 }],
    ["over100", { usedPercent: 100.001 }],
    ["invalid date", { observedAt: "invalid" }],
    ["fractional window", { windowDurationMinutes: 1.5 }],
    ["negative window", { windowDurationMinutes: -1 }],
    ["missing provider", { providerId: "missing" }],
    ["foreign account", { providerAccountId: foreignAccount }],
    ["foreign worker", { workerId: "quota-foreign-worker" }],
    ["missing worker", { workerId: "missing" }],
  ])
    assert.equal(
      await unchanged(
        "quota refuses " + name,
        scoped("quota-observe", {
          input: { ...base, eventKey: "invalid-" + name, ...patch },
        }),
      ),
      false,
    );
  assert.equal(
    await unchanged(
      "foreign owner cannot append owned quota readings",
      scoped("quota-observe", {
        owner: other,
        input: { ...base, eventKey: "foreign-owner" },
      }),
    ),
    false,
  );
  await observe(
    "older observation remains in ledger without regressing usage",
    {
      eventKey: "older",
      observedAt: "1990-01-01T00:00:00.000Z",
      usedPercent: 80,
      planType: "old",
    },
  );
  state = await projection();
  assert.equal(state.used, 123);
  assert.equal(state.plan, "plus");
  await seed(
    `UPDATE model_provider_account_workers SET weekly_usage_observed_at='2030-01-01T00:00:00Z',weekly_usage_used_basis_points=8000 WHERE account_id=${literal(account)};`,
  );
  await observe(
    "account projection advances independently of newer worker projection",
    {
      eventKey: "newer",
      observedAt: "2028-01-01T00:00:00.000Z",
      usedPercent: 40,
      planType: "team",
    },
  );
  state = await projection();
  assert.equal(state.used, 4000);
  const binding = await query(
    "newer worker projection is retained",
    `SELECT jsonb_build_object('used',weekly_usage_used_basis_points,'observed_at',weekly_usage_observed_at) AS result FROM model_provider_account_workers WHERE account_id=${literal(account)} AND worker_id=${literal(worker)}`,
  );
  assert.equal(binding.used, 8000);
  assert.equal(
    new Date(binding.observed_at).toISOString(),
    "2030-01-01T00:00:00.000Z",
  );
  await observe("equal-time independent observations may advance projection", {
    eventKey: "equal",
    observedAt: "2028-01-01T00:00:00.000Z",
    usedPercent: 41,
  });
  state = await projection();
  assert.equal(state.used, 4100);
  await observe("non-weekly reading never updates cached weekly usage", {
    eventKey: "primary-only",
    observedAt: "2032-01-01T00:00:00.000Z",
    usedPercent: 90,
    isWeeklyProjection: false,
  });
  state = await projection();
  assert.equal(state.used, 4100);
  assert.equal(
    await observe("unlinked owned workers remain valid historical dimensions", {
      eventKey: "unlinked",
      workerId: "quota-unlinked",
      isWeeklyProjection: false,
    }),
    true,
  );
  assert.equal(
    await observe("workerless readings do not create binding rows", {
      eventKey: "workerless",
      workerId: null,
      isWeeklyProjection: false,
    }),
    true,
  );
  assert.equal(
    await query(
      "quota readings never create authentication bindings",
      `SELECT to_jsonb(count(*)::integer) AS result FROM model_provider_account_workers WHERE account_id=${literal(account)}`,
    ),
    1,
  );
  const context = {
    providerId: provider,
    accountId: account,
    workerId: worker,
    accountPlanType: "team",
    trigger: "snapshot-capture",
    chatId: "historical-chat",
    turnId: "historical-turn",
    executionAttemptId: "historical-attempt",
  };
  const snapshot = {
    ...quotaSnapshot,
    snapshotId: "batch-one",
    observedAt: "2029-10-27T00:00:00.000Z",
    windows: quotaSnapshot.windows.map((window) => ({
      ...window,
      planType: null,
    })),
  };
  assert.equal(
    await compare(
      "snapshot records credits then both windows",
      scoped("quota-persist", { context, input: snapshot }),
    ),
    2,
  );
  state = await projection();
  assert.equal(state.used, 1235);
  assert.equal(state.plan, "team");
  assert.equal(state.credits.balance, "12.50");
  assert.equal(state.auth_at, null);
  rows = await ledger();
  let windows = rows.filter((row) => row.observation_batch_key === "batch-one");
  assert.equal(windows.length, 2);
  assert.equal(
    new Date(windows[0].resets_at).toISOString(),
    "1970-01-01T00:00:00.000Z",
  );
  assert.equal(windows[1].used_percent_micros, 12345679);
  assert.equal(windows[1].chat_id, "historical-chat");
  assert.equal(windows[1].turn_id, "historical-turn");
  assert.equal(windows[1].execution_attempt_id, "historical-attempt");
  assert.equal(
    await compare(
      "redelivered snapshot keeps immutable windows but may update same-time credits",
      scoped("quota-persist", {
        context,
        input: {
          ...snapshot,
          credits: { ...snapshot.credits, balance: "33.33" },
        },
      }),
    ),
    0,
  );
  state = await projection();
  assert.equal(state.credits.balance, "33.33");
  await compare(
    "older credits and weekly snapshot cannot roll current projections back",
    scoped("quota-persist", {
      context,
      input: {
        ...snapshot,
        snapshotId: "old-snapshot",
        observedAt: "2020-01-01T00:00:00.000Z",
        credits: { ...snapshot.credits, balance: "1.00" },
      },
    }),
  );
  state = await projection();
  assert.equal(state.credits.balance, "33.33");
  assert.equal(state.used, 1235);
  await unchanged(
    "snapshot validation precedes all credit and ledger writes",
    scoped("quota-persist", {
      context,
      input: {
        ...snapshot,
        windows: [{ ...snapshot.windows[0], usedPercent: 101 }],
      },
    }),
    { rejected: true },
  );
  await seed(
    "ALTER TABLE provider_quota_observations ADD CONSTRAINT fixture_quota_window CHECK(limit_id<>'reject-window');",
  );
  const fault = {
    ...snapshot,
    snapshotId: "interrupted-batch",
    observedAt: "2031-01-01T00:00:00.000Z",
    credits: { ...snapshot.credits, balance: "45.00" },
    windows: [
      snapshot.windows[0],
      { ...snapshot.windows[1], limitId: "reject-window", usedPercent: 66 },
    ],
  };
  await compare(
    "later window failure retains already committed credits and first window",
    scoped("quota-persist", { context, input: fault }),
    { rejected: true, exactError: false },
  );
  state = await projection();
  assert.equal(state.credits.balance, "45.00");
  assert.equal(state.used, 1235);
  rows = await ledger();
  assert.equal(
    rows.filter((row) => row.observation_batch_key === "interrupted-batch")
      .length,
    1,
  );
  await seed(
    "ALTER TABLE provider_quota_observations DROP CONSTRAINT fixture_quota_window;",
  );
  assert.equal(
    await compare(
      "retry inserts only the previously failed window",
      scoped("quota-persist", {
        context: { ...context, trigger: "retry-capture" },
        input: fault,
      }),
    ),
    1,
  );
  rows = await ledger();
  windows = rows.filter(
    (row) => row.observation_batch_key === "interrupted-batch",
  );
  assert.deepEqual(
    windows.map((window) => window.observation_trigger),
    ["snapshot-capture", "retry-capture"],
  );
  const readSnapshot = { ...snapshot, snapshotId: "read-snapshot" };
  const readContext = {
    ...context,
    provider: {
      name: "Quota provider",
      kind: "chatgpt",
      baseUrl: "https://chatgpt.com",
      credentialHomeKey: "legacy-home",
    },
  };
  const read = await compare(
    "read quota uses the actual worker command and persists its parsed response",
    scoped("quota-read", {
      context: readContext,
      input: { connected: true, inventory: readSnapshot },
    }),
  );
  assert.equal(read.result.inserted, 2);
  assert.equal(read.calls[0].command.type, "provider.quota.read");
  assert.equal(read.calls[0].options.timeoutMs, 120000);
  assert.equal(read.calls[0].command.provider.credentialHomeKey, "legacy-home");
  const activity = {
    id: "activity",
    type: "rateLimit",
    limitId: "codex",
    limitName: "Codex",
    planType: null,
    reachedType: null,
    credits: null,
    primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 0 },
    secondary: { usedPercent: 51, windowDurationMins: 10080, resetsAt: null },
  };
  const activityNow = Date.parse("2032-01-01T00:00:00.000Z");
  assert.equal(
    await compare(
      "rate-limit activity generates a stable fallback batch",
      scoped("quota-activity", { context, input: activity, now: activityNow }),
    ),
    2,
  );
  assert.equal(
    await compare(
      "redelivered rate-limit activity deduplicates both windows",
      scoped("quota-activity", { context, input: activity, now: activityNow }),
    ),
    0,
  );
  const diagnostic = {
    ...activity,
    updatedAtMs: 0,
    correlation: {
      diagnosticId: "diagnostic-batch",
      sourceMethod: "diagnostic",
    },
    limitId: "other-provider",
    credits: { hasCredits: true, unlimited: false, balance: "0.00" },
  };
  assert.equal(
    await compare(
      "non-Codex activity ignores credits and weekly projection",
      scoped("quota-activity", {
        context,
        input: diagnostic,
        now: activityNow,
      }),
    ),
    2,
  );
  state = await projection();
  assert.equal(state.credits.balance, "45.00");
  assert.equal(state.used, 5100);
  rows = await ledger();
  assert.ok(
    rows
      .filter((row) => row.observation_batch_key === "diagnostic-batch")
      .every(
        (row) =>
          row.is_weekly_projection === false &&
          new Date(row.observed_at).toISOString() ===
            "1970-01-01T00:00:00.000Z",
      ),
  );
  await unchanged(
    "invalid activity time fails before persistence",
    scoped("quota-activity", {
      context,
      input: { ...activity, updatedAtMs: 8640000000000001 },
      now: activityNow,
    }),
    { rejected: true },
  );
  await unchanged(
    "invalid activity batch fails before persistence",
    scoped("quota-activity", {
      context,
      input: { ...activity, correlation: { diagnosticId: "" } },
      now: activityNow,
    }),
    { rejected: true },
  );
  await unchanged(
    "year-zero credit timestamp uses actual source PostgreSQL input semantics",
    scoped("quota-persist", {
      context,
      input: {
        ...snapshot,
        snapshotId: "year-zero",
        observedAt: "0000-01-01T00:00:00.000Z",
        windows: [],
      },
    }),
    { rejected: true, exactError: false },
  );
  assert.equal(
    await compare(
      "credit timestamps retain JavaScript millisecond precision",
      scoped("account-credits", {
        credits: { hasCredits: true, unlimited: false, balance: "71.00" },
        observedAt: "2034-01-01T00:00:00.123456789Z",
      }),
    ),
    true,
  );
  assert.equal(
    await compare(
      "same-millisecond credit observations may replace prior values",
      scoped("account-credits", {
        credits: { hasCredits: true, unlimited: false, balance: "72.00" },
        observedAt: "2034-01-01T00:00:00.123Z",
      }),
    ),
    true,
  );
  state = await projection();
  assert.equal(state.credits.balance, "72.00");
  assert.equal(
    new Date(state.credits_observed_at).toISOString(),
    "2034-01-01T00:00:00.123Z",
  );
}
