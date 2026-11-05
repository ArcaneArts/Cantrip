import { wrapComponentKeyForWorker } from "@cantrip/crypto";
import { WorkerEncryptionService } from "../src/worker-encryption.js";
import { createNativeResourceProtection } from "../src/native-resource-protection.js";

/** Real HPKE bootstrap and component grant, confined to the fixture's storage. */
export async function resourceProtectionFixture(dataDirectory: string) {
  const workerId = "native-resource-fixture";
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    workerId,
    serverUrl: "https://cantrip.test",
  });
  const registration = service.registration();
  const ownerId = "native-resource-fixture-owner";
  const timestamp = "2026-11-05T00:00:00.000Z";
  const key = new Uint8Array(32).fill(47);
  const wrappedKey = await wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "chat-content",
    componentKey: key,
    keyRevision: 1,
    workerPublicKey: registration.publicKey,
  });
  key.fill(0);
  const authorize = (granted: boolean) =>
    service.acceptBootstrap({
      serverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerId,
      principal: {
        id: registration.principalId,
        ownerId,
        kind: "worker",
        workerId,
        label: "Native resource fixture",
        publicKey: registration.publicKey,
        state: "approved",
        revision: 2,
        approvedAt: timestamp,
        revokedAt: null,
        revokedReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      grants: granted
        ? [
            {
              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              ownerId,
              principalId: registration.principalId,
              component: "chat-content",
              keyRevision: 1,
              wrappedKey,
              state: "active",
              revision: 1,
              revokedAt: null,
              revokedReason: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ]
        : [],
    });
  await authorize(true);
  return {
    service,
    authorize,
    protection: createNativeResourceProtection(service),
  };
}
