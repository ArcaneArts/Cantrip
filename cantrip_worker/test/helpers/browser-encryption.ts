import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
} from "@cantrip/protocol/encryption";
import { encodeSurfacePrivateStateForWorker } from "../../src/surface-private-state-encryption.js";
import { WorkerEncryptionService } from "../../src/worker-encryption.js";

export const ownerId = "browser-adapter-owner";
export const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverUrl = "https://browser-adapter.test";
const workerId = "browser-adapter-worker";
const timestamp = "2026-08-20T12:00:00.000Z";

export async function encryptionService(
  dataDirectory: string,
): Promise<WorkerEncryptionService> {
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl,
    workerId,
  });
  const registration = service.registration();
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: "Browser adapter worker",
    publicKey: registration.publicKey,
    state: "approved",
    revision: 1,
    approvedAt: timestamp,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const componentKey = deriveComponentKey({
    accountMasterKey: generateAccountMasterKey(),
    ownerId,
    component: "surface-private-state",
    keyRevision: 1,
  });
  const wrappedKey = await wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "surface-private-state",
    componentKey,
    keyRevision: 1,
    workerPublicKey: principal.publicKey,
  });
  const grant: EncryptionKeyGrant = {
    id: crypto.randomUUID(),
    ownerId,
    principalId: principal.id,
    component: "surface-private-state",
    keyRevision: 1,
    wrappedKey,
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await service.acceptBootstrap({
    serverId,
    ownerId,
    principal,
    grants: [grant],
  });
  return service;
}

export function persistentBrowserState(input: {
  revision: number;
  service: WorkerEncryptionService;
  surfaceId: string;
  url: string;
}) {
  return encodeSurfacePrivateStateForWorker({
    ownerId,
    context: {
      serverId,
      resource: "browser-row",
      resourceId: input.surfaceId,
      operationId: null,
      recordKind: "browser-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: input.revision,
      url: input.url,
    },
    service: input.service,
  });
}
