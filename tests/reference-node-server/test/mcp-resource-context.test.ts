import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  protectedCustomizationResponseSchema,
  workerCommandSchema,
} from "@cantrip/protocol";
import type { ChatExecutionContext } from "../src/db/repository.js";

import { installChatCustomizationRoutes } from "../src/app/routes/chat-customizations.js";

const scope = {
  workerId: "worker-a",
  projectId: "project-a",
  chatId: "chat-a",
  providerId: "provider-a",
};
const protectedRequest = {
  formatVersion: 1,
  keyRevision: 1,
  domain: "customization-content",
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
const payload = {
  operationId: "67c5b79c-caa7-4d1a-9a4f-fd00be321d9a",
  operation: "customization.mcp.resource.read",
  scope,
  protectedRequest,
};

describe("MCP resource HTTP context", () => {
  it.each(["thread-a", "thread-b", null])(
    "transports the server-selected native context %s through the worker schema",
    async (threadId) => {
      const app = Fastify();
      const request = vi.fn(async (_workerId: string, command: unknown) => {
        const parsed = workerCommandSchema.parse(command);
        expect(parsed).toMatchObject({
          type: "customization.mcp.resource.read",
          threadId,
          cwd: "/project-a",
          scope,
        });
        return {
          operationId: payload.operationId,
          operation: payload.operation,
          scope,
          result: "succeeded",
          lifecycle: null,
          protectedResponse: protectedRequest,
        };
      });
      installChatCustomizationRoutes(app, {
        applicationOwnerId: () => "owner",
        serverId: "server",
        bridge: { isConnected: () => true, request },
        repository: {
          getChatExecutionContext: async () =>
            ({
              ...scope,
              cwd: "/project-a",
              threadId,
            }) as ChatExecutionContext,
        },
        runtimeForContext: async () => ({
          routeId: "route-a",
          model: {
            id: "model-a",
            profileName: "Fixture",
            providerModelId: null,
            catalog: null,
            routeId: "route-a",
            name: "fixture",
            reasoningEffort: null,
          },
          provider: {
            id: "provider-a",
            name: "Fixture",
            kind: "openai-compatible",
            baseUrl: "http://127.0.0.1:1/v1",
            protectedApiKey: null,
            accountId: null,
            credentialHomeKey: null,
            weeklyUsageReservePercent: 0,
          },
        }),
        chatCustomizationScope: () => scope,
        customizationScopesMatch: (a, b) =>
          JSON.stringify(a) === JSON.stringify(b),
        checkedCustomizationResponse: ({ raw }) =>
          protectedCustomizationResponseSchema.parse(raw),
        publishChatInvalidation: () => {},
      });
      try {
        const result = await app.inject({
          method: "POST",
          url: "/api/chats/chat-a/customizations/mcp-resource",
          payload,
        });
        expect(result.statusCode, result.body).toBe(200);
        expect(request).toHaveBeenCalledOnce();
        request.mockClear();
        const untrusted = await app.inject({
          method: "POST",
          url: "/api/chats/chat-a/customizations/mcp-resource",
          payload: { ...payload, threadId: "untrusted-client-thread" },
        });
        expect(untrusted.statusCode).toBe(400);
        expect(request).not.toHaveBeenCalled();
        const stale = await app.inject({
          method: "POST",
          url: "/api/chats/chat-a/customizations/mcp-resource",
          payload: { ...payload, scope: { ...scope, projectId: "project-b" } },
        });
        expect(stale.statusCode).toBe(409);
        expect(request).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
