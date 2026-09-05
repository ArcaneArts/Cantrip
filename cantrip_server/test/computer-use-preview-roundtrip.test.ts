import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
// Synthetic client and worker endpoints only. The server factories receive no
// component key and cannot inspect target, cursor, or captured image content.
import {
  decryptEndpointContentPayload,
  encryptEndpointContentPayload,
  openComputerUseResult,
  protectComputerUseRequest,
} from "../../packages/crypto/src/index.js";
import {
  computerUseHttpResultSchema,
  cuaSessionResultSchema,
  type ComputerUseAction,
  type ComputerUseRequest,
} from "@cantrip/protocol/computer-use";
import {
  cuaPreviewLeaseSchema,
  type CuaPreviewLease,
} from "@cantrip/protocol/computer-use-preview";
import { publishCuaPreviewActivity } from "../../cantrip_worker/src/computer-use/activity-publication.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { CuaApprovalManager } from "../../cantrip_worker/src/computer-use/approvals.js";
import { CuaPreviewCoordinator } from "../../cantrip_worker/src/computer-use/preview.js";
import { CantripCuaService } from "../../cantrip_worker/src/computer-use/service.js";
import { launchCuaTransport } from "../../cantrip_worker/src/computer-use/transport.js";
import {
  computerUsePreviewAuthority,
  installComputerUsePreviewRoutes,
  type ComputerUsePreviewRouteDependencies,
} from "../src/app/routes/computer-use-preview.js";
import {
  installComputerUseRoutes,
  type ComputerUseRouteDependencies,
} from "../src/app/routes/computer-use.js";
import type { ChatExecutionContext } from "../src/db/repository.js";

const target = { targetId: "fake-window", targetGeneration: 1 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function setup() {
  const wire: string[] = [];
  const logs: string[] = [];
  const app = Fastify({
    logger: { stream: { write: (line: string) => logs.push(line) } },
  });
  const launch = vi.fn(launchCuaTransport);
  const service = new CantripCuaService({
    workerId: "worker",
    binary:
      process.env.CANTRIP_CUA_TEST_BINARY ?? "/synthetic/no-native-launch",
    args: ["--backend", "fake"],
    launch,
  });
  const key = new Uint8Array(32).fill(73);
  const encryption = {
    ownerId: () => "owner",
    serverIdentity: () => "server",
    componentKey: vi.fn(() => ({ key: key.slice(), keyRevision: 1 })),
  };
  const approvals = new CuaApprovalManager({ workerId: "worker", encryption });
  const coordinator = new CuaPreviewCoordinator({
    workerId: "worker",
    encryption,
    approvals,
    service,
    publishActivity: (activity, contentDomain, emit) =>
      publishCuaPreviewActivity({
        encryption: encryption as unknown as WorkerEncryptionService,
        activity,
        contentDomain,
        emit,
      }),
  });
  cleanups.push(async () => {
    coordinator.close();
    approvals.close();
    await Promise.all([app.close(), service.close()]);
    key.fill(0);
  });
  const context = {
    chatId: "chat",
    experience: "agent",
    workerId: "worker",
    projectId: "project",
    contextKind: "project",
    worktreeId: "primary-worktree",
    scratchRootId: null,
    computerUseAuthorityGeneration: 1,
    isPrimary: true,
    worktreePolicy: "required-for-writes",
    permissionProfileId: ":yolo",
    defaultPermissionProfileId: ":default",
    executionLaneId: "agent-lane-one",
    threadId: "agent-thread-one",
    status: "running",
  } as ChatExecutionContext;
  let contextAvailable = true;
  const getChatExecutionContext: ComputerUsePreviewRouteDependencies["repository"]["getChatExecutionContext"] =
    async (ownerId, chatId) =>
      contextAvailable && ownerId === "owner" && chatId === "chat"
        ? context
        : null;
  const getWorker: ComputerUsePreviewRouteDependencies["repository"]["getWorker"] =
    async (ownerId, workerId) =>
      ownerId === "owner" && workerId === "worker"
        ? ({ workerId } as NonNullable<Awaited<ReturnType<typeof getWorker>>>)
        : null;
  const request: ComputerUseRouteDependencies["bridge"]["request"] = async (
    workerId,
    command,
    options,
  ) => {
    expect(workerId).toBe("worker");
    expect(options?.ownerId).toBe("owner");
    wire.push(JSON.stringify(command));
    let result: unknown;
    switch (command.type) {
      case "computer-use.preview.open":
        result = coordinator.open(command.authority, command.contentDomain);
        break;
      case "computer-use.preview.stop":
        result = coordinator.stop(command);
        break;
      case "computer-use.operation":
        expect(command.executionLaneId).toBeNull();
        result = await coordinator.execute(command, async (event) => {
          wire.push(JSON.stringify(event));
          await options?.onEvent?.(event);
        });
        break;
      default:
        throw new Error("Unexpected composition-test command.");
    }
    wire.push(JSON.stringify(result));
    return result;
  };
  const repository = { getChatExecutionContext, getWorker };
  const bridge = { request };
  installComputerUsePreviewRoutes(app, {
    applicationOwnerId: () => "owner",
    serverId: "server",
    repository,
    bridge,
    upsertLiveEncryptedChatMessage: async () => ({ id: "saved" }),
  });
  installComputerUseRoutes(app, {
    applicationOwnerId: () => "owner",
    serverId: "server",
    repository,
    bridge,
    requirePreviewLease: true,
    upsertLiveEncryptedChatMessage: async () => ({ id: "saved" }),
    authorize: async ({ ownerId, context }) =>
      computerUsePreviewAuthority({ ownerId, serverId: "server", context }),
  });

  async function openPreview() {
    const response = await app.inject({
      method: "POST",
      url: "/api/chats/chat/computer-use/preview",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    return cuaPreviewLeaseSchema.parse(response.json());
  }
  async function stop(lease: CuaPreviewLease) {
    const response = await app.inject({
      method: "POST",
      url: "/api/chats/chat/computer-use/preview/stop",
      payload: { leaseId: lease.leaseId, workerId: lease.workerId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ closed: true });
  }
  async function prepare(action: ComputerUseAction, lease: CuaPreviewLease) {
    const context = {
      serverId: "server",
      workerId: "worker",
      chatId: "chat",
      operationId: randomUUID(),
      operation: action.operation,
      previewLeaseId: lease.leaseId,
    };
    const body = await protectComputerUseRequest({
      context,
      request: action,
      seal: (context, plaintext) =>
        encryptEndpointContentPayload({
          ownerId: "owner",
          context,
          plaintext,
          keyRevision: 1,
          componentKey: key,
        }),
    });
    return { context, body };
  }
  async function inject(body: ComputerUseRequest) {
    return app.inject({
      method: "POST",
      url: "/api/chats/chat/computer-use/operation",
      payload: body,
    });
  }
  const open = (
    context: Parameters<typeof decryptEndpointContentPayload>[0]["context"],
    opaque: Parameters<typeof decryptEndpointContentPayload>[0]["opaque"],
  ) =>
    decryptEndpointContentPayload({
      ownerId: "owner",
      context,
      opaque,
      keyRevision: 1,
      componentKey: key,
    });
  async function send(action: ComputerUseAction, lease: CuaPreviewLease) {
    const prepared = await prepare(action, lease);
    const response = await inject(prepared.body);
    expect(response.statusCode).toBe(200);
    const opaque = computerUseHttpResultSchema.parse(response.json());
    const opened = await openComputerUseResult({
      context: prepared.context,
      opaque: opaque.response,
      chunks: opaque.chunks,
      open,
    });
    return { ...opened, ...prepared, opaque };
  }
  async function openSession(lease: CuaPreviewLease) {
    const opened = await send({ operation: "session.open", ...target }, lease);
    if (opened.result.status !== "ok")
      throw new Error("Expected a native session.");
    const session = cuaSessionResultSchema.parse(opened.result.data).session;
    expect(session.binding).toMatchObject({
      workerId: "worker",
      chatId: "chat",
      taskId: null,
      threadId: null,
      turnId: null,
    });
    return session.binding.sessionId;
  }
  return {
    app,
    service,
    coordinator,
    approvals,
    encryption,
    launch,
    context,
    wire,
    logs,
    openPreview,
    openSession,
    send,
    prepare,
    inject,
    open,
    stop,
    setContextAvailable: (available: boolean) => {
      contextAvailable = available;
    },
  };
}

describe("production preview factories compose without activation", () => {
  it("opens/shares/stops an authenticated lease without launching Rust or asking for an encryption key", async () => {
    const f = setup();
    expect(f.launch).not.toHaveBeenCalled();
    const first = await f.openPreview();
    expect(await f.openPreview()).toEqual(first);
    await f.stop(first);
    await f.stop(first);
    expect(f.coordinator.status().previews).toBe(0);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.encryption.componentKey).not.toHaveBeenCalled();
  });
});

// Only the explicit build/test command supplies this artifact. The actual
// process is always launched with --backend fake: no native TCC prompts.
describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "Fastify preview -> coordinator -> actual Rust fake backend",
  () => {
    it("uses selected YOLO for target/session/cursor/PNG operations and keeps private content off the relay and logs", async () => {
      const f = setup();
      const lease = await f.openPreview();
      expect(f.launch).not.toHaveBeenCalled();
      const inventory = await f.send({ operation: "targets.list" }, lease);
      expect(inventory.result).toMatchObject({
        status: "ok",
        data: {
          targets: expect.arrayContaining([
            expect.objectContaining({ id: "fake-window" }),
          ]),
        },
      });
      const sessionId = await f.openSession(lease);
      const appearance = {
        version: 1 as const,
        style: "ring" as const,
        color: "#FA13B7",
        size: 40,
        label: "Private preview cursor",
        trail: true,
        visible: true,
      };
      expect(
        (
          await f.send(
            { operation: "cursor.configure", sessionId, ...target, appearance },
            lease,
          )
        ).result,
      ).toMatchObject({
        status: "ok",
        data: { session: { cursor: { appearance } } },
      });
      expect(
        (
          await f.send(
            {
              operation: "cursor.move",
              sessionId,
              ...target,
              position: { x: 45, y: 65 },
            },
            lease,
          )
        ).result.status,
      ).toBe("ok");
      const captured = await f.send(
        { operation: "observation.snapshot", sessionId, ...target },
        lease,
      );
      expect(captured.result).toMatchObject({
        status: "ok",
        data: {
          image: {
            width: 320,
            height: 200,
            mediaType: "image/png",
            cursorIncluded: true,
          },
        },
      });
      expect(Array.from(captured.payload!.subarray(0, 8))).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
      const digest = createHash("sha256")
        .update(captured.payload!)
        .digest("hex");
      expect(captured.result).toMatchObject({
        data: {
          image: { sha256: digest, byteCount: captured.payload!.length },
        },
      });
      const rawPng = Buffer.from(captured.payload!).toString("base64");
      captured.payload!.fill(0);
      const relayed = f.wire.join("\n");
      for (const privateValue of [
        "fake-window",
        "Private preview cursor",
        "#FA13B7",
        '"position":{"x":45,"y":65}',
        rawPng,
      ]) {
        expect(relayed).not.toContain(privateValue);
        expect(f.logs.join("\n")).not.toContain(privateValue);
      }
      expect(f.approvals.status()).toMatchObject({
        pending: 0,
        grants: 0,
        completed: 0,
      });
      expect(f.launch).toHaveBeenCalledTimes(1);
      await f.stop(lease);
      expect(f.service.status().sessions).toBe(0);
      expect(f.launch).toHaveBeenCalledTimes(1);
    });

    it("preserves preview authority through ordinary agent lane/thread/status changes and permits Stop after archival", async () => {
      const f = setup();
      const lease = await f.openPreview();
      const sessionId = await f.openSession(lease);
      f.context.executionLaneId = "agent-lane-two";
      f.context.threadId = "agent-thread-two";
      f.context.status = "idle";
      expect(await f.openPreview()).toEqual(lease);
      expect(
        (await f.send({ operation: "session.state", sessionId }, lease)).result,
      ).toMatchObject({
        status: "ok",
        data: {
          session: { binding: { taskId: null, threadId: null, turnId: null } },
        },
      });
      f.context.executionLaneId = null;
      f.context.threadId = null;
      f.context.status = "running";
      expect(await f.openPreview()).toEqual(lease);
      const capture = await f.send(
        { operation: "observation.snapshot", sessionId, ...target },
        lease,
      );
      expect(capture.result.status).toBe("ok");
      capture.payload?.fill(0);
      f.setContextAvailable(false);
      await f.stop(lease);
      await f.stop(lease);
      expect(f.service.status().sessions).toBe(0);
      expect(f.launch).toHaveBeenCalledTimes(1);
    });

    it("rejects old generation/lease operations, never replays them on a fresh preview, and does not restart after Stop", async () => {
      const f = setup();
      const first = await f.openPreview();
      const sessionId = await f.openSession(first);
      const old = await f.prepare(
        { operation: "observation.snapshot", sessionId, ...target },
        first,
      );
      f.context.computerUseAuthorityGeneration = 2;
      expect((await f.inject(old.body)).statusCode).toBe(502);
      expect(f.service.status().sessions).toBe(0);
      const next = await f.openPreview();
      expect(next.leaseId).not.toBe(first.leaseId);
      expect(next.generation).toBe(2);
      expect((await f.inject(old.body)).statusCode).toBe(502);
      const relabeled = await f.inject({
        ...old.body,
        previewLeaseId: next.leaseId,
      });
      expect(relabeled.statusCode).toBe(200);
      const opaque = computerUseHttpResultSchema.parse(relabeled.json());
      expect(opaque.chunks).toEqual([]);
      const rejected = await openComputerUseResult({
        context: { ...old.context, previewLeaseId: next.leaseId },
        opaque: opaque.response,
        chunks: opaque.chunks,
        open: f.open,
      });
      expect(rejected.result.status).toBe("error");
      expect(rejected.payload).toBeNull();
      expect(
        (await f.send({ operation: "session.state", sessionId }, next)).result
          .status,
      ).toBe("error");
      await f.stop(first);
      expect(await f.openPreview()).toEqual(next);
      await f.stop(next);
      expect(
        (
          await f.inject(
            (await f.prepare({ operation: "targets.list" }, next)).body,
          )
        ).statusCode,
      ).toBe(502);
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.service.status().sessions).toBe(0);
    });
  },
);
