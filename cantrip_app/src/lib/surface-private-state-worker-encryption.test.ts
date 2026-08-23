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
  ensureSurfacePrivateStateWorkerEncryption,
  surfacePrivateStateWorkerReadiness,
  waitForSurfacePrivateStateWorkerEncryption,
} from "./surface-private-state-worker-encryption";
import type { WorkerGrantApi } from "./worker-encryption-grants";

const ownerId = "owner-surface-readiness";
const serverId = "server-surface-readiness";
const timestamp = "2026-08-19T12:00:00.000Z";

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

describe("surface private-state worker readiness", () => {
  it("adds the missing private-label grant to a surface-ready worker", async () => {
    const keyPair = await generateHpkeKeyPair(false);
    let principal: EncryptionPrincipal = {
      id: "11111111-1111-4111-8111-111111111111",
      ownerId,
      kind: "worker",
      workerId: "worker-a",
      label: "Surface worker",
      publicKey: await publicKeyForPair(keyPair),
      state: "approved",
      revision: 2,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created: string[] = [];
    const api: WorkerGrantApi = {
      approvePrincipal: async () =>
        (principal = {
          ...principal,
          state: "approved",
          revision: 2,
          approvedAt: timestamp,
        }),
      createGrant: async (principalId, input: EncryptionKeyGrantCreate) => {
        created.push(input.component);
        return {
          id: crypto.randomUUID(),
          ownerId,
          principalId,
          ...input,
          state: "active",
          revision: 1,
          revokedAt: null,
          revokedReason: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies EncryptionKeyGrant;
      },
      listGrants: async () => [],
      listPrincipals: async () => [principal],
      revokeGrant: async () => {
        throw new Error("not used");
      },
    };
    const refresh = vi.fn(async () => ({
      component: "surface-private-state" as const,
      keyRevision: 3,
      status: status("ready", [
        { component: "surface-private-state", keyRevision: 3 },
        { component: "private-surface-metadata", keyRevision: 3 },
      ]),
    }));
    await expect(
      ensureSurfacePrivateStateWorkerEncryption({
        api,
        refresh,
        service: service(),
        session: () =>
          ({ serverId, user: { id: ownerId } }) as ClientSessionContext,
        worker: worker(
          status("ready", [
            { component: "surface-private-state", keyRevision: 3 },
          ]),
        ),
      }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(created).toEqual(["private-surface-metadata"]);
  });

  it("classifies locked, missing, revoked, and stale workers", () => {
    const snapshot = service().getSnapshot();
    expect(
      surfacePrivateStateWorkerReadiness(worker(status("ready")), snapshot),
    ).toBe("missing-grant");
    expect(
      surfacePrivateStateWorkerReadiness(
        worker(
          status("ready", [
            { component: "surface-private-state", keyRevision: 3 },
          ]),
        ),
        snapshot,
      ),
    ).toBe("missing-grant");
    expect(
      surfacePrivateStateWorkerReadiness(
        worker(
          status("ready", [
            { component: "surface-private-state", keyRevision: 3 },
            { component: "private-surface-metadata", keyRevision: 2 },
          ]),
        ),
        snapshot,
      ),
    ).toBe("stale");
    expect(
      surfacePrivateStateWorkerReadiness(
        worker(
          status("ready", [
            { component: "surface-private-state", keyRevision: 3 },
            { component: "private-surface-metadata", keyRevision: 3 },
          ]),
        ),
        snapshot,
      ),
    ).toBe("ready");
    expect(
      surfacePrivateStateWorkerReadiness(
        worker(status("unavailable", [], "authorization revoked")),
        snapshot,
      ),
    ).toBe("revoked");
    expect(
      surfacePrivateStateWorkerReadiness(
        worker(status("ready")),
        new ClientEncryptionService().getSnapshot(),
      ),
    ).toBe("locked");
  });

  it("retries while a connected worker is still becoming visible", async () => {
    const ready = status("ready", [
      { component: "surface-private-state", keyRevision: 3 },
      { component: "private-surface-metadata", keyRevision: 3 },
    ]);
    const loadWorker = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(worker(ready));
    const sleep = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => ({
      component: "surface-private-state" as const,
      keyRevision: 3,
      status: ready,
    }));

    await expect(
      waitForSurfacePrivateStateWorkerEncryption({
        loadWorker,
        refresh,
        service: service(),
        session: () =>
          ({ serverId, user: { id: ownerId } }) as ClientSessionContext,
        sleep,
      }),
    ).resolves.toEqual(ready);
    expect(loadWorker).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("retries when the same worker has not activated the current grants yet", async () => {
    const ready = status("ready", [
      { component: "surface-private-state", keyRevision: 3 },
      { component: "private-surface-metadata", keyRevision: 3 },
    ]);
    const stale = status("ready", [
      { component: "surface-private-state", keyRevision: 2 },
      { component: "private-surface-metadata", keyRevision: 2 },
    ]);
    const loadWorker = vi.fn(async () => worker(ready));
    const sleep = vi.fn(async () => undefined);
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        component: "surface-private-state" as const,
        keyRevision: 3,
        status: stale,
      })
      .mockResolvedValue({
        component: "surface-private-state" as const,
        keyRevision: 3,
        status: ready,
      });

    await expect(
      waitForSurfacePrivateStateWorkerEncryption({
        loadWorker,
        refresh,
        service: service(),
        session: () =>
          ({ serverId, user: { id: ownerId } }) as ClientSessionContext,
        sleep,
      }),
    ).resolves.toEqual(ready);
    expect(loadWorker).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });
});
