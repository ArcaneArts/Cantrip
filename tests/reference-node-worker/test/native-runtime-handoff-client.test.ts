import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("durable handoff settlement", () => {
  afterEach(() => vi.useRealTimers());

  const scope = { chatId: "chat", operationId: randomUUID() };
  const client = (fetch: typeof globalThis.fetch) =>
    new NativeRuntimeHandoffClient({
      serverUrl: "http://localhost",
      workerId: "worker",
      token: () => "fixture-token",
      fetch,
    });

  it.each([
    { action: { action: "commit" }, phase: "committed" },
    {
      action: { action: "finish", outcome: "completed" },
      phase: "completed",
    },
  ] as const)(
    "retries the exact $phase request after an unavailable database",
    async ({ action, phase }) => {
      vi.useFakeTimers();
      const state = nativeRuntimeHandoffFixture({ ...scope, phase });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json({}, { status: 500 }))
        .mockResolvedValueOnce(Response.json(state));
      const completion = expect(
        client(fetch).request({ ...scope, ...action }),
      ).resolves.toMatchObject({ ...scope, phase });
      await vi.advanceTimersByTimeAsync(500);
      await completion;
      const body = { ...scope, ...action, workerId: "worker" };
      expect(
        fetch.mock.calls.map(([, options]) =>
          JSON.parse(String(options?.body)),
        ),
      ).toEqual([body, body]);
    },
  );

  it("returns a durable cancellation conflict immediately", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ code: "handoff-cancel-requested" }, { status: 409 }),
      );
    await expect(
      client(fetch).request({ ...scope, action: "commit" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "handoff-cancel-requested",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the owning worker command is aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }));
    const completion = expect(
      client(fetch).request(
        { ...scope, action: "finish", outcome: "completed" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await completion;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
