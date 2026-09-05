import type {
  EncryptedAgentInteractionRequest,
  WorkerEvent,
} from "@cantrip/protocol";
import type {
  ComputerUseRequest,
  ComputerUseResponse,
} from "@cantrip/protocol/computer-use";
import type {
  CuaApprovalRequestEvent,
  CuaPreviewLease,
} from "@cantrip/protocol/computer-use-preview";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installComputerUseRoutes,
  type ComputerUseRouteDependencies,
} from "../src/app/routes/computer-use.js";
import {
  computerUsePreviewAuthority,
  createComputerUseApprovalPublications,
  installComputerUsePreviewRoutes,
  revokeComputerUsePreviews,
  type ComputerUsePreviewRouteDependencies,
} from "../src/app/routes/computer-use-preview.js";
import { applyComputerUseApprovalTerminal } from "../src/app/runtime/worker-notification-runtime.js";
import type { ChatExecutionContext } from "../src/db/repository.js";
import { WorkerBridge, WorkerUnavailableError } from "../src/workers/bridge.js";
import { CoordinatedWorkerBridge } from "../src/workers/coordinated-bridge.js";
import {
  createInMemoryRelayCoordinatorBackend,
  InMemoryRelayCoordinator,
} from "../src/coordination/relay-coordinator.js";

const leaseId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const requestKey = "00000000-0000-4000-8000-000000000003";
const timestamp = "2026-09-01T00:00:00.000Z";
const path = "/api/chats/chat-one/computer-use";
const secret = "PRIVATE-TARGET-and-private-worker-error";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function opaque(): ComputerUseRequest["protectedContent"] {
  return {
    formatVersion: 1,
    domain: "client-control-content",
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(16).toString("base64url"),
    },
  };
}
function body(
  operation: ComputerUseRequest["operation"] = "targets.list",
): ComputerUseRequest {
  return {
    operationId,
    operation,
    previewLeaseId: leaseId,
    protectedContent: opaque(),
  };
}
function result(): ComputerUseResponse {
  return { operationId, protectedContent: opaque() };
}
function approval(): CuaApprovalRequestEvent {
  const { domain, ...protectedPayload } = opaque();
  return {
    type: "computer-use.approval.request",
    operationId,
    request: {
      requestKey,
      projectId: "project-one",
      provenance: {
        owner: "computer-use",
        chatId: "chat-one",
        workerId: "worker-one",
        threadId: null,
        turnId: null,
        itemId: null,
        executionLaneId: null,
      },
      classification: { kind: "permissions" },
      protectedPayload,
      expiresAt: "2030-09-01T00:00:00.000Z",
    },
  };
}
function approvalRecord(): EncryptedAgentInteractionRequest {
  return {
    ...approval().request,
    id: requestKey,
    status: "pending",
    protectedResponse: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function terminal() {
  return {
    type: "computer-use.approval.terminal" as const,
    chatId: "chat-one",
    requestKey,
    status: "interrupted" as const,
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup() {
  const logs: string[] = [];
  const app = Fastify({
    logger: { stream: { write: (line: string) => logs.push(line) } },
  });
  apps.push(app);
  const context = {
    chatId: "chat-one",
    workerId: "worker-one",
    projectId: "project-one",
    contextKind: "project",
    worktreeId: "worktree-one",
    scratchRootId: null,
    computerUseAuthorityGeneration: 7,
    isPrimary: true,
    worktreePolicy: "required-for-writes",
    permissionProfileId: ":yolo",
    defaultPermissionProfileId: ":workspace",
    executionLaneId: "real-agent-lane",
    threadId: "real-agent-thread",
    status: "running",
  } as ChatExecutionContext;
  const owner = vi.fn(() => "owner-one");
  const getChatExecutionContext =
    vi.fn<
      ComputerUsePreviewRouteDependencies["repository"]["getChatExecutionContext"]
    >();
  getChatExecutionContext.mockImplementation(async (ownerId, chatId) =>
    ownerId === "owner-one" && chatId === context.chatId ? context : null,
  );
  const getWorker =
    vi.fn<ComputerUsePreviewRouteDependencies["repository"]["getWorker"]>();
  getWorker.mockImplementation(async (ownerId, workerId) =>
    ownerId === "owner-one" && workerId === "worker-one"
      ? ({ workerId } as NonNullable<Awaited<ReturnType<typeof getWorker>>>)
      : null,
  );
  const request = vi.fn<ComputerUseRouteDependencies["bridge"]["request"]>();
  const lease: CuaPreviewLease = {
    leaseId,
    workerId: "worker-one",
    chatId: "chat-one",
    generation: 7,
  };
  request.mockImplementation(async (_worker, command) => {
    if (command.type === "computer-use.preview.open") return lease;
    if (command.type === "computer-use.operation") return result();
    return { closed: true };
  });
  const record =
    vi.fn<
      NonNullable<
        ComputerUseRouteDependencies["recordLiveEncryptedAgentInteractionRequest"]
      >
    >();
  record.mockResolvedValue(approvalRecord());
  const terminalize =
    vi.fn<
      NonNullable<
        ComputerUseRouteDependencies["terminalizeLiveAgentInteractionRequest"]
      >
    >();
  terminalize.mockResolvedValue(null);
  const approvalPublications = createComputerUseApprovalPublications();
  const runAsOwner = vi.fn(<T>(_owner: string, operation: () => T) =>
    operation(),
  );
  const ensureWorkerNotificationSubscription =
    vi.fn<
      NonNullable<
        ComputerUseRouteDependencies["ensureWorkerNotificationSubscription"]
      >
    >();
  const repository = { getChatExecutionContext, getWorker };
  const bridge = { request };
  installComputerUsePreviewRoutes(app, {
    applicationOwnerId: owner,
    serverId: "server-one",
    repository,
    bridge,
  });
  installComputerUseRoutes(app, {
    applicationOwnerId: owner,
    serverId: "server-one",
    repository,
    bridge,
    requirePreviewLease: true,
    approvalPublications,
    runAsOwner,
    ensureWorkerNotificationSubscription,
    authorize: async ({ ownerId, context }) =>
      computerUsePreviewAuthority({ ownerId, serverId: "server-one", context }),
    recordLiveEncryptedAgentInteractionRequest: record,
    terminalizeLiveAgentInteractionRequest: terminalize,
  });
  return {
    app,
    logs,
    context,
    owner,
    getChatExecutionContext,
    getWorker,
    request,
    lease,
    record,
    terminalize,
    approvalPublications,
    runAsOwner,
    ensureWorkerNotificationSubscription,
    send: (suffix = "/preview", payload: unknown = {}) =>
      app.inject({ method: "POST", url: path + suffix, payload }),
  };
}

describe("explicit computer-use preview activation", () => {
  it("registers without worker calls and derives a preview independently from a running agent", async () => {
    const f = setup();
    expect(f.request).not.toHaveBeenCalled();
    const response = await f.send();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(f.lease);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "worker-one",
      {
        type: "computer-use.preview.open",
        authority: {
          ownerId: "owner-one",
          serverId: "server-one",
          workerId: "worker-one",
          chatId: "chat-one",
          projectId: "project-one",
          contextKind: "project",
          placementId: "worktree-one",
          generation: 7,
          profile: {
            selectedId: ":yolo",
            effectiveId: ":read-only",
            forcedByWorktreePolicy: true,
            usesDefault: false,
          },
        },
      },
      { ownerId: "owner-one", timeoutMs: 30_000 },
    );
  });

  it("uses actual standalone placement and inherited profile without a native thread", () => {
    const f = setup();
    const authority = computerUsePreviewAuthority({
      ownerId: "owner-one",
      serverId: "server-one",
      context: {
        ...f.context,
        contextKind: "standalone",
        projectId: null,
        scratchRootId: "scratch-one",
        worktreeId: null,
        worktreeMode: null,
        worktreePolicy: null,
        rootKind: null,
        scratchRootStatus: "ready",
        permissionProfileId: null,
        defaultPermissionProfileId: ":read-only",
        threadId: null,
      },
    });
    expect(authority).toMatchObject({
      placementId: "scratch-one",
      projectId: null,
      profile: {
        selectedId: ":read-only",
        effectiveId: ":read-only",
        usesDefault: true,
        forcedByWorktreePolicy: false,
      },
    });
  });

  it("does not invent a missing durable authority generation", async () => {
    const f = setup();
    delete f.context.computerUseAuthorityGeneration;
    expect((await f.send()).statusCode).toBe(502);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    { workerId: "other-worker" },
    { profile: { selectedId: ":yolo" } },
    { generation: 99 },
  ])("rejects caller authority fields %j", async (payload) => {
    const f = setup();
    expect((await f.send("/preview", payload)).statusCode).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("hides a foreign-owner chat", async () => {
    const f = setup();
    f.owner.mockReturnValue("other-owner");
    expect((await f.send()).statusCode).toBe(404);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["workerId", "chatId", "generation"] as const)(
    "rejects a mismatched worker lease %s",
    async (field) => {
      const f = setup();
      f.request.mockResolvedValue({
        ...f.lease,
        [field]: field === "generation" ? 8 : "other",
      });
      expect((await f.send()).statusCode).toBe(502);
    },
  );

  it.each(["targets.list", "session.close"] as const)(
    "requires a lease for production %s",
    async (operation) => {
      const f = setup();
      const { previewLeaseId, ...withoutLease } = body(operation);
      expect((await f.send("/operation", withoutLease)).statusCode).toBe(400);
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("dispatches a lease-bound operation with genuine null preview lane", async () => {
    const f = setup();
    expect((await f.send("/operation", body())).statusCode).toBe(200);
    expect(f.request.mock.lastCall?.[1]).toEqual({
      type: "computer-use.operation",
      serverId: "server-one",
      chatId: "chat-one",
      executionLaneId: null,
      request: body(),
      preview: {
        leaseId,
        authority: computerUsePreviewAuthority({
          ownerId: "owner-one",
          serverId: "server-one",
          context: f.context,
        }),
      },
    });
  });

  it("passes current generation and policy for worker rejection of stale leases", async () => {
    const f = setup();
    f.context.computerUseAuthorityGeneration = 8;
    f.context.permissionProfileId = ":read-only";
    await f.send("/operation", body());
    expect(f.request.mock.lastCall?.[1]).toMatchObject({
      preview: {
        authority: { generation: 8, profile: { selectedId: ":read-only" } },
      },
    });
  });

  it("stops the exact owned lease before a session exists, even after archival", async () => {
    const f = setup();
    f.getChatExecutionContext.mockResolvedValue(null);
    expect(
      (
        await f.send("/preview/stop", { leaseId, workerId: "worker-one" })
      ).json(),
    ).toEqual({ closed: true });
    expect(f.getChatExecutionContext).not.toHaveBeenCalled();
    expect(f.getWorker).toHaveBeenCalledWith("owner-one", "worker-one");
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "worker-one",
      {
        type: "computer-use.preview.stop",
        ownerId: "owner-one",
        serverId: "server-one",
        chatId: "chat-one",
        leaseId,
      },
      { ownerId: "owner-one", timeoutMs: 30_000 },
    );
  });

  it("does not stop an unowned worker or accept a false close acknowledgment", async () => {
    const f = setup();
    expect(
      (await f.send("/preview/stop", { leaseId, workerId: "foreign-worker" }))
        .statusCode,
    ).toBe(404);
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockResolvedValue({ closed: false });
    expect(
      (await f.send("/preview/stop", { leaseId, workerId: "worker-one" }))
        .statusCode,
    ).toBe(409);
  });

  it.each([new Error(secret), new WorkerUnavailableError(secret)])(
    "redacts worker errors",
    async (error) => {
      const f = setup();
      f.request.mockRejectedValue(error);
      const response = await f.send();
      expect(response.statusCode).toBe(
        error instanceof WorkerUnavailableError ? 503 : 502,
      );
      expect(response.body).not.toContain(secret);
      expect(f.logs.join("")).not.toContain(secret);
    },
  );
});

describe("preview approval event collection", () => {
  function emitEvents(f: ReturnType<typeof setup>, events: unknown[]) {
    f.request.mockImplementation(async (_worker, _command, options) => {
      for (const event of events)
        await options?.onEvent?.(event as WorkerEvent);
      return result();
    });
  }
  it("awaits one protected durable approval and its terminal before finishing", async () => {
    const f = setup();
    const order: string[] = [];
    f.record.mockImplementation(async () => {
      order.push("record");
      return approvalRecord();
    });
    f.terminalize.mockImplementation(async () => {
      order.push("terminal");
      return null;
    });
    emitEvents(f, [approval(), terminal()]);
    const response = await f.send("/operation", body());
    expect(response.statusCode).toBe(200);
    expect(order).toEqual(["record", "terminal"]);
    expect(f.record).toHaveBeenCalledExactlyOnceWith(approval().request);
    expect(f.terminalize).toHaveBeenCalledExactlyOnceWith(
      requestKey,
      "chat-one",
      "worker-one",
      "interrupted",
    );
    expect(response.json()).toEqual({ response: result(), chunks: [] });
  });
  it.each([
    "owner",
    "chatId",
    "workerId",
    "threadId",
    "turnId",
    "itemId",
    "executionLaneId",
  ] as const)("rejects incorrect approval provenance %s", async (field) => {
    const f = setup();
    const event = approval();
    Object.assign(event.request.provenance, { [field]: "other" });
    emitEvents(f, [event]);
    expect((await f.send("/operation", body())).statusCode).toBe(502);
    expect(f.record).not.toHaveBeenCalled();
  });
  it.each(["project", "operation"] as const)(
    "rejects incorrect approval %s",
    async (field) => {
      const f = setup();
      const event = approval();
      if (field === "project") event.request.projectId = "other";
      else event.operationId = requestKey;
      emitEvents(f, [event]);
      expect((await f.send("/operation", body())).statusCode).toBe(502);
      expect(f.record).not.toHaveBeenCalled();
    },
  );
  it("bounds duplicate approval and terminal events", async () => {
    const f = setup();
    emitEvents(f, [approval(), approval()]);
    expect((await f.send("/operation", body())).statusCode).toBe(502);
    expect(f.record).toHaveBeenCalledTimes(1);
    f.record.mockClear();
    emitEvents(f, [approval(), terminal(), terminal()]);
    expect((await f.send("/operation", body())).statusCode).toBe(502);
    expect(f.terminalize).toHaveBeenCalledTimes(1);
  });
  it("rejects unrelated terminals and image chunks mixed with an approval", async () => {
    const f = setup();
    emitEvents(f, [approval(), { ...terminal(), requestKey: leaseId }]);
    expect((await f.send("/operation", body())).statusCode).toBe(502);
    expect(f.terminalize).not.toHaveBeenCalled();
    emitEvents(f, [
      approval(),
      {
        type: "computer-use.snapshot.chunk",
        operationId,
        sequence: 0,
        protectedContent: opaque(),
      },
    ]);
    expect(
      (await f.send("/operation", body("observation.snapshot"))).statusCode,
    ).toBe(502);
  });
  it("does not accept successful completion after approval persistence fails", async () => {
    const f = setup();
    f.record.mockRejectedValue(new Error(secret));
    emitEvents(f, [approval()]);
    const response = await f.send("/operation", body());
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(secret);
    expect(f.logs.join("")).not.toContain(secret);
  });

  it.each([
    "before-event-callback",
    "during-insert",
    "before-remote-event-dispatch",
  ] as const)(
    "orders a standalone Stop %s behind an actual void-emitter publication",
    async (timing) => {
      const f = setup();
      const entered = deferred<void>();
      const insert = deferred<void>();
      const backend = createInMemoryRelayCoordinatorBackend();
      const coordinatorA = new InMemoryRelayCoordinator(
        "request-origin",
        backend,
      );
      const coordinatorB = new InMemoryRelayCoordinator(
        "worker-origin",
        backend,
      );
      const remote = timing === "before-remote-event-dispatch";
      if (remote)
        await Promise.all([coordinatorA.start(), coordinatorB.start()]);
      const bridge = remote
        ? new CoordinatedWorkerBridge({
            coordinator: coordinatorA,
            resolveOwnerId: async () => "owner-one",
          })
        : new WorkerBridge();
      const workerBridge = remote
        ? new CoordinatedWorkerBridge({
            coordinator: coordinatorB,
            resolveOwnerId: async () => "owner-one",
          })
        : bridge;
      const dispatch = deferred<() => void>();
      let saved = false;
      let terminalApplication: Promise<void> | undefined;
      const getAgentInteractionRequestByKey = vi.fn(async () =>
        saved ? approvalRecord() : null,
      );
      f.record.mockImplementation(async () => {
        entered.resolve();
        await insert.promise;
        saved = true;
        return approvalRecord();
      });
      const sendTerminal = () =>
        socket.emit(
          "message",
          JSON.stringify({
            kind: "notification",
            notification: terminal(),
          }),
        );
      const socket = Object.assign(new EventEmitter(), {
        bufferedAmount: 0,
        readyState: 1,
        close() {},
        send(data: string | Uint8Array) {
          const { requestId } = JSON.parse(String(data));
          const sendEvents = () => {
            socket.emit(
              "message",
              JSON.stringify({
                kind: "event",
                requestId,
                event: approval(),
              }),
            );
            if (timing === "before-event-callback") sendTerminal();
            // The native worker emitter returns void; final transport response
            // can be queued while the server approval insert is still pending.
            socket.emit(
              "message",
              JSON.stringify({
                kind: "response",
                requestId,
                ok: true,
                result: result(),
              }),
            );
          };
          if (remote) {
            // Independent fanout arrives before any command event on purpose;
            // the request-origin server cannot assume Redis message ordering.
            sendTerminal();
            dispatch.resolve(sendEvents);
          } else sendEvents();
        },
      });
      await workerBridge.attach("worker-one", socket, "owner-one");
      let unsubscribe = () => {};
      f.ensureWorkerNotificationSubscription.mockImplementation(
        (owner, worker) => {
          expect(owner).toBe("owner-one");
          expect(worker).toBe("worker-one");
          unsubscribe = bridge.subscribeNotifications(
            "worker-one",
            (notification) => {
              terminalApplication = applyComputerUseApprovalTerminal({
                ownerId: "owner-one",
                workerId: "worker-one",
                notification,
                repository: { getAgentInteractionRequestByKey },
                terminalizeLiveAgentInteractionRequest: f.terminalize,
                approvalPublications: f.approvalPublications,
              });
              return terminalApplication;
            },
          );
        },
      );
      f.request.mockImplementation((worker, command, options) =>
        bridge.request(worker, command, options),
      );
      try {
        const response = f.send("/operation", body());
        // Fastify inject is lazy until its result is consumed.
        const completion = response.then((value) => value);
        if (remote) {
          const sendEvents = await dispatch.promise;
          expect(f.record).not.toHaveBeenCalled();
          expect(getAgentInteractionRequestByKey).not.toHaveBeenCalled();
          sendEvents();
        }
        await entered.promise;
        if (timing === "during-insert") sendTerminal();
        expect(f.terminalize).not.toHaveBeenCalled();
        insert.resolve();
        await terminalApplication;
        expect((await completion).statusCode).toBe(200);
        expect(f.terminalize).toHaveBeenCalledExactlyOnceWith(
          requestKey,
          "chat-one",
          "worker-one",
          "interrupted",
        );
        expect(f.runAsOwner).toHaveBeenCalledWith(
          "owner-one",
          expect.any(Function),
        );
        expect(
          f.ensureWorkerNotificationSubscription,
        ).toHaveBeenCalledExactlyOnceWith("owner-one", "worker-one");
      } finally {
        insert.resolve();
        unsubscribe();
        await bridge.close();
        if (workerBridge !== bridge) await workerBridge.close();
        await Promise.all([coordinatorA.close(), coordinatorB.close()]);
      }
    },
  );
});

describe("bounded approval publication fences", () => {
  const scope = {
    ownerId: "owner-one",
    workerId: "worker-one",
    chatId: "chat-one",
    requestKey,
  };

  it("snapshots active commands without waiting on foreign or future commands", async () => {
    const publications = createComputerUseApprovalPublications();
    const finish = publications.beginCommand(scope);
    await publications.waitCommands({ ...scope, ownerId: "foreign" });
    let settled = false;
    const waiting = publications.waitCommands(scope).then(() => {
      settled = true;
    });
    const finishFuture = publications.beginCommand(scope);
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await waiting;
    finishFuture();
  });

  it("bounds active commands and releases each dispatch fence exactly once", async () => {
    const publications = createComputerUseApprovalPublications();
    const finish = Array.from({ length: 256 }, () =>
      publications.beginCommand(scope),
    );
    expect(() => publications.beginCommand(scope)).toThrow(
      "publication is unavailable",
    );
    finish[0]!();
    finish[0]!();
    const next = publications.beginCommand(scope);
    expect(() => publications.beginCommand(scope)).toThrow(
      "publication is unavailable",
    );
    for (const close of finish) close();
    next();
    await publications.waitCommands(scope);
  });

  it("retains an actual insert fence after its HTTP command times out", async () => {
    const publications = createComputerUseApprovalPublications();
    const finishTimedOutCommand = publications.beginCommand(scope);
    const insert = deferred<void>();
    const write = publications.publish(scope, () => insert.promise);
    finishTimedOutCommand();
    await publications.waitCommands(scope);
    let settled = false;
    const waiting = publications.wait(scope).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    insert.resolve();
    await Promise.all([write, waiting]);
  });

  it.each(["ownerId", "workerId", "chatId", "requestKey"] as const)(
    "does not wait for another %s",
    async (field) => {
      const publications = createComputerUseApprovalPublications();
      const insert = deferred<void>();
      const pending = publications.publish(scope, () => insert.promise);
      await publications.wait({ ...scope, [field]: "other" });
      insert.resolve();
      await pending;
    },
  );

  it.each(["database failure", "database statement timeout"])(
    "releases the fence after actual %s, not an unrelated request deadline",
    async (reason) => {
      const publications = createComputerUseApprovalPublications();
      const insert = deferred<void>();
      const failure = publications
        .publish(scope, () => insert.promise)
        .catch((error) => error);
      let settled = false;
      const waiting = publications.wait(scope).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      insert.reject(new Error(reason));
      expect(await failure).toEqual(new Error(reason));
      await waiting;
      await expect(
        publications.publish(scope, async () => "retried"),
      ).resolves.toBe("retried");
    },
  );

  it("caps pending publications, rejects duplicate writes, and frees settled slots", async () => {
    const publications = createComputerUseApprovalPublications();
    const insert = deferred<void>();
    const writes = Array.from({ length: 256 }, (_, index) =>
      publications.publish(
        { ...scope, requestKey: String(index) },
        () => insert.promise,
      ),
    );
    const unusedWrite = vi.fn(async () => undefined);
    await expect(
      publications.publish({ ...scope, requestKey: "overflow" }, unusedWrite),
    ).rejects.toThrow("publication is unavailable");
    await expect(
      publications.publish({ ...scope, requestKey: "0" }, unusedWrite),
    ).rejects.toThrow("publication is unavailable");
    expect(unusedWrite).not.toHaveBeenCalled();
    insert.resolve();
    await Promise.all(writes);
    await expect(
      publications.publish(scope, async () => "ready"),
    ).resolves.toBe("ready");
  });
});

describe("authenticated terminal notifications and mutation revocation", () => {
  function notificationFixture() {
    const getAgentInteractionRequestByKey =
      vi.fn<
        Parameters<
          typeof applyComputerUseApprovalTerminal
        >[0]["repository"]["getAgentInteractionRequestByKey"]
      >();
    getAgentInteractionRequestByKey.mockImplementation(async (ownerId, key) =>
      ownerId === "owner-one" && key === requestKey ? approvalRecord() : null,
    );
    const terminalizeLiveAgentInteractionRequest =
      vi.fn<
        Parameters<
          typeof applyComputerUseApprovalTerminal
        >[0]["terminalizeLiveAgentInteractionRequest"]
      >();
    terminalizeLiveAgentInteractionRequest.mockResolvedValue(null);
    return {
      ownerId: "owner-one",
      workerId: "worker-one",
      notification: terminal(),
      repository: { getAgentInteractionRequestByKey },
      terminalizeLiveAgentInteractionRequest,
    };
  }
  it("terminalizes only the authenticated worker's durable CUA approval", async () => {
    const f = notificationFixture();
    await applyComputerUseApprovalTerminal(f);
    expect(f.repository.getAgentInteractionRequestByKey).toHaveBeenCalledWith(
      "owner-one",
      requestKey,
    );
    expect(
      f.terminalizeLiveAgentInteractionRequest,
    ).toHaveBeenCalledExactlyOnceWith(
      requestKey,
      "chat-one",
      "worker-one",
      "interrupted",
    );
  });
  it.each(["owner", "worker", "chat", "codex"] as const)(
    "ignores foreign %s notification scope",
    async (field) => {
      const f = notificationFixture();
      if (field === "owner") f.ownerId = "other";
      if (field === "worker") f.workerId = "other";
      if (field === "chat") f.notification.chatId = "other";
      if (field === "codex") {
        const record = approvalRecord();
        record.provenance = {
          ...record.provenance,
          owner: "codex",
          threadId: "thread",
        };
        f.repository.getAgentInteractionRequestByKey.mockResolvedValue(record);
      }
      await applyComputerUseApprovalTerminal(f);
      expect(f.terminalizeLiveAgentInteractionRequest).not.toHaveBeenCalled();
    },
  );
  it("accepts a terminal re-emitted after the durable request is recorded", async () => {
    const f = notificationFixture();
    f.repository.getAgentInteractionRequestByKey.mockResolvedValueOnce(null);
    await applyComputerUseApprovalTerminal(f);
    expect(f.terminalizeLiveAgentInteractionRequest).not.toHaveBeenCalled();
    await applyComputerUseApprovalTerminal(f);
    expect(f.terminalizeLiveAgentInteractionRequest).toHaveBeenCalledTimes(1);
  });
  it("attempts all exact mutation targets once and reports only a safe failure", async () => {
    const request = vi.fn<ComputerUseRouteDependencies["bridge"]["request"]>();
    request.mockImplementation(async (workerId) => {
      if (workerId === "worker-one") throw new Error(secret);
      return { closed: true };
    });
    await expect(
      revokeComputerUsePreviews({
        bridge: { request },
        ownerId: "owner-one",
        serverId: "server-one",
        workerIds: ["worker-one", "worker-two", "worker-one"],
        scope: { kind: "chat", chatId: "chat-one" },
      }),
    ).rejects.toThrow("Computer-use revocation could not reach every worker.");
    expect(request.mock.calls.map(([worker]) => worker)).toEqual([
      "worker-one",
      "worker-two",
    ]);
    expect(request.mock.calls[1]).toEqual([
      "worker-two",
      {
        type: "computer-use.preview.revoke",
        ownerId: "owner-one",
        serverId: "server-one",
        scope: { kind: "chat", chatId: "chat-one" },
      },
      { ownerId: "owner-one", timeoutMs: 2_000 },
    ]);
  });
});
import { EventEmitter } from "node:events";
