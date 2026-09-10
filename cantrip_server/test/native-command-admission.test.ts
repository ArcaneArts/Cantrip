import { createTaskGoalRuntime } from "../src/app/runtime/task-goal-runtime.js";
import { installChatGoalRoutes } from "../src/app/routes/chat-goals.js";
import { installChatExecutionControlRoutes } from "../src/app/routes/chat-execution-control.js";
import { installChatAutomationPauseRoute } from "../src/app/routes/chat-automation-pause.js";
import Fastify from "fastify";
import { installInternalNativeCommandRoutes } from "../src/app/routes/internal-native-commands.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  nativeCommandAdmissionSchema,
  queuedPromptOpaqueContentSchema,
  type ManagedQueueMutation,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-command-repository-"),
);
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "test-worker-token",
};

function opaqueMessage(role: "assistant" | "user", id = randomUUID()) {
  return {
    id,
    classification: {
      role,
      mode: "default" as const,
      attachmentIds: [],
    },
    protectedContent: {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
    reasoningEffort: null,
    idempotencyKey: `message:${id}`,
  };
}

let database: DatabaseConnection;
let chatId: string;
const workerId = "chat-turn-retry-worker";

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureLocalIdentity();
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );

  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId,
    name: "Chat turn retry worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.149.0",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId,
    ...protectedProjectFields(),
    repositoryBlindIndex: "R".repeat(43),
    repositoryId: "chat-turn-retry-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    workerId,
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const chat = await database.repository.createChat(LOCAL_USER_ID, project.id, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create retry repository test chat.");
  chatId = chat.id;
  const boot = await database.repository.startChatExecutionLane(
    LOCAL_USER_ID,
    chatId,
    "user",
    "Fixture native session",
  );
  if (!boot?.executionLaneId) throw new Error("Missing fixture lane");
  await database.repository.updateChatExecutionLaneRuntime(
    chatId,
    boot.executionLaneId,
    "native-thread",
    "ready",
  );
  await database.repository.finishChatExecutionLane(
    chatId,
    boot.executionLaneId,
    "idle",
  );
}, 60_000);

afterAll(async () => {
  await database?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

function admission(
  context: Awaited<
    ReturnType<typeof database.repository.getChatExecutionContext>
  >,
  overrides: Record<string, unknown> = {},
) {
  if (!context) throw new Error("Missing fixture context");
  return nativeCommandAdmissionSchema.parse({
    workerId,
    operationId: randomUUID(),
    origin: "terminal",
    method: "turn/start",
    session: {
      chatId,
      threadId: context.threadId,
      contextKind: context.contextKind,
      projectId: context.projectId,
      placementId: context.worktreeId ?? context.scratchRootId,
      modelRouteId: context.modelRouteId,
      providerAccountId: context.providerAccountId,
      runtimeGeneration: "runtime-one",
      connectionId: "view-one",
    },
    payloadDigest: "a".repeat(64),
    protectedPayload: opaqueMessage("user").protectedContent.envelope,
    expectedActivationGeneration: null,
    intent: { scope: "thread", settingKeys: [], expectedTurnId: null },
    ...overrides,
  });
}
async function dispatch(
  input: ReturnType<typeof admission>,
  receipt: { operationGeneration: string },
) {
  return database.repository.nativeCommands.dispatch(LOCAL_USER_ID, {
    workerId,
    operationId: input.operationId,
    operationGeneration: receipt.operationGeneration,
    payloadDigest: input.payloadDigest,
    session: input.session,
  });
}
async function finish(
  input: ReturnType<typeof admission>,
  receipt: { operationGeneration: string },
  status: "applied" | "rejected" | "uncertain" = "applied",
) {
  return database.repository.nativeCommands.settle(LOCAL_USER_ID, {
    workerId,
    operationId: input.operationId,
    operationGeneration: receipt.operationGeneration,
    status,
    resultDigest: null,
    protectedResult: null,
    rejectionCode: null,
    executionComplete: true,
  });
}

describe("durable native command admission", () => {
  it("recovers only the exact terminal turn observed by a replacement runtime", async () => {
    const repository = database.repository;
    const commands = repository.nativeCommands;
    const input = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const accepted = await commands.admit(LOCAL_USER_ID, input);
    await dispatch(input, accepted.receipt);
    await commands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: input.operationId,
      operationGeneration: accepted.receipt.operationGeneration,
      status: "applied",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: "recovery-turn",
        runtimeGeneration: "runtime-one",
      },
    });
    const expected = (await commands.recoveryContext(LOCAL_USER_ID, chatId))!;
    expect(expected.turnId).toBe("recovery-turn");
    const observed = {
      threadId: input.session.threadId!,
      turnId: expected.turnId,
      runtimeGeneration: "runtime-two",
      status: "interrupted" as const,
    };
    for (const invalid of [
      { ...observed, threadId: "other-thread" },
      { ...observed, turnId: "other-turn" },
      { ...observed, runtimeGeneration: "runtime-one" },
      { ...observed, status: "inProgress" as const },
      { ...observed, status: null },
    ]) {
      expect(
        await commands.recoverExecution(
          LOCAL_USER_ID,
          workerId,
          expected,
          invalid,
        ),
      ).toBe(false);
      expect(
        (await commands.controlContext(LOCAL_USER_ID, chatId))
          .activationGeneration,
      ).toBe(accepted.receipt.activationGeneration);
    }
    expect(
      await commands.recoverExecution(
        LOCAL_USER_ID,
        workerId,
        expected,
        observed,
      ),
    ).toBe(true);
    expect(await commands.recoveryContext(LOCAL_USER_ID, chatId)).toBeNull();
    expect(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))?.status,
    ).toBe("idle");
    const next = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const successor = await commands.admit(LOCAL_USER_ID, next);
    await dispatch(next, successor.receipt);
    await commands.recoverExecution(
      LOCAL_USER_ID,
      workerId,
      expected,
      observed,
    );
    expect(
      (await commands.controlContext(LOCAL_USER_ID, chatId))
        .activationGeneration,
    ).toBe(successor.receipt.activationGeneration);
    await finish(next, successor.receipt);
  });

  it("atomically arbitrates GUI and TUI starts, preserves idempotency, and fences reused lanes", async () => {
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    );
    const terminal = admission(context);
    const gui = admission(context, { origin: "gui" });
    const [a, b] = await Promise.all([
      database.repository.nativeCommands.admit(LOCAL_USER_ID, terminal),
      database.repository.nativeCommands.admit(LOCAL_USER_ID, gui),
    ]);
    expect([a.receipt.status, b.receipt.status].sort()).toEqual([
      "accepted",
      "rejected",
    ]);
    const winner = a.receipt.status === "accepted" ? terminal : gui;
    const accepted = a.receipt.status === "accepted" ? a : b;
    const again = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      winner,
    );
    expect(again.receipt).toEqual(accepted.receipt);
    await expect(
      database.repository.nativeCommands.admit(LOCAL_USER_ID, {
        ...winner,
        payloadDigest: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "operation-id-conflict" });
    const sent = await dispatch(winner, accepted.receipt);
    expect(sent.receipt.status).toBe("dispatched");
    await expect(dispatch(winner, accepted.receipt)).rejects.toMatchObject({
      code: "operation-already-dispatched",
    });
    await finish(winner, accepted.receipt);
    const next = admission(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const admittedNext = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      next,
    );
    expect(admittedNext.receipt.status).toBe("accepted");
    expect(admittedNext.receipt.executionLaneId).toBe(
      accepted.receipt.executionLaneId,
    );
    expect(admittedNext.receipt.activationGeneration).not.toBe(
      accepted.receipt.activationGeneration,
    );
    const staleControl = admission(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      {
        method: "turn/interrupt",
        expectedActivationGeneration: accepted.receipt.activationGeneration,
      },
    );
    expect(
      (
        await database.repository.nativeCommands.admit(
          LOCAL_USER_ID,
          staleControl,
        )
      ).receipt,
    ).toMatchObject({ status: "rejected", rejectionCode: "stale-activation" });
    await finish(winner, accepted.receipt);
    expect(
      (await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId))
        ?.status,
    ).toBe("running");
    await finish(next, admittedNext.receipt, "rejected");
  });

  it("accepts Stop independently during work and consumes a pending reply once across views", async () => {
    const start = admission(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const accepted = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      start,
    );
    await dispatch(start, accepted.receipt);
    const active = accepted.receipt.activationGeneration!;
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    );
    const stop = admission(context, {
      method: "turn/interrupt",
      expectedActivationGeneration: active,
    });
    expect(
      (await database.repository.nativeCommands.admit(LOCAL_USER_ID, stop))
        .receipt.status,
    ).toBe("accepted");
    const pending = {
      workerId,
      session: start.session,
      activationGeneration: active,
      nativeRequestId: "request-1",
      requestMethod: "item/commandExecution/requestApproval",
      turnId: "turn-1",
    };
    await database.repository.nativeCommands.registerPending(
      LOCAL_USER_ID,
      pending,
    );
    const answer = admission(context, {
      method: "serverRequest/reply",
      expectedActivationGeneration: active,
      reply: {
        nativeRequestId: pending.nativeRequestId,
        requestMethod: pending.requestMethod,
        turnId: pending.turnId,
      },
    });
    const first = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      answer,
    );
    const second = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      {
        ...answer,
        operationId: randomUUID(),
        session: { ...answer.session, connectionId: "view-two" },
      },
    );
    expect(first.receipt.status).toBe("accepted");
    expect(second.receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "stale-native-reply",
    });
    await finish(start, accepted.receipt);
  });

  it("persists rejected policy receipts, rejects foreign identity, and never replays uncertain dispatch", async () => {
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    );
    const unsupported = admission(context, { method: "account/logout" });
    expect(
      (
        await database.repository.nativeCommands.admit(
          LOCAL_USER_ID,
          unsupported,
        )
      ).receipt,
    ).toMatchObject({
      status: "rejected",
      rejectionCode: "unsupported-mutation",
    });
    const wrong = admission(context);
    await expect(
      database.repository.nativeCommands.admit(LOCAL_USER_ID, {
        ...wrong,
        session: { ...wrong.session, placementId: "other-placement" },
      }),
    ).rejects.toMatchObject({ code: "stale-placement" });
    const start = admission(context);
    const accepted = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      start,
    );
    await dispatch(start, accepted.receipt);
    await finish(start, accepted.receipt, "uncertain");
    expect(
      (await database.repository.nativeCommands.admit(LOCAL_USER_ID, start))
        .receipt.status,
    ).toBe("uncertain");
    await expect(dispatch(start, accepted.receipt)).rejects.toMatchObject({
      code: "operation-already-dispatched",
    });
  });
  it.each(["turn/start", "thread/goal/clear", "thread/goal/set"])(
    "returns the committed %s receipt while its successor dispatch remains pending",
    async (method) => {
      const app = Fastify();
      const repository = database.repository;
      let rejectDispatch!: (error: Error) => void;
      const dispatchPending = new Promise<void>((_resolve, reject) => {
        rejectDispatch = reject;
      });
      const dispatchNextQueuedPrompt = vi.fn(() => dispatchPending);
      const warning = vi.spyOn(app.log, "warn");
      installInternalNativeCommandRoutes(app, {
        config,
        serverId: "fixture-server",
        repository,
        dispatchNextQueuedPrompt,
        runAsOwner: async (_owner, operation) => operation(),
        live: {
          publishEncryptedChatMessage: () => {},
          publishTaskMessage: () => {},
          publishChatSummary: () => {},
          publishChatTurnBoundary: () => {},
          publishChatInvalidation: () => {},
        },
      });
      const input = admission(
        await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
        {
          method,
          ...(method === "thread/goal/set"
            ? {
                intent: {
                  scope: "thread",
                  settingKeys: [],
                  expectedTurnId: null,
                  goalStatus: "paused",
                },
              }
            : {}),
        },
      );
      const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
      expect(grant.receipt.status).toBe("accepted");
      await dispatch(input, grant.receipt);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          app.inject({
            method: "POST",
            url: "/api/internal/native-commands/receipt",
            headers: { authorization: `Bearer ${config.workerToken}` },
            payload: {
              workerId,
              operationId: input.operationId,
              operationGeneration: grant.receipt.operationGeneration,
              status: "applied",
              protectedResult: null,
              resultDigest: null,
              rejectionCode: null,
              executionComplete: method === "turn/start",
            },
          }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error("Native receipt waited for queued execution")),
              2000,
            );
          }),
        ]);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          receipt: { operationId: input.operationId, status: "applied" },
        });
        expect(dispatchNextQueuedPrompt).toHaveBeenCalledWith(chatId);
        expect(
          await repository.nativeCommands.get(
            LOCAL_USER_ID,
            workerId,
            input.operationId,
            grant.receipt.operationGeneration,
          ),
        ).toMatchObject({ status: "applied" });
        rejectDispatch(new Error("Fixture successor preparation failed"));
        await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
      } finally {
        if (timeout) clearTimeout(timeout);
        rejectDispatch(new Error("Fixture cleanup"));
        await app.close();
      }
    },
  );
  it("authenticates reverse calls and persists protected native events through the canonical repository", async () => {
    const app = Fastify();
    const repository = database.repository;
    installInternalNativeCommandRoutes(app, {
      config,
      serverId: "fixture-server",
      repository,
      dispatchNextQueuedPrompt: async () => {},
      runAsOwner: async (_owner, operation) => operation(),
      live: {
        publishEncryptedChatMessage: () => {},
        publishTaskMessage: () => {},
        publishChatSummary: () => {},
        publishChatTurnBoundary: () => {},
        publishChatInvalidation: () => {},
      },
    });
    try {
      const input = admission(
        await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/native-commands/admit",
            payload: input,
          })
        ).statusCode,
      ).toBe(401);
      const headers = { authorization: `Bearer ${config.workerToken}` };
      const admitted = await app.inject({
        method: "POST",
        url: "/api/internal/native-commands/admit",
        headers,
        payload: input,
      });
      expect(admitted.statusCode).toBe(200);
      const accepted = admitted.json();
      expect(accepted.receipt.status).toBe("accepted");
      const sent = await app.inject({
        method: "POST",
        url: "/api/internal/native-commands/dispatch",
        headers,
        payload: {
          workerId,
          operationId: input.operationId,
          operationGeneration: accepted.receipt.operationGeneration,
          payloadDigest: input.payloadDigest,
          session: input.session,
        },
      });
      expect(sent.statusCode).toBe(200);
      const eventBase = {
        workerId,
        operationId: input.operationId,
        operationGeneration: accepted.receipt.operationGeneration,
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/native-commands/events",
            headers,
            payload: {
              ...eventBase,
              event: {
                type: "agent.message",
                message: { text: "plaintext must never persist" },
              },
            },
          })
        ).statusCode,
      ).toBe(400);
      const message = opaqueMessage("user");
      const event = {
        ...eventBase,
        event: {
          type: "agent.protected-message",
          message,
          telemetry: { kind: "checkpoint", turnId: "native-http-turn" },
        },
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/native-commands/events",
            headers,
            payload: event,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await repository.listEncryptedMessages(LOCAL_USER_ID, chatId)).find(
          (row) => row.id === message.id,
        )?.protectedContent,
      ).toEqual(message.protectedContent);
      await finish(input, accepted.receipt);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/native-commands/events",
            headers,
            payload: event,
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("repairs an uncertain receipt only from the same active native turn without reopening dispatch", async () => {
    const input = admission(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const accepted = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      input,
    );
    await dispatch(input, accepted.receipt);
    const base = {
      workerId,
      operationId: input.operationId,
      operationGeneration: accepted.receipt.operationGeneration,
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
    };
    await database.repository.nativeCommands.settle(LOCAL_USER_ID, {
      ...base,
      status: "uncertain",
      reconciliation: {
        nativeTurnId: "turn-repair",
        runtimeGeneration: "runtime-one",
      },
    });
    await expect(
      database.repository.nativeCommands.settle(LOCAL_USER_ID, {
        ...base,
        status: "applied",
      }),
    ).rejects.toMatchObject({ code: "native-evidence-required" });
    await expect(
      database.repository.nativeCommands.settle(LOCAL_USER_ID, {
        ...base,
        status: "applied",
        reconciliation: {
          nativeTurnId: "wrong-turn",
          runtimeGeneration: "runtime-one",
        },
      }),
    ).rejects.toMatchObject({ code: "stale-native-evidence" });
    const repaired = await database.repository.nativeCommands.settle(
      LOCAL_USER_ID,
      {
        ...base,
        status: "applied",
        reconciliation: {
          nativeTurnId: "turn-repair",
          runtimeGeneration: "runtime-one",
        },
      },
    );
    expect(repaired.status).toBe("applied");
    await expect(dispatch(input, accepted.receipt)).rejects.toMatchObject({
      code: "operation-already-dispatched",
    });
    await finish(input, accepted.receipt);
  });

  it("binds the first GUI native thread at dispatch and cannot rebind it", async () => {
    const current = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    );
    if (!current?.projectId) throw new Error("Missing project");
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      current.projectId,
      { ...protectedChatFields(), worktreeMode: "agent-managed" },
    );
    if (!chat) throw new Error("Missing new chat");
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat.id,
    );
    if (!context) throw new Error("Missing new context");
    const input = admission(context, {
      origin: "gui",
      session: {
        chatId: chat.id,
        threadId: null,
        contextKind: context.contextKind,
        projectId: context.projectId,
        placementId: context.worktreeId ?? context.scratchRootId,
        modelRouteId: context.modelRouteId,
        providerAccountId: context.providerAccountId,
        runtimeGeneration: null,
        connectionId: null,
      },
    });
    const accepted = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      input,
    );
    expect(accepted.receipt.status).toBe("accepted");
    const session = {
      ...input.session,
      threadId: "first-gui-thread",
      runtimeGeneration: "gui-runtime",
      connectionId: "gui-view",
    };
    const sent = await database.repository.nativeCommands.dispatch(
      LOCAL_USER_ID,
      {
        workerId,
        operationId: input.operationId,
        operationGeneration: accepted.receipt.operationGeneration,
        payloadDigest: input.payloadDigest,
        session,
      },
    );
    expect(sent.execution?.threadId).toBe("first-gui-thread");
    expect(
      (
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        )
      )?.threadId,
    ).toBe("first-gui-thread");
    await finish(input, accepted.receipt);
    const wrong = {
      ...input,
      operationId: randomUUID(),
      session: { ...session, threadId: "replacement-thread" },
    };
    expect(
      (await database.repository.nativeCommands.admit(LOCAL_USER_ID, wrong))
        .receipt,
    ).toMatchObject({
      status: "rejected",
      rejectionCode: "thread-identity-mismatch",
    });
  });
  it("cancels an admitted preparation before dispatch and cannot cancel a reused activation", async () => {
    const input = admission(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const first = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      input,
    );
    expect(
      await database.repository.nativeCommands.cancelPreparing(
        LOCAL_USER_ID,
        chatId,
        first.receipt.activationGeneration!,
      ),
    ).toMatchObject({ workerId });
    await expect(dispatch(input, first.receipt)).rejects.toMatchObject({
      code: "cancelled-before-dispatch",
    });
    expect(
      (
        await database.repository.nativeCommands.get(
          LOCAL_USER_ID,
          workerId,
          input.operationId,
          first.receipt.operationGeneration,
        )
      ).status,
    ).toBe("rejected");
    const next = admission(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const second = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      next,
    );
    expect(second.receipt.executionLaneId).toBe(first.receipt.executionLaneId);
    expect(
      await database.repository.nativeCommands.cancelPreparing(
        LOCAL_USER_ID,
        chatId,
        first.receipt.activationGeneration!,
      ),
    ).toBeNull();
    await dispatch(next, second.receipt);
    expect(
      await database.repository.nativeCommands.cancelPreparing(
        LOCAL_USER_ID,
        chatId,
        second.receipt.activationGeneration!,
      ),
    ).toBeNull();
    await finish(next, second.receipt);
  });

  it("separates native scheduling from a fresh autonomous attempt and pins its native turn", async () => {
    for (const method of [
      "thread/queue/add",
      "thread/queue/start",
      "thread/goal/set",
    ]) {
      const request = admission(
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chatId,
        ),
        {
          method,
          intent: {
            scope: "thread",
            settingKeys: [],
            expectedTurnId: null,
            resumeAutonomy: true,
          },
        },
      );
      const grant = await database.repository.nativeCommands.admit(
        LOCAL_USER_ID,
        request,
      );
      expect(grant.receipt).toMatchObject({
        status: "accepted",
        startsExecution: false,
        activationGeneration: null,
        executionLaneId: null,
      });
      await dispatch(request, grant.receipt);
      await finish(request, grant.receipt);
    }
    const request = admission(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      {
        origin: "autonomous",
        intent: {
          scope: "thread",
          settingKeys: [],
          expectedTurnId: "native-autonomous-turn",
        },
      },
    );
    const grant = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      request,
    );
    expect(grant.receipt).toMatchObject({
      status: "accepted",
      startsExecution: true,
    });
    await dispatch(request, grant.receipt);
    const stop = admission(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      {
        method: "turn/interrupt",
        expectedActivationGeneration: grant.receipt.activationGeneration,
        intent: {
          scope: "thread",
          settingKeys: [],
          expectedTurnId: "previous-turn",
        },
      },
    );
    expect(
      (await database.repository.nativeCommands.admit(LOCAL_USER_ID, stop))
        .receipt,
    ).toMatchObject({ status: "rejected", rejectionCode: "stale-native-turn" });
    await finish(request, grant.receipt);
  });

  it("routes Stop by captured admission even when model selection is unavailable and cancels preparation without a worker", async () => {
    const app = Fastify();
    const request = vi.fn(async () => ({ interrupted: true }));
    const runtimeForContext = vi.fn(async () => null);
    installChatExecutionControlRoutes(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      repository: database.repository,
      bridge: { isConnected: () => true, request: request as never },
      runtimeForContext,
      publishChatSummary: () => {},
      interruptLiveAgentInteractionRequests: (...args) =>
        database.repository.interruptAgentInteractionRequests(...args),
    });
    try {
      const input = admission(
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chatId,
        ),
      );
      const preparing = await database.repository.nativeCommands.admit(
        LOCAL_USER_ID,
        input,
      );
      const stopped = await app.inject({
        method: "POST",
        url: `/api/chats/${chatId}/interrupt`,
      });
      expect(stopped.json()).toMatchObject({ interrupted: true });
      expect(request).not.toHaveBeenCalled();
      expect(runtimeForContext).not.toHaveBeenCalled();
      await expect(dispatch(input, preparing.receipt)).rejects.toMatchObject({
        code: "cancelled-before-dispatch",
      });
      const next = admission(
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chatId,
        ),
      );
      const active = await database.repository.nativeCommands.admit(
        LOCAL_USER_ID,
        next,
      );
      await dispatch(next, active.receipt);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/chats/${chatId}/interrupt`,
          })
        ).statusCode,
      ).toBe(200);
      expect(request).toHaveBeenCalledWith(workerId, {
        type: "chat.native-control",
        chatId,
        threadId: "native-thread",
        nativeActivationGeneration: active.receipt.activationGeneration,
        nativeRuntimeGeneration: next.session.runtimeGeneration,
        modelRouteId: next.session.modelRouteId,
        providerAccountId: next.session.providerAccountId,
        control: { kind: "interrupt" },
      });
      expect(runtimeForContext).not.toHaveBeenCalled();
      await finish(next, active.receipt);
    } finally {
      await app.close();
    }
  });

  it("notifies only the cancelled logical GUI root after committing preparation cancellation", async () => {
    const repository = database.repository;
    const input = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "gui" },
    );
    const root = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    await dispatch(input, root.receipt);
    const retry = await repository.nativeCommands.continueExecution(
      LOCAL_USER_ID,
      {
        workerId,
        rootOperationId: input.operationId,
        previousOperationId: input.operationId,
        previousOperationGeneration: root.receipt.operationGeneration,
        operationId: randomUUID(),
        payloadDigest: "e".repeat(64),
        protectedPayload: input.protectedPayload,
        session: input.session,
        reason: "capacity",
        failure: {
          kind: "native-terminal",
          nativeTurnId: "cancelled-retry-prior-turn",
          runtimeGeneration: input.session.runtimeGeneration!,
        },
      },
    );
    let replacement: Awaited<
      ReturnType<typeof repository.nativeCommands.admit>
    > | null = null;
    let replacementInput: ReturnType<typeof admission> | null = null;
    const request = vi.fn(async (_worker: string, command: unknown) => {
      expect(command).toEqual({
        type: "chat.native-logical.cancel",
        chatId,
        rootOperationId: input.operationId,
        rootOperationGeneration: root.receipt.operationGeneration,
      });
      expect(
        (
          await repository.nativeCommands.get(
            LOCAL_USER_ID,
            workerId,
            retry.receipt.operationId,
            retry.receipt.operationGeneration,
          )
        ).status,
      ).toBe("rejected");
      expect(
        (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
          .activationGeneration,
      ).toBeNull();
      replacementInput = admission(
        await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
        { origin: "gui" },
      );
      replacement = await repository.nativeCommands.admit(
        LOCAL_USER_ID,
        replacementInput,
      );
      // Delivery failure cannot undo the committed cancellation or cancel a newer root.
      throw new Error("Fixture notification transport disconnected");
    });
    const app = Fastify();
    installChatExecutionControlRoutes(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      repository,
      bridge: { isConnected: () => true, request: request as never },
      runtimeForContext: async () => {
        throw new Error("Stop must not resolve a model");
      },
      routePairsForConfiguration: async () => [],
      publishChatSummary: () => {},
      interruptLiveAgentInteractionRequests: (...args) =>
        repository.interruptAgentInteractionRequests(...args),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/chats/${chatId}/interrupt`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ interrupted: true });
      expect(request).toHaveBeenCalledOnce();
      expect(
        (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
          .activationGeneration,
      ).toBe(replacement!.receipt.activationGeneration);
      await expect(
        repository.nativeCommands.dispatch(LOCAL_USER_ID, {
          workerId,
          operationId: retry.receipt.operationId,
          operationGeneration: retry.receipt.operationGeneration,
          payloadDigest: "e".repeat(64),
          session: input.session,
        }),
      ).rejects.toMatchObject({ code: "cancelled-before-dispatch" });
    } finally {
      await app.close();
      if (replacement && replacementInput)
        await finish(replacementInput, replacement.receipt, "rejected");
    }
  });
  it("commits authorized unpause before a native resume can request its next execution", async () => {
    const app = Fastify();
    const repository = database.repository;
    await repository.setChatAutomationPaused(LOCAL_USER_ID, chatId, true);
    let observed = false;
    installChatAutomationPauseRoute(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      repository,
      publishChatSummary: () => {},
      resumeChatAutomation: async () => {},
      bridge: {
        isConnected: () => true,
        request: (async (
          _worker: string,
          command: {
            type: string;
            control?: { kind: string; paused: boolean };
          },
        ) => {
          expect(command).toMatchObject({
            type: "chat.pause.set",
            paused: false,
          });
          const context = await repository.getChatExecutionContext(
            LOCAL_USER_ID,
            chatId,
          );
          expect(context?.automationPaused).toBe(false);
          const input = admission(context, { origin: "autonomous" });
          const grant = await repository.nativeCommands.admit(
            LOCAL_USER_ID,
            input,
          );
          expect(grant.receipt.status).toBe("accepted");
          observed = true;
          await finish(input, grant.receipt, "rejected");
          return { paused: false, active: null };
        }) as never,
      },
    });
    try {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/chats/${chatId}/pause`,
            payload: { paused: false },
          })
        ).statusCode,
      ).toBe(200);
      expect(observed).toBe(true);
    } finally {
      await app.close();
    }
  });

  it.each([true, false])(
    "does not overwrite a newer native pause intent when paused=%s acknowledges late",
    async (firstPaused) => {
      const repository = database.repository;
      const start = admission(
        await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      );
      const active = await repository.nativeCommands.admit(
        LOCAL_USER_ID,
        start,
      );
      await dispatch(start, active.receipt);
      await repository.setChatAutomationPaused(
        LOCAL_USER_ID,
        chatId,
        !firstPaused,
      );
      const app = Fastify();
      let release!: () => void;
      const boundary = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      let firstDispatched = false;
      const resume = vi.fn(async () => {});
      installChatAutomationPauseRoute(app, {
        applicationOwnerId: () => LOCAL_USER_ID,
        repository,
        publishChatSummary: () => {},
        resumeChatAutomation: resume,
        bridge: {
          isConnected: () => true,
          request: (async (
            _worker: string,
            command: {
              type: string;
              control: { kind: string; paused: boolean };
            },
          ) => {
            expect(command.type).toBe("chat.native-control");
            const first = ++calls === 1;
            const paused = command.control.paused;
            const input = admission(
              await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
              {
                method: "turn/pause",
                origin: "gui",
                expectedActivationGeneration:
                  active.receipt.activationGeneration,
                intent: {
                  scope: "thread",
                  settingKeys: [],
                  expectedTurnId: null,
                  paused,
                  resumeAutonomy: !paused,
                },
              },
            );
            const grant = await repository.nativeCommands.admit(
              LOCAL_USER_ID,
              input,
            );
            expect(grant.receipt.status).toBe("accepted");
            await dispatch(input, grant.receipt);
            if (first) {
              firstDispatched = true;
              await boundary;
            }
            await repository.nativeCommands.settle(LOCAL_USER_ID, {
              workerId,
              operationId: input.operationId,
              operationGeneration: grant.receipt.operationGeneration,
              status: "applied",
              resultDigest: null,
              protectedResult: null,
              rejectionCode: null,
              executionComplete: false,
            });
            return {
              paused,
              active: {
                threadId: start.session.threadId,
                turnId: "pause-fixture",
              },
            };
          }) as never,
        },
      });
      let pending: Promise<unknown> | undefined;
      try {
        const older = app
          .inject({
            method: "PATCH",
            url: `/api/chats/${chatId}/pause`,
            payload: { paused: firstPaused },
          })
          .then((response) => response);
        pending = older;
        await vi.waitFor(() => expect(firstDispatched).toBe(true));
        const newer = await app.inject({
          method: "PATCH",
          url: `/api/chats/${chatId}/pause`,
          payload: { paused: !firstPaused },
        });
        expect(newer.statusCode, newer.body).toBe(200);
        release();
        const late = await older;
        expect(late.statusCode, late.body).toBe(200);
        expect(
          (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))
            ?.automationPaused,
        ).toBe(!firstPaused);
        expect(late.json()).toEqual({ paused: !firstPaused });
        expect(resume).toHaveBeenCalledTimes(firstPaused ? 1 : 0);
      } finally {
        release();
        await pending;
        await app.close();
        await finish(start, active.receipt);
        await repository.setChatAutomationPaused(LOCAL_USER_ID, chatId, false);
      }
    },
  );

  it("fences canonical route changes between admission and native dispatch", async () => {
    const repository = database.repository;
    const context = await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    );
    const input = admission(context);
    const forged = {
      ...input,
      operationId: randomUUID(),
      session: { ...input.session, providerAccountId: "unbound-account" },
    };
    expect(
      (await repository.nativeCommands.admit(LOCAL_USER_ID, forged)).receipt,
    ).toMatchObject({
      status: "rejected",
      rejectionCode: "runtime-route-mismatch",
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    expect(grant.receipt.status).toBe("accepted");
    const runtime = (await repository.getModelRuntimes(LOCAL_USER_ID))[0];
    if (!runtime || !context)
      throw new Error("Missing configured fixture route");
    expect(runtime.routeId).not.toBe(input.session.modelRouteId);
    await repository.updateChatRuntime(
      chatId,
      workerId,
      context.worktreeId,
      context.threadId,
      runtime.routeId,
      "ready",
      null,
    );
    await expect(dispatch(input, grant.receipt)).rejects.toMatchObject({
      code: "runtime-route-mismatch",
    });
    const changed = {
      ...input,
      session: { ...input.session, modelRouteId: runtime.routeId },
    };
    await expect(dispatch(changed, grant.receipt)).rejects.toMatchObject({
      code: "runtime-route-mismatch",
    });
    expect(
      (await repository.nativeCommands.admit(LOCAL_USER_ID, input)).execution,
    ).toBeNull();
    expect(
      (
        await repository.nativeCommands.get(
          LOCAL_USER_ID,
          workerId,
          input.operationId,
          grant.receipt.operationGeneration,
        )
      ).status,
    ).toBe("accepted");
    await finish(input, grant.receipt, "rejected");
  });
  it("sends full managed child configuration for goal resume, clear and compaction without a synthetic GUI turn", async () => {
    const repository = database.repository;
    const runtime = (await repository.getModelRuntimes(LOCAL_USER_ID))[0]!;
    const child = {
      ...runtime,
      model: { ...runtime.model, name: "fixture-custom-child" },
    };
    const beginTurn = vi.fn();
    const request = vi.fn(async (_worker, command) =>
      command.type === "chat.goal.clear"
        ? { cleared: true }
        : command.type === "chat.compact"
          ? { accepted: true }
          : {
              goal: {
                threadId: "native-thread",
                objective: "Fixture goal",
                status: "active",
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            },
    );
    const routePairsForConfiguration = vi.fn(async () => [
      { root: { runtime }, subagent: { runtime: child } },
    ]);
    const app = Fastify();
    installChatGoalRoutes(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      repository,
      bridge: { isConnected: () => true, request },
      beginTurn,
      runtimeForContext: async () => runtime,
      routePairsForConfiguration,
    } as never);
    installChatExecutionControlRoutes(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      repository,
      bridge: { isConnected: () => true, request },
      runtimeForContext: async () => runtime,
      routePairsForConfiguration,
      publishChatSummary: vi.fn(),
      interruptLiveAgentInteractionRequests: vi.fn(),
    } as never);
    try {
      const resumed = await app.inject({
        method: "PATCH",
        url: `/api/chats/${chatId}/goal`,
        payload: { status: "active" },
      });
      expect(resumed.statusCode, resumed.body).toBe(200);
      const cleared = await app.inject({
        method: "DELETE",
        url: `/api/chats/${chatId}/goal`,
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      const compacted = await app.inject({
        method: "POST",
        url: `/api/chats/${chatId}/compact`,
      });
      expect(compacted.statusCode, compacted.body).toBe(200);
      expect(request.mock.calls.map(([, command]) => command.type)).toEqual([
        "chat.goal.update",
        "chat.goal.clear",
        "chat.compact",
      ]);
      for (const [, command] of request.mock.calls)
        expect(command).toMatchObject({
          session: { contextKind: "project", chatId },
          threadId: "native-thread",
          mcpServers: [],
          subagentDefaults: { model: child.model, provider: child.provider },
        });
      expect(routePairsForConfiguration).toHaveBeenCalledTimes(3);
      expect(beginTurn).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("persists only protected managed goal input before native goal creation and does not start a GUI turn", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const runtime = (await repository.getModelRuntimes(LOCAL_USER_ID))[0]!;
    const child = {
      ...runtime,
      model: { ...runtime.model, name: "fixture-goal-child" },
    };
    const beginTurn = vi.fn();
    const dispatchNextQueuedPrompt = vi.fn();
    let protectedId = "";
    const request = vi.fn(async (_worker, command) => {
      if (command.type === "chat.message.protect") {
        expect(command.message.content).toEqual([
          { type: "text", text: "Private fixture goal" },
        ]);
        const value = opaqueMessage("user", command.message.id);
        protectedId = value.id;
        return {
          ...value,
          classification: { ...value.classification, mode: "goal" },
          idempotencyKey: command.message.idempotencyKey,
        };
      }
      if (command.type === "chat.automation.resume") return { resumed: true };
      if (command.type === "chat.goal.get")
        return {
          goal: {
            threadId: "native-thread",
            objective: "Private fixture goal",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        };
      expect(command.type).toBe("chat.goal.create");
      expect(command).toMatchObject({
        threadId: "native-thread",
        session: { chatId },
        subagentDefaults: { model: child.model },
        mcpServers: [],
      });
      const saved = await repository.getEncryptedMessageByIdempotencyKey(
        LOCAL_USER_ID,
        chatId,
        "fixture-native-goal-input",
      );
      expect(saved?.id).toBe(protectedId);
      expect(JSON.stringify(saved)).not.toContain("Private fixture goal");
      return {
        goal: {
          threadId: "native-thread",
          objective: "Private fixture goal",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    });
    const goals = createTaskGoalRuntime({
      app: { log: {} },
      applicationOwnerId: () => LOCAL_USER_ID,
      repository,
      bridge: { request, isConnected: () => true },
      continuePendingWorktreeTransition: async () => false,
      dispatchNextQueuedPrompt,
      runtimeForContext: async () => runtime,
      beginTurn,
      resolvePromptAttachments: async () => [],
      resolveModelId: async () => runtime.model.id,
      routePairsForConfiguration: async () => [
        { root: { runtime }, subagent: { runtime: child } },
      ],
      appendLiveEncryptedChatMessage: (...args) =>
        repository.appendEncryptedMessage(...args),
      taskMessageServerStub: (message) => ({ ...message, content: [] }),
      publishChatInvalidation: vi.fn(),
    } as never);
    try {
      const result = await goals.startGoalTurn(context, {
        text: "Private fixture goal",
        mode: "goal",
        attachmentIds: [],
        idempotencyKey: "fixture-native-goal-input",
      });
      expect(result.message.id).toBe(protectedId);
      expect(request.mock.calls.map(([, command]) => command.type)).toEqual([
        "chat.message.protect",
        "chat.goal.create",
      ]);
      expect(beginTurn).not.toHaveBeenCalled();
      const goalCommand = request.mock.calls[1]![1];
      expect(goalCommand.operationId).toBe(`gui-goal:${result.message.id}`);
      const operation = admission(
        await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
        { method: "thread/goal/set", operationId: goalCommand.operationId },
      );
      const admitted = await repository.nativeCommands.admit(
        LOCAL_USER_ID,
        operation,
      );
      const goalInput = {
        text: "Private fixture goal",
        mode: "goal" as const,
        attachmentIds: [],
        idempotencyKey: "fixture-native-goal-input",
      };
      await expect(goals.startGoalTurn(context, goalInput)).rejects.toThrow(
        "accepted",
      );
      await dispatch(operation, admitted.receipt);
      await repository.nativeCommands.settle(LOCAL_USER_ID, {
        workerId,
        operationId: operation.operationId,
        operationGeneration: admitted.receipt.operationGeneration,
        status: "applied",
        resultDigest: null,
        protectedResult: null,
        rejectionCode: null,
        executionComplete: false,
      });
      const replay = await goals.startGoalTurn(context, goalInput);
      expect(replay.message.id).toBe(result.message.id);
      expect(
        request.mock.calls.filter(
          ([, command]) => command.type === "chat.goal.create",
        ),
      ).toHaveLength(1);
      expect(request.mock.calls.at(-1)![1].type).toBe("chat.goal.get");
      await goals.resumeChatAutomation(chatId);
      expect(request.mock.calls.at(-1)![1]).toMatchObject({
        type: "chat.automation.resume",
        session: { chatId },
        subagentDefaults: { model: child.model },
        mcpServers: [],
      });
      expect(beginTurn).not.toHaveBeenCalled();
      expect(dispatchNextQueuedPrompt).not.toHaveBeenCalled();
    } finally {
      goals.close();
    }
  });

  it("binds rollback preparation to its accepted parent without dispatching the turn and preserves Stop cancellation", async () => {
    const repository = database.repository;
    const original = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "gui" },
    );
    const input = {
      ...original,
      session: {
        ...original.session,
        runtimeGeneration: null,
        connectionId: null,
      },
    };
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    const bound = {
      ...input,
      session: {
        ...input.session,
        runtimeGeneration: "preparation-runtime",
        connectionId: `gui:${grant.receipt.operationGeneration}`,
      },
    };
    const binding = {
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      payloadDigest: input.payloadDigest,
      session: bound.session,
    };
    expect(
      (await repository.nativeCommands.bindPreparation(LOCAL_USER_ID, binding))
        .status,
    ).toBe("accepted");
    expect(
      (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
        .runtimeGeneration,
    ).toBe("preparation-runtime");
    await expect(
      repository.nativeCommands.bindPreparation(LOCAL_USER_ID, {
        ...binding,
        session: { ...binding.session, runtimeGeneration: "replacement" },
      }),
    ).rejects.toMatchObject({ code: "stale-session" });
    const rollback = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      {
        method: "thread/rollback",
        session: bound.session,
        expectedActivationGeneration: grant.receipt.activationGeneration,
      },
    );
    const admittedRollback = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      rollback,
    );
    expect(admittedRollback.receipt.status).toBe("accepted");
    await dispatch(rollback, admittedRollback.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: rollback.operationId,
      operationGeneration: admittedRollback.receipt.operationGeneration,
      status: "applied",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
    });
    expect(
      (
        await repository.nativeCommands.lookup(
          LOCAL_USER_ID,
          workerId,
          input.operationId,
        )
      )?.status,
    ).toBe("accepted");
    await dispatch(bound, grant.receipt);
    await finish(bound, grant.receipt);
    const next = { ...input, operationId: randomUUID() };
    const nextGrant = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      next,
    );
    const nextBinding = {
      ...binding,
      operationId: next.operationId,
      operationGeneration: nextGrant.receipt.operationGeneration,
      session: {
        ...binding.session,
        connectionId: `gui:${nextGrant.receipt.operationGeneration}`,
      },
    };
    await repository.nativeCommands.bindPreparation(LOCAL_USER_ID, nextBinding);
    expect(
      await repository.nativeCommands.cancelPreparing(
        LOCAL_USER_ID,
        chatId,
        nextGrant.receipt.activationGeneration!,
      ),
    ).toMatchObject({ workerId });
    await expect(
      repository.nativeCommands.bindPreparation(LOCAL_USER_ID, nextBinding),
    ).rejects.toMatchObject({ code: "preparation-no-longer-accepted" });
    await expect(
      repository.nativeCommands.dispatch(LOCAL_USER_ID, nextBinding),
    ).rejects.toMatchObject({ code: "cancelled-before-dispatch" });
  });
  it("durably stops autonomous work while allowing manual input and fences late resume dispatch", async () => {
    const repository = database.repository;
    expect(
      await repository.nativeCommands.stopAutonomy(LOCAL_USER_ID, chatId, null),
    ).toBe(true);
    const automatic = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "autonomous" },
    );
    expect(
      (await repository.nativeCommands.admit(LOCAL_USER_ID, automatic)).receipt,
    ).toMatchObject({ status: "rejected", rejectionCode: "autonomy-stopped" });
    const manual = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const manualGrant = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      manual,
    );
    expect(manualGrant.receipt.status).toBe("accepted");
    expect(
      await repository.nativeCommands.stopAutonomy(LOCAL_USER_ID, chatId, null),
    ).toBe(false);
    await dispatch(manual, manualGrant.receipt);
    await finish(manual, manualGrant.receipt);
    const resume = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      {
        method: "thread/queue/start",
        intent: {
          scope: "thread",
          settingKeys: [],
          expectedTurnId: null,
          resumeAutonomy: true,
        },
      },
    );
    const pending = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      resume,
    );
    expect(
      await repository.nativeCommands.stopAutonomy(LOCAL_USER_ID, chatId, null),
    ).toBe(true);
    await expect(dispatch(resume, pending.receipt)).rejects.toMatchObject({
      code: "autonomy-stopped",
    });
    const explicit = { ...resume, operationId: randomUUID() };
    const accepted = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      explicit,
    );
    await dispatch(explicit, accepted.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: explicit.operationId,
      operationGeneration: accepted.receipt.operationGeneration,
      status: "applied",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
    });
    const next = { ...automatic, operationId: randomUUID() };
    const nextGrant = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      next,
    );
    expect(nextGrant.receipt.status).toBe("accepted");
    await finish(next, nextGrant.receipt, "rejected");
  });
  it("applies exact native pause intent without letting queue resume clear the GUI pause", async () => {
    const repository = database.repository;
    const start = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const active = await repository.nativeCommands.admit(LOCAL_USER_ID, start);
    await dispatch(start, active.receipt);
    const mutate = async (method: string, intent: Record<string, unknown>) => {
      const input = admission(
        await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
        {
          method,
          expectedActivationGeneration: active.receipt.activationGeneration,
          intent: {
            scope: "thread",
            settingKeys: [],
            expectedTurnId: null,
            ...intent,
          },
        },
      );
      const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
      expect(grant.receipt.status).toBe("accepted");
      await dispatch(input, grant.receipt);
      await repository.nativeCommands.settle(LOCAL_USER_ID, {
        workerId,
        operationId: input.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        status: "applied",
        resultDigest: null,
        protectedResult: null,
        rejectionCode: null,
        executionComplete: false,
      });
    };
    await mutate("turn/pause", { paused: true });
    expect(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))
        ?.automationPaused,
    ).toBe(true);
    await repository.nativeCommands.stopAutonomy(
      LOCAL_USER_ID,
      chatId,
      active.receipt.activationGeneration,
    );
    await mutate("thread/queue/start", { resumeAutonomy: true });
    expect(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))
        ?.automationPaused,
    ).toBe(true);
    await repository.nativeCommands.stopAutonomy(
      LOCAL_USER_ID,
      chatId,
      active.receipt.activationGeneration,
    );
    await mutate("turn/pause", { paused: false, resumeAutonomy: true });
    expect(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))
        ?.automationPaused,
    ).toBe(false);
    for (const [method, intent] of [
      ["turn/pause", { resumeAutonomy: true }],
      ["turn/pause", { paused: true, resumeAutonomy: true }],
      ["thread/queue/start", { paused: false, resumeAutonomy: true }],
    ] as const) {
      const bad = admission(
        await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
        {
          method,
          intent: {
            scope: "thread",
            settingKeys: [],
            expectedTurnId: null,
            ...intent,
          },
        },
      );
      expect(
        (await repository.nativeCommands.admit(LOCAL_USER_ID, bad)).receipt,
      ).toMatchObject({
        status: "rejected",
        rejectionCode: "invalid-pause-intent",
      });
    }
    await finish(start, active.receipt);
    const next = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "autonomous" },
    );
    const nextGrant = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      next,
    );
    expect(nextGrant.receipt.status).toBe("accepted");
    await finish(next, nextGrant.receipt, "rejected");
  });
  it("keeps native acknowledgement and terminal result immutable independently, including completion replay", async () => {
    const repository = database.repository;
    const input = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
    );
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    await dispatch(input, grant.receipt);
    const base = {
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied" as const,
      rejectionCode: null,
    };
    const envelope = opaqueMessage("assistant").protectedContent.envelope;
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      ...base,
      resultDigest: "b".repeat(64),
      protectedResult: envelope,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: "receipt-terminal-turn",
        runtimeGeneration: input.session.runtimeGeneration!,
      },
    });
    const terminal = {
      ...base,
      resultDigest: null,
      protectedResult: null,
      terminalResult: {
        resultDigest: "c".repeat(64),
        protectedResult: envelope,
      },
      executionComplete: true,
      reconciliation: {
        nativeTurnId: "receipt-terminal-turn",
        runtimeGeneration: input.session.runtimeGeneration!,
      },
    };
    expect(
      (await repository.nativeCommands.settle(LOCAL_USER_ID, terminal)).status,
    ).toBe("applied");
    expect(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))?.status,
    ).toBe("idle");
    await expect(
      repository.nativeCommands.settle(LOCAL_USER_ID, terminal),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      repository.nativeCommands.settle(LOCAL_USER_ID, {
        ...terminal,
        terminalResult: {
          resultDigest: "d".repeat(64),
          protectedResult: envelope,
        },
      }),
    ).rejects.toMatchObject({ code: "receipt-conflict" });
    await expect(
      repository.nativeCommands.settle(LOCAL_USER_ID, {
        ...base,
        resultDigest: "c".repeat(64),
        protectedResult: envelope,
        executionComplete: false,
      }),
    ).rejects.toMatchObject({ code: "receipt-conflict" });
  });
  it("settles an uncertain autonomous ticket only from its exact declined attempt proof", async () => {
    const repository = database.repository;
    await repository.nativeCommands.resumeAutonomy(LOCAL_USER_ID, chatId);
    const input = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      {
        origin: "autonomous",
        operationId: "native:decline-runner:decline-attempt",
        intent: {
          scope: "thread",
          settingKeys: [],
          expectedTurnId: "declined-turn",
        },
      },
    );
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    await dispatch(input, grant.receipt);
    const base = {
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
    };
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      ...base,
      status: "uncertain",
      executionComplete: false,
    });
    const declined = {
      ...base,
      status: "rejected" as const,
      executionComplete: true,
      decline: {
        nativeTurnId: "declined-turn",
        runtimeGeneration: input.session.runtimeGeneration!,
        runnerGeneration: "decline-runner",
        attemptId: "decline-attempt",
      },
    };
    await expect(
      repository.nativeCommands.settle(LOCAL_USER_ID, {
        ...declined,
        decline: { ...declined.decline, attemptId: "wrong-attempt" },
      }),
    ).rejects.toMatchObject({ code: "stale-native-evidence" });
    await expect(
      repository.nativeCommands.settle(LOCAL_USER_ID, declined),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(
      repository.nativeCommands.settle(LOCAL_USER_ID, declined),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(
      (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
        .activationGeneration,
    ).toBeNull();
  });

  it("rotates retry attempts atomically inside one GUI lane and fences Stop, old events, and logical completion", async () => {
    const repository = database.repository;
    const input = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "gui" },
    );
    const root = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    await dispatch(input, root.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: input.operationId,
      operationGeneration: root.receipt.operationGeneration,
      status: "applied",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: "retry-first-turn",
        runtimeGeneration: input.session.runtimeGeneration!,
      },
    });
    const continuation = {
      workerId,
      rootOperationId: input.operationId,
      previousOperationId: input.operationId,
      previousOperationGeneration: root.receipt.operationGeneration,
      operationId: randomUUID(),
      payloadDigest: "d".repeat(64),
      protectedPayload: input.protectedPayload,
      session: input.session,
      reason: "capacity" as const,
      failure: {
        kind: "native-terminal" as const,
        nativeTurnId: "retry-first-turn",
        runtimeGeneration: input.session.runtimeGeneration!,
      },
    };
    const second = await repository.nativeCommands.continueExecution(
      LOCAL_USER_ID,
      continuation,
    );
    expect(second.receipt).toMatchObject({
      logicalOperationId: input.operationId,
      previousOperationId: input.operationId,
      executionLaneId: root.receipt.executionLaneId,
      status: "accepted",
    });
    expect(second.receipt.operationGeneration).not.toBe(
      root.receipt.operationGeneration,
    );
    expect(second.receipt.activationGeneration).not.toBe(
      root.receipt.activationGeneration,
    );
    expect(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))?.status,
    ).toBe("running");
    expect(
      (
        await repository.nativeCommands.admit(
          LOCAL_USER_ID,
          admission(
            await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
          ),
        )
      ).receipt.status,
    ).toBe("rejected");
    expect(
      (
        await repository.nativeCommands.continueExecution(
          LOCAL_USER_ID,
          continuation,
        )
      ).receipt.operationGeneration,
    ).toBe(second.receipt.operationGeneration);
    await expect(
      repository.nativeCommands.continueExecution(LOCAL_USER_ID, {
        ...continuation,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "stale-continuation" });
    expect(
      await repository.nativeCommands.finishExecution(
        LOCAL_USER_ID,
        workerId,
        input.operationId,
        root.receipt.operationGeneration,
        "idle",
      ),
    ).toBe(false);
    await expect(
      repository.nativeCommands.withEventContext(
        LOCAL_USER_ID,
        workerId,
        input.operationId,
        root.receipt.operationGeneration,
        async () => true,
      ),
    ).rejects.toMatchObject({ code: "stale-operation-event" });
    const attempt = {
      ...input,
      operationId: continuation.operationId,
      payloadDigest: continuation.payloadDigest,
    };
    await dispatch(attempt, second.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: attempt.operationId,
      operationGeneration: second.receipt.operationGeneration,
      status: "applied",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: "retry-second-turn",
        runtimeGeneration: input.session.runtimeGeneration!,
      },
    });
    expect(
      await repository.nativeCommands.stopAutonomy(
        LOCAL_USER_ID,
        chatId,
        root.receipt.activationGeneration,
      ),
    ).toBe(false);
    expect(
      await repository.nativeCommands.stopAutonomy(
        LOCAL_USER_ID,
        chatId,
        second.receipt.activationGeneration,
      ),
    ).toBe(true);
    await expect(
      repository.nativeCommands.continueExecution(LOCAL_USER_ID, {
        ...continuation,
        previousOperationId: attempt.operationId,
        previousOperationGeneration: second.receipt.operationGeneration,
        operationId: randomUUID(),
        failure: { ...continuation.failure, nativeTurnId: "retry-second-turn" },
      }),
    ).rejects.toMatchObject({ code: "stale-continuation" });
    expect(
      await repository.nativeCommands.finishLogicalGui(
        LOCAL_USER_ID,
        workerId,
        input.operationId,
        root.receipt.operationGeneration,
        "idle",
      ),
    ).toBe(true);
    const next = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "gui" },
    );
    const nextGrant = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      next,
    );
    expect(
      await repository.nativeCommands.finishLogicalGui(
        LOCAL_USER_ID,
        workerId,
        input.operationId,
        root.receipt.operationGeneration,
        "idle",
      ),
    ).toBe(false);
    await finish(next, nextGrant.receipt, "rejected");
  });
  it("changes a bound thread only through exact invalid-compaction continuation handoff", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const base = admission(context, { origin: "gui" });
    const input = {
      ...base,
      session: { ...base.session, runtimeGeneration: null, connectionId: null },
    };
    const root = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    const session = {
      ...base.session,
      threadId: "native-replacement",
      connectionId: `gui:${root.receipt.operationGeneration}`,
    };
    const retry = {
      workerId,
      rootOperationId: input.operationId,
      previousOperationId: input.operationId,
      previousOperationGeneration: root.receipt.operationGeneration,
      operationId: randomUUID(),
      payloadDigest: "e".repeat(64),
      protectedPayload: input.protectedPayload,
      session,
      reason: "invalid-compaction" as const,
      failure: {
        kind: "native-rejected" as const,
        method: "thread/resume" as const,
        code: -32600,
        runtimeGeneration: session.runtimeGeneration!,
      },
      handoff: {
        expectedThreadId: context.threadId!,
        replacementThreadId: session.threadId,
      },
    };
    await expect(
      repository.nativeCommands.continueExecution(LOCAL_USER_ID, {
        ...retry,
        handoff: { ...retry.handoff, expectedThreadId: "wrong-thread" },
      }),
    ).rejects.toMatchObject({ code: "thread-identity-mismatch" });
    expect(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))
        ?.threadId,
    ).toBe(context.threadId);
    const child = await repository.nativeCommands.continueExecution(
      LOCAL_USER_ID,
      retry,
    );
    expect(child.execution?.threadId).toBe(session.threadId);
    expect(child.receipt.executionLaneId).toBe(root.receipt.executionLaneId);
    await dispatch(
      {
        ...input,
        operationId: retry.operationId,
        payloadDigest: retry.payloadDigest,
        session,
      },
      child.receipt,
    );
    expect(
      await repository.nativeCommands.finishLogicalGui(
        LOCAL_USER_ID,
        workerId,
        input.operationId,
        root.receipt.operationGeneration,
        "idle",
      ),
    ).toBe(true);
  });

  it("completes the production native adapter acknowledgement-to-terminal flow against the real repository", async () => {
    const { ManagedNativeCommandSession } =
      await import("../../cantrip_worker/src/codex/managed-native-command-session.js");
    const { effectivePermissionProfile } =
      await import("../src/chats/execution-helpers.js");
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const session = admission(context).session;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const settle = vi.fn(async (input) => ({
      receipt: await repository.nativeCommands.settle(LOCAL_USER_ID, {
        workerId,
        ...input,
      }),
    }));
    const onError = vi.fn();
    const adapter = new ManagedNativeCommandSession({
      identity: {
        serverId: "fixture-server",
        ownerId: LOCAL_USER_ID,
        workerId,
        chatId,
        projectId: context.projectId!,
        contextKind: "project",
        placementId: session.placementId,
      },
      runtime: {
        transportGeneration: session.runtimeGeneration,
        prepareAdmittedNativeExecution: async (options) => ({
          operationGeneration: options.operationGeneration,
          threadId: session.threadId!,
          signal: new AbortController().signal,
          completion,
          assertCurrent: () => {},
          bindReceipt: () => {},
          fail: reject,
        }),
      } as never,
      client: {
        admit: async (input) => ({
          ...(await repository.nativeCommands.admit(LOCAL_USER_ID, {
            workerId,
            ...input,
          })),
          computerUseAuthority: null,
        }),
        dispatch: async (input) => ({
          ...(await repository.nativeCommands.dispatch(LOCAL_USER_ID, {
            workerId,
            ...input,
          })),
          computerUseAuthority: null,
        }),
        settle,
      } as never,
      encryption: {
        ownerId: () => LOCAL_USER_ID,
        serverIdentity: () => "fixture-server",
        componentKey: () => ({
          keyRevision: 1,
          key: new Uint8Array(32).fill(7),
        }),
      },
      policy: {
        cwd: context.cwd,
        codexHome: dataDirectory,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
        security: {},
      },
      beginExecution: async () => ({
        options: {} as never,
        complete: async () => {},
        failed: async () => {},
        release: async () => {},
      }),
      onError,
    });
    const operation = await adapter.admit({
      operationId: randomUUID(),
      origin: "terminal",
      identity: {
        serverId: "fixture-server",
        ownerId: LOCAL_USER_ID,
        workerId,
        chatId,
        projectId: context.projectId!,
        contextKind: "project",
        placementId: session.placementId,
        threadId: session.threadId!,
        runtimeGeneration: session.runtimeGeneration!,
        modelRouteId: session.modelRouteId,
        providerAccountId: session.providerAccountId,
      },
      connectionId: session.connectionId,
      kind: "start",
      method: "turn/start",
      frame: { method: "turn/start", params: { threadId: session.threadId } },
    });
    await operation.beforeForward();
    await operation.settle({ result: { turn: { id: "actual-adapter-turn" } } });
    resolve({
      threadId: session.threadId,
      turnId: "actual-adapter-turn",
      text: "Private completed output",
      status: "completed",
    });
    await adapter.awaitExecutionReleased();
    expect(onError).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls[0]![0].resultDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(settle.mock.calls[1]![0]).toMatchObject({
      resultDigest: null,
      protectedResult: null,
      executionComplete: true,
    });
    expect(settle.mock.calls[1]![0].terminalResult.resultDigest).not.toBe(
      settle.mock.calls[0]![0].resultDigest,
    );
    expect(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))?.status,
    ).toBe("idle");
    const queued = await adapter.admit({
      operationId: randomUUID(),
      origin: "terminal",
      identity: {
        serverId: "fixture-server",
        ownerId: LOCAL_USER_ID,
        workerId,
        chatId,
        projectId: context.projectId!,
        contextKind: "project",
        placementId: session.placementId,
        threadId: session.threadId!,
        runtimeGeneration: session.runtimeGeneration!,
        modelRouteId: session.modelRouteId,
        providerAccountId: session.providerAccountId,
      },
      connectionId: session.connectionId,
      kind: "mutation",
      method: "thread/queue/start",
      frame: {
        method: "thread/queue/start",
        params: { threadId: session.threadId },
      },
    });
    await queued.beforeForward();
    await queued.settle({
      result: { turn: { id: "separately-admitted-queue-turn" } },
    });
    expect(settle).toHaveBeenCalledTimes(3);
    expect(settle.mock.calls[2]![0].reconciliation).toBeUndefined();
    expect(settle.mock.calls[2]![0].executionComplete).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(
      (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
        .activationGeneration,
    ).toBeNull();
  });
  it("acknowledges logical GUI completion only after the canonical lane is released", async () => {
    const { finishManagedGui } =
      await import("../src/app/runtime/finish-managed-gui.js");
    const repository = database.repository;
    const input = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "gui" },
    );
    const root = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    await dispatch(input, root.receipt);
    const request = vi.fn(async () => {
      expect(
        (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
          .activationGeneration,
      ).toBeNull();
      return { acknowledged: true };
    });
    const onAcknowledgementError = vi.fn();
    expect(
      await finishManagedGui({
        repository,
        bridge: { request } as never,
        ownerId: LOCAL_USER_ID,
        workerId,
        receipt: root.receipt,
        status: "idle",
        onAcknowledgementError,
      }),
    ).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      workerId,
      {
        type: "chat.native-logical.complete",
        chatId,
        rootOperationId: input.operationId,
        rootOperationGeneration: root.receipt.operationGeneration,
      },
      { ownerId: LOCAL_USER_ID, timeoutMs: 10_000 },
    );
    expect(onAcknowledgementError).not.toHaveBeenCalled();
    const next = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "gui" },
    );
    const nextGrant = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      next,
    );
    const failedTransport = vi.fn(async () => {
      throw new Error("Fixture disconnected worker");
    });
    expect(
      await finishManagedGui({
        repository,
        bridge: { request: failedTransport } as never,
        ownerId: LOCAL_USER_ID,
        workerId,
        receipt: root.receipt,
        status: "idle",
        onAcknowledgementError,
      }),
    ).toBe(false);
    expect(
      (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
        .activationGeneration,
    ).toBe(nextGrant.receipt.activationGeneration);
    expect(onAcknowledgementError).toHaveBeenCalledOnce();
    await finish(next, nextGrant.receipt, "rejected");
  });
});

function queuedFixture(modelId: string) {
  const message = opaqueMessage("user");
  return queuedPromptOpaqueContentSchema.parse({
    id: randomUUID(),
    classification: { mode: "default", attachmentIds: [] },
    protectedContent: message.protectedContent,
    modelId,
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
    worktreeId: null,
    frozen: false,
    idempotencyKey: `queued:${message.id}`,
    pendingMessage: message,
    protectedNativeInput: message.protectedContent.envelope,
    nativeClientUserMessageId: `cantrip:${message.id}`,
    nativeAction: "literal",
    executionMethod: "turn/start",
  });
}
async function queueInput(
  mutation: ManagedQueueMutation,
  expectedRevision?: number,
) {
  const context = (await database.repository.getChatExecutionContext(
    LOCAL_USER_ID,
    chatId,
  ))!;
  const snapshot = await database.repository.managedQueue.snapshot(
    LOCAL_USER_ID,
    chatId,
  );
  return {
    admission: admission(context, {
      method: `thread/queue/${mutation.kind}`,
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
        ...(["add", "start"].includes(mutation.kind)
          ? { resumeAutonomy: true }
          : {}),
      },
    }),
    mutation,
    expectedRevision: expectedRevision ?? snapshot.revision,
  };
}
async function clearQueueFixtures() {
  const snapshot = await database.repository.managedQueue.snapshot(
    LOCAL_USER_ID,
    chatId,
  );
  for (const item of snapshot.items) {
    if (item.state !== "pending")
      throw new Error("Fixture left an unresolved queue claim");
    await database.repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({
        kind: "delete",
        id: item.id,
        expectedItemRevision: item.revision,
      }),
    );
  }
}
describe("canonical managed queue and completion outbox", () => {
  it("commits encrypted canonical mutations and receipts together, with revision CAS and cross-view replay", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = queuedFixture(context.modelId!);
    const request = await queueInput({ kind: "add", prompt, attachments: [] });
    const first = await repository.managedQueue.mutate(LOCAL_USER_ID, request);
    expect(first.receipt.status).toBe("applied");
    expect(first.items.find((item) => item.id === prompt.id)).toMatchObject({
      revision: 0,
      state: "pending",
      protectedNativeInput: prompt.protectedNativeInput,
    });
    const replay = await repository.managedQueue.mutate(LOCAL_USER_ID, {
      ...request,
      admission: {
        ...request.admission,
        session: { ...request.admission.session, connectionId: "new-view" },
      },
    });
    expect(replay.receipt.operationGeneration).toBe(
      first.receipt.operationGeneration,
    );
    expect(replay.revision).toBe(first.revision);
    const stale = await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({
        kind: "update",
        id: prompt.id,
        expectedItemRevision: 99,
        prompt: { ...prompt, frozen: true },
        attachments: [],
      }),
    );
    expect(stale.receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "queue-item-revision-conflict",
    });
    expect(stale.revision).toBe(first.revision);
    const changed = await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({
        kind: "update",
        id: prompt.id,
        expectedItemRevision: 0,
        prompt: { ...prompt, frozen: true },
        attachments: [],
      }),
    );
    expect(changed.items.find((item) => item.id === prompt.id)).toMatchObject({
      revision: 1,
      frozen: true,
    });
    expect(
      await repository.managedQueue.claimNext(LOCAL_USER_ID, chatId),
    ).toBeNull();
    const staleOrder = await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput(
        { kind: "reorder", ids: changed.items.map((item) => item.id) },
        first.revision,
      ),
    );
    expect(staleOrder.receipt.rejectionCode).toBe("queue-revision-conflict");
    await clearQueueFixtures();
  });
  it("binds one immutable claim to admission and consumes only the actual native acknowledgement", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = queuedFixture(context.modelId!);
    await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({ kind: "add", prompt, attachments: [] }),
    );
    const claim = (await repository.managedQueue.claimNext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const input = admission(context, {
      origin: "gui",
      queueClaim: { id: claim.id, promptRevision: claim.promptRevision },
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    expect(grant.receipt.status).toBe("accepted");
    const duplicate = await repository.nativeCommands.admit(LOCAL_USER_ID, {
      ...input,
      operationId: randomUUID(),
    });
    expect(duplicate.receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "stale-queue-claim",
    });
    await dispatch(input, grant.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "uncertain",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
    });
    expect(
      await repository.managedQueue.releaseUnadmitted(
        LOCAL_USER_ID,
        chatId,
        claim.id,
      ),
    ).toBe(false);
    await expect(
      repository.managedQueue.startReceipt(
        LOCAL_USER_ID,
        workerId,
        input.session,
        claim.id,
      ),
    ).rejects.toMatchObject({ code: "queue-dispatch-uncertain" });
    const ack = {
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied" as const,
      resultDigest: "c".repeat(64),
      protectedResult: opaqueMessage("assistant").protectedContent.envelope,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: "queued-actual-turn",
        runtimeGeneration: input.session.runtimeGeneration!,
      },
    };
    await repository.nativeCommands.settle(LOCAL_USER_ID, ack);
    const receipt = await repository.managedQueue.startReceipt(
      LOCAL_USER_ID,
      workerId,
      input.session,
      claim.id,
    );
    expect(receipt).toMatchObject({
      claim: { status: "consumed", nativeTurnId: "queued-actual-turn" },
      receipt: { operationId: input.operationId },
      protectedResult: ack.protectedResult,
    });
    expect(
      (
        await repository.managedQueue.snapshot(LOCAL_USER_ID, chatId)
      ).items.some((item) => item.id === prompt.id),
    ).toBe(false);
    expect(
      await repository.getEncryptedQueuedPrompt(LOCAL_USER_ID, prompt.id),
    ).toMatchObject({
      state: "consumed",
      protectedNativeInput: prompt.protectedNativeInput,
    });
    await repository.nativeCommands.finishLogicalGui(
      LOCAL_USER_ID,
      workerId,
      input.operationId,
      grant.receipt.operationGeneration,
      "idle",
    );
  });
  it("reconciles queue receipts across an authorized per-item route change without relaxing mutation or placement fences", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = queuedFixture(context.modelId!);
    const add = await queueInput({ kind: "add", prompt, attachments: [] });
    await repository.managedQueue.mutate(LOCAL_USER_ID, add);
    const start = await queueInput({ kind: "start", id: prompt.id });
    const queued = await repository.managedQueue.mutate(LOCAL_USER_ID, start);
    const claim = queued.claim!;
    const input = admission(context, {
      origin: "gui",
      queueClaim: { id: claim.id, promptRevision: claim.promptRevision },
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    expect(grant.receipt.status).toBe("accepted");
    await dispatch(input, grant.receipt);
    const protectedResult =
      opaqueMessage("assistant").protectedContent.envelope;
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      protectedResult,
      resultDigest: "c".repeat(64),
      rejectionCode: null,
      executionComplete: false,
    });
    await repository.nativeCommands.finishLogicalGui(
      LOCAL_USER_ID,
      workerId,
      input.operationId,
      grant.receipt.operationGeneration,
      "idle",
    );
    const runtime = (await repository.getModelRuntimes(LOCAL_USER_ID))[0]!;
    const nextRoute =
      context.modelRouteId === runtime.routeId ? null : runtime.routeId;
    await repository.updateChatRuntime(
      chatId,
      workerId,
      context.worktreeId,
      context.threadId,
      nextRoute,
      "ready",
      null,
    );
    try {
      const current = (await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chatId,
      ))!;
      const session = {
        ...admission(current).session,
        runtimeGeneration: "runtime-after-route",
        connectionId: "new-view",
      };
      expect(session.modelRouteId).not.toBe(context.modelRouteId);
      const recovered = await repository.managedQueue.lookup(LOCAL_USER_ID, {
        ...start.admission,
        session,
      });
      expect(recovered).toMatchObject({
        found: true,
        receipt: { operationId: start.admission.operationId },
        claim: { id: claim.id, status: "consumed" },
      });
      expect(
        await repository.managedQueue.startReceipt(
          LOCAL_USER_ID,
          workerId,
          session,
          claim.id,
        ),
      ).toMatchObject({
        receipt: { operationId: input.operationId },
        protectedResult,
      });
      expect(
        await repository.managedQueue.startReceipt(
          LOCAL_USER_ID,
          workerId,
          start.admission.session,
          claim.id,
        ),
      ).toMatchObject({ receipt: { operationId: input.operationId } });
      await expect(
        repository.managedQueue.mutate(LOCAL_USER_ID, {
          ...start,
          admission: { ...start.admission, session },
        }),
      ).rejects.toMatchObject({ code: "operation-id-conflict" });
      await expect(
        repository.managedQueue.lookup(LOCAL_USER_ID, start.admission),
      ).rejects.toMatchObject({ code: "stale-queue-session" });
      for (const changed of [
        { threadId: "different-thread" },
        { placementId: "different-placement" },
        { providerAccountId: "unbound-account" },
      ]) {
        await expect(
          repository.managedQueue.lookup(LOCAL_USER_ID, {
            ...start.admission,
            session: { ...session, ...changed },
          }),
        ).rejects.toMatchObject({ code: "stale-queue-session" });
        await expect(
          repository.managedQueue.startReceipt(
            LOCAL_USER_ID,
            workerId,
            { ...session, ...changed },
            claim.id,
          ),
        ).rejects.toMatchObject({ code: "stale-queue-session" });
      }
      expect(
        (await repository.managedQueue.snapshot(LOCAL_USER_ID, chatId)).items,
      ).toEqual([]);
    } finally {
      await repository.updateChatRuntime(
        chatId,
        workerId,
        context.worktreeId,
        context.threadId,
        context.modelRouteId,
        "ready",
        null,
      );
    }
  });
  it("reads a committed receipt after a lost notification without cancelling or replaying its claim", async () => {
    const { waitForManagedQueueReceipt } =
      await import("../src/app/runtime/managed-queue-receipts.js");
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = queuedFixture(context.modelId!);
    await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({ kind: "add", prompt, attachments: [] }),
    );
    const claim = (await repository.managedQueue.claimNext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const input = admission(context, {
      origin: "gui",
      queueClaim: { id: claim.id, promptRevision: claim.promptRevision },
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    await dispatch(input, grant.receipt);
    const controller = new AbortController();
    const waiting = waitForManagedQueueReceipt(
      repository,
      LOCAL_USER_ID,
      workerId,
      input.session,
      claim.id,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      resultDigest: "d".repeat(64),
      protectedResult: opaqueMessage("assistant").protectedContent.envelope,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: "queued-lost-notification",
        runtimeGeneration: input.session.runtimeGeneration!,
      },
    });
    expect((await waiting).claim.nativeTurnId).toBe("queued-lost-notification");
    await repository.nativeCommands.finishLogicalGui(
      LOCAL_USER_ID,
      workerId,
      input.operationId,
      grant.receipt.operationGeneration,
      "idle",
    );
  });
  it("retains a cancelled item for explicit recovery without automatically replaying it", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = queuedFixture(context.modelId!);
    await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({ kind: "add", prompt, attachments: [] }),
    );
    const claim = (await repository.managedQueue.claimNext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const input = admission(context, {
      origin: "gui",
      queueClaim: { id: claim.id, promptRevision: claim.promptRevision },
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    await repository.nativeCommands.cancelPreparing(
      LOCAL_USER_ID,
      chatId,
      grant.receipt.activationGeneration!,
    );
    expect(
      await repository.getEncryptedQueuedPrompt(LOCAL_USER_ID, prompt.id),
    ).toMatchObject({ state: "pending" });
    await repository.nativeCommands.resumeAutonomy(LOCAL_USER_ID, chatId);
    expect(
      await repository.managedQueue.claimNext(LOCAL_USER_ID, chatId),
    ).toBeNull();
    await clearQueueFixtures();
  });
  it("durably records only exact logical completion and fences acknowledgment/defer identities", async () => {
    const repository = database.repository;
    const input = admission(
      await repository.getChatExecutionContext(LOCAL_USER_ID, chatId),
      { origin: "gui" },
    );
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input);
    const tuple = [
      LOCAL_USER_ID,
      workerId,
      chatId,
      input.operationId,
      grant.receipt.operationGeneration,
    ] as const;
    expect(
      await repository.nativeCommands.getLogicalCompletion(...tuple),
    ).toBeNull();
    await expect(
      repository.nativeCommands.finishLogicalGui(
        LOCAL_USER_ID,
        workerId,
        input.operationId,
        "wrong-generation",
        "idle",
      ),
    ).rejects.toBeDefined();
    expect(
      await repository.nativeCommands.getLogicalCompletion(...tuple),
    ).toBeNull();
    await repository.nativeCommands.finishLogicalGui(
      LOCAL_USER_ID,
      workerId,
      input.operationId,
      grant.receipt.operationGeneration,
      "idle",
    );
    expect(
      await repository.nativeCommands.getLogicalCompletion(...tuple),
    ).toMatchObject({ attempts: 0, rootOperationId: input.operationId });
    expect(
      await repository.nativeCommands.acknowledgeLogicalCompletion(
        LOCAL_USER_ID,
        workerId,
        chatId,
        input.operationId,
        "wrong",
      ),
    ).toBe(false);
    expect(
      await repository.nativeCommands.deferLogicalCompletion(
        ...tuple,
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(
      (
        await repository.nativeCommands.listPendingLogicalCompletions(1000)
      ).some((row) => row.rootOperationId === input.operationId),
    ).toBe(false);
    expect(
      await repository.nativeCommands.getLogicalCompletion(...tuple),
    ).toMatchObject({ attempts: 1 });
    expect(
      await repository.nativeCommands.acknowledgeLogicalCompletion(...tuple),
    ).toBe(true);
    expect(
      await repository.nativeCommands.getLogicalCompletion(...tuple),
    ).toBeNull();
  });
  it("keeps native imports nonexecutable through deletion conflicts and lost acknowledgments", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = queuedFixture(context.modelId!);
    const session = admission(context).session;
    const protectedSource = opaqueMessage("user").protectedContent.envelope;
    const input = {
      workerId,
      session,
      runnerGeneration: "runner-before-restart",
      items: [
        {
          nativeItemId: randomUUID(),
          sourceDigest: "a".repeat(64),
          protectedSource,
          prompt,
          attachments: [],
        },
      ],
    };
    const imported = await repository.managedQueue.importNative(
      LOCAL_USER_ID,
      input,
    );
    const record = imported.imports[0]!;
    expect(record).toMatchObject({
      status: "pending",
      protectedSource,
      nativeDeleteOperationId: `queue-delete:${record.importId}`,
    });
    expect(imported.items.some((item) => item.id === prompt.id)).toBe(false);
    expect(imported.pendingImports).toContainEqual(
      expect.objectContaining({
        importId: record.importId,
        status: "pending",
        prompt: expect.objectContaining({
          id: prompt.id,
          protectedNativeInput: prompt.protectedNativeInput,
          state: "importing",
        }),
      }),
    );
    expect(
      await repository.managedQueue.claimNext(LOCAL_USER_ID, chatId),
    ).toBeNull();
    const restarted = {
      workerId,
      session: {
        ...session,
        runtimeGeneration: "restarted-runtime",
        connectionId: "restarted-view",
      },
      runnerGeneration: "runner-after-restart",
      items: [],
    };
    const recovered = await repository.managedQueue.importNative(
      LOCAL_USER_ID,
      restarted,
    );
    expect(recovered.imports).toContainEqual(record);
    const ack = {
      ...restarted,
      importId: record.importId,
      sourceDigest: record.sourceDigest,
      receipt: { deleted: false, conflict: false },
    };
    const { items: _, ...ackInput } = ack;
    const uncertain = await repository.managedQueue.acknowledgeImport(
      LOCAL_USER_ID,
      ackInput,
    );
    expect(uncertain.pendingImports).toContainEqual(
      expect.objectContaining({
        importId: record.importId,
        status: "uncertain",
      }),
    );
    expect(uncertain.revision).toBeGreaterThan(imported.revision);
    expect(
      (await repository.managedQueue.acknowledgeImport(LOCAL_USER_ID, ackInput))
        .revision,
    ).toBe(uncertain.revision);
    expect(
      await repository.managedQueue.claimNext(LOCAL_USER_ID, chatId),
    ).toBeNull();
    await expect(
      repository.managedQueue.acknowledgeImport(LOCAL_USER_ID, {
        ...ackInput,
        runnerGeneration: "stale",
        receipt: { deleted: true, conflict: false },
      }),
    ).rejects.toMatchObject({ code: "stale-queue-import" });
    const committed = await repository.managedQueue.acknowledgeImport(
      LOCAL_USER_ID,
      { ...ackInput, receipt: { deleted: true, conflict: false } },
    );
    expect(committed.items.find((item) => item.id === prompt.id)).toMatchObject(
      { state: "pending" },
    );
    const duplicate = await repository.managedQueue.acknowledgeImport(
      LOCAL_USER_ID,
      { ...ackInput, receipt: { deleted: true, conflict: false } },
    );
    expect(duplicate.revision).toBe(committed.revision);
    await clearQueueFixtures();
  });
  it("replaces only a conflicted staged native snapshot and never releases the superseded input", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const session = admission(context).session;
    const prompt = queuedFixture(context.modelId!);
    const input = {
      workerId,
      session,
      runnerGeneration: "conflict-runner",
      items: [
        {
          nativeItemId: randomUUID(),
          sourceDigest: "b".repeat(64),
          protectedSource: prompt.protectedContent.envelope,
          prompt,
          attachments: [],
        },
      ],
    };
    const first = await repository.managedQueue.importNative(
      LOCAL_USER_ID,
      input,
    );
    const record = first.imports[0]!;
    await repository.managedQueue.acknowledgeImport(LOCAL_USER_ID, {
      workerId,
      session,
      runnerGeneration: input.runnerGeneration,
      importId: record.importId,
      sourceDigest: record.sourceDigest,
      receipt: { deleted: false, conflict: true },
    });
    const replacement = {
      ...input,
      items: [
        {
          ...input.items[0]!,
          sourceDigest: "c".repeat(64),
          prompt: { ...prompt, frozen: true },
        },
      ],
    };
    const revised = await repository.managedQueue.importNative(
      LOCAL_USER_ID,
      replacement,
    );
    expect(revised.imports[0]!.importId).not.toBe(record.importId);
    expect(revised.items.some((item) => item.id === prompt.id)).toBe(false);
    await expect(
      repository.managedQueue.acknowledgeImport(LOCAL_USER_ID, {
        workerId,
        session,
        runnerGeneration: input.runnerGeneration,
        importId: record.importId,
        sourceDigest: record.sourceDigest,
        receipt: { deleted: true, conflict: false },
      }),
    ).rejects.toMatchObject({ code: "stale-queue-import" });
    const latest = revised.imports[0]!;
    await repository.managedQueue.acknowledgeImport(LOCAL_USER_ID, {
      workerId,
      session,
      runnerGeneration: input.runnerGeneration,
      importId: latest.importId,
      sourceDigest: latest.sourceDigest,
      receipt: { deleted: true, conflict: false },
    });
    expect(
      await repository.managedQueue.claimNext(LOCAL_USER_ID, chatId),
    ).toBeNull();
    await clearQueueFixtures();
  });

  it("gives canonical queued input priority over autonomous goal attempts under admission lock", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = queuedFixture(context.modelId!);
    await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({ kind: "add", prompt, attachments: [] }),
    );
    const autonomous = admission(context, { origin: "autonomous" });
    const denied = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      autonomous,
    );
    expect(denied.receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "canonical-queue-pending",
    });
    const claim = (await repository.managedQueue.claimNext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const stillDenied = await repository.nativeCommands.admit(LOCAL_USER_ID, {
      ...autonomous,
      operationId: randomUUID(),
    });
    expect(stillDenied.receipt.rejectionCode).toBe("canonical-queue-pending");
    await repository.managedQueue.releaseUnadmitted(
      LOCAL_USER_ID,
      chatId,
      claim.id,
    );
    const allowedInput = { ...autonomous, operationId: randomUUID() };
    const allowed = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      allowedInput,
    );
    expect(allowed.receipt.status).toBe("accepted");
    await finish(allowedInput, allowed.receipt, "rejected");
    await clearQueueFixtures();
  });
  it("retains a newer committed revision when an older worker notice is acknowledged", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = queuedFixture(context.modelId!);
    const added = await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({
        kind: "add",
        prompt: { ...prompt, frozen: true },
        attachments: [],
      }),
    );
    const changed = await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({
        kind: "update",
        id: prompt.id,
        expectedItemRevision: 0,
        prompt: { ...prompt, frozen: true },
        attachments: [],
      }),
    );
    await repository.managedQueue.acknowledgeNotification(
      chatId,
      added.revision,
    );
    expect(
      (await repository.managedQueue.pendingNotifications()).find(
        (row) => row.chatId === chatId,
      )?.revision,
    ).toBe(changed.revision);
    await repository.managedQueue.deferNotification(chatId);
    expect(
      (await repository.managedQueue.pendingNotifications()).some(
        (row) => row.chatId === chatId,
      ),
    ).toBe(false);
    await repository.managedQueue.acknowledgeNotification(
      chatId,
      added.revision,
    );
    const { createManagedQueueDelivery } =
      await import("../src/app/runtime/managed-queue-delivery.js");
    const request = vi.fn().mockResolvedValue({});
    const publish = vi.fn();
    const onError = vi.fn();
    const delivery = createManagedQueueDelivery({
      repository: repository.managedQueue,
      bridge: { request } as never,
      publish,
      onError,
    });
    await delivery.runOnce();
    delivery.stop();
    expect(request).toHaveBeenCalledWith(
      workerId,
      { type: "chat.queue.changed", chatId, revision: changed.revision },
      { ownerId: LOCAL_USER_ID, timeoutMs: 10000 },
    );
    expect(onError).not.toHaveBeenCalled();
    expect(
      (await repository.managedQueue.pendingNotifications()).some(
        (row) => row.chatId === chatId,
      ),
    ).toBe(false);
    await clearQueueFixtures();
  });
  it("reconciles immutable encrypted mutation acknowledgments over authenticated HTTP after removal", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = { ...queuedFixture(context.modelId!), frozen: true };
    const add = await queueInput({ kind: "add", prompt, attachments: [] });
    const initial = await repository.managedQueue.mutate(LOCAL_USER_ID, add);
    const edit = await queueInput({
      kind: "update",
      id: prompt.id,
      expectedItemRevision: 0,
      prompt: { ...prompt, nativeAction: "plain" },
      attachments: [],
    });
    const changed = await repository.managedQueue.mutate(LOCAL_USER_ID, edit);
    const remove = await queueInput({
      kind: "delete",
      id: prompt.id,
      expectedItemRevision: 1,
    });
    await repository.managedQueue.mutate(LOCAL_USER_ID, remove);
    const app = Fastify();
    const { installInternalNativeQueueRoutes } =
      await import("../src/app/routes/internal-native-queue.js");
    const dispatch = vi.fn();
    installInternalNativeQueueRoutes(app, {
      config,
      repository,
      runAsOwner: async (_owner, operation) => operation(),
      dispatchNextQueuedPrompt: dispatch,
      publishChatInvalidation: vi.fn(),
    });
    try {
      const url = "/api/internal/native-queue/lookup";
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            payload: { admission: add.admission },
          })
        ).statusCode,
      ).toBe(401);
      for (const [request, accepted] of [
        [add, initial],
        [edit, changed],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${config.workerToken}` },
          payload: {
            admission: {
              ...request.admission,
              session: {
                ...request.admission.session,
                connectionId: "new-socket",
              },
            },
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          found: true,
          acceptedItem: accepted.acceptedItem,
          receipt: {
            operationGeneration: accepted.receipt.operationGeneration,
          },
        });
        expect(
          response
            .json()
            .items.some((item: { id: string }) => item.id === prompt.id),
        ).toBe(false);
      }
      const deleted = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: { admission: remove.admission },
      });
      expect(deleted.json()).toMatchObject({
        found: true,
        receipt: { status: "applied" },
      });
      const conflict = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          admission: { ...add.admission, payloadDigest: "f".repeat(64) },
        },
      });
      expect(conflict.statusCode).toBe(409);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serves GUI revision CAS and reconciles a repeated edit before worker normalization", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = { ...queuedFixture(context.modelId!), frozen: true };
    const app = Fastify();
    const { installChatQueueRoutes } =
      await import("../src/app/routes/chat-queue.js");
    const normalize = vi.fn(
      async (_worker: string, command: { prompt: typeof prompt }) => ({
        ...command.prompt,
        nativeAction: "plain",
      }),
    );
    const dispatch = vi.fn();
    installChatQueueRoutes(app, {
      applicationOwnerId: () => LOCAL_USER_ID,
      repository,
      bridge: { isConnected: () => true, request: normalize },
      beginTurn: vi.fn(),
      dispatchNextQueuedPrompt: dispatch,
      resolveModelId: async () => context.modelId!,
      resolvePromptAttachments: async () => [],
      runtimeForContext: async () => null,
      sendModelConfigurationResolutionFailure: () => null,
      appendLiveEncryptedChatMessage:
        repository.appendEncryptedMessage.bind(repository),
      deleteLiveQueuedPrompt: repository.deleteQueuedPrompt.bind(repository),
      reorderLiveQueuedPrompts:
        repository.reorderQueuedPrompts.bind(repository),
    } as never);
    try {
      const created = await app.inject({
        method: "POST",
        url: `/api/chats/${chatId}/queue`,
        payload: prompt,
      });
      expect(created.statusCode).toBe(201);
      const snapshot = (
        await app.inject({ method: "GET", url: `/api/chats/${chatId}/queue` })
      ).json();
      expect(snapshot).toMatchObject({
        revision: expect.any(Number),
        items: expect.arrayContaining([
          expect.objectContaining({ id: prompt.id, revision: 0 }),
        ]),
      });
      const edit = {
        prompt,
        expectedItemRevision: 0,
        operationId: randomUUID(),
      };
      const updated = await app.inject({
        method: "PATCH",
        url: `/api/queued-prompts/${prompt.id}`,
        payload: edit,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        id: prompt.id,
        revision: 1,
        nativeAction: "plain",
      });
      expect(normalize).toHaveBeenCalledOnce();
      const stale = await app.inject({
        method: "DELETE",
        url: `/api/queued-prompts/${prompt.id}?expectedItemRevision=0&operationId=${randomUUID()}`,
      });
      expect(stale.statusCode).toBe(409);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/queued-prompts/${prompt.id}?expectedItemRevision=1&operationId=${randomUUID()}`,
      });
      expect(removed.statusCode).toBe(204);
      const lookup = await app.inject({
        method: "GET",
        url: `/api/chats/${chatId}/queue/operations/${edit.operationId}`,
      });
      expect(lookup.statusCode).toBe(200);
      expect(lookup.json()).toMatchObject({
        found: true,
        acceptedItem: updated.json(),
        receipt: { status: "applied" },
      });
      normalize.mockRejectedValue(
        new Error("Worker unavailable after original edit"),
      );
      const repeated = await app.inject({
        method: "PATCH",
        url: `/api/queued-prompts/${prompt.id}`,
        payload: edit,
      });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toEqual(updated.json());
      expect(normalize).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("holds queued goal handoff until an exact epoch attempt starts, including worker restart", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = {
      ...queuedFixture(context.modelId!),
      executionMethod: "thread/goal/set" as const,
      nativeAction: "parseSlash" as const,
    };
    await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({ kind: "add", prompt, attachments: [] }),
    );
    const claim = (await repository.managedQueue.claimNext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const next = queuedFixture(context.modelId!);
    await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({ kind: "add", prompt: next, attachments: [] }),
    );
    const parent = admission(context, {
      origin: "gui",
      method: "thread/goal/set",
      queueClaim: { id: claim.id, promptRevision: claim.promptRevision },
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
        resumeAutonomy: true,
        goalStatus: "active",
      },
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, parent);
    expect(grant.receipt.status).toBe("accepted");
    await dispatch(parent, grant.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: parent.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "uncertain",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: null,
      executionComplete: false,
    });
    const goalEpoch = "native-goal:configuration-7";
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: parent.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      resultDigest: "e".repeat(64),
      protectedResult: opaqueMessage("assistant").protectedContent.envelope,
      rejectionCode: null,
      executionComplete: false,
      goalEpoch,
    });
    expect(
      await repository.managedQueue.claimNext(LOCAL_USER_ID, chatId),
    ).toBeNull();
    expect(
      (
        await repository.managedQueue.snapshot(LOCAL_USER_ID, chatId)
      ).claims.find((row) => row.id === claim.id),
    ).toMatchObject({ awaitingGoal: true, goalEpoch, goalOperationId: null });
    const supersede = await repository.nativeCommands.admit(LOCAL_USER_ID, {
      ...parent,
      operationId: randomUUID(),
      queueClaim: undefined,
    });
    expect(supersede.receipt.rejectionCode).toBe("queue-goal-handoff-pending");
    const handoff = {
      claimId: claim.id,
      operationId: parent.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      goalEpoch,
    };
    const attempt = admission(context, {
      origin: "autonomous",
      session: {
        ...parent.session,
        runtimeGeneration: "runtime-after-restart",
        connectionId: "new-owner",
      },
      goalQueueHandoff: handoff,
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: "actual-goal-first-turn",
      },
    });
    const stale = await repository.nativeCommands.admit(LOCAL_USER_ID, {
      ...attempt,
      operationId: randomUUID(),
      goalQueueHandoff: { ...handoff, goalEpoch: "same-objective-newer-epoch" },
    });
    expect(stale.receipt.rejectionCode).toBe("stale-goal-handoff");
    const started = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      attempt,
    );
    expect(started.receipt.status).toBe("accepted");
    await dispatch(attempt, started.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: attempt.operationId,
      operationGeneration: started.receipt.operationGeneration,
      status: "applied",
      resultDigest: "f".repeat(64),
      protectedResult: opaqueMessage("assistant").protectedContent.envelope,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: "actual-goal-first-turn",
        runtimeGeneration: attempt.session.runtimeGeneration!,
      },
    });
    expect(
      await repository.getEncryptedQueuedPrompt(LOCAL_USER_ID, prompt.id),
    ).toMatchObject({ state: "consumed" });
    await finish(attempt, started.receipt);
    const following = (await repository.managedQueue.claimNext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    expect(following.promptId).toBe(next.id);
    await repository.managedQueue.releaseUnadmitted(
      LOCAL_USER_ID,
      chatId,
      following.id,
    );
    await clearQueueFixtures();
  });
  it("explicit goal clear cancels an unstarted handoff and rejects the late exact epoch", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = {
      ...queuedFixture(context.modelId!),
      executionMethod: "thread/goal/set" as const,
    };
    await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({ kind: "add", prompt, attachments: [] }),
    );
    const claim = (await repository.managedQueue.claimNext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const parent = admission(context, {
      origin: "gui",
      method: "thread/goal/set",
      queueClaim: { id: claim.id, promptRevision: claim.promptRevision },
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
        resumeAutonomy: true,
      },
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, parent);
    await dispatch(parent, grant.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: parent.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      resultDigest: "a".repeat(64),
      protectedResult: opaqueMessage("assistant").protectedContent.envelope,
      rejectionCode: null,
      executionComplete: false,
      goalEpoch: "cleared-goal:1",
    });
    const clear = admission(context, { method: "thread/goal/clear" });
    const clearGrant = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      clear,
    );
    expect(clearGrant.receipt.status).toBe("accepted");
    await dispatch(clear, clearGrant.receipt);
    await finish(clear, clearGrant.receipt);
    expect(
      await repository.getEncryptedQueuedPrompt(LOCAL_USER_ID, prompt.id),
    ).toMatchObject({ state: "pending" });
    const late = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      admission(context, {
        origin: "autonomous",
        goalQueueHandoff: {
          claimId: claim.id,
          operationId: parent.operationId,
          operationGeneration: grant.receipt.operationGeneration,
          goalEpoch: "cleared-goal:1",
        },
      }),
    );
    expect(late.receipt.rejectionCode).toBe("stale-goal-handoff");
    expect(
      await repository.managedQueue.claimNext(LOCAL_USER_ID, chatId),
    ).toBeNull();
    await clearQueueFixtures();
  });
  it("queues GUI input while its first native thread is still being prepared without replacing the reserved lane", async () => {
    const repository = database.repository;
    const current = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const chat = await repository.createChat(
      LOCAL_USER_ID,
      current.projectId!,
      { ...protectedChatFields(), worktreeMode: "agent-managed" },
    );
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chat!.id,
    ))!;
    const session = {
      chatId: chat!.id,
      threadId: null,
      contextKind: context.contextKind,
      projectId: context.projectId,
      placementId: context.worktreeId!,
      modelRouteId: context.modelRouteId,
      providerAccountId: context.providerAccountId,
      runtimeGeneration: null,
      connectionId: null,
    };
    const parent = admission(context, { origin: "gui", session });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, parent);
    expect(grant.receipt.status).toBe("accepted");
    const prompt = { ...queuedFixture(current.modelId!), frozen: true };
    const { mutateManagedGuiQueue } =
      await import("../src/app/runtime/managed-queue-input.js");
    const queued = await mutateManagedGuiQueue(
      repository,
      LOCAL_USER_ID,
      context,
      { kind: "add", prompt, attachments: [] },
      { operationId: randomUUID() },
    );
    expect(queued.receipt.status).toBe("applied");
    expect(queued.items).toContainEqual(
      expect.objectContaining({ id: prompt.id }),
    );
    expect(
      (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chat!.id))
        .activationGeneration,
    ).toBe(grant.receipt.activationGeneration);
    await repository.nativeCommands.cancelPreparing(
      LOCAL_USER_ID,
      chat!.id,
      grant.receipt.activationGeneration!,
    );
  });
  it("cancels accepted queued goal authority before a delayed native dispatch", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const prompt = {
      ...queuedFixture(context.modelId!),
      executionMethod: "thread/goal/set" as const,
    };
    await repository.managedQueue.mutate(
      LOCAL_USER_ID,
      await queueInput({ kind: "add", prompt, attachments: [] }),
    );
    const claim = (await repository.managedQueue.claimNext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const parent = admission(context, {
      origin: "gui",
      method: "thread/goal/set",
      queueClaim: { id: claim.id, promptRevision: claim.promptRevision },
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
        resumeAutonomy: true,
      },
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, parent);
    expect(grant.receipt.status).toBe("accepted");
    const clear = admission(context, { method: "thread/goal/clear" });
    const clearing = await repository.nativeCommands.admit(
      LOCAL_USER_ID,
      clear,
    );
    await dispatch(clear, clearing.receipt);
    await finish(clear, clearing.receipt);
    expect(
      await repository.nativeCommands.get(
        LOCAL_USER_ID,
        workerId,
        parent.operationId,
        grant.receipt.operationGeneration,
      ),
    ).toMatchObject({
      status: "rejected",
      rejectionCode: "queue-goal-handoff-cancelled",
    });
    await expect(dispatch(parent, grant.receipt)).rejects.toBeDefined();
    expect(
      await repository.getEncryptedQueuedPrompt(LOCAL_USER_ID, prompt.id),
    ).toMatchObject({ state: "pending" });
    await clearQueueFixtures();
  });

  it("recovers the exact surviving worker GUI root into the completion outbox and fences a newer root", async () => {
    const repository = database.repository;
    const context = (await repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    ))!;
    const user = opaqueMessage("user");
    const input = admission(context, {
      origin: "gui",
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: "recovered-final-turn",
      },
    });
    const grant = await repository.nativeCommands.admit(LOCAL_USER_ID, input, {
      clientMessageId: user.id,
    });
    const attribution = {
      contextKind: "project" as const,
      executionLaneId: grant.receipt.executionLaneId!,
      worktreeId: context.worktreeId!,
      scratchRootId: null,
    };
    await repository.appendEncryptedMessage(
      LOCAL_USER_ID,
      chatId,
      user,
      attribution,
    );
    await repository.appendEncryptedMessage(
      LOCAL_USER_ID,
      chatId,
      { ...opaqueMessage("assistant"), idempotencyKey: `assistant:${user.id}` },
      attribution,
    );
    await dispatch(input, grant.receipt);
    await repository.nativeCommands.settle(LOCAL_USER_ID, {
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      resultDigest: "a".repeat(64),
      protectedResult: opaqueMessage("assistant").protectedContent.envelope,
      rejectionCode: null,
      executionComplete: false,
    });
    const outcome = {
      type: "chat.turn.outcome" as const,
      chatId,
      clientMessageId: user.id,
      executionLaneId: grant.receipt.executionLaneId!,
      contextKind: "project" as const,
      worktreeId: context.worktreeId!,
      scratchRootId: null,
      nativeLogicalRoot: {
        operationId: input.operationId,
        operationGeneration: grant.receipt.operationGeneration,
      },
      outcome: {
        ok: true as const,
        result: {
          threadId: input.session.threadId!,
          turnId: "recovered-final-turn",
          status: "completed" as const,
          text: "",
        },
      },
    };
    const { createChatRecoveryRuntime } =
      await import("../src/app/runtime/chat-recovery-runtime.js");
    const request = vi.fn(
      async (_worker: string, command: { type: string }) => {
        if (command.type === "chat.native-logical.complete")
          throw new Error("First logical ACK lost");
        return {};
      },
    );
    const noop = vi.fn();
    const recovery = createChatRecoveryRuntime({
      app: { log: { warn: noop, error: noop, info: noop } },
      applicationOwnerId: () => LOCAL_USER_ID,
      repository,
      bridge: { request, isConnected: () => true },
      runAsOwner: async (_owner: string, operation: () => Promise<unknown>) =>
        operation(),
      appendLiveEncryptedChatMessage:
        repository.appendEncryptedMessage.bind(repository),
      upsertLiveChatMessage: noop,
      interruptLiveAgentInteractionRequests: noop,
      publishChatTurnBoundary: noop,
      publishChatInvalidation: noop,
    } as never);
    await recovery.recoverChatTurnOutcome(LOCAL_USER_ID, workerId, outcome);
    expect(
      await repository.nativeCommands.getLogicalCompletion(
        LOCAL_USER_ID,
        workerId,
        chatId,
        input.operationId,
        grant.receipt.operationGeneration,
      ),
    ).toMatchObject({ rootOperationId: input.operationId });
    expect(
      (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
        .activationGeneration,
    ).toBeNull();
    expect(request).toHaveBeenCalledWith(
      workerId,
      {
        type: "chat.native-logical.complete",
        chatId,
        rootOperationId: input.operationId,
        rootOperationGeneration: grant.receipt.operationGeneration,
      },
      { ownerId: LOCAL_USER_ID, timeoutMs: 10000 },
    );
    const next = admission(
      (await repository.getChatExecutionContext(LOCAL_USER_ID, chatId))!,
      { origin: "gui" },
    );
    const newer = await repository.nativeCommands.admit(LOCAL_USER_ID, next, {
      clientMessageId: randomUUID(),
    });
    expect(newer.receipt.status).toBe("accepted");
    const requestCount = request.mock.calls.length;
    await recovery.recoverChatTurnOutcome(LOCAL_USER_ID, workerId, outcome);
    expect(request.mock.calls).toHaveLength(requestCount);
    expect(
      (await repository.nativeCommands.controlContext(LOCAL_USER_ID, chatId))
        .activationGeneration,
    ).toBe(newer.receipt.activationGeneration);
    await finish(next, newer.receipt, "rejected");
  });
});

describe("native settings application evidence", () => {
  it.each([
    "unsetServiceTier",
    "collaborationModeKind",
    "multiAgentEnabled",
    "subagentModel",
    "subagentReasoningEffort",
  ])(
    "admits the explicit %s settings field through the shared command path",
    async (key) => {
      const context = await database.repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chatId,
      );
      const input = admission(context, {
        method: "thread/settings/update",
        intent: {
          scope: "thread",
          settingKeys: [key],
          nativeSettingsOperationId: randomUUID(),
          expectedTurnId: null,
        },
      });
      const grant = await database.repository.nativeCommands.admit(
        LOCAL_USER_ID,
        input,
      );
      expect(grant.receipt.status).toBe("accepted");
      await dispatch(input, grant.receipt);
      await finish(input, grant.receipt);
    },
  );

  async function settingsCommand() {
    const context = await database.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      chatId,
    );
    const nativeOperationId = randomUUID();
    const input = admission(context, {
      method: "thread/settings/update",
      intent: {
        scope: "thread",
        settingKeys: ["model"],
        nativeSettingsOperationId: nativeOperationId,
        expectedTurnId: null,
      },
    });
    const grant = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      input,
    );
    expect(grant.receipt.status).toBe("accepted");
    const event = (
      kind:
        | "queued"
        | "applied"
        | "rejected"
        | "transport-lost"
        | "correlation-conflict",
      submissionId: string | null = "settings-submission",
    ) => ({
      workerId,
      operationId: input.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      nativeOperationId,
      eventId: randomUUID(),
      threadId: input.session.threadId!,
      runtimeGeneration: input.session.runtimeGeneration!,
      kind,
      submissionId,
      resultDigest: "b".repeat(64),
      protectedResult: opaqueMessage("assistant").protectedContent.envelope,
    });
    return {
      input,
      grant,
      event,
      record: (value: ReturnType<typeof event>) =>
        database.repository.nativeCommands.recordSettingsEvidence(
          LOCAL_USER_ID,
          value,
        ),
    };
  }

  it("recovers a lost HTTP acknowledgment through the production worker delivery and authenticated route", async () => {
    const { NativeSettingsDelivery } =
      await import("../../cantrip_worker/src/native-settings-delivery.js");
    const { NativeCommandClient } =
      await import("../../cantrip_worker/src/native-command-client.js");
    const { input, grant } = await settingsCommand();
    await dispatch(input, grant.receipt);
    const app = Fastify();
    installInternalNativeCommandRoutes(app, {
      config,
      serverId: "fixture-server",
      repository: database.repository,
      dispatchNextQueuedPrompt: async () => {},
      runAsOwner: async (_owner, operation) => operation(),
      live: {
        publishEncryptedChatMessage() {},
        publishTaskMessage() {},
        publishChatSummary() {},
        publishChatTurnBoundary() {},
        publishChatInvalidation() {},
      },
    });
    const bodies: string[] = [];
    const responses: Array<Record<string, any>> = [];
    const client = new NativeCommandClient({
      serverUrl: "http://fixture",
      workerId,
      token: () => config.workerToken,
      fetch: async (url, options) => {
        bodies.push(String(options?.body));
        const response = await app.inject({
          method: "POST",
          url: new URL(String(url)).pathname,
          headers: options?.headers as Record<string, string>,
          payload: String(options?.body),
        });
        responses.push(response.json());
        if (bodies.length === 1) throw new Error("Lost response after commit");
        return new Response(response.body, {
          status: response.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const errors: unknown[] = [];
    const delivery = new NativeSettingsDelivery({
      directory: path.join(dataDirectory, "settings-delivery"),
      workerId,
      client,
      retryDelayMs: 10,
      service: {
        ownerId: () => LOCAL_USER_ID,
        serverIdentity: () => "fixture-server",
        componentKey: () => ({
          keyRevision: 1,
          key: new Uint8Array(32).fill(7),
        }),
      },
      onError: (error) => errors.push(error),
    });
    try {
      const scope = {
        chatId,
        operationId: input.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        nativeOperationId: input.intent.nativeSettingsOperationId!,
        threadId: input.session.threadId!,
        runtimeGeneration: input.session.runtimeGeneration!,
      };
      await delivery.track(scope);
      await delivery.record(scope, "applied", "native-submission", {
        developer_instructions: "private-native-settings",
      });
      await expect.poll(() => responses.length).toBe(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(bodies[0]).not.toContain("private-native-settings");
      expect(responses[0]).toEqual(responses[1]);
      expect(responses[1]!.application).toMatchObject({
        status: "applied",
        evidenceCount: 1,
      });
      expect(errors).toHaveLength(1);
    } finally {
      await delivery.stop();
      await app.close();
    }
  });

  it("records actual application before the RPC acknowledgment without regressing on a late queue receipt", async () => {
    const { input, grant, event, record } = await settingsCommand();
    const applied = event("applied");
    await expect(record(applied)).rejects.toMatchObject({
      code: "native-settings-evidence-scope",
    });
    await dispatch(input, grant.receipt);
    expect((await record(applied)).application.status).toBe("applied");
    expect((await record(event("queued"))).application).toMatchObject({
      status: "applied",
      evidenceCount: 2,
    });
    const receipt = await database.repository.nativeCommands.settle(
      LOCAL_USER_ID,
      {
        workerId,
        operationId: input.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        status: "applied",
        resultDigest: null,
        protectedResult: null,
        rejectionCode: null,
        executionComplete: false,
      },
    );
    expect(receipt.settingsApplication?.status).toBe("applied");
    expect((await record(applied)).application.evidenceCount).toBe(2);
    await expect(
      record({ ...applied, resultDigest: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "native-settings-evidence-conflict" });
  });

  it("does not confuse accepted RPCs with successful settings and retains contradictory facts", async () => {
    const { input, grant, event, record } = await settingsCommand();
    await dispatch(input, grant.receipt);
    expect((await record(event("queued"))).application.status).toBe("pending");
    expect((await record(event("rejected"))).application.status).toBe(
      "rejected",
    );
    const receipt = await database.repository.nativeCommands.settle(
      LOCAL_USER_ID,
      {
        workerId,
        operationId: input.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        status: "applied",
        resultDigest: null,
        protectedResult: null,
        rejectionCode: null,
        executionComplete: false,
      },
    );
    expect(receipt.status).toBe("applied");
    expect(receipt.settingsApplication?.status).toBe("rejected");
    expect((await record(event("applied"))).application.status).toBe(
      "uncertain",
    );
    expect((await record(event("queued"))).application.status).toBe(
      "uncertain",
    );
  });

  it("recovers from transport loss using evidence without granting mutation replay", async () => {
    const { input, grant, event, record } = await settingsCommand();
    await dispatch(input, grant.receipt);
    expect(
      (await record(event("transport-lost", null))).application.status,
    ).toBe("uncertain");
    expect((await record(event("applied"))).application.status).toBe("applied");
    const replay = await database.repository.nativeCommands.admit(
      LOCAL_USER_ID,
      input,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.settingsApplication?.status).toBe("applied");
    expect(
      (await record(event("queued", "other-submission"))).application.status,
    ).toBe("uncertain");
  });

  it("rejects wrong owner, worker, operation generation, native thread and transport", async () => {
    const { input, grant, event, record } = await settingsCommand();
    await dispatch(input, grant.receipt);
    const evidence = event("applied");
    await expect(
      database.repository.nativeCommands.recordSettingsEvidence(
        "other-owner",
        evidence,
      ),
    ).rejects.toMatchObject({ code: "operation-not-found" });
    for (const override of [
      { workerId: "other-worker" },
      { operationGeneration: "other-operation" },
    ])
      await expect(record({ ...evidence, ...override })).rejects.toMatchObject({
        code: "operation-not-found",
      });
    for (const override of [
      { threadId: "child-thread" },
      { runtimeGeneration: "other-runtime" },
      { nativeOperationId: "other-native-operation" },
    ])
      await expect(record({ ...evidence, ...override })).rejects.toMatchObject({
        code: "native-settings-evidence-scope",
      });
    expect((await record(evidence)).application.evidenceCount).toBe(1);
  });

  it("serializes concurrent delivery and prevents shared event IDs from crossing commands", async () => {
    const a = await settingsCommand();
    const b = await settingsCommand();
    await dispatch(a.input, a.grant.receipt);
    await dispatch(b.input, b.grant.receipt);
    const applied = a.event("applied");
    const results = await Promise.all([
      a.record(applied),
      a.record(applied),
      a.record(a.event("queued")),
    ]);
    expect(
      results.every((result) => result.application.status === "applied"),
    ).toBe(true);
    await expect(
      b.record({ ...b.event("applied"), eventId: applied.eventId }),
    ).rejects.toMatchObject({ code: "native-settings-evidence-conflict" });
    expect(
      (await b.record(b.event("rejected"))).application.evidenceCount,
    ).toBe(1);
  });
});
