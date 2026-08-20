import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decryptSurfacePrivateState,
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
  WorkerComponentKeyGrant,
} from "@cantrip/protocol/encryption";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeSurfacePrivateStateForWorker,
  encodeSurfacePrivateStateForWorker,
} from "./surface-private-state-encryption.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-surface-worker";
const timestamp = "2026-08-19T12:00:00.000Z";
const directories: string[] = [];
const context = {
  serverId: "https://cantrip.test",
  resource: "terminal-operation" as const,
  resourceId: "terminal-1",
  operationId: "open-1",
  recordKind: "terminal-state" as const,
};
const content = {
  version: 1 as const,
  classification: { recordKind: "terminal-state" as const },
  directory: { kind: "relative-path" as const, path: "private/path" },
  serviceCommand: "pnpm private",
};

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "cantrip-surface-worker-"));
  directories.push(created);
  return created;
}

function principal(
  service: WorkerEncryptionService,
  workerId: string,
  state: EncryptionPrincipal["state"] = "approved",
): EncryptionPrincipal {
  const registration = service.registration();
  return {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: "Surface-state worker",
    publicKey: registration.publicKey,
    state,
    revision: 1,
    approvedAt: state === "approved" ? timestamp : null,
    revokedAt: state === "revoked" ? timestamp : null,
    revokedReason: state === "revoked" ? "test revocation" : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function grant(
  principalId: string,
  wrappedKey: WorkerComponentKeyGrant,
): EncryptionKeyGrant {
  return {
    id: crypto.randomUUID(),
    ownerId,
    principalId,
    component: wrappedKey.component,
    keyRevision: wrappedKey.keyRevision,
    wrappedKey,
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true })),
  );
});

describe("worker surface private-state adapter", () => {
  it("recovers the scoped grant after restart without a client or password", async () => {
    const dataDirectory = await directory();
    const workerId = "worker-a";
    const first = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: context.serverId,
      workerId,
    });
    const workerPrincipal = principal(first, workerId);
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "surface-private-state",
      keyRevision: 2,
    });
    const workerGrant = grant(
      workerPrincipal.id,
      await wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component: "surface-private-state",
        componentKey,
        keyRevision: 2,
        workerPublicKey: workerPrincipal.publicKey,
      }),
    );
    await first.acceptBootstrap({
      ownerId,
      principal: workerPrincipal,
      grants: [workerGrant],
    });
    first.lock();

    const restarted = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: context.serverId,
      workerId,
    });
    await restarted.acceptBootstrap({
      ownerId,
      principal: workerPrincipal,
      grants: [workerGrant],
    });
    const opaque = await encodeSurfacePrivateStateForWorker({
      ownerId,
      context,
      content,
      service: restarted,
    });
    await expect(
      decryptSurfacePrivateState({
        ownerId,
        context,
        keyRevision: 2,
        componentKey,
        opaque,
      }),
    ).resolves.toEqual(content);
    await expect(
      decodeSurfacePrivateStateForWorker({
        ownerId,
        context,
        opaque,
        service: restarted,
      }),
    ).resolves.toEqual(content);
  });

  it("rejects missing, revoked, and another worker's grant", async () => {
    const workerA = await WorkerEncryptionService.open({
      dataDirectory: await directory(),
      serverUrl: context.serverId,
      workerId: "worker-a",
    });
    await expect(
      encodeSurfacePrivateStateForWorker({
        ownerId,
        context,
        content,
        service: workerA,
      }),
    ).rejects.toMatchObject({ state: "missing-grant" });

    await workerA.acceptBootstrap({
      ownerId,
      principal: principal(workerA, "worker-a", "revoked"),
      grants: [],
    });
    await expect(
      encodeSurfacePrivateStateForWorker({
        ownerId,
        context,
        content,
        service: workerA,
      }),
    ).rejects.toMatchObject({ state: "revoked" });

    const workerB = await WorkerEncryptionService.open({
      dataDirectory: await directory(),
      serverUrl: context.serverId,
      workerId: "worker-b",
    });
    const principalB = principal(workerB, "worker-b");
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "surface-private-state",
      keyRevision: 1,
    });
    const wrappedForA = await wrapComponentKeyForWorker({
      ownerId,
      workerId: "worker-b",
      component: "surface-private-state",
      componentKey,
      keyRevision: 1,
      workerPublicKey: workerA.registration().publicKey,
    });
    await expect(
      workerB.acceptBootstrap({
        ownerId,
        principal: principalB,
        grants: [grant(principalB.id, wrappedForA)],
      }),
    ).rejects.toThrow(/could not be opened/u);
  });
});
