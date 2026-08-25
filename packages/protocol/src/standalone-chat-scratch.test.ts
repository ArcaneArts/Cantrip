import { describe, expect, it } from "vitest";

import {
  unavailableStandaloneChatCapabilities,
  workerCommandSchema,
  workerHeartbeatSchema,
  workerNotificationSchema,
} from "./index.js";

const rootId = "33333333-3333-4333-8333-333333333333";
const chatId = "22222222-2222-4222-8222-222222222222";
const jobId = "44444444-4444-4444-8444-444444444444";

describe("standalone Chat scratch protocol", () => {
  it("defaults older worker heartbeats to unavailable", () => {
    const parsed = workerHeartbeatSchema.parse({
      workerId: "worker-one",
      name: "Worker One",
      platform: "linux",
      architecture: "x64",
      codexVersion: null,
      startedAt: "2026-08-25T12:00:00.000Z",
    });
    expect(parsed.standaloneChat).toEqual(
      unavailableStandaloneChatCapabilities,
    );
  });

  it("accepts identity-only lifecycle commands", () => {
    expect(
      workerCommandSchema.parse({
        type: "chat.scratch.provision",
        jobId,
        attempt: 1,
        rootId,
        chatId,
      }),
    ).toMatchObject({ type: "chat.scratch.provision", rootId, chatId });
    expect(
      workerCommandSchema.parse({
        type: "chat.scratch.reconcile",
        roots: [
          {
            rootId,
            chatId,
            archivedAt: "2026-01-01T00:00:00.000Z",
            archiveExpiresAt: "2026-04-01T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ type: "chat.scratch.reconcile" });
  });

  it("rejects uppercase UUIDs, paths, and unknown command fields", () => {
    expect(
      workerCommandSchema.safeParse({
        type: "chat.scratch.delete",
        jobId,
        attempt: 1,
        rootId,
        chatId: "019FDCF5-C116-77D0-9588-7C65FC3BC7C2",
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.safeParse({
        type: "chat.scratch.delete",
        jobId,
        attempt: 1,
        rootId,
        chatId,
        path: "/caller/chosen/path",
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.safeParse({
        type: "chat.scratch.reconcile",
        roots: [
          {
            rootId,
            chatId,
            archivedAt: "2026-04-01T00:00:00.000Z",
            archiveExpiresAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires an exact standalone execution profile and scratch root", () => {
    const turn = {
      type: "chat.turn" as const,
      executionProfile: "standalone-chat" as const,
      contextKind: "standalone" as const,
      chatId,
      clientMessageId: "message-one",
      executionLaneId: "lane-one",
      worktreeId: null,
      scratchRootId: rootId,
      rootKind: null,
      cwd: "ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      isPrimary: true,
      worktreeMode: null,
      worktreePolicy: null,
      policyProjectId: null,
      threadId: null,
      prompt: "Analyze the data in this scratch folder.",
      model: {
        id: "model-one",
        routeId: "route-one",
        name: "gpt-test",
        reasoningEffort: null,
      },
      provider: {
        id: "provider-one",
        name: "ChatGPT",
        kind: "chatgpt" as const,
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
      },
      permissionProfileId: ":workspace",
      planMode: "default" as const,
    };
    expect(workerCommandSchema.parse(turn)).toMatchObject({
      executionProfile: "standalone-chat",
      contextKind: "standalone",
      worktreeId: null,
      scratchRootId: rootId,
    });
    expect(
      workerCommandSchema.safeParse({
        ...turn,
        subagentDefaults: { model: turn.model, provider: turn.provider },
      }).success,
    ).toBe(false);
    expect(
      workerCommandSchema.safeParse({
        ...turn,
        executionProfile: "ide",
      }).success,
    ).toBe(false);

    const outcome = {
      type: "chat.turn.outcome" as const,
      chatId,
      clientMessageId: turn.clientMessageId,
      executionLaneId: turn.executionLaneId,
      contextKind: "standalone" as const,
      worktreeId: null,
      scratchRootId: rootId,
      outcome: {
        ok: true as const,
        result: {
          threadId: "thread-one",
          text: "Done",
          status: "completed" as const,
        },
      },
    };
    expect(workerNotificationSchema.parse(outcome)).toMatchObject({
      contextKind: "standalone",
      scratchRootId: rootId,
    });
    expect(
      workerNotificationSchema.safeParse({
        ...outcome,
        worktreeId: "worktree-one",
      }).success,
    ).toBe(false);
  });
});
