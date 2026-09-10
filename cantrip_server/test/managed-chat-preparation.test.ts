import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedChatPreparation } from "../src/app/runtime/managed-chat-preparation.js";
import { installManagedChatPreparationRoutes } from "../src/app/routes/managed-chat-preparation.js";
import { installProjectChatCatalogRoutes } from "../src/app/routes/chat-catalogs.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import {
  protectedChatFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeEach(async () => {
  f = await createNativeSettingsFixture();
  await f.db
    .update(schema.chatRuntimeSessions)
    .set({ codexThreadId: null })
    .where(eq(schema.chatRuntimeSessions.chatId, f.chatId));
}, 60000);
afterEach(async () => {
  await f?.close();
});
async function fixture(
  options: { thread?: () => Promise<void>; console?: () => Promise<void> } = {},
) {
  const calls: string[] = [];
  const attachments = new Map<string, () => void>();
  const bridge: Pick<WorkerCommandBus, "request"> = {
    request: async (_worker, command, requestOptions) => {
      calls.push(command.type);
      if (command.type === "chat.thread.ensure") {
        await options.thread?.();
        return {
          threadId: command.threadId ?? `native-${command.session!.chatId}`,
        };
      }
      if (command.type === "terminal.prepare-state")
        return protectedTerminalFields(command.terminalId);
      if (command.type === "terminal.open") {
        const finished = new Promise((resolve) =>
          attachments.set(command.attachmentId, () =>
            resolve({ status: "detached" }),
          ),
        );
        await options.console?.();
        requestOptions?.onEvent?.({
          type: "terminal.ready",
          terminalId: command.terminalId,
        } as never);
        return finished;
      }
      if (command.type === "terminal.detach") {
        attachments.get(command.attachmentId)?.();
        return { status: "detached" };
      }
      throw new Error(`Unexpected worker command: ${command.type}`);
    },
  };
  const [route] = await f.db.select().from(schema.modelRoutes).limit(1);
  const runtime = (await f.repository.getModelRuntimeByRoute(
    owner,
    route!.id,
  ))!;
  const preparation = createManagedChatPreparation({
    repository: f.repository,
    bridge,
    serverId: "server",
    runAsOwner: async (_owner, run) => run(),
    publish() {},
    runtimeForContext: async () => runtime,
    routePairsForConfiguration: async () =>
      [{ root: { runtime, reasoningEffort: null }, subagent: null }] as never,
  });
  return { preparation, calls, bridge };
}
it("coalesces preparation and joins the canonical thread before waiting for CLI startup", async () => {
  let releaseThread!: () => void;
  let releaseConsole!: () => void;
  const thread = new Promise<void>((resolve) => {
    releaseThread = resolve;
  });
  const cli = new Promise<void>((resolve) => {
    releaseConsole = resolve;
  });
  const { preparation, calls } = await fixture({
    thread: () => thread,
    console: () => cli,
  });
  await Promise.all([
    preparation.request(owner, f.chatId),
    preparation.request(owner, f.chatId),
  ]);
  let joined = false;
  const join = preparation.join(owner, f.chatId).then(() => {
    joined = true;
  });
  await vi.waitFor(() => expect(calls).toContain("chat.thread.ensure"));
  expect(joined).toBe(false);
  releaseThread();
  await join;
  expect(
    (await f.repository.getChatExecutionContext(owner, f.chatId))!.threadId,
  ).toBe(`native-${f.chatId}`);
  expect(calls.filter((type) => type === "chat.thread.ensure")).toHaveLength(1);
  await vi.waitFor(() => expect(calls).toContain("terminal.open"));
  expect(
    (await f.repository.managedChatPreparations.get(owner, f.chatId))!.phase,
  ).toBe("console");
  releaseConsole();
  await preparation.settle(owner, f.chatId);
  expect(
    (await f.repository.managedChatPreparations.get(owner, f.chatId))!.phase,
  ).toBe("ready");
  expect(calls).not.toContain("terminal.input");
  expect(
    (await f.db.select().from(schema.terminals)).filter(
      (row) => row.linkedChatId === f.chatId,
    ),
  ).toHaveLength(1);
});
it.each(["thread", "console"] as const)(
  "persists a real %s failure and allows an explicit retry",
  async (phase) => {
    let fail = true;
    const { preparation } = await fixture({
      [phase]: async () => {
        if (fail) throw new Error("fixture unavailable");
      },
    });
    await preparation.request(owner, f.chatId);
    await preparation.settle(owner, f.chatId);
    expect(
      await f.repository.managedChatPreparations.get(owner, f.chatId),
    ).toMatchObject({ phase: "failed", failedPhase: phase });
    if (phase === "console") await preparation.join(owner, f.chatId);
    fail = false;
    await preparation.request(owner, f.chatId);
    await preparation.settle(owner, f.chatId);
    expect(
      await f.repository.managedChatPreparations.get(owner, f.chatId),
    ).toMatchObject({ phase: "ready", failedPhase: null });
  },
);
it("starts preparation on actual chat creation without opening a presentation, and scopes status to its owner", async () => {
  const { preparation, bridge, calls } = await fixture();
  const app = Fastify();
  let currentOwner = owner;
  installProjectChatCatalogRoutes(app, {
    applicationOwnerId: () => currentOwner,
    repository: f.repository,
    bridge: { isConnected: () => true },
    publishStandaloneChatRootJobChange() {},
    standaloneChatRootJobExecutor: { queueAvailable() {} },
    prepareManagedChat: preparation.request,
  });
  installManagedChatPreparationRoutes(app, {
    applicationOwnerId: () => currentOwner,
    repository: f.repository,
    preparation,
  });
  try {
    const context = (await f.repository.getChatExecutionContext(
      owner,
      f.chatId,
    ))!;
    const input = protectedChatFields();
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/chats`,
      payload: { ...input, worktreeId: context.worktreeId },
    });
    expect(response.statusCode, response.body).toBe(201);
    await preparation.settle(owner, input.id);
    const state = await app.inject({
      url: `/api/chats/${input.id}/preparation`,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json().preparation.phase).toBe("ready");
    expect(calls.filter((type) => type === "terminal.open")).toHaveLength(1);
    const before = calls.length;
    await app.inject({ url: `/api/chats/${input.id}/preparation` });
    expect(calls).toHaveLength(before);
    currentOwner = "another-owner";
    expect(
      (await app.inject({ url: `/api/chats/${input.id}/preparation` }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
it("recovers the same console after a worker reconnect and ignores a superseded status write", async () => {
  const { preparation } = await fixture();
  await preparation.request(owner, f.chatId);
  await preparation.settle(owner, f.chatId);
  const prior = (await f.repository.managedChatPreparations.get(
    owner,
    f.chatId,
  ))!;
  await preparation.workerConnected(owner, f.workerId);
  await preparation.settle(owner, f.chatId);
  const recovered = (await f.repository.managedChatPreparations.get(
    owner,
    f.chatId,
  ))!;
  expect(recovered.terminalId).toBe(prior.terminalId);
  expect(recovered.generation).not.toBe(prior.generation);
  expect(
    await f.repository.managedChatPreparations.update(
      owner,
      prior,
      "failed",
      "thread",
    ),
  ).toBeNull();
  expect(
    (await f.repository.managedChatPreparations.get(owner, f.chatId))!.phase,
  ).toBe("ready");
});
it("coalesces a linked-console creation race into one durable terminal", async () => {
  const consoles = await Promise.all(
    [protectedTerminalFields(), protectedTerminalFields()].map((input) =>
      f.repository.getOrCreateChatConsole(owner, f.chatId, input),
    ),
  );
  expect(consoles[0]!.id).toBe(consoles[1]!.id);
});

it("reports a preparation failure to an immediate GUI join", async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  const { preparation, calls } = await fixture({ thread: () => pending });
  await preparation.request(owner, f.chatId);
  const joined = expect(preparation.join(owner, f.chatId)).rejects.toThrow(
    "fixture preparation failed",
  );
  await vi.waitFor(() => expect(calls).toContain("chat.thread.ensure"));
  fail(new Error("fixture preparation failed"));
  await joined;
  await preparation.settle(owner, f.chatId);
  expect(
    (await f.repository.managedChatPreparations.get(owner, f.chatId))!.phase,
  ).toBe("failed");
  expect(calls).not.toContain("terminal.open");
});

it("does not launch a console after its chat was archived during native preparation", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { preparation, calls } = await fixture({ thread: () => pending });
  await preparation.request(owner, f.chatId);
  await vi.waitFor(() => expect(calls).toContain("chat.thread.ensure"));
  await f.db
    .update(schema.chats)
    .set({ archivedAt: new Date() })
    .where(eq(schema.chats.id, f.chatId));
  release();
  await preparation.settle(owner, f.chatId);
  expect(calls).not.toContain("terminal.open");
  const before = calls.length;
  await preparation.workerConnected(owner, f.workerId);
  expect(calls).toHaveLength(before);
});

it("does not let a late older recovery replace a newer prepared session", async () => {
  const { preparation, calls } = await fixture();
  await preparation.request(owner, f.chatId);
  await preparation.settle(owner, f.chatId);
  let release!: () => void;
  const recovery = new Promise<void>((resolve) => {
    release = resolve;
  });
  await preparation.workerConnected(
    owner,
    f.workerId,
    new Map([[f.chatId, recovery]]),
  );
  const oldJoin = expect(preparation.join(owner, f.chatId)).rejects.toThrow(
    "The preparation was replaced.",
  );
  try {
    await preparation.workerConnected(owner, f.workerId);
    await preparation.settle(owner, f.chatId);
    const current = await f.repository.managedChatPreparations.get(
      owner,
      f.chatId,
    );
    const count = calls.length;
    release();
    await oldJoin;
    expect(calls).toHaveLength(count);
    expect(
      await f.repository.managedChatPreparations.get(owner, f.chatId),
    ).toEqual(current);
  } finally {
    release();
    await oldJoin;
  }
});
