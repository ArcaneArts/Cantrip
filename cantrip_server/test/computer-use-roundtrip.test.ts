import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
// Client-side codec in this test only. The production server imports no crypto
// and receives neither the component key nor plaintext native content.
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
  type CuaScope,
} from "@cantrip/protocol/computer-use";
import { CantripCuaService } from "../../cantrip_worker/src/computer-use/service.js";
import {
  CuaAuthorizationError,
  handleComputerUseOperation,
} from "../../cantrip_worker/src/computer-use/handler.js";
import { launchCuaTransport } from "../../cantrip_worker/src/computer-use/transport.js";
import {
  installComputerUseRoutes,
  type ComputerUseRouteDependencies,
} from "../src/app/routes/computer-use.js";
import type { ChatExecutionContext } from "../src/db/repository.js";

const scope: CuaScope = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  taskId: "task",
  threadId: "thread",
  turnId: "turn",
};
const target = { targetId: "fake-window", targetGeneration: 1 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function setup() {
  const logs: string[] = [];
  const wire: string[] = [];
  const app = Fastify({
    logger: { stream: { write: (line: string) => logs.push(line) } },
  });
  const launch = vi.fn(launchCuaTransport);
  const service = new CantripCuaService({
    workerId: scope.workerId,
    binary: process.env.CANTRIP_CUA_TEST_BINARY,
    args: ["--backend", "fake"],
    launch,
  });
  cleanups.push(async () => {
    await app.close();
    await service.close();
  });
  // Synthetic per-test key only, never loaded from a profile or native vault.
  const key = new Uint8Array(32).fill(47);
  const encryption = {
    ownerId: () => scope.ownerId,
    serverIdentity: () => scope.serverId,
    componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
  };
  const lifetime = new AbortController();
  const execution = {
    scope: { ...scope },
    executionLaneId: "lane",
    signal: lifetime.signal,
  };
  const authorize = vi.fn(async () => {});
  const authorizeServer = vi.fn(async () => {});
  const context = {
    chatId: scope.chatId,
    workerId: scope.workerId,
    executionLaneId: "lane",
  } as ChatExecutionContext;
  const request: ComputerUseRouteDependencies["bridge"]["request"] = async (
    workerId,
    command,
    options,
  ) => {
    expect(workerId).toBe(scope.workerId);
    if (command.type !== "computer-use.operation")
      throw new Error("Unexpected command");
    wire.push(JSON.stringify(command));
    const response = await handleComputerUseOperation(
      command,
      async (event) => {
        wire.push(JSON.stringify(event));
        await options?.onEvent?.(event);
      },
      {
        workerId,
        service,
        encryption,
        resolveExecution: async () => execution,
        authorize,
      },
    );
    wire.push(JSON.stringify(response));
    return response;
  };
  installComputerUseRoutes(app, {
    applicationOwnerId: () => scope.ownerId,
    serverId: scope.serverId,
    repository: {
      getChatExecutionContext: async (owner, chat) =>
        owner === scope.ownerId && chat === scope.chatId ? context : null,
    },
    bridge: { request },
    authorize: authorizeServer,
  });
  const open = (
    context: Parameters<typeof decryptEndpointContentPayload>[0]["context"],
    opaque: Parameters<typeof decryptEndpointContentPayload>[0]["opaque"],
  ) =>
    decryptEndpointContentPayload({
      ownerId: scope.ownerId,
      context,
      keyRevision: 1,
      componentKey: key,
      opaque,
    });
  async function send(
    action: ComputerUseAction,
    mutate?: (body: ComputerUseRequest) => void,
  ) {
    const context = {
      serverId: scope.serverId,
      workerId: scope.workerId,
      chatId: scope.chatId,
      operationId: randomUUID(),
      operation: action.operation,
    };
    const body = await protectComputerUseRequest({
      context,
      request: action,
      seal: (context, plaintext) =>
        encryptEndpointContentPayload({
          ownerId: scope.ownerId,
          context,
          keyRevision: 1,
          componentKey: key,
          plaintext,
        }),
    });
    mutate?.(body);
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${scope.chatId}/computer-use/operation`,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    const opaque = computerUseHttpResultSchema.parse(response.json());
    return {
      ...(await openComputerUseResult({
        context,
        opaque: opaque.response,
        chunks: opaque.chunks,
        open,
      })),
      context,
      opaque,
    };
  }
  async function session() {
    const opened = await send({ operation: "session.open", ...target });
    expect(opened.result.status).toBe("ok");
    if (opened.result.status !== "ok") throw new Error("Session not opened");
    return cuaSessionResultSchema.parse(opened.result.data).session.binding
      .sessionId;
  }
  return {
    app,
    service,
    launch,
    logs,
    wire,
    send,
    session,
    execution,
    authorize,
    authorizeServer,
    open,
    lifetime,
  };
}

// Only the explicit CUA command builds and supplies a Rust artifact. Normal
// server tests never compile Rust or request native Screen Recording access.
describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "protected client/server/worker/actual Rust round trip",
  () => {
    it("opens, configures all cursor styles, moves, captures authenticated PNGs, and stops", async () => {
      const f = setup();
      expect(f.launch).not.toHaveBeenCalled();
      const inventory = await f.send({ operation: "targets.list" });
      expect(inventory.result).toMatchObject({
        status: "ok",
        data: {
          targets: expect.arrayContaining([
            expect.objectContaining({ id: target.targetId }),
          ]),
        },
      });
      const sessionId = await f.session();
      let previousHash: string | undefined;
      for (const style of ["arrow", "dot", "ring", "crosshair"] as const) {
        const appearance = {
          version: 1 as const,
          style,
          color: "#F812BA",
          size: 32,
          label: "Private agent label",
          trail: true,
          visible: true,
        };
        const configured = await f.send({
          operation: "cursor.configure",
          sessionId,
          ...target,
          appearance,
        });
        expect(configured.result).toMatchObject({
          status: "ok",
          data: { session: { cursor: { appearance } } },
        });
        expect(
          (
            await f.send({
              operation: "cursor.move",
              sessionId,
              ...target,
              position: { x: 35, y: 40 },
            })
          ).result.status,
        ).toBe("ok");
        const snapshot = await f.send({
          operation: "observation.snapshot",
          sessionId,
          ...target,
        });
        expect(snapshot.result).toMatchObject({
          status: "ok",
          data: { image: { width: 320, height: 200, cursorIncluded: true } },
        });
        expect(Array.from(snapshot.payload!.slice(0, 8))).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
        const hash = createHash("sha256")
          .update(snapshot.payload!)
          .digest("hex");
        expect(hash).not.toBe(previousHash);
        previousHash = hash;
        expect(f.wire.join("\n")).not.toContain("Private agent label");
        expect(f.wire.join("\n")).not.toContain("fake-window");
        expect(f.wire.join("\n")).not.toContain(
          Buffer.from(snapshot.payload!).toString("base64"),
        );
        snapshot.payload!.fill(0);
      }
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(
        (await f.send({ operation: "session.close", sessionId })).result,
      ).toMatchObject({ status: "ok", data: { closed: true } });
      expect(f.service.status().sessions).toBe(0);
      expect(f.logs.join("\n")).not.toContain("Private agent label");
    });

    it("returns protected denial without launching the helper", async () => {
      const f = setup();
      f.authorize.mockRejectedValue(
        new CuaAuthorizationError("approval-required"),
      );
      expect(
        (await f.send({ operation: "targets.list" })).result,
      ).toMatchObject({ status: "error", code: "approval-required" });
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.wire.join("\n")).not.toContain("approval-required");
    });

    it("cancels pending approval on execution revocation without sending a delayed action", async () => {
      const f = setup();
      let entered!: () => void;
      let allow!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.authorize.mockImplementation(() => {
        entered();
        return new Promise<void>((resolve) => {
          allow = resolve;
        });
      });
      const pending = f.send({ operation: "session.open", ...target });
      await waiting;
      f.lifetime.abort();
      expect((await pending).result).toMatchObject({
        status: "error",
        code: "cancelled",
        outcome: "not-sent",
      });
      allow();
      await Promise.resolve();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.service.status().sessions).toBe(0);
    });

    it.each(["ownerId", "workerId", "chatId", "serverId"] as const)(
      "rejects trusted-scope mismatch in %s",
      async (field) => {
        const f = setup();
        f.execution.scope[field] = "other";
        expect(
          (await f.send({ operation: "targets.list" })).result,
        ).toMatchObject({ status: "error", code: "ownership-mismatch" });
        expect(f.launch).not.toHaveBeenCalled();
      },
    );

    it("rejects a relocated execution lane", async () => {
      const f = setup();
      f.execution.executionLaneId = "other";
      expect(
        (await f.send({ operation: "targets.list" })).result,
      ).toMatchObject({ status: "error", code: "ownership-mismatch" });
      expect(f.launch).not.toHaveBeenCalled();
    });

    it("does not allow a replaced task, thread, or turn to access a session", async () => {
      const f = setup();
      const sessionId = await f.session();
      for (const field of ["taskId", "threadId", "turnId"] as const) {
        f.execution.scope[field] = "replacement";
        expect(
          (await f.send({ operation: "session.state", sessionId })).result,
        ).toMatchObject({ status: "error", code: "ownership-mismatch" });
        f.execution.scope[field] = scope[field];
      }
    });

    it("allows scoped Stop after approval revocation without launching or asking again", async () => {
      const f = setup();
      const sessionId = await f.session();
      f.authorize
        .mockClear()
        .mockRejectedValue(new CuaAuthorizationError("approval-required"));
      f.authorizeServer.mockClear().mockRejectedValue(new Error("Revoked"));
      f.lifetime.abort();
      expect(
        (await f.send({ operation: "session.close", sessionId })).result.status,
      ).toBe("ok");
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.authorizeServer).not.toHaveBeenCalled();
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.service.status().sessions).toBe(0);
    });

    it("rejects sealed capture disguised as public Stop before the helper launches", async () => {
      const f = setup();
      // Build a capture request but replace only its public routing hint.
      await expect(
        f.send({ operation: "targets.list" }, (body) => {
          body.operation = "session.close";
        }),
      ).rejects.toThrow();
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
    });

    it("rejects a missing image chunk rather than returning partial pixels", async () => {
      const f = setup();
      const sessionId = await f.session();
      const snapshot = await f.send({
        operation: "observation.snapshot",
        sessionId,
        ...target,
      });
      await expect(
        openComputerUseResult({
          context: snapshot.context,
          opaque: snapshot.opaque.response,
          chunks: [],
          open: f.open,
        }),
      ).rejects.toThrow();
      snapshot.payload!.fill(0);
    });
  },
);
