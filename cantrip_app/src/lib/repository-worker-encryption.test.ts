import {
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
} from "@cantrip/crypto";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
  WorkerEncryptionRefreshResult,
  WorkerEncryptionStatus,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientEncryptionService } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";
import {
  ensureRepositoryWorkerEncryption,
  type RepositoryWorkerDescriptor,
} from "./repository-worker-encryption";
import type { WorkerGrantApi } from "./worker-encryption-grants";

const identity = { ownerId: "owner-a", serverId: "server-a" };
const timestamp = "2026-10-17T00:00:00.000Z";
const services: ClientEncryptionService[] = [];
function session(ownerId = identity.ownerId, serverId = identity.serverId) {
  setClientSession({
    authMode: "accounts",
    csrfToken: "q".repeat(32),
    expiresAt: null,
    serverId,
    user: {
      id: ownerId,
      kind: "account",
      displayName: "QA",
      email: "qa@example.test",
      role: "member",
    },
  });
}
afterEach(() => {
  for (const service of services.splice(0)) service.lock();
  clearClientSession();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  session();
  const service = new ClientEncryptionService();
  services.push(service);
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity,
    masterKeyRevision: 1,
  });
  let principal: EncryptionPrincipal = {
    id: crypto.randomUUID(),
    ownerId: identity.ownerId,
    workerId: "worker-a",
    kind: "worker",
    label: "QA",
    publicKey: await publicKeyForPair(await generateHpkeKeyPair(false)),
    state: "pending",
    revision: 1,
    approvedAt: null,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let registered = false;
  const grants: EncryptionKeyGrant[] = [];
  const api = {
    listPrincipals: vi.fn(async () => (registered ? [principal] : [])),
    approvePrincipal: vi.fn(async () => {
      principal = {
        ...principal,
        state: "approved",
        revision: 2,
        approvedAt: timestamp,
      };
      return principal;
    }),
    listGrants: vi.fn(async () => grants),
    createGrant: vi.fn<WorkerGrantApi["createGrant"]>(
      async (principalId, input) => {
        const grant: EncryptionKeyGrant = {
          id: crypto.randomUUID(),
          ownerId: identity.ownerId,
          principalId,
          ...input,
          state: "active",
          revision: 1,
          revokedAt: null,
          revokedReason: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        grants.push(grant);
        return grant;
      },
    ),
    revokeGrant: vi.fn<WorkerGrantApi["revokeGrant"]>(),
  } satisfies WorkerGrantApi;
  const status = (
    state: WorkerEncryptionStatus["state"] = "pending-approval",
  ): WorkerEncryptionStatus => ({
    supported: true,
    state,
    principalId: principal.id,
    grants:
      state === "ready"
        ? [{ component: "repository-content", keyRevision: 1 }]
        : [],
    lastSyncedAt: timestamp,
    error: null,
  });
  const result = (
    value: WorkerEncryptionStatus,
  ): WorkerEncryptionRefreshResult => ({
    component: "repository-content",
    keyRevision: 1,
    status: value,
  });
  const refresh = vi.fn(async () => {
    registered = true;
    return result(status(grants.length ? "ready" : "pending-approval"));
  });
  const worker: RepositoryWorkerDescriptor = {
    online: true,
    workerId: "worker-a",
    encryption: {
      ...status("error"),
      error:
        "Worker encryption identity conflicts with the registered principal.",
    },
  };
  return {
    api,
    service,
    worker,
    refresh,
    status,
    result,
    grants,
    register: () => {
      registered = true;
    },
  };
}

describe("repository worker encryption bootstrap", () => {
  it("refreshes failed first registration before granting and activates the scoped key", async () => {
    const f = await fixture();
    await expect(ensureRepositoryWorkerEncryption(f)).resolves.toEqual(
      f.status("ready"),
    );
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      f.api.listPrincipals.mock.invocationCallOrder[0]!,
    );
    expect(f.api.approvePrincipal).toHaveBeenCalledOnce();
    expect(f.grants).toHaveLength(1);
    expect(f.grants[0]).toMatchObject({
      component: "repository-content",
      keyRevision: 1,
      wrappedKey: {
        purpose: "worker-component-key",
        workerId: f.worker.workerId,
      },
    });
  });

  it("retries a joined pre-grant refresh once after that refresh completes", async () => {
    const f = await fixture();
    f.register();
    f.worker.encryption = { ...f.status(), error: null };
    const oldRefresh = deferred<WorkerEncryptionRefreshResult>();
    f.refresh.mockImplementationOnce(() => oldRefresh.promise);
    const operation = ensureRepositoryWorkerEncryption(f);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    expect(f.grants).toHaveLength(1);
    oldRefresh.resolve(f.result(f.status()));
    await expect(operation).resolves.toEqual(f.status("ready"));
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.api.createGrant).toHaveBeenCalledOnce();
  });

  it("bounds a missing-grant retry without issuing replacement grants", async () => {
    const f = await fixture();
    f.register();
    f.worker.encryption = { ...f.status(), error: null };
    f.refresh.mockResolvedValue(f.result(f.status()));
    await expect(ensureRepositoryWorkerEncryption(f)).rejects.toMatchObject({
      state: "pending-approval",
    });
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.api.createGrant).toHaveBeenCalledOnce();
  });

  it("propagates an actual refresh rejection without retrying or granting", async () => {
    const f = await fixture();
    const denied = new Error("Unauthorized");
    f.refresh.mockRejectedValue(denied);
    await expect(ensureRepositoryWorkerEncryption(f)).rejects.toBe(denied);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.api.listPrincipals).not.toHaveBeenCalled();
  });

  it.each(["cached", "refreshed"])(
    "does not authorize a %s revoked worker",
    async (when) => {
      const f = await fixture();
      const revoked = {
        ...f.status("unavailable"),
        error: "Worker encryption authorization was revoked.",
      };
      if (when === "cached") f.worker.encryption = revoked;
      else f.refresh.mockResolvedValue(f.result(revoked));
      await expect(ensureRepositoryWorkerEncryption(f)).rejects.toMatchObject({
        state: "revoked",
      });
      expect(f.refresh).toHaveBeenCalledTimes(when === "cached" ? 0 : 1);
      expect(f.api.createGrant).not.toHaveBeenCalled();
    },
  );

  it("does not retry a replaced worker identity after granting", async () => {
    const f = await fixture();
    f.register();
    f.worker.encryption = { ...f.status(), error: null };
    f.refresh.mockResolvedValue(
      f.result({ ...f.status(), principalId: crypto.randomUUID() }),
    );
    await expect(ensureRepositoryWorkerEncryption(f)).rejects.toMatchObject({
      state: "stale",
    });
    expect(f.refresh).toHaveBeenCalledOnce();
  });

  it.each(["owner", "server", "lock", "revision", "session-incarnation"])(
    "rejects %s replacement during bootstrap before granting",
    async (change) => {
      const f = await fixture();
      const pending = deferred<WorkerEncryptionRefreshResult>();
      f.refresh.mockImplementationOnce(() => pending.promise);
      const operation = ensureRepositoryWorkerEncryption(f);
      const rejected = operation.then(
        () => ({ state: "unexpected-success" }),
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
      if (change === "owner") session("owner-b");
      if (change === "server") session(identity.ownerId, "server-b");
      if (change === "lock") f.service.lock();
      if (change === "revision")
        f.service.setAccountMasterKey({
          accountMasterKey: generateAccountMasterKey(),
          identity,
          masterKeyRevision: 2,
        });
      if (change === "session-incarnation") {
        clearClientSession();
        session();
      }
      pending.resolve(f.result(f.status()));
      await expect(rejected).resolves.toMatchObject({ state: "locked" });
      expect(f.api.listPrincipals).not.toHaveBeenCalled();
    },
  );

  it("rejects identity replacement while grant discovery is pending", async () => {
    const f = await fixture();
    f.register();
    f.worker.encryption = { ...f.status(), error: null };
    const pending = deferred<EncryptionPrincipal[]>();
    f.api.listPrincipals.mockImplementationOnce(() => pending.promise);
    const operation = ensureRepositoryWorkerEncryption(f);
    const rejected = operation.then(
      () => ({ state: "unexpected-success" }),
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(f.api.listPrincipals).toHaveBeenCalledOnce());
    session("owner-b");
    pending.resolve(await f.api.listPrincipals());
    await expect(rejected).resolves.toMatchObject({ state: "locked" });
    expect(f.api.approvePrincipal).not.toHaveBeenCalled();
    expect(f.api.createGrant).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("rejects a ready result after the client identity changes", async () => {
    const f = await fixture();
    f.register();
    f.worker.encryption = { ...f.status(), error: null };
    const pending = deferred<WorkerEncryptionRefreshResult>();
    f.refresh.mockImplementationOnce(() => pending.promise);
    const operation = ensureRepositoryWorkerEncryption(f);
    const rejected = operation.then(
      () => ({ state: "unexpected-success" }),
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    session(identity.ownerId, "server-b");
    pending.resolve(f.result(f.status("ready")));
    await expect(rejected).resolves.toMatchObject({ state: "locked" });
    expect(f.refresh).toHaveBeenCalledOnce();
  });

  it("stops before creating a grant when identity changes during grant lookup", async () => {
    const f = await fixture();
    f.register();
    f.worker.encryption = f.status();
    const pending = deferred<EncryptionKeyGrant[]>();
    f.api.listGrants.mockImplementationOnce(() => pending.promise);
    const operation = ensureRepositoryWorkerEncryption(f);
    const rejected = operation.catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.api.listGrants).toHaveBeenCalledOnce());
    session("owner-b");
    pending.resolve([]);
    await expect(rejected).resolves.toMatchObject({ state: "locked" });
    expect(f.api.createGrant).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it.each(["revoked", "rejected", "wrong-key", "replaced-ready-principal"])(
    "does not retry %s activation after granting",
    async (failure) => {
      const f = await fixture();
      f.register();
      f.worker.encryption = f.status();
      if (failure === "rejected")
        f.refresh.mockRejectedValue(new Error("Unauthorized"));
      else if (failure === "revoked")
        f.refresh.mockResolvedValue(
          f.result({
            ...f.status("unavailable"),
            error: "Worker encryption authorization was revoked.",
          }),
        );
      else if (failure === "wrong-key")
        f.refresh.mockResolvedValue({
          ...f.result(f.status("ready")),
          keyRevision: 2,
        });
      else
        f.refresh.mockResolvedValue(
          f.result({ ...f.status("ready"), principalId: crypto.randomUUID() }),
        );
      const expected =
        failure === "rejected"
          ? { message: "Unauthorized" }
          : { state: failure === "revoked" ? "revoked" : "stale" };
      await expect(ensureRepositoryWorkerEncryption(f)).rejects.toMatchObject(
        expected,
      );
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.api.createGrant).toHaveBeenCalledOnce();
    },
  );

  it("keeps a ready worker's existing grant without issuing more authority", async () => {
    const f = await fixture();
    f.worker.encryption = f.status("ready");
    await expect(ensureRepositoryWorkerEncryption(f)).resolves.toEqual(
      f.worker.encryption,
    );
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.api.listPrincipals).not.toHaveBeenCalled();
  });
});
