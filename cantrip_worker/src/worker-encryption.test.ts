import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  bytesEqual,
  deriveComponentKey,
  generateAccountMasterKey,
  importHpkeKeyPair,
  clearSensitiveBytes,
  unwrapComponentKeyForWorker,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
  WorkerComponentKeyGrant,
} from "@cantrip/protocol/encryption";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkerEncryptionError,
  WorkerEncryptionService,
  workerEncryptionKeyPath,
} from "./worker-encryption.js";

const ownerId = "owner-worker-encryption";
const timestamp = "2026-08-19T12:00:00.000Z";
const directories: string[] = [];

async function directory(): Promise<string> {
  const created = await mkdtemp(
    path.join(tmpdir(), "cantrip-worker-encryption-"),
  );
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
    label: "Test worker",
    publicKey: registration.publicKey,
    state,
    revision: state === "pending" ? 1 : 2,
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
  id: string,
): EncryptionKeyGrant {
  return {
    id,
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

describe("persistent worker encryption", () => {
  it("binds a protected private-key record to one server and worker", async () => {
    const dataDirectory = await directory();
    const service = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: "https://cantrip.test",
      workerId: "worker-a",
    });
    const pathname = workerEncryptionKeyPath(dataDirectory);
    expect((await stat(pathname)).mode & 0o777).toBe(0o600);
    const record = JSON.parse(await readFile(pathname, "utf8")) as {
      ownerId: string | null;
      privateKey: string;
      workerId: string;
    };
    expect(record).toMatchObject({ ownerId: null, workerId: "worker-a" });
    expect(record.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(
      WorkerEncryptionService.open({
        dataDirectory,
        serverUrl: "https://cantrip.test",
        workerId: "worker-b",
      }),
    ).rejects.toMatchObject({
      code: "identity-mismatch",
    } satisfies Partial<WorkerEncryptionError>);
    await expect(
      WorkerEncryptionService.open({
        allowLoopbackServerPortChange: true,
        dataDirectory,
        serverUrl: "https://cantrip.test:8443",
        workerId: "worker-a",
      }),
    ).rejects.toMatchObject({
      code: "identity-mismatch",
    } satisfies Partial<WorkerEncryptionError>);
    expect(service.status().state).toBe("pending-approval");
  });

  it("reuses a bundled local identity when the server port changes", async () => {
    const dataDirectory = await directory();
    const original = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: "http://127.0.0.1:62586",
      workerId: "desktop-local",
    });
    const originalRegistration = original.registration();

    const reopened = await WorkerEncryptionService.open({
      allowLoopbackServerPortChange: true,
      dataDirectory,
      serverUrl: "http://127.0.0.1:63891",
      workerId: "desktop-local",
    });

    expect(reopened.registration()).toEqual(originalRegistration);
    const record = JSON.parse(
      await readFile(workerEncryptionKeyPath(dataDirectory), "utf8"),
    ) as { serverId: string };
    expect(record.serverId).toBe("http://127.0.0.1");
  });

  it("opens client-created scoped grants, restores after restart, and fails closed", async () => {
    const dataDirectory = await directory();
    const workerId = "worker-a";
    const service = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: "https://cantrip.test",
      workerId,
    });
    const workerPrincipal = principal(service, workerId);
    const accountMasterKey = generateAccountMasterKey();
    const taskKeyV1 = deriveComponentKey({
      accountMasterKey,
      ownerId,
      component: "task-content",
      keyRevision: 1,
    });
    const wrappedV1 = await wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component: "task-content",
      componentKey: taskKeyV1,
      keyRevision: 1,
      workerPublicKey: workerPrincipal.publicKey,
    });
    const grantV1 = grant(
      workerPrincipal.id,
      wrappedV1,
      "11111111-1111-4111-8111-111111111111",
    );
    await service.acceptBootstrap({
      ownerId,
      principal: workerPrincipal,
      grants: [grantV1],
    });
    const openedV1 = service.componentKey("task-content");
    expect(openedV1.keyRevision).toBe(1);
    expect(bytesEqual(openedV1.key, taskKeyV1)).toBe(true);
    expect(() => service.componentKey("chat-content")).toThrowError(
      /does not have an active chat-content/u,
    );

    service.lock();
    const restarted = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: "https://cantrip.test",
      workerId,
    });
    await restarted.acceptBootstrap({
      ownerId,
      principal: workerPrincipal,
      grants: [grantV1],
    });
    expect(
      bytesEqual(restarted.componentKey("task-content").key, taskKeyV1),
    ).toBe(true);

    const taskKeyV2 = deriveComponentKey({
      accountMasterKey,
      ownerId,
      component: "task-content",
      keyRevision: 2,
    });
    const grantV2 = grant(
      workerPrincipal.id,
      await wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component: "task-content",
        componentKey: taskKeyV2,
        keyRevision: 2,
        workerPublicKey: workerPrincipal.publicKey,
      }),
      "22222222-2222-4222-8222-222222222222",
    );
    await restarted.acceptBootstrap({
      ownerId,
      principal: workerPrincipal,
      grants: [grantV1, grantV2],
    });
    expect(restarted.componentKey("task-content").keyRevision).toBe(2);
    expect(
      bytesEqual(restarted.componentKey("task-content").key, taskKeyV2),
    ).toBe(true);
    await expect(
      restarted.acceptBootstrap({
        ownerId,
        principal: workerPrincipal,
        grants: [grantV1],
      }),
    ).rejects.toThrowError(/rolled back/u);
    expect(() => restarted.componentKey("task-content")).toThrowError(
      /does not have an active/u,
    );

    await restarted.acceptBootstrap({
      ownerId,
      principal: principal(restarted, workerId, "revoked"),
      grants: [],
    });
    expect(restarted.status().state).toBe("unavailable");
    expect(() => restarted.componentKey("task-content")).toThrowError(
      /does not have an active/u,
    );
  });

  it("does not let another worker or authentication-secret material open a grant", async () => {
    const workerA = await WorkerEncryptionService.open({
      dataDirectory: await directory(),
      serverUrl: "https://cantrip.test",
      workerId: "worker-a",
    });
    const workerB = await WorkerEncryptionService.open({
      dataDirectory: await directory(),
      serverUrl: "https://cantrip.test",
      workerId: "worker-b",
    });
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "chat-content",
      keyRevision: 1,
    });
    const wrappedForA = await wrapComponentKeyForWorker({
      ownerId,
      workerId: "worker-b",
      component: "chat-content",
      componentKey,
      keyRevision: 1,
      workerPublicKey: workerA.registration().publicKey,
    });
    const workerBPrincipal = principal(workerB, "worker-b");
    await expect(
      workerB.acceptBootstrap({
        ownerId,
        principal: workerBPrincipal,
        grants: [
          grant(
            workerBPrincipal.id,
            wrappedForA,
            "33333333-3333-4333-8333-333333333333",
          ),
        ],
      }),
    ).rejects.toThrowError(/could not be opened/u);
    expect(() => workerB.componentKey("chat-content")).toThrowError(
      /does not have an active/u,
    );

    const authenticationHashBytes = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          "$argon2id$v=19$m=65536,t=3,p=1$database-auth-verifier",
        ),
      ),
    );
    try {
      await expect(async () => {
        const hashKeyPair = await importHpkeKeyPair({
          publicKey: workerA.registration().publicKey,
          privateKey: authenticationHashBytes,
        });
        await unwrapComponentKeyForWorker({
          ownerId,
          grant: wrappedForA,
          workerKeyPair: hashKeyPair,
        });
      }).rejects.toThrowError();
    } finally {
      clearSensitiveBytes(authenticationHashBytes);
    }
  });
});
