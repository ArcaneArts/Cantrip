// Existing endpoint crypto is the authority. All keys stay in this disposable
// client; only opaque wrappers are sent over HTTP to either server.
import assert from "node:assert/strict";
import {
  createPasswordKdfParameters,
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
  unwrapAccountMasterKeyForClient,
  unwrapAccountMasterKeyWithPassword,
  wrapAccountMasterKeyForClient,
  wrapAccountMasterKeyWithPassword,
} from "../../packages/crypto/src/index.ts";
import { password } from "./security-fixtures.mjs";

export async function securityCryptoFlow(fixture, transition) {
  const client = "crypto-client",
    id = "77777777-7777-4777-8777-777777777777";
  let steps = 0;
  const visit = async (label, method, url, options = {}) => {
    steps++;
    await fixture.observe(`crypto ${label}`, method, url, {
      client,
      ...options,
    });
    return fixture.records.get(`crypto ${label}`);
  };
  const email = "crypto@example.invalid";
  await visit("register", "POST", "/api/auth/register", {
    json: { email, displayName: "Crypto fixture", password },
    status: 201,
  });
  const session = await visit("session", "GET", "/api/auth/session");
  const ownerId = session.currentUser.id,
    accountMasterKey = generateAccountMasterKey(),
    clientKeyPair = await generateHpkeKeyPair();
  const publicKey = await publicKeyForPair(clientKeyPair);
  const passwordWrappedMasterKey = await wrapAccountMasterKeyWithPassword({
    ownerId,
    accountMasterKey,
    password,
    masterKeyRevision: 1,
    kdf: createPasswordKdfParameters({ memoryKiB: 8192, iterations: 1 }),
  });
  const wrappedMasterKey = await wrapAccountMasterKeyForClient({
    ownerId,
    accountMasterKey,
    clientId: id,
    masterKeyRevision: 1,
    clientPublicKey: publicKey,
  });
  const input = {
    profile: {
      formatVersion: 1,
      activeMasterKeyRevision: 1,
      passwordKdf: passwordWrappedMasterKey.kdf,
      passwordWrappedMasterKey,
      payloadMigrationStatus: "pending",
    },
    initialClient: {
      id,
      label: "Actual HPKE client",
      publicKey,
      wrappedMasterKey,
    },
  };
  const created = await visit(
    "initialize",
    "POST",
    "/api/encryption/profile/initialize",
    { csrf: true, json: input, status: 201 },
  );
  assert.deepEqual(
    created.profile.passwordWrappedMasterKey,
    passwordWrappedMasterKey,
  );
  assert.deepEqual(created.grant.wrappedKey, wrappedMasterKey);
  assert.deepEqual(
    await unwrapAccountMasterKeyWithPassword({
      ownerId,
      password,
      wrapper: created.profile.passwordWrappedMasterKey,
    }),
    accountMasterKey,
  );
  assert.deepEqual(
    await unwrapAccountMasterKeyForClient({
      ownerId,
      clientKeyPair,
      wrapper: created.grant.wrappedKey,
    }),
    accountMasterKey,
  );
  await assert.rejects(
    unwrapAccountMasterKeyForClient({
      ownerId: "different-owner",
      clientKeyPair,
      wrapper: created.grant.wrappedKey,
    }),
  );
  await transition?.("after-initialize", fixture);
  const beforeChange = await visit(
    "profile before password change",
    "GET",
    "/api/encryption/profile",
  );
  assert.deepEqual(beforeChange.profile, created.profile);
  const changedPassword = "changed actual crypto fixture password";
  const nextWrapper = await wrapAccountMasterKeyWithPassword({
    ownerId,
    accountMasterKey,
    password: changedPassword,
    masterKeyRevision: 1,
    kdf: createPasswordKdfParameters({ memoryKiB: 8192, iterations: 1 }),
  });
  const changed = await visit(
    "password change",
    "POST",
    "/api/account/password",
    {
      csrf: true,
      json: {
        currentPassword: password,
        newPassword: changedPassword,
        expectedProfileRevision: 1,
        passwordKdf: nextWrapper.kdf,
        passwordWrappedMasterKey: nextWrapper,
      },
    },
  );
  assert.equal(changed.revision, 2);
  assert.equal(changed.activeMasterKeyRevision, 1);
  assert.deepEqual(changed.passwordWrappedMasterKey, nextWrapper);
  assert.deepEqual(
    await unwrapAccountMasterKeyWithPassword({
      ownerId,
      password: changedPassword,
      wrapper: changed.passwordWrappedMasterKey,
    }),
    accountMasterKey,
  );
  await assert.rejects(
    unwrapAccountMasterKeyWithPassword({
      ownerId,
      password,
      wrapper: changed.passwordWrappedMasterKey,
    }),
  );
  await visit("old password denied", "POST", "/api/auth/login", {
    client: "crypto-old",
    json: { email, password },
    status: 401,
  });
  await visit("new password login", "POST", "/api/auth/login", {
    client: "crypto-new",
    json: { email, password: changedPassword },
  });
  if (transition) await transition("after-password-change", fixture);
  else {
    await fixture.close();
    await fixture.start();
  }
  const retained = await visit(
    "retained profile",
    "GET",
    "/api/encryption/profile",
  );
  assert.deepEqual(retained.profile, changed);
  const grants = await visit(
    "retained grant",
    "GET",
    `/api/encryption/principals/${id}/grants`,
  );
  assert.deepEqual(grants, [created.grant]);
  assert.deepEqual(
    await unwrapAccountMasterKeyWithPassword({
      ownerId,
      password: changedPassword,
      wrapper: retained.profile.passwordWrappedMasterKey,
    }),
    accountMasterKey,
  );
  assert.deepEqual(
    await unwrapAccountMasterKeyForClient({
      ownerId,
      clientKeyPair,
      wrapper: grants[0].wrappedKey,
    }),
    accountMasterKey,
  );
  // Check authenticated metadata and ciphertext integrity with the real client.
  const tampered = structuredClone(grants[0].wrappedKey);
  const bytes = Buffer.from(tampered.envelope.ciphertext, "base64url");
  bytes[0] ^= 1;
  tampered.envelope.ciphertext = bytes.toString("base64url");
  await assert.rejects(
    unwrapAccountMasterKeyForClient({
      ownerId,
      clientKeyPair,
      wrapper: tampered,
    }),
  );
  accountMasterKey.fill(0);
  return {
    passed: true,
    httpSteps: steps,
    retainedWrapperBytes: true,
    passwordRewrap: true,
    hpkeOpen: true,
    wrongOwnerRejected: true,
    tamperingRejected: true,
  };
}
