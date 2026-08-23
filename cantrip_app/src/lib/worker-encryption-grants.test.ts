import {
  bytesEqual,
  deriveComponentKey,
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
  unwrapComponentKeyForWorker,
} from "@cantrip/crypto";
import type {
  EncryptionKeyGrant,
  EncryptionKeyGrantCreate,
  EncryptionPrincipal,
} from "@cantrip/protocol/encryption";
import { describe, expect, it } from "vitest";

import { ClientEncryptionService } from "./client-encryption";
import {
  authorizeWorkerEncryption,
  revokeWorkerEncryptionGrant,
  type WorkerGrantApi,
} from "./worker-encryption-grants";

const identity = { ownerId: "owner-a", serverId: "server-a" } as const;
const timestamp = "2026-08-19T12:00:00.000Z";

function apiFor(principal: EncryptionPrincipal) {
  const grants: EncryptionKeyGrant[] = [];
  const api: WorkerGrantApi = {
    approvePrincipal: async (_principalId, expectedRevision) => {
      principal = {
        ...principal,
        state: "approved",
        revision: expectedRevision + 1,
        approvedAt: timestamp,
      };
      return principal;
    },
    createGrant: async (principalId, input: EncryptionKeyGrantCreate) => {
      const created: EncryptionKeyGrant = {
        id: crypto.randomUUID(),
        ownerId: identity.ownerId,
        principalId,
        component: input.component,
        keyRevision: input.keyRevision,
        wrappedKey: input.wrappedKey,
        state: "active",
        revision: 1,
        revokedAt: null,
        revokedReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      grants.push(created);
      return created;
    },
    listGrants: async () => grants,
    listPrincipals: async () => [principal],
    revokeGrant: async (grantId, expectedRevision, reason) => {
      const index = grants.findIndex((grant) => grant.id === grantId);
      const grant = grants[index];
      if (!grant || grant.revision !== expectedRevision) {
        throw new Error("Grant revision changed.");
      }
      const revoked = {
        ...grant,
        state: "revoked" as const,
        revision: grant.revision + 1,
        revokedAt: timestamp,
        revokedReason: reason,
        updatedAt: timestamp,
      };
      grants[index] = revoked;
      return revoked;
    },
  };
  return { api, grants };
}

describe("client-created worker encryption grants", () => {
  it("approves a registered worker and wraps only requested component keys", async () => {
    const workerId = "worker-a";
    const workerKeyPair = await generateHpkeKeyPair(false);
    const principal: EncryptionPrincipal = {
      id: "11111111-1111-4111-8111-111111111111",
      ownerId: identity.ownerId,
      kind: "worker",
      workerId,
      label: "Worker A",
      publicKey: await publicKeyForPair(workerKeyPair),
      state: "pending",
      revision: 1,
      approvedAt: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const { api } = apiFor(principal);
    const service = new ClientEncryptionService();
    const accountMasterKey = generateAccountMasterKey();
    service.setAccountMasterKey({
      accountMasterKey,
      identity,
      masterKeyRevision: 1,
    });

    const [grant] = await authorizeWorkerEncryption({
      api,
      components: ["chat-content"],
      identity,
      service,
      workerId,
    });
    expect(grant?.wrappedKey.purpose).toBe("worker-component-key");
    if (!grant || grant.wrappedKey.purpose !== "worker-component-key") {
      throw new Error("Expected a worker component grant.");
    }
    const opened = await unwrapComponentKeyForWorker({
      ownerId: identity.ownerId,
      grant: grant.wrappedKey,
      workerKeyPair,
    });
    const expected = deriveComponentKey({
      accountMasterKey,
      ownerId: identity.ownerId,
      component: "chat-content",
      keyRevision: 1,
    });
    expect(bytesEqual(opened, expected)).toBe(true);

    const [replacement] = await authorizeWorkerEncryption({
      api,
      components: ["chat-content"],
      identity,
      keyRevision: 2,
      service,
      workerId,
    });
    expect(replacement?.keyRevision).toBe(2);
    if (!replacement) throw new Error("Expected a replacement grant.");
    const revoked = await revokeWorkerEncryptionGrant({
      api,
      grant,
      reason: "component key replaced",
    });
    expect(revoked).toMatchObject({
      state: "revoked",
      revokedReason: "component key replaced",
    });

    await expect(
      authorizeWorkerEncryption({
        api,
        components: ["workspace-display-name" as "chat-content"],
        identity,
        service,
        workerId,
      }),
    ).rejects.toThrowError();
  });

  it("refuses to manufacture grants while the client key service is locked", async () => {
    const workerKeyPair = await generateHpkeKeyPair(false);
    const workerId = "worker-b";
    const { api } = apiFor({
      id: "22222222-2222-4222-8222-222222222222",
      ownerId: identity.ownerId,
      kind: "worker",
      workerId,
      label: null,
      publicKey: await publicKeyForPair(workerKeyPair),
      state: "approved",
      revision: 2,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await expect(
      authorizeWorkerEncryption({
        api,
        components: ["chat-content"],
        identity,
        service: new ClientEncryptionService(),
        workerId,
      }),
    ).rejects.toMatchObject({ code: "locked" });
  });

  it("shares concurrent authorization for the same worker component", async () => {
    const workerKeyPair = await generateHpkeKeyPair(false);
    const workerId = "worker-concurrent";
    const { api } = apiFor({
      id: "33333333-3333-4333-8333-333333333333",
      ownerId: identity.ownerId,
      kind: "worker",
      workerId,
      label: null,
      publicKey: await publicKeyForPair(workerKeyPair),
      state: "approved",
      revision: 2,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const createGrant = api.createGrant.bind(api);
    let createCalls = 0;
    api.createGrant = async (principalId, input) => {
      createCalls += 1;
      await Promise.resolve();
      return createGrant(principalId, input);
    };
    const service = new ClientEncryptionService();
    service.setAccountMasterKey({
      accountMasterKey: generateAccountMasterKey(),
      identity,
      masterKeyRevision: 1,
    });

    const authorize = () =>
      authorizeWorkerEncryption({
        api,
        components: ["surface-private-state"],
        identity,
        service,
        workerId,
      });
    const [first, second] = await Promise.all([authorize(), authorize()]);

    expect(createCalls).toBe(1);
    expect(second[0]?.id).toBe(first[0]?.id);
  });
});
