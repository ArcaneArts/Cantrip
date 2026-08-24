import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
} from "@cantrip/protocol/encryption";
import { afterEach, describe, expect, it } from "vitest";

import {
  openWorkerCodeSettings,
  protectWorkerCodeSettings,
} from "./code-settings-encryption.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-code-settings";
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timestamp = "2026-08-23T12:00:00.000Z";
const directories: string[] = [];

async function worker(
  workerId: string,
  componentKey: Uint8Array,
  keyRevision = 1,
) {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-code-settings-encryption-"),
  );
  directories.push(dataDirectory);
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl: "https://cantrip.test",
    workerId,
  });
  const registration = service.registration();
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: workerId,
    publicKey: registration.publicKey,
    state: "approved",
    revision: 2,
    approvedAt: timestamp,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const wrappedKey = await wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "customization-content",
    componentKey,
    keyRevision,
    workerPublicKey: registration.publicKey,
  });
  const grant: EncryptionKeyGrant = {
    id: `${keyRevision}`.repeat(8).slice(0, 8) + "-1111-4111-8111-111111111111",
    ownerId,
    principalId: principal.id,
    component: "customization-content",
    keyRevision,
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
  return { grant, principal, service };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Code settings worker encryption", () => {
  it("round-trips across authorized workers and authenticates stored metadata", async () => {
    const accountMasterKey = generateAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey,
      ownerId,
      component: "customization-content",
      keyRevision: 1,
    });
    const workerA = await worker("code-settings-worker-a", componentKey);
    const workerB = await worker("code-settings-worker-b", componentKey);
    const upload = await protectWorkerCodeSettings({
      expectedRevision: null,
      profileId: "default",
      service: workerA.service,
      settings: {
        "editor.fontSize": 17,
        "[typescript]": { "editor.tabSize": 2 },
      },
    });
    const profile = {
      profileId: "default" as const,
      record: upload.record,
      updatedAt: timestamp,
      updatedByWorkerId: "code-settings-worker-a",
    };
    await expect(
      openWorkerCodeSettings({ profile, service: workerB.service }),
    ).resolves.toEqual({
      "editor.fontSize": 17,
      "[typescript]": { "editor.tabSize": 2 },
    });
    await expect(
      openWorkerCodeSettings({
        profile: {
          ...profile,
          record: { ...profile.record, revision: 2 },
        },
        service: workerB.service,
      }),
    ).rejects.toThrow(/authenticated/u);
    await expect(
      openWorkerCodeSettings({
        profile: {
          ...profile,
          record: {
            ...profile.record,
            operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          },
        },
        service: workerB.service,
      }),
    ).rejects.toThrow(/authenticated/u);
  });
});
