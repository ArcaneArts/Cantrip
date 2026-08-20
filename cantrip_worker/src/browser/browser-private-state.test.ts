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

import { encodeSurfacePrivateStateForWorker } from "../surface-private-state-encryption.js";
import { WorkerEncryptionService } from "../worker-encryption.js";
import {
  BrowserNavigationOperationGuard,
  openBrowserNavigationOperation,
  openBrowserPersistentPrivateState,
} from "./browser-private-state.js";

const ownerId = "browser-private-state-owner";
const serverId = "https://browser-private-state.test";
const workerId = "browser-private-state-worker";
const timestamp = "2026-08-20T12:00:00.000Z";
const directories: string[] = [];

async function service(): Promise<WorkerEncryptionService> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-browser-private-state-"),
  );
  directories.push(dataDirectory);
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl: serverId,
    workerId,
  });
  const registration = service.registration();
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: "Browser private-state worker",
    publicKey: registration.publicKey,
    state: "approved",
    revision: 1,
    approvedAt: timestamp,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const componentKey = deriveComponentKey({
    accountMasterKey: generateAccountMasterKey(),
    ownerId,
    component: "surface-private-state",
    keyRevision: 1,
  });
  const wrappedKey = await wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "surface-private-state",
    componentKey,
    keyRevision: 1,
    workerPublicKey: principal.publicKey,
  });
  const grant: EncryptionKeyGrant = {
    id: crypto.randomUUID(),
    ownerId,
    principalId: principal.id,
    component: "surface-private-state",
    keyRevision: 1,
    wrappedKey,
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await service.acceptBootstrap({ ownerId, principal, grants: [grant] });
  return service;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true })),
  );
});

describe("browser private state", () => {
  it("opens the canonical browser row only for its bound row and revision", async () => {
    const worker = await service();
    const surfaceId = "browser-row-a";
    const stateProtection = await encodeSurfacePrivateStateForWorker({
      ownerId,
      context: {
        serverId,
        resource: "browser-row",
        resourceId: surfaceId,
        operationId: null,
        recordKind: "browser-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "browser-state" },
        revision: 4,
        url: "https://private.example.test/start",
      },
      service: worker,
    });

    await expect(
      openBrowserPersistentPrivateState({
        ownerId,
        service: worker,
        surfaceId,
        state: {
          serverId,
          stateProtection,
          stateResource: "browser-row",
          stateRevision: 4,
        },
      }),
    ).resolves.toEqual({
      revision: 4,
      url: "https://private.example.test/start",
    });
    await expect(
      openBrowserPersistentPrivateState({
        ownerId,
        service: worker,
        surfaceId: "browser-row-b",
        state: {
          serverId,
          stateProtection,
          stateResource: "browser-row",
          stateRevision: 4,
        },
      }),
    ).rejects.toThrow();
    await expect(
      openBrowserPersistentPrivateState({
        ownerId,
        service: worker,
        surfaceId,
        state: {
          serverId,
          stateProtection,
          stateResource: "browser-row",
          stateRevision: 5,
        },
      }),
    ).rejects.toThrow(/revision is stale/u);
  });

  it("rejects swapped, tampered, stale, and replayed navigation operations", async () => {
    const worker = await service();
    const surfaceId = "browser-navigation-a";
    const operationId = "navigation-operation-a";
    const stateProtection = await encodeSurfacePrivateStateForWorker({
      ownerId,
      context: {
        serverId,
        resource: "browser-operation",
        resourceId: surfaceId,
        operationId,
        recordKind: "browser-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "browser-state" },
        revision: 7,
        url: "https://private.example.test/next",
      },
      service: worker,
    });
    const opened = await openBrowserNavigationOperation({
      operationId,
      ownerId,
      serverId,
      service: worker,
      stateProtection,
      surfaceId,
    });
    expect(opened.url).toBe("https://private.example.test/next");

    const guard = new BrowserNavigationOperationGuard();
    expect(() =>
      guard.accept({ expectedRevision: 7, operationId, revision: 7 }),
    ).not.toThrow();
    expect(() =>
      guard.accept({ expectedRevision: 7, operationId, revision: 7 }),
    ).toThrow(/already applied/u);
    expect(() =>
      new BrowserNavigationOperationGuard().accept({
        expectedRevision: 8,
        operationId: "navigation-operation-stale",
        revision: 7,
      }),
    ).toThrow(/stale/u);

    await expect(
      openBrowserNavigationOperation({
        operationId: "navigation-operation-b",
        ownerId,
        serverId,
        service: worker,
        stateProtection,
        surfaceId,
      }),
    ).rejects.toThrow();

    const tampered = structuredClone(stateProtection);
    const ciphertext = tampered.protectedState.envelope.ciphertext;
    tampered.protectedState.envelope.ciphertext = `${
      ciphertext[0] === "A" ? "B" : "A"
    }${ciphertext.slice(1)}`;
    await expect(
      openBrowserNavigationOperation({
        operationId,
        ownerId,
        serverId,
        service: worker,
        stateProtection: tampered,
        surfaceId,
      }),
    ).rejects.toThrow();
  });
});
