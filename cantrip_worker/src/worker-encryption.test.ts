import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherServerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fetchSequence(...responses: Array<Promise<Response>>): typeof fetch {
  let index = 0;
  return (async () => {
    const response = responses[index++];
    if (!response) throw new Error("Unexpected bootstrap request.");
    return response;
  }) as typeof fetch;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true })),
  );
});

describe("persistent worker encryption", () => {
  it("binds a protected private-key record to one transport and worker", async () => {
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
      serverId: string | null;
      serverUrl: string;
      version: number;
      workerId: string;
    };
    expect(record).toMatchObject({
      ownerId: null,
      serverId: null,
      serverUrl: "https://cantrip.test",
      version: 2,
      workerId: "worker-a",
    });
    expect(record.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(() => service.serverIdentity()).toThrowError(
      /has not verified the logical server identity/u,
    );
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

  it("fetches bootstrap over the transport URL but exposes the client server UUID", async () => {
    const workerId = "worker-a";
    const service = await WorkerEncryptionService.open({
      dataDirectory: await directory(),
      serverUrl: "http://127.0.0.1:4310",
      workerId,
    });
    const workerPrincipal = principal(service, workerId, "pending");
    let requestedUrl: string | null = null;

    await service.refresh({
      credential: "worker-credential",
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json({
          serverId,
          ownerId,
          principal: workerPrincipal,
          grants: [],
        });
      },
    });

    expect(requestedUrl).toBe(
      "http://127.0.0.1:4310/api/internal/workers/encryption/bootstrap",
    );
    expect(service.serverIdentity()).toBe(serverId);
  });

  it("uses the bootstrapped server UUID across loopback port changes and restarts", async () => {
    const dataDirectory = await directory();
    const original = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: "http://127.0.0.1:62586",
      workerId: "desktop-local",
    });
    const originalRegistration = original.registration();
    const workerPrincipal = principal(original, "desktop-local", "pending");
    await original.acceptBootstrap({
      serverId,
      ownerId,
      principal: workerPrincipal,
      grants: [],
    });
    expect(original.serverIdentity()).toBe(serverId);

    const reopened = await WorkerEncryptionService.open({
      allowLoopbackServerPortChange: true,
      dataDirectory,
      serverUrl: "http://127.0.0.1:63891",
      workerId: "desktop-local",
    });

    expect(reopened.registration()).toEqual(originalRegistration);
    expect(() => reopened.serverIdentity()).toThrowError(
      /has not verified the logical server identity/u,
    );
    await reopened.acceptBootstrap({
      serverId,
      ownerId,
      principal: workerPrincipal,
      grants: [],
    });
    expect(reopened.serverIdentity()).toBe(serverId);
    const record = JSON.parse(
      await readFile(workerEncryptionKeyPath(dataDirectory), "utf8"),
    ) as { serverId: string; serverUrl: string; version: number };
    expect(record).toMatchObject({
      version: 2,
      serverUrl: "http://127.0.0.1",
      serverId,
    });
  });

  it("rebinds a development portless loopback transport only after verified bootstrap", async () => {
    const dataDirectory = await directory();
    const pathname = workerEncryptionKeyPath(dataDirectory);
    const workerId = "desktop-local";
    const original = await WorkerEncryptionService.open({
      allowLoopbackServerPortChange: true,
      dataDirectory,
      serverUrl: "http://127.0.0.1:62586",
      workerId,
    });
    const workerPrincipal = principal(original, workerId, "pending");
    await original.acceptBootstrap({
      serverId,
      ownerId,
      principal: workerPrincipal,
      grants: [],
    });
    expect(JSON.parse(await readFile(pathname, "utf8"))).toMatchObject({
      serverUrl: "http://127.0.0.1",
      serverId,
    });

    const transitioned = await WorkerEncryptionService.open({
      allowLoopbackServerPortChange: false,
      dataDirectory,
      serverUrl: "http://127.0.0.1:63891",
      workerId,
    });
    expect(transitioned.registration()).toEqual(original.registration());
    expect(JSON.parse(await readFile(pathname, "utf8"))).toMatchObject({
      serverUrl: "http://127.0.0.1",
      serverId,
    });

    await expect(
      transitioned.refresh({
        credential: "unavailable-worker-credential",
        fetch: async () => {
          throw new Error("server unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "server-unavailable" });
    expect(JSON.parse(await readFile(pathname, "utf8"))).toMatchObject({
      serverUrl: "http://127.0.0.1",
      serverId,
    });

    await transitioned.acceptBootstrap({
      serverId,
      ownerId,
      principal: workerPrincipal,
      grants: [],
    });
    expect(JSON.parse(await readFile(pathname, "utf8"))).toMatchObject({
      serverUrl: "http://127.0.0.1:63891",
      serverId,
    });
    await expect(
      WorkerEncryptionService.open({
        allowLoopbackServerPortChange: false,
        dataDirectory,
        serverUrl: "http://127.0.0.1:64000",
        workerId,
      }),
    ).rejects.toMatchObject({
      code: "identity-mismatch",
    } satisfies Partial<WorkerEncryptionError>);
    await expect(
      WorkerEncryptionService.open({
        allowLoopbackServerPortChange: false,
        dataDirectory,
        serverUrl: "http://localhost:63891",
        workerId,
      }),
    ).rejects.toMatchObject({
      code: "identity-mismatch",
    } satisfies Partial<WorkerEncryptionError>);
  });

  it("defers legacy migration until an authoritative bootstrap succeeds", async () => {
    const dataDirectory = await directory();
    const pathname = workerEncryptionKeyPath(dataDirectory);
    const original = await WorkerEncryptionService.open({
      allowLoopbackServerPortChange: true,
      dataDirectory,
      serverUrl: "http://127.0.0.1:62586",
      workerId: "desktop-local",
    });
    const current = JSON.parse(await readFile(pathname, "utf8")) as Record<
      string,
      unknown
    >;
    const { serverUrl, ...legacy } = current;
    await writeFile(
      pathname,
      `${JSON.stringify({
        ...legacy,
        version: 1,
        serverId: serverUrl,
      })}\n`,
      { mode: 0o600 },
    );

    const migrated = await WorkerEncryptionService.open({
      allowLoopbackServerPortChange: true,
      dataDirectory,
      serverUrl: "http://127.0.0.1:63891",
      workerId: "desktop-local",
    });

    expect(migrated.registration()).toEqual(original.registration());
    expect(() => migrated.serverIdentity()).toThrowError(
      /has not verified the logical server identity/u,
    );
    expect(JSON.parse(await readFile(pathname, "utf8"))).toMatchObject({
      version: 1,
      serverId: "http://127.0.0.1",
    });
    await expect(
      migrated.refresh({
        credential: "unavailable-worker-credential",
        fetch: async () => {
          throw new Error("server unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "server-unavailable" });
    expect(JSON.parse(await readFile(pathname, "utf8"))).toMatchObject({
      version: 1,
      serverId: "http://127.0.0.1",
    });

    await migrated.acceptBootstrap({
      serverId,
      ownerId,
      principal: principal(migrated, "desktop-local", "pending"),
      grants: [],
    });
    expect(JSON.parse(await readFile(pathname, "utf8"))).toMatchObject({
      version: 2,
      serverUrl: "http://127.0.0.1",
      serverId,
    });
  });

  it("ignores older pending and failing refreshes after a newer ready bootstrap", async () => {
    const dataDirectory = await directory();
    const workerId = "worker-a";
    const service = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: "https://cantrip.test",
      workerId,
    });
    const approvedPrincipal = principal(service, workerId);
    const componentKey = deriveComponentKey({
      accountMasterKey: generateAccountMasterKey(),
      ownerId,
      component: "task-content",
      keyRevision: 1,
    });
    const readyGrant = grant(
      approvedPrincipal.id,
      await wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component: "task-content",
        componentKey,
        keyRevision: 1,
        workerPublicKey: approvedPrincipal.publicKey,
      }),
      "44444444-4444-4444-8444-444444444444",
    );
    const olderPending = deferred<Response>();
    const newerReady = deferred<Response>();
    const firstFetch = fetchSequence(olderPending.promise, newerReady.promise);
    const olderRefresh = service.refresh({
      credential: "worker-credential",
      fetch: firstFetch,
    });
    const newerRefresh = service.refresh({
      credential: "worker-credential",
      fetch: firstFetch,
    });

    newerReady.resolve(
      Response.json({
        serverId,
        ownerId,
        principal: approvedPrincipal,
        grants: [readyGrant],
      }),
    );
    await expect(newerRefresh).resolves.toMatchObject({ state: "ready" });
    olderPending.resolve(
      Response.json({
        serverId: otherServerId,
        ownerId,
        principal: principal(service, workerId, "pending"),
        grants: [],
      }),
    );
    await expect(olderRefresh).resolves.toMatchObject({ state: "ready" });
    expect(service.status().state).toBe("ready");
    expect(service.serverIdentity()).toBe(serverId);
    expect(
      bytesEqual(service.componentKey("task-content").key, componentKey),
    ).toBe(true);

    const olderFailure = deferred<Response>();
    const latestReady = deferred<Response>();
    const secondFetch = fetchSequence(
      olderFailure.promise,
      latestReady.promise,
    );
    const failingRefresh = service.refresh({
      credential: "worker-credential",
      fetch: secondFetch,
    });
    const readyRefresh = service.refresh({
      credential: "worker-credential",
      fetch: secondFetch,
    });
    latestReady.resolve(
      Response.json({
        serverId,
        ownerId,
        principal: approvedPrincipal,
        grants: [readyGrant],
      }),
    );
    await expect(readyRefresh).resolves.toMatchObject({ state: "ready" });
    olderFailure.resolve(
      Response.json({ error: "stale bootstrap rejected" }, { status: 409 }),
    );
    await expect(failingRefresh).rejects.toMatchObject({
      code: "server-unavailable",
    });
    expect(service.status().state).toBe("ready");
    expect(service.serverIdentity()).toBe(serverId);
    expect(
      bytesEqual(service.componentKey("task-content").key, componentKey),
    ).toBe(true);
    expect(
      JSON.parse(
        await readFile(workerEncryptionKeyPath(dataDirectory), "utf8"),
      ),
    ).toMatchObject({
      serverId,
    });
  });

  it("rejects a different logical server at the same transport origin", async () => {
    const dataDirectory = await directory();
    const workerId = "worker-a";
    const original = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: "https://cantrip.test",
      workerId,
    });
    const workerPrincipal = principal(original, workerId, "pending");
    await original.acceptBootstrap({
      serverId,
      ownerId,
      principal: workerPrincipal,
      grants: [],
    });
    const restarted = await WorkerEncryptionService.open({
      dataDirectory,
      serverUrl: "https://cantrip.test",
      workerId,
    });

    await expect(
      restarted.acceptBootstrap({
        serverId: otherServerId,
        ownerId,
        principal: workerPrincipal,
        grants: [],
      }),
    ).rejects.toMatchObject({
      code: "identity-mismatch",
    } satisfies Partial<WorkerEncryptionError>);
    expect(() => restarted.serverIdentity()).toThrowError(
      /has not verified the logical server identity/u,
    );
    expect(
      JSON.parse(
        await readFile(workerEncryptionKeyPath(dataDirectory), "utf8"),
      ),
    ).toMatchObject({ serverId });
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
      serverId,
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
      serverId,
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
      serverId,
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
        serverId,
        ownerId,
        principal: workerPrincipal,
        grants: [grantV1],
      }),
    ).rejects.toThrowError(/rolled back/u);
    expect(() => restarted.componentKey("task-content")).toThrowError(
      /does not have an active/u,
    );

    await restarted.acceptBootstrap({
      serverId,
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
        serverId,
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
