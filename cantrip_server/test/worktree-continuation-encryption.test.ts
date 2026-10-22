import { describe, expect, it, vi } from "vitest";
import {
  createChatRecoveryRuntime,
  type ChatRecoveryRuntimeDependencies,
} from "../src/app/runtime/chat-recovery-runtime.js";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.js";
import { protectTaskConversationMessage } from "../../cantrip_worker/src/task-operation.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { decryptTaskMessageProtectedContent } from "../../packages/crypto/src/index.js";
import { taskMessageOpaqueContentSchema } from "@cantrip/protocol/tasks";

describe("worktree continuation encryption", () => {
  it("runs worker-reconnect reconciliation in the authenticated owner's scope", async () => {
    let scope: string | null = null;
    const reconcile = vi.fn(async (owner: string) => {
      expect(scope).toBe(owner);
    });
    const runtime = createChatRecoveryRuntime({
      bridge: { isConnected: () => true },
      reconcileTaskExecutions: reconcile,
      runAsOwner: async (owner: string, run: () => Promise<unknown>) => {
        scope = owner;
        try {
          return await run();
        } finally {
          scope = null;
        }
      },
      repository: { listPendingWorktreeTransitionChatIds: async () => [] },
    } as unknown as ChatRecoveryRuntimeDependencies);
    await runtime.resumePendingWorktreeTransitionsForWorker(
      "another-owner",
      "worker",
    );
    expect(reconcile).toHaveBeenCalledExactlyOnceWith("another-owner");
  });
  it.each(["task", "agent"] as const)(
    "protects a %s continuation before beginning the next turn",
    async (experience) => {
      const key = new Uint8Array(32).fill(7);
      const service = {
        ownerId: () => "owner",
        componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
      } as unknown as WorkerEncryptionService;
      let applied = false;
      const context = () => ({
        contextKind: "project",
        chatId: "chat",
        projectId: "project",
        experience,
        status: "idle",
        automationPaused: false,
        workerId: "worker",
        worktreeId: applied ? "target" : "primary",
        reasoningEffort: null,
      });
      const beginTurn = vi.fn(async (_context, _input, options) => {
        expect(
          options[
            experience === "task"
              ? "encryptedTaskMessages"
              : "encryptedChatMessages"
          ],
        ).toBeDefined();
        return {};
      });
      const recover = vi.fn(async () => true);
      const bridge = {
        isConnected: () => true,
        request: vi.fn(async (_worker, command) => {
          if (command.type === "chat.message.protect")
            return protectChatMessage({
              id: command.message.id,
              message: command.message,
              service,
            });
          if (command.type === "task.message.protect")
            return protectTaskConversationMessage({
              message: command.message,
              service,
            });
          throw new Error("Unexpected command");
        }),
      };
      const runtime = createChatRecoveryRuntime({
        applicationOwnerId: () => "owner",
        bridge,
        beginTurn,
        recoverTaskExecution: recover,
        app: { log: { error: vi.fn() } },
        repository: {
          getPendingChatWorktreeTransition: async () => ({
            lane: { id: "pending", transitionKind: "switch" },
            worktree: { workerId: "worker" },
          }),
          getChatExecutionContext: async () => context(),
          applyChatWorktreeTransition: async () => {
            applied = true;
            return {
              transitionKind: "switch",
              worktree: {
                id: "target",
                name: "Feature worktree",
                branch: "feature",
              },
            };
          },
        },
        resolveModelId: async () => "model",
        availableModelRuntimes: async () => [],
      } as unknown as ChatRecoveryRuntimeDependencies);
      expect(await runtime.continuePendingWorktreeTransition("chat")).toBe(
        true,
      );
      expect(beginTurn).toHaveBeenCalledOnce();
      expect(recover).not.toHaveBeenCalled();
      if (experience === "task") {
        const message = taskMessageOpaqueContentSchema.parse(
          beginTurn.mock.calls[0]![2].encryptedTaskMessages.userMessage,
        );
        const opened = await decryptTaskMessageProtectedContent({
          componentKey: key,
          ownerId: "owner",
          messageId: message.id,
          keyRevision: 1,
          encrypted: message.protectedContent,
          publicClassification: message.classification,
        });
        expect(opened.classification.role).toBe("system");
        expect(JSON.stringify(opened.content)).toContain(
          "Continued in Feature worktree",
        );
        expect(JSON.stringify(message)).not.toContain("Feature worktree");
      }
    },
  );
  it("does not apply a stale pending switch or protect another prompt when native work is recovered", async () => {
    const apply = vi.fn();
    const begin = vi.fn();
    const request = vi.fn();
    const runtime = createChatRecoveryRuntime({
      applicationOwnerId: () => "owner",
      bridge: { isConnected: () => true, request },
      beginTurn: begin,
      recoverTaskExecution: async () => true,
      repository: {
        getPendingChatWorktreeTransition: async () => ({
          worktree: { workerId: "worker" },
        }),
        getChatExecutionContext: async () => ({
          contextKind: "project",
          experience: "task",
          status: "failed",
          automationPaused: false,
        }),
        applyChatWorktreeTransition: apply,
      },
    } as unknown as ChatRecoveryRuntimeDependencies);
    expect(await runtime.continuePendingWorktreeTransition("chat")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
