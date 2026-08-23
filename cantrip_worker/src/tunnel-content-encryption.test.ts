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
} from "@cantrip/protocol";
import { tunnelContentRecordSchema } from "@cantrip/protocol/tunnel-content";
import { afterEach, describe, expect, it } from "vitest";

import { protectWorkerEndpointContent } from "./endpoint-content-encryption.js";
import { openWorkerTunnelContentRecord } from "./tunnel-content-encryption.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-tunnel-content";
const serverId = "https://cantrip.test";
const workerId = "worker-a";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true })),
  );
});

async function service() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-tunnel-content-"),
  );
  directories.push(dataDirectory);
  const worker = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl: serverId,
    workerId,
  });
  const registration = worker.registration();
  const now = "2026-08-22T12:00:00.000Z";
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: "Tunnel worker",
    publicKey: registration.publicKey,
    state: "approved",
    revision: 1,
    approvedAt: now,
    revokedAt: null,
    revokedReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const componentKey = deriveComponentKey({
    accountMasterKey: generateAccountMasterKey(),
    ownerId,
    component: "tunnel-content",
    keyRevision: 1,
  });
  const grant: EncryptionKeyGrant = {
    id: crypto.randomUUID(),
    ownerId,
    principalId: principal.id,
    component: "tunnel-content",
    keyRevision: 1,
    wrappedKey: await wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component: "tunnel-content",
      componentKey,
      keyRevision: 1,
      workerPublicKey: principal.publicKey,
    }),
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: now,
    updatedAt: now,
  };
  await worker.acceptBootstrap({ ownerId, principal, grants: [grant] });
  return worker;
}

describe("Tunnel content encryption", () => {
  it("keeps presentation and TCP configuration opaque and record-bound", async () => {
    const worker = await service();
    const tunnelId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const content = tunnelContentRecordSchema.parse({
      name: "Private tunnel",
      description: "Private description",
      source: { kind: "desktop-loopback" },
      destination: {
        kind: "worker-tcp",
        workerId,
        host: "127.0.0.1",
        port: 51_731,
      },
      dataProtection: {
        formatVersion: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        key: "k".repeat(43),
      },
    });
    const protectedContent = await protectWorkerEndpointContent({
      context: {
        domain: "tunnel-content",
        serverId,
        workerId,
        scopeId: JSON.stringify(["tunnel", tunnelId]),
        operationId,
        operation: "tunnel.record",
        direction: "stored",
        sequence: 1,
      },
      content,
      schema: tunnelContentRecordSchema,
      service: worker,
    });
    const record = { operationId, revision: 1, protectedContent };

    expect(JSON.stringify(record)).not.toContain("Private tunnel");
    expect(JSON.stringify(record)).not.toContain("51731");
    await expect(
      openWorkerTunnelContentRecord({
        record,
        serverId,
        service: worker,
        tunnelId,
        workerId,
      }),
    ).resolves.toEqual(content);
    await expect(
      openWorkerTunnelContentRecord({
        record,
        serverId,
        service: worker,
        tunnelId: crypto.randomUUID(),
        workerId,
      }),
    ).rejects.toThrow(/authenticated/u);
  });
});
