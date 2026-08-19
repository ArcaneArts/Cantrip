import {
  clearSensitiveBytes,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  workerEncryptionComponentScopeSchema,
  type EncryptionKeyGrant,
  type EncryptionKeyGrantCreate,
  type EncryptionPrincipal,
  type WorkerEncryptionComponentScope,
} from "@cantrip/protocol/encryption";

import type {
  ClientEncryptionIdentity,
  ClientEncryptionService,
} from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";
import {
  approveEncryptionPrincipal,
  createEncryptionGrant,
  listEncryptionGrants,
  listEncryptionPrincipals,
  revokeEncryptionGrant,
} from "./encryption-api";

export interface WorkerGrantApi {
  approvePrincipal(
    principalId: string,
    expectedRevision: number,
  ): Promise<EncryptionPrincipal>;
  createGrant(
    principalId: string,
    input: EncryptionKeyGrantCreate,
  ): Promise<EncryptionKeyGrant>;
  listGrants(principalId: string): Promise<EncryptionKeyGrant[]>;
  listPrincipals(): Promise<EncryptionPrincipal[]>;
  revokeGrant(
    grantId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<EncryptionKeyGrant>;
}

const defaultApi: WorkerGrantApi = {
  approvePrincipal: approveEncryptionPrincipal,
  createGrant: createEncryptionGrant,
  listGrants: listEncryptionGrants,
  listPrincipals: listEncryptionPrincipals,
  revokeGrant: revokeEncryptionGrant,
};

function workerPrincipal(
  principals: EncryptionPrincipal[],
  workerId: string,
): EncryptionPrincipal | null {
  return (
    principals.find(
      (principal) =>
        principal.kind === "worker" &&
        principal.workerId === workerId &&
        principal.state !== "revoked",
    ) ?? null
  );
}

export async function authorizeWorkerEncryption(input: {
  api?: WorkerGrantApi;
  components: WorkerEncryptionComponentScope[];
  identity: ClientEncryptionIdentity;
  keyRevision?: number;
  service?: ClientEncryptionService;
  workerId: string;
}): Promise<EncryptionKeyGrant[]> {
  const api = input.api ?? defaultApi;
  const service = input.service ?? clientEncryption;
  const components = [
    ...new Set(
      input.components.map((component) =>
        workerEncryptionComponentScopeSchema.parse(component),
      ),
    ),
  ];
  let principal = workerPrincipal(await api.listPrincipals(), input.workerId);
  if (!principal) {
    throw new ClientEncryptionError(
      "principal-unavailable",
      "The worker has not registered an encryption key yet.",
    );
  }
  if (principal.state === "pending") {
    try {
      principal = await api.approvePrincipal(principal.id, principal.revision);
    } catch {
      principal = workerPrincipal(await api.listPrincipals(), input.workerId);
    }
  }
  if (!principal || principal.state !== "approved") {
    throw new ClientEncryptionError(
      "principal-unavailable",
      "The worker encryption key is not approved.",
    );
  }
  const snapshot = service.getSnapshot();
  if (
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.serverId !== input.identity.serverId ||
    snapshot.identity.ownerId !== input.identity.ownerId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked before authorizing a worker.",
    );
  }
  const keyRevision = input.keyRevision ?? snapshot.masterKeyRevision;
  const created: EncryptionKeyGrant[] = [];
  for (const component of components) {
    const componentKey = service.componentKey({
      component,
      identity: input.identity,
      keyRevision,
    });
    try {
      const wrappedKey = await wrapComponentKeyForWorker({
        ownerId: input.identity.ownerId,
        workerId: input.workerId,
        component,
        componentKey,
        keyRevision,
        workerPublicKey: principal.publicKey,
      });
      try {
        created.push(
          await api.createGrant(principal.id, {
            component,
            keyRevision,
            wrappedKey,
          }),
        );
      } catch (error) {
        const existing = (await api.listGrants(principal.id)).find(
          (grant) =>
            grant.state === "active" &&
            grant.component === component &&
            grant.keyRevision === keyRevision,
        );
        if (!existing) throw error;
        created.push(existing);
      }
    } finally {
      clearSensitiveBytes(componentKey);
    }
  }
  return created;
}

export async function revokeWorkerEncryptionGrant(input: {
  api?: WorkerGrantApi;
  grant: EncryptionKeyGrant;
  reason: string;
}): Promise<EncryptionKeyGrant> {
  if (input.grant.wrappedKey.purpose !== "worker-component-key") {
    throw new ClientEncryptionError(
      "principal-unavailable",
      "Only worker component grants can be revoked here.",
    );
  }
  return (input.api ?? defaultApi).revokeGrant(
    input.grant.id,
    input.grant.revision,
    input.reason,
  );
}
