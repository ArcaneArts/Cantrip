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
      { timeoutMs: 30_000 },
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
