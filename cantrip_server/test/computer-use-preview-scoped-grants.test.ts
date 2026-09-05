import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptChatMessageProtectedContent,
  decryptTaskMessageProtectedContent,
  decryptEndpointContentPayload,
  deriveComponentKey,
  encryptEndpointContentPayload,
  generateAccountMasterKey,
  openComputerUseResult,
  protectComputerUseRequest,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/src/index.js";
import { agentActivitySchema } from "@cantrip/protocol";
import { computerUseHttpResultSchema } from "@cantrip/protocol/computer-use";
import { cuaPreviewLeaseSchema } from "@cantrip/protocol/computer-use-preview";
import type {
  EncryptionKeyGrant,
  EncryptionPrincipal,
  WorkerEncryptionComponentScope,
} from "@cantrip/protocol/encryption";
import { encryptionKeyGrantCreateSchema } from "@cantrip/protocol/encryption";
import { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { ClientEncryptionService } from "../../cantrip_app/src/lib/client-encryption";
import {
  createComputerUseClient,
  type ComputerUseClientDependencies,
} from "../../cantrip_app/src/lib/computer-use-client";
import { createComputerUsePreviewFixture } from "./support/computer-use-preview-fixture.js";

vi.mock("../../cantrip_app/src/lib/api-client", () => ({
  request: () => {
    throw new Error("Unbound application request.");
  },
}));
vi.mock("../../cantrip_app/src/lib/client-session", () => ({
  clientSessionIdentityMatches: () => false,
  getClientSessionIdentitySnapshot: () => null,
  onClientSessionIdentityChanged: () => () => {},
}));
vi.mock("../../cantrip_app/src/lib/server-connections", () => ({
  getActiveServerUrl: () => {
    throw new Error("Unbound application server.");
  },
}));
vi.mock("../../cantrip_app/src/lib/client-log-relay", () => ({
  clientLogger: { event: () => {} },
  operationalErrorMetadata: () => ({}),
}));

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Actual generated test-only worker principal and separately derived component
 * keys. No application profile, stored user grants, or native helper is used. */
async function scopedWorker() {
  const directory = await mkdtemp(path.join(tmpdir(), "cua-scoped-grants-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ownerId = "fixture-owner";
  const serverId = randomUUID();
  const workerId = "fixture-worker";
  const service = await WorkerEncryptionService.open({
    dataDirectory: directory,
    serverUrl: "https://fixture.invalid",
    workerId,
  });
  cleanup.push(() => service.lock());
  const registration = service.registration();
  const timestamp = new Date().toISOString();
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: "Scoped preview regression worker",
    publicKey: registration.publicKey,
    state: "approved",
    revision: 2,
    approvedAt: timestamp,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const masterKey = generateAccountMasterKey();
  cleanup.push(() => {
    masterKey.fill(0);
  });
  const keys = new Map<WorkerEncryptionComponentScope, Uint8Array>();
  const grants: EncryptionKeyGrant[] = [];
  async function authorize(component: WorkerEncryptionComponentScope) {
    const key = deriveComponentKey({
      accountMasterKey: masterKey,
      ownerId,
      component,
      keyRevision: 1,
    });
    keys.set(component, key);
    cleanup.push(() => {
      key.fill(0);
    });
    const wrappedKey = await wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component,
      componentKey: key,
      keyRevision: 1,
      workerPublicKey: registration.publicKey,
    });
    grants.push({
      id: randomUUID(),
      ownerId,
      principalId: principal.id,
      component,
      keyRevision: 1,
      wrappedKey,
      state: "active",
      revision: 1,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await service.acceptBootstrap({ serverId, ownerId, principal, grants });
  }
  await authorize("client-control-content");
  return {
    service,
    keys,
    authorize,
    ownerId,
    serverId,
    workerId,
    masterKey,
    principal,
    grants,
  };
}

describe("idle preview history with actual scoped worker grants", () => {
  it.each(["chat", "task"] as const)(
    "%s preview requires its own history grant before its first operation can publish Trajectory",
    async (domain) => {
      const worker = await scopedWorker();
      const historyScope = domain === "chat" ? "chat-content" : "task-content";
      const otherHistoryScope =
        domain === "chat" ? "task-content" : "chat-content";
      const clientControlKey = worker.keys.get("client-control-content")!;
      const listObservations = vi.fn(() => ({ sources: [] }));
      const f = createComputerUsePreviewFixture({
        binary: "/synthetic/never-launch-for-agent-source-list",
        permissionProfile: ":yolo",
        scopedEncryption: { service: worker.service, clientControlKey },
        context: {
          experience: domain === "chat" ? "agent" : "task",
          status: "idle",
          threadId: null,
        },
        agentObservations: {
          listObservations,
          readObservation: () => {
            throw new Error("No observation was requested.");
          },
        },
      });
      cleanup.push(() => f.close());
      const keyAccess = vi.spyOn(worker.service, "componentKey");
      const opened = await f.app.inject({
        method: "POST",
        url: `/api/chats/${f.credentials.chatId}/computer-use/preview`,
        payload: {},
      });
      expect(opened.statusCode).toBe(200);
      const lease = cuaPreviewLeaseSchema.parse(opened.json());
      expect(lease.contentDomain).toBe(domain);
      expect(keyAccess).not.toHaveBeenCalled();
      expect(f.launchCount).toBe(0);

      async function perform() {
        const context = {
          serverId: f.credentials.serverId,
          workerId: f.credentials.workerId,
          chatId: f.credentials.chatId,
          operationId: randomUUID(),
          operation: "agent.sources.list" as const,
          previewLeaseId: lease.leaseId,
        };
        const request = await protectComputerUseRequest({
          context,
          request: { operation: "agent.sources.list" },
          seal: (context, plaintext) =>
            encryptEndpointContentPayload({
              ownerId: worker.ownerId,
              context,
              plaintext,
              keyRevision: 1,
              componentKey: clientControlKey,
            }),
        });
        const response = await f.app.inject({
          method: "POST",
          url: `/api/chats/${f.credentials.chatId}/computer-use/operation`,
          payload: request,
        });
        return { response, context };
      }

      // Reproduce the live failure: endpoint crypto and source listing succeed,
      // but the first protected history publication has no authorized key.
      const missing = await perform();
      expect(missing.response.statusCode).toBe(502);
      expect(listObservations).toHaveBeenCalledTimes(1);
      expect(f.chatActivities.size + f.taskActivities.size).toBe(0);
      const historyCalls = keyAccess.mock.calls.flatMap((args, index) =>
        args[0] === historyScope ? [keyAccess.mock.results[index]!] : [],
      );
      expect(historyCalls).toHaveLength(1);
      expect(historyCalls[0]!.type).toBe("throw");
      expect(historyCalls[0]!.value.code).toBe("missing-scope");
      expect(historyCalls[0]!.value.message).toContain(historyScope);
      expect(f.launchCount).toBe(0);

      // A real, valid grant for the opposite history domain cannot substitute.
      await worker.authorize(otherHistoryScope);
      expect((await perform()).response.statusCode).toBe(502);
      expect(f.chatActivities.size + f.taskActivities.size).toBe(0);

      // Authorize and bootstrap the actual history key without starting an
      // agent turn, recreating the lease, or changing the native execution path.
      await worker.authorize(historyScope);
      const success = await perform();
      expect(success.response.statusCode).toBe(200);
      const envelope = computerUseHttpResultSchema.parse(
        success.response.json(),
      );
      const result = await openComputerUseResult({
        context: success.context,
        opaque: envelope.response,
        chunks: envelope.chunks,
        open: (context, opaque) =>
          decryptEndpointContentPayload({
            ownerId: worker.ownerId,
            context,
            opaque,
            componentKey: clientControlKey,
            keyRevision: 1,
          }),
      });
      expect(result.result).toMatchObject({
        status: "ok",
        data: { sources: [] },
      });
      const records = domain === "chat" ? f.chatActivities : f.taskActivities;
      const otherRecords =
        domain === "chat" ? f.taskActivities : f.chatActivities;
      expect(records.size).toBe(1);
      expect(otherRecords.size).toBe(0);
      const message = [...records.values()][0]!;
      const decrypt =
        domain === "chat"
          ? decryptChatMessageProtectedContent
          : decryptTaskMessageProtectedContent;
      const content = await decrypt({
        ownerId: worker.ownerId,
        componentKey: worker.keys.get(historyScope)!,
        messageId: message.id,
        keyRevision: 1,
        encrypted: message.protectedContent,
        publicClassification: message.classification,
      });
      expect(content.content).toHaveLength(1);
      const part = content.content[0]!;
      expect(part.type).toBe("activity");
      if (part.type !== "activity")
        throw new Error("Expected protected activity.");
      expect(agentActivitySchema.parse(part.activity)).toMatchObject({
        type: "computerUse",
        source: "user-preview",
        operation: "agent.sources.list",
        operationId: success.context.operationId,
        outcome: "completed",
        binding: {
          chatId: f.credentials.chatId,
          taskId: domain === "task" ? f.credentials.chatId : null,
          threadId: null,
          turnId: null,
          sessionId: null,
        },
      });
      expect(listObservations).toHaveBeenCalledTimes(3);
      expect(f.launchCount).toBe(0);
      expect(f.service.status().sessions).toBe(0);
      expect(f.context.threadId).toBeNull();
    },
  );
});

describe("actual client prepares idle preview history grants", () => {
  it.each(["chat", "task"] as const)(
    "first %s operation authorizes and refreshes its actual scoped history key",
    async (domain) => {
      const worker = await scopedWorker();
      const historyScope = domain === "chat" ? "chat-content" : "task-content";
      const otherHistoryScope =
        domain === "chat" ? "task-content" : "chat-content";
      const clientControlKey = worker.keys.get("client-control-content")!;
      const f = createComputerUsePreviewFixture({
        binary: "/synthetic/never-launch-for-agent-source-list",
        permissionProfile: ":yolo",
        scopedEncryption: { service: worker.service, clientControlKey },
        context: {
          experience: domain === "chat" ? "agent" : "task",
          status: "idle",
          threadId: null,
        },
        agentObservations: {
          listObservations: () => ({ sources: [] }),
          readObservation: () => {
            throw new Error("No observation was requested.");
          },
        },
      });
      cleanup.push(() => f.close());
      const clientEncryption = new ClientEncryptionService();
      const cryptoIdentity = {
        ownerId: worker.ownerId,
        serverId: worker.serverId,
      };
      clientEncryption.setAccountMasterKey({
        accountMasterKey: worker.masterKey,
        identity: cryptoIdentity,
        masterKeyRevision: 1,
      });
      cleanup.push(() => clientEncryption.lock());
      const identity = {
        accountId: null,
        connectionId: "scoped-preview-connection",
        generation: 1,
        incarnationId: "scoped-preview-incarnation",
        serverId: worker.serverId,
        serverUrl: "https://fixture.invalid",
        userId: worker.ownerId,
      };
      const requested: string[] = [];
      const createdScopes: string[] = [];
      let refreshes = 0;
      const request: NonNullable<
        ComputerUseClientDependencies["request"]
      > = async <T>(
        url: string,
        init?: RequestInit,
        behavior?: Parameters<
          NonNullable<ComputerUseClientDependencies["request"]>
        >[2],
      ) => {
        expect(behavior).toEqual({
          allowCsrfRecovery: false,
          expectedIdentity: identity,
        });
        if (init?.signal?.aborted)
          throw new Error("Cancelled fixture request.");
        const address = new URL(url);
        const route = address.pathname;
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        requested.push(`${method} ${route}`);
        // In-memory control-plane adapter only. Wrapping is done by the actual
        // app grant helper; opening/authenticating grants is the real worker.
        if (route === "/api/encryption/principals" && method === "GET")
          return [worker.principal] as T;
        if (
          route === `/api/encryption/principals/${worker.principal.id}/grants`
        ) {
          if (method === "GET") return structuredClone(worker.grants) as T;
          if (method === "POST") {
            const input = encryptionKeyGrantCreateSchema.parse(body);
            const now = new Date().toISOString();
            const grant: EncryptionKeyGrant = {
              ...input,
              id: randomUUID(),
              ownerId: worker.ownerId,
              principalId: worker.principal.id,
              state: "active",
              revision: 1,
              revokedAt: null,
              revokedReason: null,
              createdAt: now,
              updatedAt: now,
            };
            worker.grants.push(grant);
            createdScopes.push(grant.component);
            return structuredClone(grant) as T;
          }
        }
        if (
          route === `/api/workers/${worker.workerId}/encryption/refresh` &&
          method === "POST"
        ) {
          expect(body).toEqual({
            component: "client-control-content",
            keyRevision: 1,
          });
          refreshes++;
          const status = await worker.service.refresh({
            credential: "synthetic-test-worker-credential",
            fetch: async () =>
              Response.json({
                serverId: worker.serverId,
                ownerId: worker.ownerId,
                principal: worker.principal,
                grants: worker.grants,
              }),
          });
          return {
            component: "client-control-content",
            keyRevision: 1,
            status,
          } as T;
        }
        const response = await f.app.inject({
          method: method as "POST",
          url: route,
          payload: body,
        });
        if (response.statusCode !== 200)
          throw new Error(`Scoped preview HTTP ${response.statusCode}`);
        return response.json() as T;
      };
      const viewer = createComputerUseClient(f.credentials.chatId, {
        request,
        sessionIdentity: () => identity,
        identityMatches: (expected) =>
          JSON.stringify(expected) === JSON.stringify(identity),
        onIdentityChanged: () => () => {},
        serverUrl: () => identity.serverUrl,
        encryption: clientEncryption,
        // Intentionally use production prepareWorkerEncryption by default.
      });
      cleanup.push(() => viewer.dispose());
      const lease = await viewer.open();
      expect(lease.contentDomain).toBe(domain);
      expect(refreshes).toBe(0);
      expect(createdScopes).toEqual([]);
      expect(() => worker.service.componentKey(historyScope)).toThrow(
        /active .* encryption grant/u,
      );
      const response = await viewer.operation(lease, {
        operation: "agent.sources.list",
      });
      expect(response.content).toMatchObject({
        status: "ok",
        data: { sources: [] },
      });
      expect(response.bytes).toBeNull();
      expect(refreshes).toBe(1);
      expect(createdScopes.sort()).toEqual(
        ["interaction-content", historyScope].sort(),
      );
      expect(worker.grants.map((grant) => grant.component).sort()).toEqual(
        ["client-control-content", "interaction-content", historyScope].sort(),
      );
      expect(() => worker.service.componentKey(otherHistoryScope)).toThrow(
        /active .* encryption grant/u,
      );
      const operationIndex = requested.findIndex((route) =>
        route.endsWith("/computer-use/operation"),
      );
      const refreshIndex = requested.findIndex((route) =>
        route.endsWith("/encryption/refresh"),
      );
      expect(refreshIndex).toBeGreaterThan(0);
      expect(operationIndex).toBeGreaterThan(refreshIndex);
      const records = domain === "chat" ? f.chatActivities : f.taskActivities;
      expect(records.size).toBe(1);
      const message = [...records.values()][0]!;
      const key = clientEncryption.componentKey({
        component: historyScope,
        identity: cryptoIdentity,
        keyRevision: 1,
      });
      try {
        const decrypt =
          domain === "chat"
            ? decryptChatMessageProtectedContent
            : decryptTaskMessageProtectedContent;
        const content = await decrypt({
          ownerId: worker.ownerId,
          componentKey: key,
          messageId: message.id,
          keyRevision: 1,
          encrypted: message.protectedContent,
          publicClassification: message.classification,
        });
        const item = content.content[0];
        expect(item?.type).toBe("activity");
        if (item?.type !== "activity")
          throw new Error("Expected protected activity.");
        expect(item.activity).toMatchObject({
          type: "computerUse",
          operation: "agent.sources.list",
          outcome: "completed",
          binding: {
            threadId: null,
            turnId: null,
            taskId: domain === "task" ? f.credentials.chatId : null,
          },
        });
      } finally {
        key.fill(0);
      }
      expect(f.launchCount).toBe(0);
      expect(f.context.threadId).toBeNull();
    },
  );
});
