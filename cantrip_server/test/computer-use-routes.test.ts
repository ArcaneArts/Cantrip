import {
  CUA_CHUNK_BYTES,
  CUA_MAX_CHUNKS,
  CUA_CONTROL_BYTES,
  type ComputerUseChunkEvent,
  type ComputerUseRequest,
  type ComputerUseResponse,
} from "@cantrip/protocol/computer-use";
import type { WorkerEvent } from "@cantrip/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installComputerUseRoutes,
  type ComputerUseRouteDependencies,
} from "../src/app/routes/computer-use.js";
import type { ChatExecutionContext } from "../src/db/repository.js";
import {
  WorkerBridge,
  type WorkerRequestOptions,
} from "../src/workers/bridge.js";

const operationId = "00000000-0000-4000-8000-000000000001";
const otherOperationId = "00000000-0000-4000-8000-000000000002";
const url = "/api/chats/chat-one/computer-use/operation";
const secret = "PRIVATE-TARGET-TITLE-and-native-error";

function opaque(bytes = 16): ComputerUseRequest["protectedContent"] {
  return {
    formatVersion: 1,
    domain: "client-control-content",
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(bytes).toString("base64url"),
    },
  };
}

function body(
  operation: ComputerUseRequest["operation"] = "observation.snapshot",
): ComputerUseRequest {
  return { operationId, operation, protectedContent: opaque() };
}

function chunk(sequence = 0): ComputerUseChunkEvent {
  return {
    type: "computer-use.snapshot.chunk",
    operationId,
    sequence,
    protectedContent: opaque(),
  };
}

function result(): ComputerUseResponse {
  return { operationId, protectedContent: opaque() };
}

function context(): ChatExecutionContext {
  return {
    automationPaused: false,
    chatId: "chat-one",
    contextKind: "project",
    cwd: "worker-private-root-handle",
    experience: "chat",
    executionLaneId: "lane-one",
    isPrimary: false,
    status: "running",
    modelId: null,
    reasoningEffort: null,
    modelConfiguration: {
      modelId: null,
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
    },
    modelRouteId: null,
    providerAccountId: null,
    permissionProfileId: ":workspace",
    planMode: "default",
    projectId: "project-one",
    rootKind: "git-worktree",
    scratchRootId: null,
    threadId: "thread-one",
    workerId: "worker-one",
    worktreeId: "worktree-one",
    worktreeMode: "agent-managed",
    worktreePolicy: "agent-managed",
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
  const currentContext = context();
  const applicationOwnerId = vi.fn(() => "owner-one");
  const getChatExecutionContext =
    vi.fn<
      ComputerUseRouteDependencies["repository"]["getChatExecutionContext"]
    >();
  getChatExecutionContext.mockImplementation(async (ownerId, chatId) =>
    ownerId === "owner-one" && chatId === "chat-one" ? currentContext : null,
  );
  const authorize = vi.fn<ComputerUseRouteDependencies["authorize"]>();
  authorize.mockResolvedValue(undefined);
  const request = vi.fn<ComputerUseRouteDependencies["bridge"]["request"]>();
  request.mockResolvedValue(result());
  installComputerUseRoutes(app, {
    applicationOwnerId,
    serverId: "server-one",
    repository: { getChatExecutionContext },
    bridge: { request },
    authorize,
  });
  return {
    app,
    logs,
    applicationOwnerId,
    currentContext,
    getChatExecutionContext,
    authorize,
    request,
    send: (payload: unknown = body()) =>
      app.inject({ method: "POST", url, payload }),
  };
}

async function emit(options: WorkerRequestOptions | undefined, event: unknown) {
  await options?.onEvent?.(event as WorkerEvent);
}

describe("unregistered computer-use relay factory", () => {
  it("authorizes the authoritative owner/chat/worker lane before dispatch", async () => {
    const fixture = setup();
    const order: string[] = [];
    fixture.authorize.mockImplementation(async () => {
      order.push("authorized");
    });
    fixture.request.mockImplementation(async (_workerId, _command, options) => {
      order.push("dispatched");
      await emit(options, chunk());
      order.push("chunk");
      return result();
    });

    const response = await fixture.send();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ response: result(), chunks: [chunk()] });
    expect(order).toEqual(["authorized", "dispatched", "chunk"]);
    expect(fixture.getChatExecutionContext).toHaveBeenCalledWith(
      "owner-one",
      "chat-one",
    );
    expect(fixture.authorize).toHaveBeenCalledWith({
      ownerId: "owner-one",
      context: fixture.currentContext,
      operation: "observation.snapshot",
      operationId,
    });
    expect(fixture.request).toHaveBeenCalledWith(
      "worker-one",
      {
        type: "computer-use.operation",
        serverId: "server-one",
        chatId: "chat-one",
        executionLaneId: "lane-one",
        request: body(),
      },
      {
        ownerId: "owner-one",
        timeoutMs: 30_000,
        onEvent: expect.any(Function),
      },
    );
  });

  it("uses the new execution worker and lane on the next request after handoff", async () => {
    const fixture = setup();
    await fixture.send(body("capabilities.get"));
    fixture.currentContext.workerId = "worker-two";
    fixture.currentContext.executionLaneId = "lane-two";
    const response = await fixture.send(body("capabilities.get"));
    expect(response.statusCode).toBe(200);
    expect(fixture.request.mock.lastCall?.slice(0, 2)).toEqual([
      "worker-two",
      {
        type: "computer-use.operation",
        serverId: "server-one",
        chatId: "chat-one",
        executionLaneId: "lane-two",
        request: body("capabilities.get"),
      },
    ]);
  });

  it("waits for queued chunk callbacks before returning an immediate final worker response", async () => {
    const fixture = setup();
    const bridge = new WorkerBridge();
    const socket = Object.assign(new EventEmitter(), {
      bufferedAmount: 0,
      readyState: 1,
      close() {},
      send(data: string | Uint8Array) {
        const { requestId } = JSON.parse(String(data));
        socket.emit(
          "message",
          JSON.stringify({
            kind: "event",
            requestId,
            event: chunk(),
          }),
        );
        socket.emit(
          "message",
          JSON.stringify({
            kind: "response",
            requestId,
            ok: true,
            result: result(),
          }),
        );
      },
    });
    bridge.attach("worker-one", socket);
    fixture.request.mockImplementation((workerId, command, options) =>
      bridge.request(workerId, command, {
        ...options,
        onEvent: async (event) => {
          await Promise.resolve();
          await options?.onEvent?.(event);
        },
      }),
    );
    try {
      const response = await fixture.send();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        response: result(),
        chunks: [chunk()],
      });
    } finally {
      await bridge.close();
    }
  });

  it("cannot find another owner's chat and never dispatches it", async () => {
    const fixture = setup();
    fixture.applicationOwnerId.mockReturnValue("owner-two");
    const response = await fixture.send();
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Chat not found." });
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it.each([
    "workerId",
    "executionLaneId",
    "ownerId",
    "taskId",
    "turnId",
    "threadId",
  ])(
    "rejects client-supplied %s authority instead of forwarding it",
    async (field) => {
      const fixture = setup();
      const response = await fixture.send({ ...body(), [field]: "selected" });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Invalid computer-use request.",
      });
      expect(fixture.getChatExecutionContext).not.toHaveBeenCalled();
      expect(fixture.request).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch when authorization denies, without leaking its reason", async () => {
    const fixture = setup();
    fixture.authorize.mockRejectedValue(new Error(secret));
    const response = await fixture.send();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Computer use is not authorized.",
    });
    expect(response.body).not.toContain(secret);
    expect(fixture.logs.join("")).not.toContain(secret);
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("allows scoped stop without asking for approval, but still requires chat ownership", async () => {
    const fixture = setup();
    fixture.authorize.mockRejectedValue(new Error(secret));
    const stopped = await fixture.send(body("session.close"));
    expect(stopped.statusCode).toBe(200);
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.request.mock.lastCall?.[1]).toEqual({
      type: "computer-use.operation",
      serverId: "server-one",
      chatId: "chat-one",
      executionLaneId: "lane-one",
      request: body("session.close"),
    });
    fixture.applicationOwnerId.mockReturnValue("owner-two");
    expect((await fixture.send(body("session.close"))).statusCode).toBe(404);
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });

  it("sanitizes unavailable repository and worker errors", async () => {
    const fixture = setup();
    fixture.getChatExecutionContext.mockRejectedValueOnce(new Error(secret));
    const unavailable = await fixture.send();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      error: "Chat context is unavailable.",
    });
    fixture.request.mockRejectedValueOnce(new Error(secret));
    const failed = await fixture.send();
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: "Computer-use request failed." });
    expect(unavailable.body + failed.body).not.toContain(secret);
    expect(fixture.logs.join("")).not.toContain(secret);
  });

  it.each([
    ["wrong correlation", [{ ...chunk(), operationId: otherOperationId }]],
    ["out of order", [chunk(1)]],
    ["duplicate", [chunk(), chunk()]],
    ["non-CUA event", [{ type: "terminal.ready" }]],
    ["unexpected fields", [{ ...chunk(), title: secret }]],
    [
      "oversized ciphertext",
      [{ ...chunk(), protectedContent: opaque(CUA_CHUNK_BYTES + 17) }],
    ],
  ])("rejects %s chunks with a fixed error", async (_name, events) => {
    const fixture = setup();
    fixture.request.mockImplementation(async (_workerId, _command, options) => {
      for (const event of events) await emit(options, event);
      return result();
    });
    const response = await fixture.send();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Computer-use request failed." });
  });

  it("accepts exactly the maximum chunk count and size", async () => {
    const fixture = setup();
    const protectedContent = opaque(CUA_CHUNK_BYTES + 16);
    fixture.request.mockImplementation(async (_workerId, _command, options) => {
      for (let sequence = 0; sequence < CUA_MAX_CHUNKS; sequence += 1) {
        await emit(options, { ...chunk(sequence), protectedContent });
      }
      return result();
    });
    const response = await fixture.send();
    expect(response.statusCode).toBe(200);
    const parsed = response.json();
    expect(parsed.chunks).toHaveLength(CUA_MAX_CHUNKS);
    expect(parsed.chunks.at(-1)).toEqual({
      ...chunk(CUA_MAX_CHUNKS - 1),
      protectedContent,
    });
  });

  it("rejects a sixty-fifth chunk and releases the accumulator for later requests", async () => {
    const fixture = setup();
    let staleOptions: WorkerRequestOptions | undefined;
    fixture.request.mockImplementationOnce(
      async (_workerId, _command, options) => {
        staleOptions = options;
        for (let sequence = 0; sequence <= CUA_MAX_CHUNKS; sequence += 1) {
          await emit(options, chunk(sequence));
        }
        return result();
      },
    );
    expect((await fixture.send()).statusCode).toBe(502);
    await expect(emit(staleOptions, chunk())).resolves.toBeUndefined();
    const response = await fixture.send(body("capabilities.get"));
    expect(response.json()).toEqual({ response: result(), chunks: [] });
  });

  it("rejects image chunks accompanying a non-snapshot operation", async () => {
    const fixture = setup();
    fixture.request.mockImplementation(async (_workerId, _command, options) => {
      await emit(options, chunk());
      return result();
    });
    expect((await fixture.send(body("targets.list"))).statusCode).toBe(502);
  });

  it.each([
    ["wrong correlation", { ...result(), operationId: otherOperationId }],
    ["plaintext details", { ...result(), title: secret }],
    [
      "oversized metadata",
      { ...result(), protectedContent: opaque(CUA_CONTROL_BYTES + 17) },
    ],
  ])("rejects %s in final metadata", async (_name, finalResponse) => {
    const fixture = setup();
    fixture.request.mockResolvedValue(finalResponse);
    const response = await fixture.send();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Computer-use request failed." });
  });

  it("does not mistake missing chunks for verified plaintext metadata", async () => {
    const fixture = setup();
    const response = await fixture.send();
    // Only the client knows the sealed manifest's chunk count. The relay sends
    // opaque data faithfully; the client must reject an incomplete snapshot.
    expect(response.json()).toEqual({ response: result(), chunks: [] });
  });

  it("returns fixed errors for invalid JSON and oversized request bodies", async () => {
    const fixture = setup();
    const malformed = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: `{${secret}`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: "Invalid computer-use request.",
    });
    const oversized = await fixture.send({
      ...body(),
      padding: "x".repeat(128 * 1024),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({
      error: "Invalid computer-use request.",
    });
    expect(fixture.request).not.toHaveBeenCalled();
  });
});
import { EventEmitter } from "node:events";
