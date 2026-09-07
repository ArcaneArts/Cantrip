import { describe, expect, it, vi } from "vitest";
import { prepareConsoleExecutionContext } from "../src/chats/console-context.js";
import { managedConsoleChat } from "../src/chats/execution-helpers.js";
import { workerCommandSchema } from "@cantrip/protocol";
import type { ChatExecutionContext } from "../src/db/repository.js";

const context = {
  chatId: "chat",
  contextKind: "project",
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  rootKind: "git-worktree",
  scratchRootId: null,
  executionLaneId: null,
  computerUseEnabled: true,
  status: "idle",
} as ChatExecutionContext;

it("reserves a console-first lane and sends enabled tools before any model turn", async () => {
  const getChatExecutionContext = vi
    .fn()
    .mockResolvedValueOnce(context)
    .mockResolvedValue({ ...context, executionLaneId: "lane" });
  const ensureChatConsoleExecutionLane = vi.fn(async () => {});
  const prepared = await prepareConsoleExecutionContext(
    { getChatExecutionContext, ensureChatConsoleExecutionLane },
    "owner",
    "chat",
  );
  expect(ensureChatConsoleExecutionLane).toHaveBeenCalledWith("owner", "chat");
  expect(getChatExecutionContext).toHaveBeenLastCalledWith(
    "owner",
    "chat",
    true,
  );
  expect(prepared?.status).toBe("idle");
  expect(managedConsoleChat(prepared!)).toEqual({
    chatId: "chat",
    executionLaneId: "lane",
    contextKind: "project",
    projectId: "project",
    worktreeId: "worktree",
    rootKind: "git-worktree",
    scratchRootId: null,
    computerUseEnabled: true,
  });
});

it("reuses the reserved lane and reads the current off switch when reopening", async () => {
  const getChatExecutionContext = vi.fn(async () => ({
    ...context,
    executionLaneId: "lane",
    computerUseEnabled: false,
  }));
  const ensureChatConsoleExecutionLane = vi.fn();
  const prepared = await prepareConsoleExecutionContext(
    { getChatExecutionContext, ensureChatConsoleExecutionLane },
    "owner",
    "chat",
  );
  expect(ensureChatConsoleExecutionLane).not.toHaveBeenCalled();
  expect(managedConsoleChat(prepared!)?.computerUseEnabled).toBe(false);
});

describe("console managed context wire contract", () => {
  const managedChat = managedConsoleChat({
    ...context,
    executionLaneId: "lane",
  });
  const command = {
    type: "chat.thread.ensure",
    managedChat,
    cwd: "/project",
    threadId: null,
    planMode: "default",
    permissionProfileId: ":workspace",
    mcpServers: [],
    model: {
      id: "model",
      routeId: "route",
      name: "model",
      reasoningEffort: "medium",
    },
    provider: {
      id: "provider",
      name: "provider",
      kind: "chatgpt",
      baseUrl: "https://example.com",
      protectedApiKey: null,
    },
  };
  it("preserves managed scope through worker validation", () => {
    expect(workerCommandSchema.parse(command)).toMatchObject({ managedChat });
  });
  it("keeps older unbound commands compatible and rejects mixed placements", () => {
    const { managedChat: _scope, ...legacy } = command;
    expect(workerCommandSchema.safeParse(legacy).success).toBe(true);
    expect(
      workerCommandSchema.safeParse({
        ...command,
        managedChat: { ...managedChat, scratchRootId: "scratch" },
      }).success,
    ).toBe(false);
  });
});
