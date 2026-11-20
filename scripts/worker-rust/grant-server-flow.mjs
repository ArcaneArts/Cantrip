// The disposable client generates keys and sends opaque wrappers through the
// real HTTP API. The actual native worker opens its scoped component grants.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
  wrapAccountMasterKeyForClient,
  deriveComponentKey,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";

// The built-in owner in auth-none mode. The profile must exist before Core can
// register an encryption principal for the worker.
const ownerId = "00000000-0000-0000-0000-000000000001";

export async function initializeGrantProfile(call) {
  const master = generateAccountMasterKey();
  try {
    const client = await generateHpkeKeyPair();
    const publicKey = await publicKeyForPair(client);
    const clientId = "77777777-7777-4777-8777-777777777777";
    const wrappedMasterKey = await wrapAccountMasterKeyForClient({
      ownerId,
      clientId,
      accountMasterKey: master,
      masterKeyRevision: 1,
      clientPublicKey: publicKey,
    });
    const initialized = await call(
      "POST",
      "/api/encryption/profile/initialize",
      {
        profile: {
          formatVersion: 1,
          activeMasterKeyRevision: 1,
          passwordKdf: null,
          passwordWrappedMasterKey: null,
          payloadMigrationStatus: "pending",
        },
        initialClient: {
          id: clientId,
          label: "Native worker grant fixture",
          publicKey,
          wrappedMasterKey,
        },
      },
    );
    assert.equal(initialized.status, 201, JSON.stringify(initialized.body));
    assert.equal(initialized.body.profile.ownerId, ownerId);
    return master;
  } catch (error) {
    master.fill(0);
    throw error;
  }
}

export async function verifyGrantFlow(
  call,
  encryptionPath,
  workerId,
  { revoke = true, accountMasterKey } = {},
) {
  const identity = JSON.parse(await readFile(encryptionPath, "utf8"));
  const master = accountMasterKey ?? (await initializeGrantProfile(call));
  try {
    const pending = await call(
      "POST",
      `/api/workers/${workerId}/encryption/refresh`,
      { component: "task-content", keyRevision: 1 },
    );
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.status.state, "pending-approval");
    const principals = await call("GET", "/api/encryption/principals");
    assert.equal(principals.status, 200);
    const worker = principals.body.find(
      (principal) => principal.id === identity.principalId,
    );
    assert.ok(worker);
    const approved = await call(
      "POST",
      `/api/encryption/principals/${worker.id}/approve`,
      { expectedRevision: worker.revision },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    for (const keyRevision of [1, 2]) {
      const componentKey = deriveComponentKey({
        accountMasterKey: master,
        ownerId,
        component: "task-content",
        keyRevision,
      });
      let wrappedKey;
      try {
        wrappedKey = await wrapComponentKeyForWorker({
          ownerId,
          workerId,
          component: "task-content",
          keyRevision,
          componentKey,
          workerPublicKey: identity.publicKey,
        });
      } finally {
        componentKey.fill(0);
      }
      const granted = await call(
        "POST",
        `/api/encryption/principals/${worker.id}/grants`,
        { component: "task-content", keyRevision, wrappedKey },
      );
      assert.equal(granted.status, 201, JSON.stringify(granted.body));
      const refreshed = await call(
        "POST",
        `/api/workers/${workerId}/encryption/refresh`,
        { component: "task-content", keyRevision },
      );
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
      assert.equal(refreshed.body.status.state, "ready");
      assert.deepEqual(refreshed.body.status.grants, [
        { component: "task-content", keyRevision },
      ]);
    }
    if (!revoke) return;
    const revoked = await call(
      "POST",
      `/api/encryption/principals/${worker.id}/revoke`,
      {
        expectedRevision: approved.body.revision,
        reason: "Disposable native worker grant test",
      },
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const refreshed = await call(
      "POST",
      `/api/workers/${workerId}/encryption/refresh`,
      { component: "task-content", keyRevision: 2 },
    );
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.status.state, "unavailable");
    assert.deepEqual(refreshed.body.status.grants, []);
    const stored = JSON.parse(await readFile(encryptionPath, "utf8"));
    assert.equal(stored.ownerId, ownerId);
    assert.equal(stored.acceptedRevisions["task-content"], 2);
    assert.equal(stored.principalId, identity.principalId);
    assert.equal(stored.privateKey, identity.privateKey);
  } finally {
    if (!accountMasterKey) master.fill(0);
  }
}
