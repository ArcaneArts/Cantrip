import assert from "node:assert/strict";

export async function accountCases({
  seed,
  compare,
  unchanged,
  owner,
  other,
  stamp,
  literal,
  envelope,
  pair,
  report,
}) {
  const provider = "chatgpt",
    account = "88888888-8888-4888-8888-888888888881",
    second = "88888888-8888-4888-8888-888888888882";
  const scoped = (op, extra = {}) => ({
    op,
    owner,
    provider,
    account,
    ...extra,
  });
  const read = (label) => compare(label, scoped("accounts-list"));
  const projectionSQL = `SELECT jsonb_build_object('credentialRevision',credential_revision,'credentialState',credential_state,'protectedCredential',protected_credential,'subject',credential_subject_blind_index,'expiresAt',credential_expires_at,'planType',plan_type,'credits',credits,'creditsObservedAt',credits_observed_at,'usage',weekly_usage_used_basis_points,'resetsAt',weekly_usage_resets_at,'weeklyObservedAt',weekly_usage_observed_at,'lastRefreshAt',credential_last_refresh_at,'leaseId',credential_refresh_lease_id,'leaseExpiresAt',credential_refresh_lease_expires_at) AS result FROM model_provider_accounts WHERE id=${literal(account)}`;
  await compare(
    "pooled account list includes worker bindings",
    scoped("accounts-list"),
  );
  for (const p of ["missing", "ollama", "foreign"])
    assert.equal(
      await compare(
        "account list unavailable provider " + p,
        scoped("accounts-list", { provider: p }),
      ),
      null,
    );
  assert.equal(
    await compare(
      "account list rejects foreign owner",
      scoped("accounts-list", { owner: other }),
    ),
    null,
  );
  for (const id of [account, second]) {
    const result = await compare(
      "create encrypted account " + id,
      scoped("account-create", { input: { id, protectedLabel: envelope } }),
    );
    assert.equal(result.credentialState, "signed-out");
    assert.equal(result.enabled, true);
    assert.deepEqual(result.protectedLabel, envelope);
  }
  await unchanged(
    "duplicate account ID rolls back",
    scoped("account-create", {
      input: { id: account, protectedLabel: envelope },
    }),
    { rejected: true, exactError: false },
  );
  for (const p of ["ollama", "missing"])
    assert.equal(
      await unchanged(
        "create account rejects provider " + p,
        scoped("account-create", {
          provider: p,
          input: {
            id: "88888888-8888-4888-8888-888888888883",
            protectedLabel: envelope,
          },
        }),
      ),
      null,
    );
  assert.equal(
    await unchanged(
      "create account rejects ownership",
      scoped("account-create", {
        owner: other,
        input: {
          id: "88888888-8888-4888-8888-888888888883",
          protectedLabel: envelope,
        },
      }),
    ),
    null,
  );
  let rows = await read("account positions append after last position");
  assert.deepEqual(
    rows.map((r) => r.position),
    [0, 1, 2, 3],
  );
  const ids = rows.map((r) => r.id);
  for (const input of [
    { ids: ids.slice(1) },
    { ids: [ids[0], ids[0], ...ids.slice(2)] },
    { ids: ids.map((id, i) => (i === 0 ? "missing" : id)) },
  ])
    assert.equal(
      await unchanged(
        "invalid account order " + JSON.stringify(input),
        scoped("accounts-order", { input }),
      ),
      false,
    );
  assert.equal(
    await compare(
      "empty unavailable provider reorder matches source",
      scoped("accounts-order", { provider: "missing", input: { ids: [] } }),
    ),
    true,
  );
  await compare(
    "swap pooled accounts without transient position collision",
    scoped("accounts-order", { input: { ids: ids.toReversed() } }),
  );
  rows = await read("read complete reordered account set");
  assert.deepEqual(
    rows.map((r) => r.id),
    ids.toReversed(),
  );
  assert.equal(
    (
      await compare(
        "default account follows order",
        scoped("account-runtime", { account: null }),
      )
    ).accountId,
    second,
  );
  for (const id of ids)
    await compare(
      "disable account " + id,
      scoped("account-update", { account: id, input: { enabled: false } }),
    );
  assert.equal(
    await compare(
      "no enabled default account",
      scoped("account-runtime", { account: null }),
    ),
    null,
  );
  assert.equal(
    (
      await compare(
        "explicit disabled account remains addressable",
        scoped("account-runtime"),
      )
    ).accountId,
    account,
  );
  await compare(
    "opaque label update",
    scoped("account-update", {
      input: { protectedLabel: { ...envelope, keyRevision: 2 }, enabled: true },
    }),
  );
  await compare(
    "empty account update preserves protected label",
    scoped("account-update", { input: {} }),
  );
  assert.equal(
    await unchanged(
      "foreign account update is absent",
      scoped("account-update", { owner: other, input: { enabled: false } }),
    ),
    null,
  );
  assert.equal(
    await compare(
      "credential absent before first store",
      scoped("credential-get"),
    ),
    null,
  );
  await compare(
    "signed-out account has migration identity",
    scoped("credential-migration"),
  );
  await compare("migration list excludes signed-out records", {
    op: "credential-migrations",
    owner,
  });
  const input = {
    subjectBlindIndex: Buffer.alloc(32, 1).toString("base64url"),
    protectedCredential: envelope,
  };
  const metadata = { expiresAt: "2026-10-29T00:00:00.000Z" };
  for (const op of ["credential-get", "credential-migration"])
    assert.equal(
      await compare("foreign " + op, scoped(op, { owner: other })),
      null,
    );
  assert.equal(
    await unchanged(
      "missing credential store avoids metadata conversion",
      scoped("credential-store", {
        owner: other,
        input,
        metadata: { expiresAt: "invalid" },
        expectedRevision: 0,
      }),
    ),
    null,
  );
  let value = await compare(
    "store opaque provider credential",
    scoped("credential-store", { input, metadata, expectedRevision: 0 }),
  );
  assert.equal(value.revision, 1);
  assert.deepEqual(value.credential, input);
  assert.deepEqual(value.metadata, metadata);
  value = await compare(
    "read stored opaque provider credential",
    scoped("credential-get"),
  );
  assert.deepEqual(value.credential, input);
  await unchanged(
    "credential identity conflict precedes revision conflict",
    scoped("credential-store", {
      input: {
        ...input,
        subjectBlindIndex: Buffer.alloc(32, 2).toString("base64url"),
      },
      metadata,
      expectedRevision: 0,
    }),
    { rejected: true },
  );
  await unchanged(
    "stale credential save is fenced",
    scoped("credential-store", { input, metadata, expectedRevision: 0 }),
    { rejected: true },
  );
  assert.equal(
    await unchanged(
      "stale credential-state observation",
      scoped("credential-state", {
        state: "reauth-required",
        expectedRevision: 0,
      }),
    ),
    false,
  );
  assert.equal(
    await compare(
      "mark credential reauthentication required",
      scoped("credential-state", {
        state: "reauth-required",
        expectedRevision: 1,
      }),
    ),
    true,
  );
  value = await compare(
    "credential record retains opaque credential while reauth required",
    scoped("credential-get"),
  );
  assert.equal(value.state, "reauth-required");
  await compare(
    "mark credential identity conflict",
    scoped("credential-state", { state: "conflict", expectedRevision: 1 }),
  );
  value = await compare(
    "refresh same identity accepts omitted expected revision",
    scoped("credential-store", {
      input: { ...input, protectedCredential: { ...envelope, keyRevision: 3 } },
      metadata: { expiresAt: null },
    }),
  );
  assert.equal(value.revision, 2);
  assert.equal(value.metadata.expiresAt, null);
  await compare("signed-in migration metadata", scoped("credential-migration"));
  await compare("signed-in credential migration list", {
    op: "credential-migrations",
    owner,
  });
  const status = (authenticated, weeklyUsage, planType = "pro") => ({
    authenticated,
    email: "not-server-owned@example.invalid",
    planType,
    weeklyUsage,
  });
  await compare(
    "persist quota and legacy worker authentication",
    scoped("account-status", {
      worker: "worker",
      status: status(true, { usedPercent: 12.345, resetsAt: 1793232000 }),
    }),
  );
  value = await compare(
    "quota status account projection",
    scoped("query-json", { sql: projectionSQL }),
  );
  assert.equal(value.usage, 1235);
  assert.equal(value.planType, "pro");
  const observed = value.weeklyObservedAt;
  const readObserved = async () =>
    Promise.all(
      pair.map(async (f) => {
        const r = await f.request({ op: "query-json", sql: projectionSQL });
        assert.equal(r.rejected, false, r.diagnostic);
        return r.value.weeklyObservedAt;
      }),
    );
  const observedBefore = await readObserved();
  await compare(
    "signed-out status retains account quota and plan",
    scoped("account-status", {
      worker: "worker",
      status: status(false, null, null),
    }),
  );
  value = await compare(
    "account quota retained without new reading",
    scoped("query-json", { sql: projectionSQL }),
  );
  assert.equal(value.usage, 1235);
  assert.equal(value.planType, "pro");
  // The source retains this timestamp byte-for-byte, rather than refreshing it.
  assert.equal(value.weeklyObservedAt, observed);
  const observedAfter = await readObserved();
  assert.deepEqual(observedAfter, observedBefore);
  report.cases.at(-1).quotaObservationTimesRetained = {
    before: observedBefore,
    after: observedAfter,
  };
  rows = await read("worker binding clears its quota on no-reading status");
  let binding = rows
    .find((r) => r.id === account)
    .workerBindings.find((b) => b.workerId === "worker");
  assert.equal(binding.authState, "signed-out");
  assert.equal(binding.weeklyUsageUsedPercent, null);
  await unchanged(
    "status worker FK failure rolls back account projection",
    scoped("account-status", {
      worker: "missing-worker",
      status: status(true, { usedPercent: 77, resetsAt: null }),
    }),
    { rejected: true, exactError: false },
  );
  await unchanged(
    "quota check failure rolls back account and binding",
    scoped("account-status", {
      worker: "worker",
      status: status(true, { usedPercent: 101, resetsAt: null }),
    }),
    { rejected: true, exactError: false },
  );
  for (const percent of [-100, -0.005, 0, 12.345, 100, 101, Number.MAX_VALUE]) {
    assert.equal(
      await compare(
        "clamped quota usage " + percent,
        scoped("account-usage", {
          usedPercent: percent,
          resetsAt: null,
          planType: "",
        }),
      ),
      true,
    );
    value = await compare(
      "clamped usage projection " + percent,
      scoped("query-json", { sql: projectionSQL }),
    );
    assert.equal(
      value.usage,
      Math.round(Math.min(100, Math.max(0, percent)) * 100),
    );
    assert.equal(value.planType, "pro");
  }
  for (const usedPercent of ["NaN", "Infinity", "-Infinity"])
    assert.equal(
      await unchanged(
        "nonfinite usage is ignored " + usedPercent,
        scoped("account-usage", { usedPercent, resetsAt: 1e30 }),
      ),
      false,
    );
  for (const resetsAt of [-0.0005, 0, -12219292800, 253402300799.999]) {
    await compare(
      "legacy status Date range " + resetsAt,
      scoped("account-status", {
        worker: "worker",
        status: status(true, { usedPercent: 45, resetsAt }),
      }),
    );
    assert.equal(
      await compare(
        "quota reset Date range " + resetsAt,
        scoped("account-usage", { usedPercent: 44, resetsAt }),
      ),
      true,
    );
    const stored = await compare(
      "actual database timestamp " + resetsAt,
      scoped("query-json", {
        sql: `SELECT jsonb_build_object('resetText',weekly_usage_resets_at) AS result FROM model_provider_accounts WHERE id=${literal(account)}`,
      }),
    );
    // Historical PostgreSQL zones can return offsets with seconds. The Node
    // Date parser rejects those strings; exercise the summary operation in
    // either case, with the expectation derived from the actual stored value.
    const readRejected =
      stored.resetText !== null &&
      !Number.isFinite(Date.parse(stored.resetText));
    const rows = await compare(
      "quota reset account summary " + resetsAt,
      scoped("accounts-list"),
      { rejected: readRejected, exactError: false },
    );
    if (!readRejected)
      assert.equal(
        rows.find((row) => row.id === account).weeklyUsageResetsAt,
        resetsAt ? new Date(resetsAt * 1000).toISOString() : null,
      );
    const legacy = await compare(
      "legacy reset account and binding " + resetsAt,
      scoped("accounts-list"),
      { rejected: readRejected, exactError: false },
    );
    if (!readRejected) {
      const summary = legacy.find((row) => row.id === account);
      assert.equal(
        summary.weeklyUsageResetsAt,
        resetsAt ? new Date(resetsAt * 1000).toISOString() : null,
      );
      assert.equal(
        summary.workerBindings.find((row) => row.workerId === "worker")
          .weeklyUsageResetsAt,
        summary.weeklyUsageResetsAt,
      );
    }
  }
  // Node can format expanded years, but PostgreSQL rejects the signed ISO
  // strings that Drizzle sends. Exercise the real operation and exact rollback.
  for (const resetsAt of [
    253402300800, 8520336000000, 8640000000000, -8640000000000,
    8640000000000.002, -8640000000000.002,
  ]) {
    await unchanged(
      "quota rejects expanded or invalid timestamp " + resetsAt,
      scoped("account-usage", { usedPercent: 44, resetsAt }),
      { rejected: true, exactError: false },
    );
    await unchanged(
      "legacy quota rejects expanded or invalid timestamp " + resetsAt,
      scoped("account-status", {
        worker: "worker",
        status: status(true, { usedPercent: 45, resetsAt }),
      }),
      { rejected: true, exactError: false },
    );
  }
  for (const timestamp of [
    "10000-01-01T00:00:00Z",
    "270000-01-01T00:00:00Z",
    "275760-09-13T00:00:00Z",
  ]) {
    await seed(
      `UPDATE model_provider_accounts SET weekly_usage_resets_at=${literal(timestamp)}::timestamptz WHERE id=${literal(account)}`,
    );
    await seed(
      `UPDATE model_provider_account_workers SET weekly_usage_resets_at=${literal(timestamp)}::timestamptz WHERE account_id=${literal(account)} AND worker_id='worker'`,
    );
    const summary = (
      await read("retained expanded timestamp " + timestamp)
    ).find((row) => row.id === account);
    const expected = new Date(
      timestamp.replace(
        /^(\d{5,6})-/,
        (_, year) => "+" + year.padStart(6, "0") + "-",
      ),
    ).toISOString();
    assert.equal(summary.weeklyUsageResetsAt, expected);
    assert.equal(
      summary.workerBindings.find((row) => row.workerId === "worker")
        .weeklyUsageResetsAt,
      expected,
    );
  }
  await compare(
    "clear expanded reset through normal status",
    scoped("account-status", {
      worker: "worker",
      status: status(true, { usedPercent: 45, resetsAt: null }),
    }),
  );
  assert.equal(
    await unchanged(
      "foreign quota write is ignored",
      scoped("account-usage", { owner: other, usedPercent: 55 }),
    ),
    false,
  );
  const credits = { hasCredits: true, unlimited: false, balance: "12.50" };
  assert.equal(
    await compare(
      "record provider credits",
      scoped("account-credits", { credits, observedAt: stamp }),
    ),
    true,
  );
  assert.equal(
    await unchanged(
      "older credits observation ignored",
      scoped("account-credits", {
        credits: { ...credits, balance: "1" },
        observedAt: "2026-10-24T00:00:00.000Z",
      }),
    ),
    false,
  );
  assert.equal(
    await compare(
      "equal credits observation replaces snapshot",
      scoped("account-credits", {
        credits: { ...credits, balance: "13" },
        observedAt: stamp,
      }),
    ),
    true,
  );
  assert.equal(
    await unchanged(
      "foreign credits observation ignored",
      scoped("account-credits", { owner: other, credits, observedAt: stamp }),
    ),
    false,
  );
  await seed(
    `UPDATE model_provider_accounts SET credential_refresh_lease_id='lease',credential_refresh_lease_expires_at='2026-10-30',plan_type='pro' WHERE id=${literal(account)};`,
  );
  await unchanged(
    "stale sign-out cannot clear a refreshed credential",
    scoped("credential-signout", { expectedRevision: 1 }),
    { rejected: true },
  );
  await seed(
    "ALTER TABLE model_provider_account_workers ADD CONSTRAINT fixture_signout_failure CHECK(auth_state<>'signed-out') NOT VALID;",
  );
  await unchanged(
    "binding sign-out failure rolls back credential and account state",
    scoped("credential-signout", { expectedRevision: 2 }),
    { rejected: true, exactError: false },
  );
  await seed(
    "ALTER TABLE model_provider_account_workers DROP CONSTRAINT fixture_signout_failure;",
  );
  value = await compare(
    "sign-out atomically clears credential, quota, credits and bindings",
    scoped("credential-signout", { expectedRevision: 2 }),
  );
  assert.deepEqual(value, { revision: 3 });
  assert.equal(
    await compare(
      "signed-out protected credential no longer readable",
      scoped("credential-get"),
    ),
    null,
  );
  value = await compare(
    "sign-out retained observation fields",
    scoped("query-json", { sql: projectionSQL }),
  );
  assert.equal(value.credentialRevision, 3);
  assert.equal(value.protectedCredential, null);
  assert.equal(value.subject, null);
  assert.equal(value.expiresAt, null);
  assert.equal(value.planType, null);
  assert.equal(value.credits, null);
  assert.equal(value.usage, null);
  assert.equal(value.leaseId, null);
  assert.ok(value.weeklyObservedAt);
  assert.ok(value.lastRefreshAt);
  await compare(
    "signed-out migration record retains revision",
    scoped("credential-migration"),
  );
  await compare("signed-out account removed from migration list", {
    op: "credential-migrations",
    owner,
  });
  const parallel = await compare(
    "concurrent credential saves fence one revision",
    scoped("credential-parallel", {
      input,
      metadata,
      expectedRevision: 3,
      count: 2,
    }),
  );
  assert.equal(parallel.filter((v) => v.value).length, 1);
  assert.equal(parallel.filter((v) => v.error).length, 1);
  assert.equal(parallel.find((v) => v.value).value.revision, 4);
  await seed(
    `UPDATE model_provider_accounts SET position=2147483647 WHERE id=${literal(second)};`,
  );
  await unchanged(
    "account reorder overflow rolls back positions",
    scoped("accounts-order", { input: { ids } }),
    { rejected: true, exactError: false },
  );
  await unchanged(
    "account append overflow rolls back insert",
    scoped("account-create", {
      input: {
        id: "88888888-8888-4888-8888-888888888883",
        protectedLabel: envelope,
      },
    }),
    { rejected: true, exactError: false },
  );
  await seed(
    `UPDATE model_provider_accounts SET position=0 WHERE id=${literal(second)};`,
  );
  assert.equal(
    await compare(
      "clear credential returns presence",
      scoped("credential-clear", { expectedRevision: 4 }),
    ),
    true,
  );
  assert.equal(
    await compare(
      "repeated sign-out still advances revision",
      scoped("credential-clear", { expectedRevision: 5 }),
    ),
    true,
  );
  assert.equal(
    await compare(
      "missing credential clear is false",
      scoped("credential-clear", { account: "missing" }),
    ),
    false,
  );
  assert.equal(
    await unchanged(
      "account deletion rejects foreign owner",
      scoped("account-delete", { owner: other }),
    ),
    false,
  );
  await compare("account deletion removes bindings", scoped("account-delete"));
  rows = await read("remaining account list after deletion");
  assert.ok(rows.every((r) => r.id !== account));
  assert.equal(
    await compare(
      "deleted account cannot be selected",
      scoped("account-runtime"),
    ),
    null,
  );
}
