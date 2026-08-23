import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decryptPrivateDisplayLabel,
  deriveComponentKey,
  encryptPrivateDisplayLabel,
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
  decodePrivateDisplayLabelForWorker,
  encodePrivateDisplayLabelForWorker,
} from "./private-label-encryption.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-private-label-worker";
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverUrl = "https://cantrip.test";
const timestamp = "2026-08-19T12:00:00.000Z";
const directories: string[] = [];

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "cantrip-label-worker-"));
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
    label: "Private-label worker",
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
    id: "11111111-1111-4111-8111-111111111111",
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

describe("worker private display-label adapter", () => {
  it("agrees with the shared client codec and recovers after restart without a password", async () => {
    const dataDirectory = await directory();
    const workerId = "worker-a";
    const first = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl,
      workerId,
    });
    const workerPrincipal = principal(first, workerId);
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "private-surface-metadata",
      keyRevision: 2,
    });
    const workerGrant = grant(
      workerPrincipal.id,
      await wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component: "private-surface-metadata",
        componentKey,
        keyRevision: 2,
        workerPublicKey: workerPrincipal.publicKey,
      }),
    );
    await first.acceptBootstrap({
      serverId,
      ownerId,
      principal: workerPrincipal,
      grants: [workerGrant],
    });
    first.lock();

    const restarted = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl,
      workerId,
    });
    await restarted.acceptBootstrap({
      serverId,
      ownerId,
      principal: workerPrincipal,
      grants: [workerGrant],
    });
    const workerOpaque = await encodePrivateDisplayLabelForWorker({
      ownerId,
      label: "Worker-encrypted project",
      recordKind: "project",
      rowId: "project-1",
      service: restarted,
    });
    await expect(
      decryptPrivateDisplayLabel({
        ownerId,
        recordKind: "project",
        rowId: "project-1",
        keyRevision: 2,
        componentKey,
        opaque: workerOpaque,
      }),
    ).resolves.toBe("Worker-encrypted project");

    const clientOpaque = await encryptPrivateDisplayLabel({
      ownerId,
      label: "Client-encrypted chat",
      recordKind: "chat",
      rowId: "chat-1",
      keyRevision: 2,
      componentKey,
    });
    await expect(
      decodePrivateDisplayLabelForWorker({
        ownerId,
        opaque: clientOpaque,
        recordKind: "chat",
        rowId: "chat-1",
        service: restarted,
      }),
    ).resolves.toBe("Client-encrypted chat");
  });

  it("fails closed for missing, stale, revoked, and another worker's grant", async () => {
    const workerA = await WorkerEncryptionService.open({
      dataDirectory: await directory(),
      serverUrl,
      workerId: "worker-a",
    });
    await expect(
      encodePrivateDisplayLabelForWorker({
        ownerId,
        label: "Missing grant",
        recordKind: "project",
        rowId: "project-1",
        service: workerA,
      }),
    ).rejects.toMatchObject({ state: "missing" });

    const workerPrincipal = principal(workerA, "worker-a");
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "private-surface-metadata",
      keyRevision: 1,
    });
    const workerGrant = grant(
      workerPrincipal.id,
      await wrapComponentKeyForWorker({
        ownerId,
        workerId: "worker-a",
        component: "private-surface-metadata",
        componentKey,
        keyRevision: 1,
        workerPublicKey: workerPrincipal.publicKey,
      }),
    );
    await workerA.acceptBootstrap({
      serverId,
      ownerId,
      principal: workerPrincipal,
      grants: [workerGrant],
    });
    const future = await encryptPrivateDisplayLabel({
      ownerId,
      label: "Future revision",
      recordKind: "chat",
      rowId: "chat-1",
      keyRevision: 2,
      componentKey,
    });
    await expect(
      decodePrivateDisplayLabelForWorker({
        ownerId,
        opaque: future,
        recordKind: "chat",
        rowId: "chat-1",
        service: workerA,
      }),
    ).rejects.toMatchObject({ state: "stale" });

    await workerA.acceptBootstrap({
      serverId,
      ownerId,
      principal: principal(workerA, "worker-a", "revoked"),
      grants: [],
    });
    await expect(
      encodePrivateDisplayLabelForWorker({
        ownerId,
        label: "Revoked grant",
        recordKind: "project",
        rowId: "project-1",
        service: workerA,
      }),
    ).rejects.toMatchObject({ state: "revoked" });

    const workerB = await WorkerEncryptionService.open({
      dataDirectory: await directory(),
      serverUrl,
      workerId: "worker-b",
    });
    const workerBPrincipal = principal(workerB, "worker-b");
    const grantEncryptedForA = grant(
      workerBPrincipal.id,
      await wrapComponentKeyForWorker({
        ownerId,
        workerId: "worker-b",
        component: "private-surface-metadata",
        componentKey,
        keyRevision: 1,
        workerPublicKey: workerPrincipal.publicKey,
      }),
    );
    await expect(
      workerB.acceptBootstrap({
        serverId,
        ownerId,
        principal: workerBPrincipal,
        grants: [grantEncryptedForA],
      }),
    ).rejects.toThrow(/could not be opened/u);
  });
});
