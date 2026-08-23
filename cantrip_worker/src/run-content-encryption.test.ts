import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  runConfigurationWriteRequestSchema,
  type EncryptionKeyGrant,
  type EncryptionPrincipal,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  openWorkerRunContent,
  protectWorkerRunContent,
} from "./run-content-encryption.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-run-content";
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverUrl = "https://cantrip.test";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true })),
  );
});

async function service() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-run-content-"),
  );
  directories.push(dataDirectory);
  const worker = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl,
    workerId: "worker-a",
  });
  const registration = worker.registration();
  const now = "2026-08-22T12:00:00.000Z";
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId: "worker-a",
    label: "Run worker",
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
    component: "run-content",
    keyRevision: 1,
  });
  const grant: EncryptionKeyGrant = {
    id: crypto.randomUUID(),
    ownerId,
    principalId: principal.id,
    component: "run-content",
    keyRevision: 1,
    wrappedKey: await wrapComponentKeyForWorker({
      ownerId,
      workerId: "worker-a",
      component: "run-content",
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
  await worker.acceptBootstrap({
    serverId,
    ownerId,
    principal,
    grants: [grant],
  });
  return worker;
}

describe("Run content encryption", () => {
  it("round-trips request and response directions and rejects a direction swap", async () => {
    const worker = await service();
    const input = runConfigurationWriteRequestSchema.parse({
      expectedRevision: null,
      document: {
        version: 1,
        name: "Private environment",
        setup: {
          default: "pnpm install",
          win32: null,
          darwin: null,
          linux: null,
        },
        actions: [
          {
            name: "Private action",
            icon: "run",
            command: "pnpm dev --filter private",
            platform: null,
          },
        ],
      },
    });
    const common = {
      serverId,
      projectId: "project-a",
      worktreeId: "worktree-a",
      operationId: crypto.randomUUID(),
      operation: "run.configuration.write",
      content: input,
      schema: runConfigurationWriteRequestSchema,
      service: worker,
    };
    const request = await protectWorkerRunContent({
      ...common,
      direction: "request",
    });
    await expect(
      openWorkerRunContent({ ...common, opaque: request }),
    ).resolves.toEqual(input);

    const response = await protectWorkerRunContent(common);
    await expect(
      openWorkerRunContent({
        ...common,
        opaque: response,
        direction: "response",
      }),
    ).resolves.toEqual(input);
    await expect(
      openWorkerRunContent({ ...common, opaque: response }),
    ).rejects.toThrow(/authenticated/u);
  });
});
