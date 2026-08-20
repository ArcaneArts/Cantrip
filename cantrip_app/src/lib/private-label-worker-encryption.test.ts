import {
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
} from "@cantrip/crypto";
import type {
  EncryptionKeyGrant,
  EncryptionKeyGrantCreate,
  EncryptionPrincipal,
  WorkerEncryptionStatus,
} from "@cantrip/protocol/encryption";
import { describe, expect, it, vi } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  ensurePrivateLabelWorkerEncryption,
  privateLabelWorkerEncryptionReadiness,
} from "./private-label-worker-encryption";
import type { WorkerGrantApi } from "./worker-encryption-grants";

const ownerId = "owner-private-label-readiness";
const serverId = "server-private-label-readiness";
const timestamp = "2026-08-19T12:00:00.000Z";

function session(): ClientSessionContext {
  return { serverId, user: { id: ownerId } } as ClientSessionContext;
}

function service(revision = 3): ClientEncryptionService {
  const result = new ClientEncryptionService();
  result.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: revision,
  });
  return result;
}

function status(
  state: WorkerEncryptionStatus["state"],
  grants: WorkerEncryptionStatus["grants"] = [],
  error: string | null = null,
): WorkerEncryptionStatus {
  return {
    supported: true,
    state,
    principalId: "11111111-1111-4111-8111-111111111111",
    grants,
    lastSyncedAt: timestamp,
    error,
  };
}

function worker(encryption: WorkerEncryptionStatus) {
  return { workerId: "worker-a", online: true, encryption };
}

async function apiFor(state: EncryptionPrincipal["state"] = "approved") {
  const keyPair = await generateHpkeKeyPair(false);
  let principal: EncryptionPrincipal = {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId,
    kind: "worker",
    workerId: "worker-a",
    label: "Private-label worker",
    publicKey: await publicKeyForPair(keyPair),
    state,
    revision: 1,
    approvedAt: state === "approved" ? timestamp : null,
    revokedAt: state === "revoked" ? timestamp : null,
    revokedReason: state === "revoked" ? "revoked for test" : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const grants: EncryptionKeyGrant[] = [];
  const createdComponents: string[] = [];
  const api: WorkerGrantApi = {
    approvePrincipal: async () => {
      principal = {
        ...principal,
        state: "approved",
        revision: principal.revision + 1,
        approvedAt: timestamp,
      };
      return principal;
    },
    createGrant: async (principalId, input: EncryptionKeyGrantCreate) => {
      createdComponents.push(input.component);
      const created: EncryptionKeyGrant = {
        id: crypto.randomUUID(),
        ownerId,
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
    revokeGrant: async () => {
      throw new Error("not used");
    },
  };
  return { api, createdComponents };
}

describe("private-label worker encryption readiness", () => {
  it("creates only a private-surface-metadata grant and confirms the revision", async () => {
    const { api, createdComponents } = await apiFor("pending");
    const refresh = vi.fn(async () => ({
      component: "private-surface-metadata" as const,
      keyRevision: 3,
      status: status("ready", [
        { component: "private-surface-metadata", keyRevision: 3 },
      ]),
    }));
    await expect(
      ensurePrivateLabelWorkerEncryption({
        api,
        refresh,
        service: service(),
        session,
        worker: worker(status("pending-approval")),
      }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(createdComponents).toEqual(["private-surface-metadata"]);
    expect(refresh).toHaveBeenCalledWith("worker-a", {
      component: "private-surface-metadata",
      keyRevision: 3,
    });
  });

  it("classifies locked, missing, revoked, stale, and unsupported workers", () => {
    const snapshot = service().getSnapshot();
    expect(
      privateLabelWorkerEncryptionReadiness(worker(status("ready")), snapshot),
    ).toBe("missing-grant");
    expect(
      privateLabelWorkerEncryptionReadiness(
        worker(
          status("ready", [
            { component: "private-surface-metadata", keyRevision: 2 },
          ]),
        ),
        snapshot,
      ),
    ).toBe("stale");
    expect(
      privateLabelWorkerEncryptionReadiness(
        worker(
          status(
            "unavailable",
            [],
            "Worker encryption authorization was revoked.",
          ),
        ),
        snapshot,
      ),
    ).toBe("revoked");
    expect(
      privateLabelWorkerEncryptionReadiness(
        worker(status("ready")),
        new ClientEncryptionService().getSnapshot(),
      ),
    ).toBe("locked");
    expect(
      privateLabelWorkerEncryptionReadiness(
        worker({
          supported: false,
          state: "unavailable",
          principalId: null,
          grants: [],
          lastSyncedAt: null,
          error: null,
        }),
        snapshot,
      ),
    ).toBe("unavailable");
  });
});
