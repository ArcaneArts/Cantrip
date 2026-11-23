import assert from "node:assert/strict";
import test from "node:test";
import { verifyCatalogContinuity } from "./server-rust/desktop-client-continuity.mjs";

const original = () => ({
  installation: [
    { installation_id: "retained-installation", schema_version: 1 },
  ],
  deviceKeys: [
    {
      key_alias: "retained-key",
      public_key_json: "original-public-key",
      provider: "keyring",
    },
  ],
  accountBindings: [
    {
      server_id: "server",
      owner_id: "owner",
      principal_id: "client",
      key_alias: "retained-key",
      grant_revision: 2,
      master_key_revision: 1,
    },
  ],
  migrations: [{ migration_id: "legacy-device", state: "complete" }],
  metadata: [{ schema_version: 1, revision: 4 }],
});

test("desktop acceptance retains identity and key records across metadata updates", () => {
  const before = original();
  const after = structuredClone(before);
  after.metadata[0].revision += 3;
  const result = verifyCatalogContinuity(before, after);
  assert.equal(result.passed, true);
  assert.equal(result.deviceKeysRetained, 1);
  assert.equal(result.accountBindingsRetained, 1);
  assert.equal(result.privateKeysRetrieved, false);
});

for (const [label, change] of [
  [
    "a recreated installation",
    (x) => {
      x.installation[0].installation_id = "replacement";
    },
  ],
  [
    "a replaced public key",
    (x) => {
      x.deviceKeys[0].public_key_json = "replacement";
    },
  ],
  [
    "a replaced client principal",
    (x) => {
      x.accountBindings[0].principal_id = "replacement";
    },
  ],
  [
    "a changed key alias",
    (x) => {
      x.accountBindings[0].key_alias = "replacement";
    },
  ],
  [
    "a changed master-key revision",
    (x) => {
      x.accountBindings[0].master_key_revision++;
    },
  ],
  [
    "a lost account binding",
    (x) => {
      x.accountBindings = [];
    },
  ],
  [
    "a backwards catalog revision",
    (x) => {
      x.metadata[0].revision--;
    },
  ],
]) {
  test("desktop acceptance rejects " + label, () => {
    const before = original();
    const after = structuredClone(before);
    change(after);
    assert.throws(() => verifyCatalogContinuity(before, after));
  });
}
