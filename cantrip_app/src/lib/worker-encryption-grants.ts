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

const pendingGrantAuthorizations = new WeakMap<
  ClientEncryptionService,
  WeakMap<WorkerGrantApi, Map<string, Promise<EncryptionKeyGrant>>>
>();

function pendingGrantMap(
  service: ClientEncryptionService,
  api: WorkerGrantApi,
): Map<string, Promise<EncryptionKeyGrant>> {
  let serviceAuthorizations = pendingGrantAuthorizations.get(service);
  if (!serviceAuthorizations) {
    serviceAuthorizations = new WeakMap();
    pendingGrantAuthorizations.set(service, serviceAuthorizations);
  }
  let authorizations = serviceAuthorizations.get(api);
  if (!authorizations) {
    authorizations = new Map();
    serviceAuthorizations.set(api, authorizations);
  }
  return authorizations;
}

function activeComponentGrant(
  grants: EncryptionKeyGrant[],
  component: WorkerEncryptionComponentScope,
  keyRevision: number,
): EncryptionKeyGrant | undefined {
  return grants.find(
    (grant) =>
      grant.state === "active" &&
      grant.component === component &&
      grant.keyRevision === keyRevision,
  );
}

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
  const existingGrants = await api.listGrants(principal.id);
  const authorizations = pendingGrantMap(service, api);
  const created: EncryptionKeyGrant[] = [];
  for (const component of components) {
    const existing = activeComponentGrant(
      existingGrants,
      component,
      keyRevision,
    );
    if (existing) {
      created.push(existing);
      continue;
    }
    const authorizationKey = JSON.stringify([
      input.identity.ownerId,
      input.identity.serverId,
      input.workerId,
      principal.id,
      principal.revision,
      component,
      keyRevision,
    ]);
    let authorization = authorizations.get(authorizationKey);
    if (!authorization) {
      authorization = (async () => {
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
            return await api.createGrant(principal.id, {
              component,
              keyRevision,
              wrappedKey,
            });
          } catch (error) {
            const concurrent = activeComponentGrant(
              await api.listGrants(principal.id),
              component,
              keyRevision,
            );
            if (!concurrent) throw error;
            return concurrent;
          }
        } finally {
          clearSensitiveBytes(componentKey);
        }
      })();
      authorizations.set(authorizationKey, authorization);
      const clearAuthorization = () => {
        if (authorizations.get(authorizationKey) === authorization) {
          authorizations.delete(authorizationKey);
        }
      };
      void authorization.then(clearAuthorization, clearAuthorization);
    }
    created.push(await authorization);
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
