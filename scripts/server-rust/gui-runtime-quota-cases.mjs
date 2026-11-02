import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";

export async function runGuiRuntimeQuotaCases({ observe, seed, owner }) {
  const provider = "gui-quota-provider",
    account = "gui-quota-account",
    now = Math.floor(Date.parse(stamp) / 1000) * 1000,
    credits = { balance: "25.00", hasCredits: true, unlimited: false };
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('${provider}',${literal(owner)},'Quota account','chatgpt','https://chatgpt.com') ON CONFLICT DO NOTHING`,
    `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key) VALUES('${account}','${provider}','{}'::jsonb,'quota-home') ON CONFLICT DO NOTHING`,
  ]);
  const execution = { workerId: "alpha", chatId: "chat" },
    runtime = {
      routeId: "gui-anchor",
      provider: {
        id: provider,
        accountId: account,
        kind: "chatgpt",
        name: "Quota account",
        baseUrl: "https://chatgpt.com",
        credentialHomeKey: "quota-home",
        credits: null,
      },
      model: { reasoningEffort: "high" },
    };
  const window = (patch = {}) => ({
    limitId: "codex",
    limitName: "Codex",
    planType: "plus",
    reachedType: null,
    windowKind: "secondary",
    usedPercent: 12.3456785,
    windowDurationMinutes: 10080,
    resetsAt: null,
    isWeeklyProjection: true,
    rawPayload: { opaque: "worker-metadata" },
    ...patch,
  });
  const snapshot = (patch = {}) => ({
    snapshotId: "quota-snapshot",
    observedAt: stamp,
    workerVersion: "quota-worker",
    codexVersion: "quota-codex",
    windows: [window()],
    credits,
    ...patch,
  });
  const activity = (patch = {}) => ({
    type: "rateLimit",
    id: "rate-activity",
    updatedAtMs: now,
    limitId: "codex",
    limitName: "Codex",
    planType: "plus",
    reachedType: null,
    credits,
    primary: null,
    secondary: {
      usedPercent: 23.4567895,
      windowDurationMins: 10080,
      resetsAt: null,
    },
    correlation: {
      diagnosticId: "quota-diagnostic",
      turnId: "activity-turn",
      sourceMethod: "worker-rate-limit",
    },
    ...patch,
  });
  const clean = () =>
    seed([
      "DELETE FROM provider_quota_observations",
      `UPDATE model_provider_accounts SET credits=NULL,credits_observed_at=NULL,plan_type=NULL,weekly_usage_used_basis_points=NULL,weekly_usage_observed_at=NULL,weekly_usage_resets_at=NULL WHERE id='${account}'`,
      `UPDATE model_providers SET kind='chatgpt' WHERE id='${provider}'`,
    ]);
  const run = (name, fields = {}) =>
    observe(
      name,
      {
        action: "quota",
        now,
        runtime,
        execution,
        attempt: "quota-attempt",
        turnId: "snapshot-turn",
        snapshot: snapshot(),
        steps: [{ op: "capture" }],
        ...fields,
      },
      { op: "native-command-gui-quota", shape: "raw" },
    );
  const state = (name) =>
    observe(
      name,
      {
        sql: `SELECT jsonb_build_object('readings',(SELECT jsonb_agg(to_jsonb(q)-'id'-'received_at' ORDER BY event_key) FROM provider_quota_observations q),'account',(SELECT jsonb_build_object('credits',credits,'creditsObservedAt',credits_observed_at,'planType',plan_type,'used',weekly_usage_used_basis_points) FROM model_provider_accounts WHERE id='${account}')) result`,
      },
      { op: "query-json", shape: "raw" },
    );
  await clean();
  let outputs = await run(
    "quota snapshot uses the actual worker protocol and account writer",
  );
  for (const o of outputs) {
    assert.deepEqual(o.runtime.provider.credits, credits);
    assert.deepEqual(o.publications, [
      { ownerId: owner, resource: "settings" },
    ]);
    assert.deepEqual(o.logs, []);
    assert.equal(o.commands.length, 1);
    assert.deepEqual(o.commands[0], {
      ownerId: owner,
      worker: "alpha",
      atMs: now,
      timeoutMs: 120000,
      command: {
        type: "provider.quota.read",
        provider: {
          id: provider,
          accountId: account,
          kind: "chatgpt",
          name: "Quota account",
          baseUrl: "https://chatgpt.com",
          credentialHomeKey: "quota-home",
          protectedApiKey: null,
        },
      },
    });
  }
  let states = await state("snapshot dimensions and weekly account projection");
  for (const s of states) {
    assert.equal(s.readings.length, 1);
    assert.equal(s.readings[0].observation_trigger, "fixture-capture");
    assert.equal(s.readings[0].execution_attempt_id, "quota-attempt");
    assert.equal(s.readings[0].turn_id, "snapshot-turn");
    assert.equal(s.readings[0].used_percent_micros, 12345679);
    assert.equal(s.account.used, 1235);
    assert.deepEqual(s.account.credits, credits);
  }
  await clean();
  outputs = await run(
    "identical captured credits publish once and snapshot readings deduplicate",
    { steps: [{ op: "capture" }, { op: "capture" }] },
  );
  for (const o of outputs) {
    assert.equal(o.commands.length, 2);
    assert.equal(o.publications.length, 1);
  }
  states = await state("one immutable quota reading for a repeated snapshot");
  for (const s of states) assert.equal(s.readings.length, 1);
  await clean();
  outputs = await run(
    "live Codex rate limit activity updates the same route credits",
    {
      steps: [
        { op: "activity", activity: activity() },
        { op: "activity", activity: activity() },
      ],
    },
  );
  for (const o of outputs) {
    assert.equal(o.commands.length, 0);
    assert.deepEqual(o.runtime.provider.credits, credits);
    assert.equal(o.publications.length, 1);
  }
  states = await state(
    "live rate limit preserves actual correlation and fallback metadata",
  );
  for (const s of states) {
    assert.equal(s.readings.length, 1);
    assert.equal(s.readings[0].observation_trigger, "live-rate-limit-update");
    assert.equal(s.readings[0].turn_id, "activity-turn");
    assert.equal(s.readings[0].observation_batch_key, "quota-diagnostic");
    assert.equal(s.readings[0].worker_version, null);
    assert.equal(s.account.used, 2346);
  }
  for (const limitId of [null, "other-limit"]) {
    await clean();
    outputs = await run("live rate limit credit eligibility " + limitId, {
      steps: [
        {
          op: "activity",
          activity: activity({ limitId, correlation: null, updatedAtMs: null }),
        },
      ],
    });
    for (const o of outputs) {
      assert.equal(o.publications.length, limitId === null ? 1 : 0);
      assert.deepEqual(
        o.runtime.provider.credits,
        limitId === null ? credits : null,
      );
    }
    states = await state(
      "limit-specific credits and default observation clock " + limitId,
    );
    for (const s of states) {
      assert.equal(s.readings[0].turn_id, null);
      assert.equal(
        s.readings[0].observation_batch_key,
        `quota-attempt:rate-activity:${now}`,
      );
      assert.deepEqual(s.account.credits, limitId === null ? credits : null);
    }
  }
  await clean();
  const missingLimit = activity({ primary: null, secondary: null });
  delete missingLimit.limitId;
  outputs = await run(
    "missing live limit identity does not inherit explicit-null credit eligibility",
    {
      steps: [{ op: "activity", activity: missingLimit }],
    },
  );
  for (const o of outputs) {
    assert.equal(o.runtime.provider.credits, null);
    assert.deepEqual(o.publications, []);
    assert.deepEqual(o.logs, []);
  }
  states = await state(
    "missing live limit retains account credits without fabricating windows",
  );
  for (const s of states) {
    assert.equal(s.account.credits, null);
    assert.equal(s.readings, null);
  }
  await clean();
  await seed(`UPDATE model_providers SET kind='grok' WHERE id='${provider}'`);
  outputs = await run(
    "Grok quota persists without mutating ChatGPT runtime credit policy",
    {
      runtime: { ...runtime, provider: { ...runtime.provider, kind: "grok" } },
    },
  );
  for (const o of outputs) {
    assert.equal(o.commands.length, 1);
    assert.deepEqual(o.publications, []);
    assert.equal(o.runtime.provider.credits, null);
  }
  states = await state("Grok account uses its own provider kind");
  for (const s of states) {
    assert.equal(s.readings[0].provider_kind, "grok");
    assert.equal(s.account.credits, null);
  }
  for (const [label, patch] of [
    ["missing account", { accountId: null }],
    ["missing credential home", { credentialHomeKey: "" }],
    ["non-account provider", { kind: "ollama" }],
  ]) {
    await clean();
    outputs = await run("quota sampling skips " + label, {
      runtime: { ...runtime, provider: { ...runtime.provider, ...patch } },
    });
    for (const o of outputs) {
      assert.deepEqual(o.commands, []);
      assert.deepEqual(o.logs, []);
      assert.deepEqual(o.publications, []);
      assert.deepEqual(o.remainingTimers, []);
    }
    states = await state("no invented quota readings for " + label);
    for (const s of states) assert.equal(s.readings, null);
  }
  await clean();
  outputs = await run(
    "rate limit activity with no account returns before changing credits",
    {
      runtime: {
        ...runtime,
        provider: { ...runtime.provider, accountId: null },
      },
      steps: [{ op: "activity", activity: activity() }],
    },
  );
  for (const o of outputs) {
    assert.deepEqual(o.publications, []);
    assert.equal(o.runtime.provider.credits, null);
  }
  await clean();
  const resetsAt = now / 1000 + 20;
  outputs = await run(
    "known reset windows deduplicate across captures and release keys before recapture",
    {
      snapshot: snapshot({
        windows: [window({ resetsAt }), window({ resetsAt })],
      }),
      steps: [
        { op: "capture" },
        { op: "capture" },
        {
          op: "advance",
          byMs: 15000,
          snapshot: snapshot({
            snapshotId: "before-reset",
            windows: [window({ resetsAt })],
          }),
        },
        {
          op: "advance",
          byMs: 7000,
          snapshot: snapshot({
            snapshotId: "after-reset",
            windows: [window({ resetsAt })],
          }),
        },
      ],
    },
  );
  for (const o of outputs) {
    assert.deepEqual(
      o.commands.map((c) => c.atMs),
      [now, now, now + 15000, now + 22000],
    );
    assert.deepEqual(o.remainingTimers, []);
  }
  states = await state("reset phase observations retain exact triggers");
  for (const s of states)
    assert.deepEqual(
      s.readings.map((r) => r.observation_trigger).sort(),
      [
        "fixture-capture",
        "fixture-capture",
        "reset-window-after",
        "reset-window-before",
      ].sort(),
    );
  for (const [label, windows, expected] of [
    ["null reset", [window()], []],
    ["past reset", [window({ resetsAt: now / 1000 - 10 })], []],
    [
      "only future after phase",
      [window({ resetsAt: now / 1000 + 4 })],
      [now + 6000],
    ],
    [
      "maximum timer bound",
      [window({ resetsAt: now / 1000 + 2147005 })],
      [now + 2147000000],
    ],
    ["beyond timer bound", [window({ resetsAt: now / 1000 + 2147010 })], []],
    [
      "null and unknown limit share the Source reset identity",
      [
        window({ limitId: null, resetsAt }),
        window({ limitId: "unknown", resetsAt }),
      ],
      [now + 15000, now + 22000],
    ],
    [
      "distinct windows retain independent reset identities",
      [window({ resetsAt, windowKind: "primary" }), window({ resetsAt })],
      [now + 15000, now + 15000, now + 22000, now + 22000],
    ],
  ]) {
    await clean();
    outputs = await run("quota reset schedule " + label, {
      snapshot: snapshot({ windows }),
    });
    for (const o of outputs)
      assert.deepEqual(o.remainingTimers, expected, label);
  }
  await clean();
  outputs = await run(
    "turn completion samples immediately and after 5, 15 and 45 seconds",
    {
      steps: [
        { op: "completed" },
        {
          op: "advance",
          byMs: 5000,
          snapshot: snapshot({ snapshotId: "plus5" }),
        },
        {
          op: "advance",
          byMs: 10000,
          snapshot: snapshot({ snapshotId: "plus15" }),
        },
        {
          op: "advance",
          byMs: 30000,
          snapshot: snapshot({ snapshotId: "plus45" }),
        },
      ],
    },
  );
  for (const o of outputs) {
    assert.deepEqual(
      o.commands.map((c) => c.atMs),
      [now, now + 5000, now + 15000, now + 45000],
    );
    assert.equal(o.publications.length, 1);
    assert.deepEqual(o.remainingTimers, []);
  }
  states = await state("completed turn sample triggers are durable");
  for (const s of states)
    assert.deepEqual(
      s.readings.map((r) => r.observation_trigger).sort(),
      [
        "turn-completed",
        "turn-completed-plus-5s",
        "turn-completed-plus-15s",
        "turn-completed-plus-45s",
      ].sort(),
    );
  await clean();
  outputs = await run("closing cancels completed-turn and known-reset timers", {
    snapshot: snapshot({ windows: [window({ resetsAt })] }),
    steps: [
      { op: "completed" },
      { op: "close" },
      { op: "advance", byMs: 60000 },
    ],
  });
  for (const o of outputs) {
    assert.equal(o.commands.length, 1);
    assert.deepEqual(o.remainingTimers, []);
  }
  await clean();
  outputs = await run(
    "closing retains an admitted quota request through its actual SQL commits",
    {
      closeWhilePending: true,
      steps: [],
    },
  );
  for (const o of outputs) {
    assert.equal(o.commands.length, 1);
    assert.deepEqual(o.remainingTimers, []);
    assert.deepEqual(o.runtime.provider.credits, credits);
    assert.equal(o.publications.length, 1);
  }
  states = await state(
    "admitted quota request remains durable after close drains it",
  );
  for (const s of states) {
    assert.equal(s.readings.length, 1);
    assert.equal(s.readings[0].observation_trigger, "turn-completed");
  }
  for (const [label, fields] of [
    ["worker request failure", { requestFailure: true }],
    ["invalid worker snapshot", { snapshot: { snapshotId: "invalid" } }],
  ]) {
    await clean();
    outputs = await run("quota degrades on " + label, fields);
    for (const o of outputs) {
      assert.equal(o.commands.length, 1);
      assert.deepEqual(o.publications, []);
      assert.equal(o.runtime.provider.credits, null);
      assert.deepEqual(o.logs, [
        {
          level: "debug",
          message: "Provider quota sample unavailable",
          error: true,
          providerId: provider,
          providerAccountId: account,
          trigger: "fixture-capture",
          workerId: "alpha",
        },
      ]);
    }
    states = await state("no fabricated quota state after " + label);
    for (const s of states) assert.equal(s.readings, null);
  }
  await clean();
  await seed(
    "ALTER TABLE provider_quota_observations ADD CONSTRAINT reject_gui_quota CHECK(false)",
  );
  try {
    outputs = await run(
      "snapshot SQL failure preserves separately committed credits without publishing success",
    );
    for (const o of outputs) {
      assert.equal(o.runtime.provider.credits, null);
      assert.deepEqual(o.publications, []);
      assert.equal(o.logs[0].level, "debug");
    }
    states = await state(
      "snapshot credit commit precedes immutable reading SQL failure",
    );
    for (const s of states) {
      assert.equal(s.readings, null);
      assert.deepEqual(s.account.credits, credits);
    }
    await clean();
    outputs = await run(
      "live SQL failure retains in-memory credits and warns without publishing",
      { steps: [{ op: "activity", activity: activity() }] },
    );
    for (const o of outputs) {
      assert.deepEqual(o.runtime.provider.credits, credits);
      assert.deepEqual(o.publications, []);
      assert.deepEqual(o.logs, [
        {
          level: "warn",
          message: "Unable to persist provider quota observation",
          error: true,
          accountId: account,
          providerId: provider,
        },
      ]);
    }
    states = await state(
      "live quota failure does not invent a durable reading",
    );
    for (const s of states) {
      assert.equal(s.readings, null);
      assert.deepEqual(s.account.credits, credits);
    }
  } finally {
    await seed(
      "ALTER TABLE provider_quota_observations DROP CONSTRAINT reject_gui_quota",
    );
  }
  for (const creditsValue of [null, undefined]) {
    await clean();
    const response = snapshot({ credits: creditsValue, windows: [] });
    if (creditsValue === undefined) delete response.credits;
    outputs = await run(
      "absent snapshot credits retain existing routing state " + creditsValue,
      {
        runtime: { ...runtime, provider: { ...runtime.provider, credits } },
        snapshot: response,
      },
    );
    for (const o of outputs) {
      assert.deepEqual(o.runtime.provider.credits, credits);
      assert.deepEqual(o.publications, []);
      assert.deepEqual(o.remainingTimers, []);
    }
  }
  await clean();
}
