import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { installChatRuntimeConfigurationRoutes } from "../src/app/routes/chat-runtime-configuration.js";
import { NativeCommandError } from "../src/db/repository/native-command-errors.js";
const binding = {
  bindingId: "binding",
  chatId: "chat",
  workerId: "worker",
  threadId: "native-thread",
  runtimeGeneration: "native-runtime",
  nativeEpoch: "native-epoch",
  contextKind: "project",
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: null,
};
async function fixture() {
  const app = Fastify();
  const context = {
    chatId: "chat",
    threadId: "native-thread",
    workerId: "worker",
    defaultPermissionProfileId: ":workspace",
    isPrimary: true,
    worktreePolicy: "required-for-writes",
  };
  const repository = {
    getChatExecutionContext: vi.fn().mockResolvedValue(context),
    setChatPermissionProfile: vi.fn(),
    nativeCommands: {
      resolveSettingsWriteBinding: vi.fn().mockResolvedValue(binding),
      settingsState: vi.fn().mockResolvedValue({
        permissionPolicy: null,
        desired: null,
        pending: [],
      }),
      lookup: vi.fn().mockResolvedValue(null),
    },
  };
  const bridge = {
    isConnected: vi.fn().mockReturnValue(true),
    request: vi.fn().mockResolvedValue({
      operationId: "operation",
      submissionId: "native-submission",
      status: "queued",
    }),
  };
  installChatRuntimeConfigurationRoutes(app, {
    applicationOwnerId: () => "owner",
    repository,
    bridge,
  } as unknown as Parameters<typeof installChatRuntimeConfigurationRoutes>[1]);
  return { app, repository, bridge };
}
describe("bound permission setting route", () => {
  it("returns a pending conflict from the actual rejected command instead of a 500", async () => {
    const f = await fixture();
    try {
      f.bridge.request.mockRejectedValue(
        new Error(
          "Native command admission rejected: permission-transition-pending",
        ),
      );
      f.repository.nativeCommands.lookup.mockResolvedValue({
        chatId: "chat",
        method: "thread/settings/update",
        status: "rejected",
        rejectionCode: "permission-transition-pending",
      });
      const response = await f.app.inject({
        method: "PATCH",
        url: "/api/chats/chat/permission-profile",
        payload: {
          id: ":yolo",
          operationId: "operation",
          bindingId: "binding",
          expectedRevision: "0",
        },
      });
      expect(f.bridge.request).toHaveBeenCalledTimes(1);
      expect(f.repository.nativeCommands.lookup).toHaveBeenCalledWith(
        "owner",
        "worker",
        "operation",
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "permission-transition-pending",
        error:
          "A permission change is already pending. Check the permission menu for its status.",
      });
    } finally {
      await f.app.close();
    }
  });
  it.each([
    null,
    {
      chatId: "another-chat",
      method: "thread/settings/update",
      status: "rejected",
      rejectionCode: "permission-transition-pending",
    },
    {
      chatId: "chat",
      method: "thread/settings/update",
      status: "applied",
      rejectionCode: null,
    },
  ])(
    "does not invent a rejection when the command did not reject: %s",
    async (record) => {
      const f = await fixture();
      try {
        f.bridge.request.mockRejectedValue(new Error("worker disconnected"));
        f.repository.nativeCommands.lookup.mockResolvedValue(record);
        const response = await f.app.inject({
          method: "PATCH",
          url: "/api/chats/chat/permission-profile",
          payload: {
            id: ":yolo",
            operationId: "operation",
            bindingId: "binding",
            expectedRevision: "0",
          },
        });
        expect(response.statusCode).toBe(500);
      } finally {
        await f.app.close();
      }
    },
  );
  it("routes an exact-source durable transition and does not mutate confirmed selection or probe capability", async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({
        method: "PATCH",
        url: "/api/chats/chat/permission-profile",
        payload: {
          id: ":yolo",
          operationId: "operation",
          bindingId: "binding",
          expectedRevision: "0",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "queued" });
      expect(f.bridge.request).toHaveBeenCalledExactlyOnceWith("worker", {
        type: "chat.permissions.update",
        operationId: "operation",
        binding,
        permissionTransition: {
          selectedId: ":yolo",
          resolvedSelectedId: ":yolo",
          effectiveId: ":read-only",
          expectedRevision: "0",
        },
      });
      expect(f.repository.setChatPermissionProfile).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it("rejects unbound/stale source writes before forwarding and preserves an explicit retryable conflict", async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.app.inject({
            method: "PATCH",
            url: "/api/chats/chat/permission-profile",
            payload: { id: null },
          })
        ).statusCode,
      ).toBe(400);
      expect(f.bridge.request).not.toHaveBeenCalled();
      f.repository.nativeCommands.resolveSettingsWriteBinding.mockRejectedValue(
        new NativeCommandError("settings-binding-replaced"),
      );
      const response = await f.app.inject({
        method: "PATCH",
        url: "/api/chats/chat/permission-profile",
        payload: {
          id: null,
          operationId: "operation",
          bindingId: "old-binding",
          expectedRevision: "0",
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "settings-binding-replaced",
      });
      expect(f.bridge.request).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
});
