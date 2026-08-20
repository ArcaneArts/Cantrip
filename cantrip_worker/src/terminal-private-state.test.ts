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

import { encodeSurfacePrivateStateForWorker } from "./surface-private-state-encryption.js";
import { openTerminalPrivateState } from "./terminal-private-state.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-terminal-private-state";
const serverId = "https://cantrip.test";
const terminalId = "terminal-1";
const timestamp = "2026-08-20T12:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true })),
  );
});

async function fixture(): Promise<WorkerEncryptionService> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-terminal-private-state-"),
  );
  directories.push(dataDirectory);
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl: serverId,
    workerId: "worker-a",
  });
  const registration = service.registration();
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId: "worker-a",
    label: "Terminal worker",
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
    workerId: "worker-a",
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

async function protect(
  service: WorkerEncryptionService,
  directory: { kind: "project-root" } | { kind: "relative-path"; path: string },
) {
  return encodeSurfacePrivateStateForWorker({
    ownerId,
    context: {
      serverId,
      resource: "terminal-row",
      resourceId: terminalId,
      operationId: null,
      recordKind: "terminal-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "terminal-state" },
      directory,
      serviceCommand: "pnpm dev --filter private",
    },
    service,
  });
}

describe("terminal private-state runtime", () => {
  it("resolves project-root and repository-relative working directories", async () => {
    const service = await fixture();
    const worktreePath = path.join(tmpdir(), "private-worktree");
    await expect(
      openTerminalPrivateState({
        serverId,
        terminalId,
        worktreePath,
        stateProtection: await protect(service, { kind: "project-root" }),
        service,
      }),
    ).resolves.toEqual({
      cwd: path.resolve(worktreePath),
      serviceCommand: "pnpm dev --filter private",
    });
    await expect(
      openTerminalPrivateState({
        serverId,
        terminalId,
        worktreePath,
        stateProtection: await protect(service, {
          kind: "relative-path",
          path: "packages/app",
        }),
        service,
      }),
    ).resolves.toEqual({
      cwd: path.resolve(worktreePath, "packages/app"),
      serviceCommand: "pnpm dev --filter private",
    });
  });

  it("rejects ciphertext replayed for another terminal row", async () => {
    const service = await fixture();
    await expect(
      openTerminalPrivateState({
        serverId,
        terminalId: "terminal-2",
        worktreePath: "/tmp/worktree",
        stateProtection: await protect(service, { kind: "project-root" }),
        service,
      }),
    ).rejects.toMatchObject({ state: "corrupt" });
  });

  it("rejects a missing scoped worker grant", async () => {
    const granted = await fixture();
    const ungrantedDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-terminal-private-state-missing-"),
    );
    directories.push(ungrantedDirectory);
    const ungranted = await WorkerEncryptionService.open({
      dataDirectory: ungrantedDirectory,
      serverUrl: serverId,
      workerId: "worker-b",
    });
    const ungrantedRegistration = ungranted.registration();
    await ungranted.acceptBootstrap({
      ownerId,
      principal: {
        id: ungrantedRegistration.principalId,
        ownerId,
        kind: "worker",
        workerId: "worker-b",
        label: "Ungranted terminal worker",
        publicKey: ungrantedRegistration.publicKey,
        state: "approved",
        revision: 1,
        approvedAt: timestamp,
        revokedAt: null,
        revokedReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      grants: [],
    });
    await expect(
      openTerminalPrivateState({
        serverId,
        terminalId,
        worktreePath: "/tmp/worktree",
        stateProtection: await protect(granted, { kind: "project-root" }),
        service: ungranted,
      }),
    ).rejects.toMatchObject({ state: "missing-grant" });
  });
});
