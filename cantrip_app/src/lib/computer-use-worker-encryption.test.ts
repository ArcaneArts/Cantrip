import {
  bytesEqual,
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
  unwrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  workerEncryptionComponentScopeSchema,
  type EncryptionKeyGrant,
  type EncryptionKeyGrantCreate,
  type EncryptionPrincipal,
  type WorkerEncryptionRefreshResult,
} from "@cantrip/protocol/encryption";
import { describe, expect, it, vi } from "vitest";

import type { request } from "./api-client";
import { ClientEncryptionService } from "./client-encryption";
import { prepareComputerUseWorkerEncryption } from "./computer-use-worker-encryption";

const timestamp = "2026-09-05T12:00:00.000Z";
const identity = {
  accountId: "owner-a",
  connectionId: "connection-a",
  generation: 1,
  incarnationId: "44444444-4444-4444-8444-444444444444",
  serverId: "server-a",
  serverUrl: "https://server-a.test",
  userId: "owner-a",
};
const encryptionIdentity = {
  ownerId: identity.userId,
  serverId: identity.serverId,
};

async function fixture(contentDomain: "chat" | "task" = "chat") {
  const keyPair = await generateHpkeKeyPair(false);
  let principal: EncryptionPrincipal = {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: identity.userId,
    kind: "worker",
    workerId: "worker-a",
    label: "Synthetic worker",
    publicKey: await publicKeyForPair(keyPair),
    state: "pending",
    revision: 1,
    approvedAt: null,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: encryptionIdentity,
    masterKeyRevision: 2,
  });
  const componentKey = vi.spyOn(service, "componentKey");
  const abort = new AbortController();
  let current = true;
  const grants: EncryptionKeyGrant[] = [];
  let refreshTransform = (value: WorkerEncryptionRefreshResult) => value;
  const respond: typeof request = async (url, init) => {
    if (url.endsWith("/principals")) return [principal];
    if (url.endsWith("/approve")) {
      const body = JSON.parse(init!.body as string) as {
        expectedRevision: number;
      };
      principal = {
        ...principal,
        state: "approved",
        revision: body.expectedRevision + 1,
        approvedAt: timestamp,
      };
      return principal;
    }
    if (url.endsWith("/grants") && init?.method === "GET") return [...grants];
    if (url.endsWith("/grants") && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as EncryptionKeyGrantCreate;
      const grant: EncryptionKeyGrant = {
        ...body,
        id: crypto.randomUUID(),
        principalId: principal.id,
        ownerId: identity.userId,
        state: "active",
        revision: 1,
        revokedAt: null,
        revokedReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      grants.push(grant);
      return grant;
    }
    if (url.endsWith("/encryption/refresh"))
      return refreshTransform({
        component: "client-control-content",
        keyRevision: 2,
        status: {
          supported: true,
          state: "ready",
          principalId: principal.id,
          grants: grants.map(({ component, keyRevision }) => ({
            component: workerEncryptionComponentScopeSchema.parse(component),
            keyRevision,
          })),
          lastSyncedAt: timestamp,
          error: null,
        },
      });
    throw new Error(`Unexpected synthetic request: ${url}`);
  };
  let handler = respond;
  const send = vi.fn<typeof request>((...args) => handler(...args));
  const input: Parameters<typeof prepareComputerUseWorkerEncryption>[0] = {
    baseUrl: identity.serverUrl,
    identity,
    lease: {
      leaseId: "22222222-2222-4222-8222-222222222222",
      chatId: "chat-a",
      workerId: "worker-a",
      generation: 1,
      contentDomain,
    },
    service,
    keyRevision: 2,
    signal: abort.signal,
    assertCurrent: () => {
      if (!current) throw new Error("Identity changed");
    },
    request: send,
  };
  return {
    input,
    service,
    componentKey,
    send,
    respond,
    grants,
    keyPair,
    abort,
    setCurrent(value: boolean) {
      current = value;
    },
    setHandler(value: typeof handler) {
      handler = value;
    },
    setPrincipal(value: Partial<EncryptionPrincipal>) {
      principal = { ...principal, ...value };
    },
    setRefresh(value: typeof refreshTransform) {
      refreshTransform = value;
    },
  };
}

describe("computer-use scoped worker encryption", () => {
  it.each(["chat", "task"] as const)(
    "creates real wrapped keys for exactly the %s preview paths and confirms worker refresh",
    async (domain) => {
      const f = await fixture(domain);
      await prepareComputerUseWorkerEncryption(f.input);
      expect(f.grants.map(({ component }) => component)).toEqual([
        "client-control-content",
        "interaction-content",
        `${domain}-content`,
      ]);
      for (const grant of f.grants) {
        if (grant.wrappedKey.purpose !== "worker-component-key")
          throw new Error("Wrong key purpose");
        const opened = await unwrapComponentKeyForWorker({
          ownerId: identity.userId,
          workerKeyPair: f.keyPair,
          grant: grant.wrappedKey,
        });
        const expected = f.service.componentKey({
          component: grant.component,
          identity: encryptionIdentity,
          keyRevision: 2,
        });
        expect(bytesEqual(opened, expected)).toBe(true);
        opened.fill(0);
        expected.fill(0);
      }
      for (const [url, options, safety] of f.send.mock.calls) {
        expect(url.startsWith("https://server-a.test/api/")).toBe(true);
        expect(options?.signal).toBe(f.abort.signal);
        expect(safety).toEqual({
          expectedIdentity: identity,
          allowCsrfRecovery: false,
        });
      }
      expect(f.send.mock.calls.at(-1)?.[0]).toBe(
        "https://server-a.test/api/workers/worker-a/encryption/refresh",
      );
      expect(
        f.componentKey.mock.results.every(({ value }) =>
          value.every((byte: number) => byte === 0),
        ),
      ).toBe(true);
      await prepareComputerUseWorkerEncryption(f.input);
      expect(f.grants).toHaveLength(3);
    },
  );

  it.each([
    "missing-interaction",
    "wrong-revision",
    "wrong-principal",
    "unavailable",
  ] as const)("rejects actual refresh evidence with %s", async (defect) => {
    const f = await fixture();
    f.setRefresh((value) => {
      if (defect === "wrong-revision") return { ...value, keyRevision: 3 };
      if (defect === "missing-interaction")
        return {
          ...value,
          status: {
            ...value.status,
            grants: value.status.grants.filter(
              ({ component }) => component !== "interaction-content",
            ),
          },
        };
      if (defect === "wrong-principal")
        return {
          ...value,
          status: {
            ...value.status,
            principalId: "33333333-3333-4333-8333-333333333333",
          },
        };
      return {
        ...value,
        status: { ...value.status, state: "error", error: "Synthetic failure" },
      };
    });
    await expect(prepareComputerUseWorkerEncryption(f.input)).rejects.toThrow(
      "has not loaded",
    );
  });

  it.each(["ownerId", "workerId"] as const)(
    "never approves a principal for another %s",
    async (field) => {
      const f = await fixture();
      f.setPrincipal({ [field]: "other" });
      await expect(prepareComputerUseWorkerEncryption(f.input)).rejects.toThrow(
        "not registered",
      );
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.componentKey).not.toHaveBeenCalled();
    },
  );

  it.each(["abort", "identity"] as const)(
    "stops all follow-on requests and key access after %s during an awaited principal approval",
    async (change) => {
      const f = await fixture();
      f.setHandler(async (...args) => {
        const response = await f.respond(...args);
        if (args[0].endsWith("/approve")) {
          if (change === "abort") f.abort.abort(new Error("Stopped"));
          else f.setCurrent(false);
        }
        return response;
      });
      await expect(prepareComputerUseWorkerEncryption(f.input)).rejects.toThrow(
        change === "abort" ? "Stopped" : "Identity changed",
      );
      expect(f.send.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
        "principals",
        "approve",
      ]);
      expect(f.componentKey).not.toHaveBeenCalled();
    },
  );

  it("clears the wrapped component's borrowed key and never starts another scope after cancellation during create", async () => {
    const f = await fixture();
    f.setHandler(async (...args) => {
      const response = await f.respond(...args);
      if (args[0].endsWith("/grants") && args[1]?.method === "POST")
        f.abort.abort(new Error("Stopped"));
      return response;
    });
    await expect(prepareComputerUseWorkerEncryption(f.input)).rejects.toThrow(
      "Stopped",
    );
    expect(f.grants.map(({ component }) => component)).toEqual([
      "client-control-content",
    ]);
    expect(f.componentKey).toHaveBeenCalledTimes(1);
    expect(
      f.componentKey.mock.results[0]?.value.every((byte: number) => byte === 0),
    ).toBe(true);
    expect(f.send.mock.calls.some(([url]) => url.endsWith("/refresh"))).toBe(
      false,
    );
  });

  it("rejects stored grants whose wrapped recipient is another worker", async () => {
    const f = await fixture();
    await prepareComputerUseWorkerEncryption(f.input);
    const grant = f.grants[0]!;
    if (grant.wrappedKey.purpose !== "worker-component-key")
      throw new Error("Wrong key purpose");
    grant.wrappedKey = { ...grant.wrappedKey, workerId: "other-worker" };
    f.send.mockClear();
    f.componentKey.mockClear();
    await expect(prepareComputerUseWorkerEncryption(f.input)).rejects.toThrow(
      "another principal",
    );
    expect(f.componentKey).not.toHaveBeenCalled();
    expect(f.send.mock.calls.some(([url]) => url.endsWith("/refresh"))).toBe(
      false,
    );
  });
});
