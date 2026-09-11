import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  encryptedChatTurnCreateSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { buildApp } from "../src/app.js";
import { AppLiveHub } from "../src/live/hub.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";
import {
  protectedChatFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";
import {
  LOCAL_USER_ID as owner,
  DEFAULT_MODEL_ID,
} from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let f: Awaited<ReturnType<typeof createNativeSettingsFixture>> | undefined;
const pending: Promise<unknown>[] = [];
let release: () => void = () => {};
let releaseCode: () => void = () => {};
afterEach(async () => {
  release();
  releaseCode();
  await Promise.allSettled(pending.splice(0));
  await app?.close();
  await f?.close();
  vi.restoreAllMocks();
});
function turn() {
  const id = randomUUID();
  const message = {
    id,
    classification: { role: "user", mode: "default", attachmentIds: [] },
    protectedContent: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: settingsEnvelope,
    },
    reasoningEffort: null,
    idempotencyKey: id,
  };
  return encryptedChatTurnCreateSchema.parse({
    message,
    modelId: DEFAULT_MODEL_ID,
    queuedPrompt: {
      id: randomUUID(),
      classification: { mode: "default", attachmentIds: [] },
      protectedContent: message.protectedContent,
      modelId: DEFAULT_MODEL_ID,
      reasoningEffort: null,
      worktreeId: null,
      frozen: false,
      idempotencyKey: id,
      pendingMessage: message,
    },
  });
}
async function fixture({ consoleFailure = false, holdCode = false } = {}) {
  app = undefined;
  f = undefined;
  const code = new Promise<void>((resolve) => {
    releaseCode = resolve;
  });
  if (!holdCode) releaseCode();
  f = await createNativeSettingsFixture();
  const repository = f.repository;
  const context = (await repository.getChatExecutionContext(owner, f.chatId))!;
  let reject: (error: Error) => void = () => {};
  const thread = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  void thread.catch(() => {});
  const commands: WorkerCommand[] = [];
  const attachments = new Map<string, () => void>();
  const bridge: WorkerCommandBus = {
    attach() {},
    close() {},
    isConnected: () => true,
    sendSurfaceFrame: () => false,
    subscribeWorkerDisconnect: () => () => {},
    subscribeSurfaceFrames: () => () => {},
    request: async (_worker, command, options) => {
      commands.push(command);
      if (command.type === "chat.thread.ensure") {
        await thread;
        return {
          threadId: command.threadId ?? `native-${command.session!.chatId}`,
        };
      }
      if (command.type === "terminal.prepare-state")
        return protectedTerminalFields(command.terminalId);
      if (command.type === "terminal.open") {
        if (consoleFailure) throw new Error("Fixture CLI spawn failed");
        const done = new Promise((resolve) =>
          attachments.set(command.attachmentId, () =>
            resolve({ status: "detached" }),
          ),
        );
        options?.onEvent?.({ type: "terminal.ready" } as never);
        return done;
      }
      if (command.type === "terminal.detach") {
        attachments.get(command.attachmentId)?.();
        return { status: "detached" };
      }
      if (command.type === "code.agentTurnState") return { notified: true };
      if (command.type === "code.prepareAgentTurn") {
        await code;
        return { prepared: true, sessions: [] };
      }
      if (command.type === "chat.turn")
        throw new Error("Fixture records dispatch but does not run a model.");
      throw new Error(`Fixture has no handler for ${command.type}`);
    },
  };
  app = await buildApp({
    config: f.config,
    database: {
      repository,
      engine: "pglite",
      close: async () => {},
      ping: async () => {},
    },
    logger: false,
    workerBridge: bridge,
  });
  const input = protectedChatFields();
  const created = await app.inject({
    method: "POST",
    url: `/api/projects/${context.projectId}/chats`,
    payload: { ...input, worktreeId: context.worktreeId },
  });
  expect(created.statusCode, created.body).toBe(201);
  await vi.waitFor(() =>
    expect(
      commands.some((command) => command.type === "chat.thread.ensure"),
    ).toBe(true),
  );
  return { chatId: input.id, commands, reject, repository };
}
function observeSubmission(
  repository: NonNullable<typeof f>["repository"],
  chatId: string,
) {
  const original = repository.getChatExecutionContext.bind(repository);
  let observed!: () => void;
  const read = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const spy = vi
    .spyOn(repository, "getChatExecutionContext")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === chatId) observed();
      return result;
    });
  return read.finally(() => spy.mockRestore());
}
it("reports native preparation failure through the actual first-send route without claiming acceptance", async () => {
  const published = vi.spyOn(AppLiveHub.prototype, "publish");
  const { chatId, reject, repository, commands } = await fixture();
  const input = turn();
  const observed = observeSubmission(repository, chatId);
  const response = app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/turns`,
    payload: input,
  });
  pending.push(response);
  await observed;
  reject(new Error("Fixture native preparation failed"));
  const result = await response;
  expect(result.statusCode, result.body).toBe(400);
  expect(result.json().error).toContain("Fixture native preparation failed");
  expect(published).toHaveBeenCalledWith(
    expect.objectContaining({
      resource: "chat-preparation",
      scope: { kind: "chat", chatId },
    }),
  );
  expect(
    await repository.getEncryptedMessageByIdempotencyKey(
      owner,
      chatId,
      input.message.idempotencyKey,
    ),
  ).toBeNull();
  expect(
    commands.filter((command) => command.type === "chat.turn"),
  ).toHaveLength(0);
}, 60000);
it("Stop during eager preparation prevents the waiting first input from dispatching later", async () => {
  const { chatId, repository, commands } = await fixture();
  const input = turn();
  const observed = observeSubmission(repository, chatId);
  const response = app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/turns`,
    payload: input,
  });
  pending.push(response);
  await observed;
  const stopped = await app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/interrupt`,
  });
  expect(stopped.statusCode, stopped.body).toBe(200);
  expect(stopped.json().interrupted).toBe(true);
  release();
  const result = await response;
  expect(result.statusCode, result.body).toBe(409);
  expect(result.json().error).toContain("cancelled-before-admission");
  expect(
    commands.filter((command) => command.type === "chat.turn"),
  ).toHaveLength(0);
  expect(
    await repository.getEncryptedMessageByIdempotencyKey(
      owner,
      chatId,
      input.message.idempotencyKey,
    ),
  ).toBeNull();
  const next = turn();
  const sent = await app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/turns`,
    payload: next,
  });
  expect(sent.statusCode, sent.body).toBe(202);
  expect(sent.json().message.id).toBe(next.message.id);
  await vi.waitFor(() =>
    expect(
      commands.filter((command) => command.type === "chat.turn"),
    ).toHaveLength(1),
  );
}, 60000);

it("accepts the first GUI message despite a CLI-only failure and returns the same saved input on retry", async () => {
  const { chatId, repository, commands } = await fixture({
    consoleFailure: true,
  });
  release();
  await vi.waitFor(async () =>
    expect(
      await repository.managedChatPreparations.get(owner, chatId),
    ).toMatchObject({ phase: "failed", failedPhase: "console" }),
  );
  const input = turn();
  const response = await app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/turns`,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(202);
  expect(response.json().message.id).toBe(input.message.id);
  await vi.waitFor(() =>
    expect(
      commands.filter((command) => command.type === "chat.turn"),
    ).toHaveLength(1),
  );
  const repeated = await app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/turns`,
    payload: input,
  });
  expect(repeated.statusCode, repeated.body).toBe(200);
  expect(repeated.json().message.id).toBe(input.message.id);
  expect(
    commands.filter((command) => command.type === "chat.turn"),
  ).toHaveLength(1);
}, 60000);

it("Stop during Code preparation also cancels input after native startup has finished", async () => {
  const { chatId, repository, commands } = await fixture({ holdCode: true });
  release();
  const input = turn();
  const response = app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/turns`,
    payload: input,
  });
  pending.push(response);
  await vi.waitFor(() =>
    expect(
      commands.some((command) => command.type === "code.prepareAgentTurn"),
    ).toBe(true),
  );
  const stopped = await app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/interrupt`,
  });
  expect(stopped.statusCode, stopped.body).toBe(200);
  releaseCode();
  const result = await response;
  expect(result.statusCode, result.body).toBe(409);
  expect(result.json().code).toBe("cancelled-before-admission");
  expect(
    commands.filter((command) => command.type === "chat.turn"),
  ).toHaveLength(0);
  expect(
    await repository.getEncryptedMessageByIdempotencyKey(
      owner,
      chatId,
      input.message.idempotencyKey,
    ),
  ).toBeNull();
}, 60000);
