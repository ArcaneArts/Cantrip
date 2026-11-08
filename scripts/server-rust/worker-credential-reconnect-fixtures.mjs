import assert from "node:assert/strict";
import { capturedCredentialFixture } from "./settings-provider-fixtures.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import { literal } from "./project-target-state.mjs";

export const privateMarker =
  "access_token=credential-reconnect-private-fixture";
export const migrationMessage = "Provider credential migration pass completed";
export const startupWarning =
  "Provider credential migration pass could not start";
export const accountId = (n) =>
  "99999999-9999-4999-8999-" + String(n).padStart(12, "0");
export function credentialCases(timeouts = false) {
  return [
    "portable",
    "nonportable",
    "missing",
    "malformed",
    "invalid",
    "error",
    "already",
    "conflict",
    "disabled",
    "signed-out",
    "foreign",
    "grok",
    "purge-failure",
    ...(timeouts ? ["deadline"] : []),
  ].map((name, i) => {
    const initial = ["already", "conflict"].includes(name)
      ? capturedCredentialFixture(30 + i)
      : null;
    const captured = capturedCredentialFixture(80 + i);
    if (name === "already")
      captured.subjectBlindIndex = initial.subjectBlindIndex;
    return {
      name,
      id: accountId(i + 1),
      provider:
        "credential-reconnect-" +
        (name === "foreign" ? "foreign" : name === "grok" ? "grok" : "chatgpt"),
      kind: name === "grok" ? "grok" : "chatgpt",
      home: "legacy-home/家-" + name,
      position: i,
      initial,
      captured,
      state: initial
        ? "signed-in"
        : name === "signed-out"
          ? "signed-out"
          : "migration-needed",
      revision: initial ? 3 : 0,
      enabled: name !== "disabled",
    };
  });
}
export function credentialSeed(cases, owner, foreign) {
  const statements = [
    `INSERT INTO users(id,kind,email,normalized_email,display_name) VALUES(${literal(foreign)},'account','credential-foreign@example.invalid','credential-foreign@example.invalid','Foreign credential owner')`,
  ];
  for (const [suffix, kind, who] of [
    ["chatgpt", "chatgpt", owner],
    ["grok", "grok", owner],
    ["foreign", "chatgpt", foreign],
  ])
    statements.push(
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('credential-reconnect-${suffix}',${literal(who)},'Reconnect ${suffix}',${literal(kind)},'https://example.invalid')`,
    );
  for (const c of cases)
    statements.push(
      `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,enabled,credential_state,protected_credential,credential_revision,credential_subject_blind_index) VALUES(${literal(c.id)},${literal(c.provider)},${literal(JSON.stringify(policyEnvelope))},${literal(c.home)},${c.position},${c.enabled},${literal(c.state)},${c.initial ? literal(JSON.stringify(c.initial.protectedCredential)) : "NULL"},${c.revision},${c.initial ? literal(c.initial.subjectBlindIndex) : "NULL"})`,
    );
  return statements;
}
export const credentialRowsQuery =
  "SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'state',a.credential_state,'revision',a.credential_revision,'credential',a.protected_credential,'subject',a.credential_subject_blind_index,'enabled',a.enabled,'expiresAt',a.credential_expires_at) ORDER BY a.id),'[]'::jsonb)::text result FROM model_provider_accounts a WHERE a.provider_id LIKE 'credential-reconnect-%'";
export function assertCredentialRows(rows, cases) {
  assert.equal(rows.length, cases.length);
  for (const c of cases) {
    const row = rows.find((r) => r.id === c.id);
    const stored = [
      "portable",
      "nonportable",
      "disabled",
      "grok",
      "purge-failure",
    ].includes(c.name);
    assert.deepEqual(row, {
      id: c.id,
      state: stored
        ? "signed-in"
        : c.name === "conflict"
          ? "conflict"
          : c.state,
      revision: stored ? 1 : c.revision,
      credential: stored
        ? c.captured.protectedCredential
        : (c.initial?.protectedCredential ?? null),
      subject: stored
        ? c.captured.subjectBlindIndex
        : (c.initial?.subjectBlindIndex ?? null),
      enabled: c.enabled,
      expiresAt: null,
    });
  }
}
export function expectedMigration(round, timeouts) {
  return round === 1
    ? {
        alreadyCaptured: 1,
        captured: 5,
        checked: 11 + (timeouts ? 1 : 0),
        conflicts: 1,
        failed: 3 + (timeouts ? 1 : 0),
        malformed: 1,
        missing: 1,
        purged: 4,
      }
    : {
        alreadyCaptured: 2,
        captured: 0,
        checked: 10,
        conflicts: 0,
        failed: 2,
        malformed: 1,
        missing: 5,
        purged: 1,
      };
}
