import assert from "node:assert/strict";
import { capturedCredentialFixture } from "./settings-provider-fixtures.mjs";

const summary = (patch = {}, account = true) => ({
  alreadyCaptured: 0,
  captured: 0,
  checked: 1,
  conflicts: 0,
  failed: 0,
  malformed: 0,
  missing: 0,
  purged: 0,
  ...(account ? { workerLogoutRequired: false } : {}),
  ...patch,
});
export async function credentialServiceCases({
  seed,
  compare,
  unchanged,
  literal,
  envelope,
}) {
  const owner = "credential-service-owner",
    other = "credential-service-other",
    provider = "credential-service-chatgpt",
    grok = "credential-service-grok",
    worker = "credential-worker-alpha";
  const account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    second = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    grokAccount = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  for (const id of [owner, other]) {
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email) VALUES(${literal(id)},'account','member','active','Credential service',${literal(id + "@example.invalid")},${literal(id + "@example.invalid")})`,
    );
    await compare("initialize credential service " + id, {
      op: "ensure-account",
      owner: id,
    });
  }
  for (const [id, kind, initial] of [
    [provider, "chatgpt", account],
    [grok, "grok", grokAccount],
  ])
    await compare("create credential service provider " + kind, {
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
  await seed(
    `UPDATE model_providers SET created_at=CASE WHEN id=${literal(provider)} THEN '2026-10-26T00:00:01Z'::timestamptz ELSE '2026-10-26T00:00:02Z'::timestamptz END WHERE owner_id=${literal(owner)}`,
  );
  await compare("create second legacy credential account", {
    op: "account-create",
    owner,
    provider,
    input: { id: second, protectedLabel: envelope },
  });
  for (const [id, name, who, unlinked] of [
    [worker, "Alpha", owner, false],
    ["credential-worker-beta", "Beta", owner, false],
    ["credential-worker-offline", "Offline", owner, false],
    ["credential-worker-unlinked", "Unlinked", owner, true],
    ["credential-worker-foreign", "Foreign", other, false],
  ]) {
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,unlinked_at) VALUES(${literal(id)},${literal(who)},${literal(name)},'linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z',${unlinked ? "'2026-10-25T01:00:00Z'" : "NULL"})`,
    );
  }
  const credential = (fill) => capturedCredentialFixture(fill.charCodeAt(0));
  const first = credential("K"),
    different = credential("R");
  const available = (extra = {}) => ({
    status: "available",
    credential: first,
    metadata: { expiresAt: null },
    portableAuth: true,
    ...extra,
  });
  const capture = (extra = {}) => ({
    op: "migration-account",
    owner,
    provider,
    account,
    worker,
    input: { connected: true, reply: available() },
    ...extra,
  });
  const reset = (id = account) =>
    seed(
      `UPDATE model_provider_accounts SET credential_state='migration-needed',credential_revision=0,credential_subject_blind_index=NULL,protected_credential=NULL,credential_expires_at=NULL WHERE id=${literal(id)}`,
    );
  const check = (value) => {
    assert.equal(
      JSON.stringify(value).includes(
        first.protectedCredential.envelope.ciphertext,
      ),
      false,
      "service output never includes credential ciphertext",
    );
    assert.equal(
      JSON.stringify(value).includes("oauth-secret-should-not-escape"),
      false,
      "service output never includes worker OAuth errors",
    );
    assert.deepEqual(value.logs, []);
  };
  const read = async (label, extra = {}) => {
    const value = await compare(label, capture(extra));
    check(value);
    return value;
  };
  for (const [label, extra] of [
    ["missing account", { account: "missing" }],
    ["wrong provider", { provider: "missing" }],
    ["foreign owner", { owner: other }],
  ]) {
    const value = await unchanged("capture " + label, capture(extra));
    assert.deepEqual(value.result, summary({ checked: 0, failed: 1 }));
    assert.deepEqual(value.calls, []);
  }
  for (const [label, reply, expected] of [
    ["missing", { status: "missing" }, { missing: 1 }],
    ["malformed", { status: "malformed" }, { malformed: 1 }],
    [
      "invalid status",
      { status: "unexpected", accessToken: "oauth-secret-should-not-escape" },
      { failed: 1 },
    ],
    [
      "missing credential",
      { status: "available", metadata: { expiresAt: null } },
      { failed: 1 },
    ],
    [
      "invalid metadata",
      available({ metadata: { expiresAt: "invalid" } }),
      { failed: 1 },
    ],
  ]) {
    const value = await unchanged(
      "capture " + label,
      capture({ input: { connected: true, reply } }),
    );
    check(value);
    assert.deepEqual(value.result, summary(expected));
    assert.equal(value.calls[0].options.timeoutMs, 15000);
  }
  let value = await read("worker errors return only secret-free counters", {
    input: { connected: true, error: "oauth-secret-should-not-escape" },
  });
  assert.deepEqual(value.result, summary({ failed: 1 }));
  value = await read("portable credential captures without implicit purge");
  assert.deepEqual(value.result, summary({ captured: 1 }));
  assert.equal(value.calls.length, 1);
  assert.equal(value.calls[0].command.credentialHomeKey, provider);
  value = await unchanged(
    "matching signed-in identity is already captured without rewriting ciphertext",
    capture({
      input: {
        connected: true,
        reply: available({
          credential: {
            ...first,
            protectedCredential: credential("B").protectedCredential,
          },
        }),
      },
    }),
  );
  check(value);
  assert.deepEqual(value.result, summary({ alreadyCaptured: 1 }));
  value = await read("signed-in identity mismatch marks conflict", {
    input: { connected: true, reply: available({ credential: different }) },
  });
  assert.deepEqual(value.result, summary({ conflicts: 1 }));
  await reset();
  value = await read("omitted portable flag defaults to logout-required", {
    input: {
      connected: true,
      reply: {
        status: "available",
        credential: first,
        metadata: { expiresAt: null },
      },
    },
  });
  assert.deepEqual(
    value.result,
    summary({ captured: 1, workerLogoutRequired: true }),
  );
  await reset();
  value = await read("explicit nonportable capture never purges", {
    input: {
      connected: true,
      purgeKinds: ["chatgpt"],
      reply: available({ portableAuth: false }),
    },
  });
  assert.deepEqual(
    value.result,
    summary({ captured: 1, workerLogoutRequired: true }),
  );
  assert.equal(value.calls.length, 1);
  await reset();
  value = await read("purge requires matching subject and committed revision", {
    input: {
      connected: true,
      purgeKinds: ["chatgpt"],
      byType: {
        "provider.auth.legacy.capture": { reply: available() },
        "provider.auth.legacy.purge": {
          reply: {
            purged: true,
            subjectBlindIndex: first.subjectBlindIndex,
            serverCredentialRevision: 1,
          },
        },
      },
    },
  });
  assert.deepEqual(value.result, summary({ captured: 1, purged: 1 }));
  assert.equal(value.calls.length, 2);
  assert.equal(value.calls[1].command.serverCredentialRevision, 1);
  assert.equal(
    value.calls[1].command.expectedSubjectBlindIndex,
    first.subjectBlindIndex,
  );
  for (const [label, reply] of [
    [
      "wrong subject",
      {
        purged: true,
        subjectBlindIndex: different.subjectBlindIndex,
        serverCredentialRevision: 1,
      },
    ],
    [
      "wrong revision",
      {
        purged: true,
        subjectBlindIndex: first.subjectBlindIndex,
        serverCredentialRevision: 2,
      },
    ],
    ["malformed acknowledgement", { purged: true }],
  ]) {
    await reset();
    value = await read(
      "purge " + label + " preserves captured credential and counts failure",
      {
        input: {
          connected: true,
          purgeKinds: ["chatgpt"],
          byType: {
            "provider.auth.legacy.capture": { reply: available() },
            "provider.auth.legacy.purge": { reply },
          },
        },
      },
    );
    assert.deepEqual(value.result, summary({ captured: 1, failed: 1 }));
  }
  await reset();
  value = await read("purge disabled for other provider kinds", {
    input: { connected: true, purgeKinds: ["grok"], reply: available() },
  });
  assert.deepEqual(value.result, summary({ captured: 1 }));
  assert.equal(value.calls.length, 1);
  const raceSQL = (state = "signed-in", subject = first.subjectBlindIndex) =>
    `UPDATE model_provider_accounts SET credential_revision=1,credential_state=${literal(state)},credential_subject_blind_index=${literal(subject)},protected_credential=${literal(JSON.stringify(first.protectedCredential))}::jsonb WHERE id=${literal(account)}`;
  await reset();
  value = await read("capture revision race recovers same signed-in identity", {
    input: { connected: true, beforeSQL: [raceSQL()], reply: available() },
  });
  assert.deepEqual(value.result, summary({ captured: 1 }));
  await reset();
  value = await read(
    "capture revision race marks different identity conflict",
    {
      input: {
        connected: true,
        beforeSQL: [raceSQL("signed-in", different.subjectBlindIndex)],
        reply: available(),
      },
    },
  );
  assert.deepEqual(value.result, summary({ conflicts: 1 }));
  await reset();
  value = await read("capture revision race rejects a signed-out winner", {
    input: {
      connected: true,
      beforeSQL: [raceSQL("signed-out")],
      reply: available(),
    },
  });
  assert.deepEqual(value.result, summary({ failed: 1 }));
  // An actual trigger races the first conflict-state CAS, requiring the
  // coordinator to re-read the newer revision and retry once.
  await reset();
  await read("seed credential before conflict CAS race");
  await seed("CREATE TABLE fixture_conflict_race(id integer PRIMARY KEY)");
  await seed(
    `CREATE FUNCTION fixture_conflict_race_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS (SELECT 1 FROM fixture_conflict_race) THEN INSERT INTO fixture_conflict_race VALUES(1); UPDATE model_provider_accounts SET credential_revision=credential_revision+1 WHERE id=OLD.id; RETURN NULL; END IF; RETURN NEW; END $$`,
  );
  await seed(
    "CREATE TRIGGER fixture_conflict_race_trigger BEFORE UPDATE OF credential_state ON model_provider_accounts FOR EACH ROW WHEN (NEW.credential_state='conflict') EXECUTE FUNCTION fixture_conflict_race_fn()",
  );
  value = await read("conflict marking retries after an actual failed CAS", {
    input: { connected: true, reply: available({ credential: different }) },
  });
  assert.deepEqual(value.result, summary({ conflicts: 1 }));
  await seed(
    "DROP TRIGGER fixture_conflict_race_trigger ON model_provider_accounts",
  );
  await seed("DROP FUNCTION fixture_conflict_race_fn()");
  await seed("DROP TABLE fixture_conflict_race");
  await reset();
  await reset(second);
  await reset(grokAccount);
  value = await compare(
    "bulk migration continues after malformed and secret-bearing failures",
    {
      op: "migration-worker",
      owner,
      worker,
      input: {
        connected: true,
        accounts: {
          [account]: {
            "provider.auth.legacy.capture": { reply: { status: "missing" } },
          },
          [second]: {
            "provider.auth.legacy.capture": { reply: { status: "malformed" } },
          },
          [grokAccount]: {
            "provider.auth.legacy.capture": {
              error: "oauth-secret-should-not-escape",
            },
          },
        },
      },
    },
  );
  check(value);
  assert.deepEqual(
    value.result,
    summary({ checked: 3, missing: 1, malformed: 1, failed: 1 }, false),
  );
  value = await unchanged("bulk migration respects owner scope", {
    op: "migration-worker",
    owner: other,
    worker,
    input: { connected: true, reply: available() },
  });
  assert.deepEqual(value.result, summary({ checked: 0 }, false));
  assert.deepEqual(value.calls, []);
  await reset(grokAccount);
  value = await read(
    "Grok portable capture and purge use the actual provider family",
    {
      provider: grok,
      account: grokAccount,
      input: {
        connected: true,
        purgeKinds: ["grok"],
        byType: {
          "provider.auth.legacy.capture": { reply: available() },
          "provider.auth.legacy.purge": {
            reply: {
              purged: true,
              subjectBlindIndex: first.subjectBlindIndex,
              serverCredentialRevision: 1,
            },
          },
        },
      },
    },
  );
  assert.deepEqual(value.result, summary({ captured: 1, purged: 1 }));
  assert.equal(value.calls[0].command.providerKind, "grok");
  // Keep valid capture coverage before the timestamp boundary regression.
  await reset();
  value = await read("captured expiry preserves millisecond clipping", {
    input: {
      connected: true,
      reply: available({
        metadata: { expiresAt: "2030-01-01T00:00:00.123456789Z" },
      }),
    },
  });
  assert.deepEqual(value.result, summary({ captured: 1 }));
  const clipped = await compare(
    "captured expiry is stored at the source millisecond precision",
    { op: "credential-get", owner, provider, account },
  );
  assert.equal(clipped.metadata.expiresAt, "2030-01-01T00:00:00.123Z");
  await reset();
  value = await unchanged(
    "year-zero credential expiry follows actual driver rejection",
    capture({
      input: {
        connected: true,
        reply: available({
          metadata: { expiresAt: "0000-01-01T00:00:00.000Z" },
        }),
      },
    }),
  );
  check(value);
  assert.deepEqual(value.result, summary({ failed: 1 }));
  await reset();
  value = await read(
    "unobserved capture still commits before native drain completes",
    { input: { connected: true, reply: available(), discard: true } },
  );
  assert.equal(value.result, null);
  const afterDiscard = await compare(
    "unobserved capture retained its opaque credential",
    { op: "credential-get", owner, provider, account },
  );
  assert.equal(afterDiscard.state, "signed-in");
  assert.deepEqual(afterDiscard.credential, first);
  // Lifecycle: credential commit is observed by both catalog and worker hooks.
  const connected = {
    [worker]: true,
    "credential-worker-beta": true,
    "credential-worker-offline": false,
    "credential-worker-unlinked": true,
    "credential-worker-foreign": true,
  };
  const signout = (extra = {}) => ({
    op: "lifecycle-signout",
    owner,
    provider,
    account,
    kind: "chatgpt",
    home: provider,
    input: { connected, observeClear: true },
    ...extra,
  });
  value = await unchanged(
    "sign-out missing account only emits the start diagnostic",
    signout({ account: "missing" }),
  );
  assert.equal(value.result, null);
  assert.equal(value.logs.length, 1);
  assert.deepEqual(value.calls, []);
  const store = async (id = account, p = provider) =>
    compare("prepare lifecycle opaque credential " + id, {
      op: "credential-store",
      owner,
      provider: p,
      account: id,
      input: first,
      metadata: { expiresAt: null },
    });
  await store();
  value = await compare(
    "global sign-out clears before every cleanup consumer",
    signout(),
  );
  assert.deepEqual(value.result, {
    catalogInvalidated: true,
    credentialCleared: true,
    revocation: "not-applicable",
    workersClosed: 2,
    workersFailed: 0,
  });
  assert.deepEqual(
    value.calls.map((c) => c.worker),
    [worker, "credential-worker-beta"],
  );
  assert.ok(
    value.calls.every(
      (c) => c.credentialCleared && c.options.timeoutMs === 15000,
    ),
  );
  assert.equal(value.invalidations[0].credentialCleared, true);
  assert.equal(value.logs.length, 2);
  assert.equal(
    JSON.stringify(value).includes(
      first.protectedCredential.envelope.ciphertext,
    ),
    false,
  );
  await store();
  value = await compare(
    "sign-out reports cleanup failures after preserving the clear",
    signout({
      input: {
        connected,
        observeClear: true,
        invalidateError: true,
        workers: {
          [worker]: { error: "oauth-secret-should-not-escape", elapsedMs: 5 },
          "credential-worker-beta": { reply: null, elapsedMs: 7 },
        },
      },
    }),
  );
  assert.deepEqual(value.result, {
    catalogInvalidated: false,
    credentialCleared: true,
    revocation: "not-applicable",
    workersClosed: 1,
    workersFailed: 1,
  });
  assert.equal(value.logs[1].level, "warn");
  assert.equal(value.logs[2].context.durationMs, 12);
  assert.equal(
    JSON.stringify(value).includes("oauth-secret-should-not-escape"),
    false,
  );
  await store();
  value = await compare(
    "worker selection precedes synchronous invalidator disconnection",
    signout({
      input: {
        connected,
        observeClear: true,
        disconnectOnInvalidate: worker,
        rejectDisconnected: true,
      },
    }),
  );
  assert.equal(value.result.workersFailed, 1);
  assert.equal(value.result.workersClosed, 1);
  assert.equal(value.calls.length, 2);
  await store();
  value = await compare(
    "lifecycle info callback is optional",
    signout({ input: { connected: {}, noInfo: true } }),
  );
  assert.deepEqual(value.logs, []);
  assert.equal(value.result.workersClosed, 0);
  await store();
  value = await compare(
    "unobserved sign-out still completes global cleanup",
    signout({ input: { connected, observeClear: true, discard: true } }),
  );
  assert.equal(value.result, null);
  assert.equal(value.calls.length, 2);
  assert.equal(
    value.logs.at(-1).context.event,
    "provider.account.sign_out_completed",
  );
  assert.ok(value.calls.every((call) => call.credentialCleared));
  await store();
  await seed(
    `ALTER TABLE model_provider_accounts ADD CONSTRAINT fixture_signout_rollback CHECK(id<>${literal(account)} OR credential_state<>'signed-out')`,
  );
  await unchanged(
    "failed credential clear prevents all downstream cleanup",
    signout(),
    { rejected: true, exactError: false },
  );
  await seed(
    "ALTER TABLE model_provider_accounts DROP CONSTRAINT fixture_signout_rollback",
  );
  await store(grokAccount, grok);
  value = await compare(
    "Grok lifecycle uses the same owned worker cleanup",
    signout({ provider: grok, account: grokAccount, kind: "grok", home: grok }),
  );
  assert.equal(value.result.workersClosed, 2);
  assert.ok(value.calls.every((c) => c.command.providerKind === "grok"));
}
