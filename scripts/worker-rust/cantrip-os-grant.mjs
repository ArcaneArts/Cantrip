import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";

export const ownerId = "00000000-0000-0000-0000-000000000001";

export async function grantCantripOsFixture(
  call,
  workerId,
  data,
  runRuntime,
  productFiles,
) {
  const identity = JSON.parse(
    await readFile(path.join(data, "worker-encryption-key.json"), "utf8"),
  );
  const accountMasterKey = crypto.generateAccountMasterKey();
  const clientId = randomUUID();
  const publicKey = await crypto.publicKeyForPair(
    await crypto.generateHpkeKeyPair(),
  );
  const wrappedMasterKey = await crypto.wrapAccountMasterKeyForClient({
    ownerId,
    clientId,
    accountMasterKey,
    masterKeyRevision: 1,
    clientPublicKey: publicKey,
  });
  await call(
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
        label: "Cantrip OS source fixture",
        publicKey,
        wrappedMasterKey,
      },
    },
    201,
  );
  const refresh = (component) =>
    call("POST", `/api/workers/${workerId}/encryption/refresh`, {
      component,
      keyRevision: 1,
    });
  await refresh("repository-content");
  const principals = await call("GET", "/api/encryption/principals");
  const principal = principals.find(({ id }) => id === identity.principalId);
  assert.ok(principal);
  await call("POST", `/api/encryption/principals/${principal.id}/approve`, {
    expectedRevision: principal.revision,
  });
  const components = ["repository-content"];
  if (runRuntime) components.push("run-content");
  if (productFiles)
    components.push("surface-private-state", "private-surface-metadata");
  const keys = new Map();
  for (const component of components) {
    const componentKey = crypto.deriveComponentKey({
      accountMasterKey,
      ownerId,
      component,
      keyRevision: 1,
    });
    const wrappedKey = await crypto.wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component,
      keyRevision: 1,
      componentKey,
      workerPublicKey: identity.publicKey,
    });
    await call(
      "POST",
      `/api/encryption/principals/${principal.id}/grants`,
      { component, keyRevision: 1, wrappedKey },
      201,
    );
    assert.equal((await refresh(component)).status.state, "ready");
    keys.set(component, componentKey);
  }
  return keys;
}
