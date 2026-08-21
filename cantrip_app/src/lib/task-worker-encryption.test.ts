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
  ensureTaskWorkerEncryption,
  taskWorkerEncryptionReadiness,
} from "./task-worker-encryption";
import type { WorkerGrantApi } from "./worker-encryption-grants";

const ownerId = "owner-task-encryption";
const serverId = "server-task-encryption";
const timestamp = "2026-08-19T12:00:00.000Z";
const requiredTaskWorkerComponents = [
  "attachment-content",
  "task-content",
  "mcp-secret",
  "policy-content",
  "provider-credential",
] as const;

function workerGrants(
  keyRevision: number,
  taskKeyRevision = keyRevision,
): WorkerEncryptionStatus["grants"] {
  return requiredTaskWorkerComponents.map((component) => ({
    component,
    keyRevision: component === "task-content" ? taskKeyRevision : keyRevision,
  }));
}

function session(): ClientSessionContext {
  return {
    serverId,
    user: { id: ownerId },
  } as ClientSessionContext;
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

function worker(encryption: WorkerEncryptionStatus, workerId = "worker-a") {
  return { workerId, online: true, encryption };
}

async function apiFor(
  workerId: string,
  state: EncryptionPrincipal["state"] = "approved",
) {
  const keyPair = await generateHpkeKeyPair(false);
  let principal: EncryptionPrincipal = {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId,
    kind: "worker",
    workerId,
    label: "Task worker",
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
      const grant: EncryptionKeyGrant = {
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
      grants.push(grant);
      return grant;
    },
    listGrants: async () => grants,
    listPrincipals: async () => [principal],
    revokeGrant: async () => {
      throw new Error("not used");
    },
  };
  return { api, createdComponents };
}

describe("Task worker encryption readiness", () => {
  it("approves every required content grant before refreshing the worker", async () => {
    const client = service();
    const { api, createdComponents } = await apiFor("worker-a", "pending");
    const refresh = vi.fn(async () => ({
      component: "task-content" as const,
      keyRevision: 3,
      status: status("ready", workerGrants(3)),
    }));

    const refreshed = await ensureTaskWorkerEncryption({
      api,
      refresh,
      service: client,
      session,
      worker: worker(status("pending-approval")),
    });

    expect(createdComponents).toEqual(requiredTaskWorkerComponents);
    expect(refresh).toHaveBeenCalledWith("worker-a", {
      component: "task-content",
      keyRevision: 3,
    });
    expect(refreshed.grants).toEqual(workerGrants(3));
  });

  it("fails closed while locked or revoked without creating a grant", async () => {
    const { api, createdComponents } = await apiFor("worker-a");
    const refresh = vi.fn();
    await expect(
      ensureTaskWorkerEncryption({
        api,
        refresh,
        service: new ClientEncryptionService(),
        session,
        worker: worker(status("ready")),
      }),
    ).rejects.toMatchObject({ state: "locked" });
    await expect(
      ensureTaskWorkerEncryption({
        api,
        refresh,
        service: service(),
        session,
        worker: worker(
          status(
            "unavailable",
            [],
            "Worker encryption authorization was revoked.",
          ),
        ),
      }),
    ).rejects.toMatchObject({ state: "revoked" });
    expect(createdComponents).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects another worker principal and an unrefreshed key revision", async () => {
    const client = service(2);
    const wrongWorker = await apiFor("worker-b");
    await expect(
      ensureTaskWorkerEncryption({
        api: wrongWorker.api,
        refresh: vi.fn(),
        service: client,
        session,
        worker: worker(status("ready")),
      }),
    ).rejects.toThrow(/registered an encryption key/u);

    const matching = await apiFor("worker-a");
    await expect(
      ensureTaskWorkerEncryption({
        api: matching.api,
        refresh: async () => ({
          component: "task-content",
          keyRevision: 2,
          status: status("ready", workerGrants(2, 1)),
        }),
        service: client,
        session,
        worker: worker(status("ready", workerGrants(2, 1))),
      }),
    ).rejects.toMatchObject({ state: "wrong-revision" });
  });

  it("refreshes an already-ready worker without manufacturing another grant", async () => {
    const refresh = vi.fn(async () => ({
      component: "task-content" as const,
      keyRevision: 3,
      status: status("ready", workerGrants(3)),
    }));
    const api = {
      listPrincipals: vi.fn(() => Promise.reject(new Error("not called"))),
    } as unknown as WorkerGrantApi;
    await expect(
      ensureTaskWorkerEncryption({
        api,
        refresh,
        service: service(),
        session,
        worker: worker(status("ready", workerGrants(3))),
      }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(api.listPrincipals).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("classifies missing, wrong, offline, and unsupported readiness", () => {
    const snapshot = service().getSnapshot();
    expect(
      taskWorkerEncryptionReadiness(worker(status("ready")), snapshot),
    ).toBe("missing-grant");
    expect(
      taskWorkerEncryptionReadiness(
        worker(status("ready", workerGrants(3, 1))),
        snapshot,
      ),
    ).toBe("wrong-revision");
    expect(
      taskWorkerEncryptionReadiness(
        { ...worker(status("ready")), online: false },
        snapshot,
      ),
    ).toBe("offline");
    expect(
      taskWorkerEncryptionReadiness(
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
