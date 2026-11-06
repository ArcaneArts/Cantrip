import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { nativeRuntimeHandoffConfigurationSchema } from "@cantrip/protocol";
import { NativeRuntimeHandoffClient } from "../src/native-runtime-handoff-client.js";
import { nativeRuntimeHandoffFixture } from "./fixtures/native-runtime-handoff.js";

describe("handoff configuration identity across Chat and Task Goal roots", () => {
  it.each(["session", "task"] as const)(
    "accepts the actual %s variant and rejects a different chat",
    async (kind) => {
      const state = nativeRuntimeHandoffFixture();
      const identity = {
        chatId: state.chatId,
        projectId: "project",
        worktreeId: "worktree",
        rootKind: "git-worktree",
        computerUseEnabled: false,
      };
      const response = nativeRuntimeHandoffConfigurationSchema.parse({
        state,
        side: "source",
        configuration: {
          threadId: state.source.threadId,
          cwd: "/tmp",
          model: {
            id: "model",
            routeId: "old-route",
            name: "model",
            reasoningEffort: null,
          },
          provider: {
            id: "provider",
            name: "provider",
            kind: "openai-compatible",
            baseUrl: "http://localhost/v1",
            apiKey: null,
          },
          subagentDefaults: null,
          mcpServers: [],
          planMode: "default",
          permissionProfileId: ":workspace",
          ...(kind === "session"
            ? {
                session: {
                  ...identity,
                  contextKind: "project",
                  scratchRootId: null,
                },
              }
            : {
                task: {
                  ...identity,
                  cycleId: randomUUID(),
                  orderEpoch: 1,
                  goalEpoch: "goal-epoch",
                },
              }),
        },
      });
      const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = new NativeRuntimeHandoffClient({
        serverUrl: "http://localhost",
        workerId: state.workerId,
        token: () => "fixture-token",
        fetch: fetch as never,
      });
      const action = {
        chatId: state.chatId,
        operationId: state.operationId,
        side: "source" as const,
      };
      expect(await client.configuration(action)).toEqual(response);
      const context =
        "session" in response.configuration
          ? response.configuration.session
          : response.configuration.task;
      context.chatId = "other-chat";
      await expect(client.configuration(action)).rejects.toThrow(
        "Handoff configuration belongs to another operation.",
      );
    },
  );
});
