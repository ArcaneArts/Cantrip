import assert from "node:assert/strict";
import { capturedCredentialFixture } from "./settings-provider-fixtures.mjs";

export async function accountAuthenticationCases({
  seed,
  compare,
  unchanged,
  literal,
  envelope,
}) {
  const owner = "auth-service-owner",
    other = "auth-service-other";
  const provider = "auth-service-chatgpt",
    grok = "auth-service-grok";
  const account = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    grokAccount = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
  const alpha = "auth-worker-alpha",
    beta = "auth-worker-beta",
    offline = "auth-worker-offline",
    foreign = "auth-worker-foreign",
    unlinked = "auth-worker-unlinked";
  const connected = {
    [alpha]: true,
    [beta]: true,
    [offline]: false,
    [foreign]: true,
    [unlinked]: true,
  };
  const credential = capturedCredentialFixture(71);
  const available = (extra = {}) => ({
    status: "available",
    credential,
    metadata: { expiresAt: null },
    portableAuth: true,
    ...extra,
  });
  for (const id of [owner, other]) {
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(id)},'account','member','active','Authentication service',${literal(id + "@example.invalid")},${literal(id + "@example.invalid")})`,
    );
    await compare("initialize auth service " + id, {
      op: "ensure-account",
      owner: id,
    });
  }
  for (const [id, kind, initial] of [
    [provider, "chatgpt", account],
    [grok, "grok", grokAccount],
  ]) {
    await compare("create auth service provider " + kind, {
      op: "provider-create",
      owner,
      input: {
        id,
        name: kind,
        kind,
        baseUrl: kind === "grok" ? "https://grok.com" : "https://chatgpt.com",
        protectedApiKey: null,
        initialAccount: { id: initial, protectedLabel: envelope },
      },
    });
  }
  await compare("create another auth account", {
    op: "account-create",
    owner,
    provider,
    input: { id: second, protectedLabel: envelope },
  });
  await seed(
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('auth-service-wrong-kind',${literal(owner)},'Wrong kind','openai-compatible','https://fixture.invalid')`,
  );
  for (const [worker, who, isUnlinked] of [
    [alpha, owner, false],
    [beta, owner, false],
    [offline, owner, false],
    [foreign, other, false],
    [unlinked, owner, true],
  ]) {
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,unlinked_at) VALUES(${literal(worker)},${literal(who)},${literal(worker)},'linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z',${isUnlinked ? "'2026-10-25T01:00:00Z'" : "NULL"})`,
    );
  }
  const resolve = (extra = {}) => ({
    op: "auth-resolve",
    owner,
    provider,
    account,
    input: {},
    ...extra,
  });
  const prepare = (extra = {}) => ({
    op: "auth-prepare",
    owner,
    provider,
    account,
    input: { connected },
    ...extra,
  });
  const reset = async (state = "signed-out", id = account) => {
    await seed(
      `DELETE FROM model_provider_account_workers WHERE account_id=${literal(id)}`,
    );
    await seed(
      `UPDATE model_provider_accounts SET credential_state=${literal(state)},credential_revision=0,protected_credential=NULL,credential_subject_blind_index=NULL,credential_expires_at=NULL,enabled=true WHERE id=${literal(id)}`,
    );
  };
  const bindings = async (rows, id = account) => {
    await seed(
      `DELETE FROM model_provider_account_workers WHERE account_id=${literal(id)}`,
    );
    for (const [worker, state = "signed-in"] of rows)
      await seed(
        `INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state,last_synced_at,updated_at) VALUES(${literal(id)},${literal(worker)},${literal(state)},'2026-10-25T00:00:00Z','2026-10-25T00:00:00Z')`,
      );
  };
  const store = (id = account, p = provider) =>
    compare("seed portable credential " + id, {
      op: "credential-store",
      owner,
      provider: p,
      account: id,
      input: credential,
      metadata: { expiresAt: null },
    });
  const check = (value, types, workers) => {
    assert.deepEqual(
      value.calls.map((c) => c.command.type),
      types,
    );
    if (workers)
      assert.deepEqual(
        value.calls.map((c) => c.worker),
        workers,
      );
    for (const call of value.calls) {
      assert.equal(call.options.ownerId, owner);
      assert.equal(call.options.timeoutMs, 15000);
      assert.equal(call.command.providerAccountId, account);
      assert.equal(call.command.providerKind, "chatgpt");
    }
    assert.deepEqual(value.logs, []);
    assert.deepEqual(value.invalidations, []);
    assert.equal(
      JSON.stringify(value).includes(
        credential.protectedCredential.envelope.ciphertext,
      ),
      false,
    );
  };
  const valid = (value) => assert.equal(value.result, null);
  for (const [label, extra] of [
    ["foreign owner", { owner: other }],
    ["missing provider", { provider: "missing" }],
    ["wrong kind", { provider: "auth-service-wrong-kind" }],
    ["missing account", { account: "missing" }],
    ["wrong provider account", { account: grokAccount }],
  ]) {
    const value = await unchanged("auth target " + label, resolve(extra));
    assert.deepEqual(value.result, {
      error: "Provider account not found.",
      reconnectRequired: false,
    });
    check(value, []);
  }
  let value = await unchanged("resolve explicit auth target", resolve());
  assert.equal(value.result.accountId, account);
  assert.equal(value.result.providerKind, "chatgpt");
  const home = value.result.credentialHomeKey;
  assert.equal(
    (
      await unchanged(
        "resolve first enabled auth target",
        resolve({ account: undefined }),
      )
    ).result.accountId,
    account,
  );
  await seed(
    `UPDATE model_provider_accounts SET enabled=false WHERE id=${literal(account)}`,
  );
  assert.equal(
    (
      await unchanged(
        "resolve next enabled auth target",
        resolve({ account: undefined }),
      )
    ).result.accountId,
    second,
  );
  assert.equal(
    (
      await unchanged(
        "empty account follows default target",
        resolve({ account: "" }),
      )
    ).result.accountId,
    second,
  );
  assert.equal(
    (
      await unchanged(
        "explicit disabled auth target remains selectable",
        resolve(),
      )
    ).result.accountId,
    account,
  );
  await seed(
    `UPDATE model_provider_accounts SET enabled=false WHERE id=${literal(second)}`,
  );
  assert.deepEqual(
    (
      await unchanged(
        "no enabled default auth target",
        resolve({ account: undefined }),
      )
    ).result,
    { error: "Provider account not found.", reconnectRequired: false },
  );
  await seed(
    `UPDATE model_provider_accounts SET enabled=true WHERE provider_id=${literal(provider)}`,
  );
  value = await unchanged(
    "resolve Grok target",
    resolve({ provider: grok, account: grokAccount }),
  );
  assert.equal(value.result.providerKind, "grok");

  await reset();
  await store();
  await bindings([[alpha], [beta], [offline], [foreign], [unlinked]]);
  value = await unchanged(
    "portable sign-out only logs out owned connected legacy bindings",
    prepare({ worker: offline }),
  );
  valid(value);
  check(value, ["codex.auth.logout", "codex.auth.logout"], [alpha, beta]);
  assert.ok(value.calls.every((c) => c.command.credentialHomeKey === home));
  value = await unchanged(
    "portable sign-out ignores all legacy logout failures",
    prepare({
      input: {
        connected,
        byType: {
          "codex.auth.logout": { error: "controlled old worker logout failed" },
        },
      },
    }),
  );
  valid(value);
  check(value, ["codex.auth.logout", "codex.auth.logout"], [alpha, beta]);
  for (const state of [
    "migration-needed",
    "reauth-required",
    "conflict",
    "signed-out",
  ]) {
    await seed(
      `UPDATE model_provider_accounts SET credential_state=${literal(state)} WHERE id=${literal(account)}`,
    );
    value = await unchanged(
      "portable record controls preparation in state " + state,
      prepare(),
    );
    valid(value);
    check(value, ["codex.auth.logout", "codex.auth.logout"], [alpha, beta]);
  }
  await bindings([
    [alpha, "signed-out"],
    [beta, "signed-out"],
  ]);
  value = await unchanged(
    "portable record skips non-legacy bindings",
    prepare({ worker: alpha }),
  );
  valid(value);
  check(value, []);

  for (const rows of [
    [],
    [[alpha, "signed-out"]],
    [[offline]],
    [[foreign]],
    [[unlinked]],
  ]) {
    await reset("migration-needed");
    await bindings(rows);
    value = await unchanged(
      "legacy migration requires its available original worker " +
        JSON.stringify(rows),
      prepare({ worker: beta }),
    );
    assert.deepEqual(value.result, {
      error:
        "The original worker must reconnect before this provider account can be signed out globally.",
      reconnectRequired: true,
    });
    check(value, []);
  }
  for (const state of ["signed-out", "reauth-required", "conflict"]) {
    await reset(state);
    await bindings([[offline], [foreign], [unlinked]]);
    value = await unchanged(
      "no portable record and no runner in state " + state,
      prepare(),
    );
    valid(value);
    check(value, []);
  }
  const cases = [
    ["requested runner first", "signed-out", beta, [[alpha]], beta],
    [
      "legacy runner before bound signed-out runner",
      "signed-out",
      undefined,
      [[beta, "signed-out"], [alpha]],
      alpha,
    ],
    [
      "bound signed-out runner is usable",
      "signed-out",
      undefined,
      [[beta, "signed-out"]],
      beta,
    ],
    [
      "foreign requested runner is excluded",
      "signed-out",
      foreign,
      [[alpha]],
      alpha,
    ],
    [
      "unlinked requested runner is excluded",
      "signed-out",
      unlinked,
      [[alpha]],
      alpha,
    ],
    [
      "offline requested runner is excluded",
      "signed-out",
      offline,
      [[beta]],
      beta,
    ],
    ["empty requested runner is ignored", "signed-out", "", [[alpha]], alpha],
    [
      "legacy migration ignores an unrelated requested runner",
      "migration-needed",
      beta,
      [[alpha]],
      alpha,
    ],
    [
      "legacy migration skips offline original runner",
      "migration-needed",
      undefined,
      [[offline], [beta]],
      beta,
    ],
  ];
  for (const [label, state, requested, rows, selected] of cases) {
    await reset(state);
    await bindings(rows);
    value = await unchanged(
      "sign-out runner order: " + label,
      prepare({
        worker: requested,
        input: {
          connected,
          byType: {
            "provider.auth.legacy.capture": { reply: { status: "missing" } },
            "codex.auth.logout": { reply: null },
          },
        },
      }),
    );
    valid(value);
    check(
      value,
      ["provider.auth.legacy.capture", "codex.auth.logout"],
      [selected, selected],
    );
  }
  for (const [label, response] of [
    ["missing", { reply: { status: "missing" } }],
    ["malformed", { reply: { status: "malformed" } }],
    ["unsupported old worker", { error: "capture command unavailable" }],
  ]) {
    await reset("migration-needed");
    await bindings([[alpha]]);
    value = await unchanged(
      "legacy fallback logout after " + label,
      prepare({
        input: {
          connected,
          byType: {
            "provider.auth.legacy.capture": response,
            "codex.auth.logout": { reply: null },
          },
        },
      }),
    );
    valid(value);
    check(
      value,
      ["provider.auth.legacy.capture", "codex.auth.logout"],
      [alpha, alpha],
    );
  }
  await reset("migration-needed");
  await bindings([[alpha]]);
  value = await unchanged(
    "legacy fallback logout failure is actionable",
    prepare({
      input: {
        connected,
        byType: {
          "provider.auth.legacy.capture": { reply: { status: "missing" } },
          "codex.auth.logout": { error: "controlled upstream logout failure" },
        },
      },
    }),
  );
  assert.deepEqual(value.result, {
    error: "controlled upstream logout failure",
    reconnectRequired: false,
  });
  check(
    value,
    ["provider.auth.legacy.capture", "codex.auth.logout"],
    [alpha, alpha],
  );
  for (const portable of [true, false, undefined]) {
    await reset("migration-needed");
    await bindings([[alpha]]);
    const reply = available();
    if (portable === undefined) delete reply.portableAuth;
    else reply.portableAuth = portable;
    value = await compare(
      "capture before global sign-out portable=" + portable,
      prepare({
        input: {
          connected,
          byType: {
            "provider.auth.legacy.capture": { reply },
            "codex.auth.logout": {
              error: "ignored after portable credential committed",
            },
          },
        },
      }),
    );
    valid(value);
    check(
      value,
      portable === true
        ? ["provider.auth.legacy.capture"]
        : ["provider.auth.legacy.capture", "codex.auth.logout"],
    );
    const stored = await compare(
      "captured portable record remains before global clear " + portable,
      { op: "credential-get", owner, provider, account },
    );
    assert.deepEqual(stored.credential, credential);
    assert.equal(stored.state, "signed-in");
  }
  await reset("migration-needed");
  await bindings([[alpha]]);
  value = await compare(
    "opt-in portable purge before global sign-out",
    prepare({
      input: {
        connected,
        purgeKinds: ["chatgpt"],
        byType: {
          "provider.auth.legacy.capture": { reply: available() },
          "provider.auth.legacy.purge": {
            reply: {
              purged: true,
              serverCredentialRevision: 1,
              subjectBlindIndex: credential.subjectBlindIndex,
            },
          },
        },
      },
    }),
  );
  valid(value);
  check(
    value,
    ["provider.auth.legacy.capture", "provider.auth.legacy.purge"],
    [alpha, alpha],
  );
  await reset("migration-needed");
  await bindings([[alpha]]);
  value = await compare(
    "failed portable purge retains captured server record",
    prepare({
      input: {
        connected,
        purgeKinds: ["chatgpt"],
        byType: {
          "provider.auth.legacy.capture": { reply: available() },
          "provider.auth.legacy.purge": { error: "purge failed" },
        },
      },
    }),
  );
  valid(value);
  check(
    value,
    ["provider.auth.legacy.capture", "provider.auth.legacy.purge"],
    [alpha, alpha],
  );

  await reset("signed-out");
  value = await compare(
    "unobserved preparation finishes capture and worker cleanup",
    prepare({
      worker: alpha,
      input: {
        connected,
        discard: true,
        waitForCalls: 2,
        byType: {
          "provider.auth.legacy.capture": {
            reply: available({ portableAuth: false }),
          },
          "codex.auth.logout": {
            reply: null,
            beforeSQL: [
              `UPDATE model_provider_accounts SET plan_type='unobserved-cleanup-finished' WHERE id=${literal(account)}`,
            ],
          },
        },
      },
    }),
  );
  valid(value);
  check(
    value,
    ["provider.auth.legacy.capture", "codex.auth.logout"],
    [alpha, alpha],
  );
  assert.equal(
    (
      await compare("unobserved cleanup durable marker", {
        op: "accounts-list",
        owner,
        provider,
      })
    ).find((a) => a.id === account).planType,
    "unobserved-cleanup-finished",
  );

  const reauth = (extra = {}) => ({
    op: "auth-reauth",
    owner,
    provider,
    account,
    input: {},
    ...extra,
  });
  for (const extra of [
    { account: "missing" },
    { owner: other },
    { provider: "missing" },
  ]) {
    assert.equal(
      (
        await unchanged(
          "reauth ignores unknown target " + JSON.stringify(extra),
          reauth(extra),
        )
      ).result,
      false,
    );
  }
  await reset();
  assert.equal(
    (await unchanged("reauth ignores absent opaque record", reauth())).result,
    false,
  );
  await store();
  for (const state of [
    "signed-out",
    "migration-needed",
    "conflict",
    "reauth-required",
  ]) {
    await seed(
      `UPDATE model_provider_accounts SET credential_state=${literal(state)} WHERE id=${literal(account)}`,
    );
    assert.equal(
      (await unchanged("reauth handles existing state " + state, reauth()))
        .result,
      state === "reauth-required",
    );
  }
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-in' WHERE id=${literal(account)}`,
  );
  assert.equal(
    (await compare("signed-in credential becomes reauth-required", reauth()))
      .result,
    true,
  );
  const stored = await compare("reauth retains identity and revision", {
    op: "credential-get",
    owner,
    provider,
    account,
  });
  assert.equal(stored.state, "reauth-required");
  assert.equal(stored.revision, 1);
  assert.deepEqual(stored.credential, credential);
  await seed(
    `UPDATE model_provider_accounts SET credential_state='signed-in' WHERE id=${literal(account)}`,
  );
  await seed(
    `CREATE FUNCTION fixture_auth_reauth_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.credential_state='reauth-required' THEN UPDATE model_provider_accounts SET credential_revision=credential_revision+1 WHERE id=OLD.id; RETURN NULL; END IF; RETURN NEW; END $$`,
  );
  await seed(
    "CREATE TRIGGER fixture_auth_reauth_race BEFORE UPDATE OF credential_state ON model_provider_accounts FOR EACH ROW EXECUTE FUNCTION fixture_auth_reauth_race()",
  );
  assert.equal(
    (
      await compare(
        "reauth CAS loses to a real credential revision race",
        reauth(),
      )
    ).result,
    false,
  );
  const raced = await compare("reauth race preserves winner", {
    op: "credential-get",
    owner,
    provider,
    account,
  });
  assert.equal(raced.state, "signed-in");
  assert.equal(raced.revision, 2);
  assert.deepEqual(raced.credential, credential);
  await seed(
    "DROP TRIGGER fixture_auth_reauth_race ON model_provider_accounts",
  );
  await seed("DROP FUNCTION fixture_auth_reauth_race()");

  await reset("migration-needed", grokAccount);
  await bindings([[alpha]], grokAccount);
  value = await compare(
    "Grok legacy sign-out uses the account provider kind",
    prepare({
      provider: grok,
      account: grokAccount,
      worker: beta,
      input: {
        connected,
        byType: { "provider.auth.legacy.capture": { reply: available() } },
      },
    }),
  );
  valid(value);
  assert.equal(value.calls.length, 1);
  assert.equal(value.calls[0].worker, alpha);
  assert.equal(value.calls[0].command.providerKind, "grok");
  assert.equal(value.calls[0].command.providerId, grok);
  assert.equal(value.calls[0].command.providerAccountId, grokAccount);
  assert.equal(value.calls[0].options.ownerId, owner);
  assert.equal(value.calls[0].options.timeoutMs, 15000);
  assert.equal(
    (
      await compare("Grok capture survives preparation", {
        op: "credential-get",
        owner,
        provider: grok,
        account: grokAccount,
      })
    ).state,
    "signed-in",
  );
  assert.equal(
    (
      await compare(
        "Grok reauthentication state",
        reauth({ provider: grok, account: grokAccount }),
      )
    ).result,
    true,
  );
  assert.equal(
    (
      await compare("Grok retained reauthentication credential", {
        op: "credential-get",
        owner,
        provider: grok,
        account: grokAccount,
      })
    ).state,
    "reauth-required",
  );
}
