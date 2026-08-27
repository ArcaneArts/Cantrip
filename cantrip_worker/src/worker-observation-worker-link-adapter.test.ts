import { createHash } from "node:crypto";

import type {
  InstalledWorkerLinkGrant,
  WorkerCommand,
  WorkerNotification,
  WorkerLinkSession,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { WorkerLinkAdapterEmitter } from "./worker-link-gateway.js";
import {
  decodeWorkerObservationPayload,
  WorkerObservationHub,
} from "./worker-observation-worker-link-adapter.js";

const now = Date.parse("2026-08-26T12:00:00.000Z");
const subscriptionId = "77777777-7777-4777-8777-777777777777";

function fixtures() {
  const identity = {
    serverId: "server-1",
    serverGeneration: "server-generation-1",
    ownerId: "owner-1",
    accountSessionId: "account-session-1",
    clientInstanceId: "client-instance-1",
    workerId: "worker-1",
    workerProcessGeneration: "worker-generation-1",
  };
  const lease = {
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    absoluteExpiresAt: new Date(now + 120_000).toISOString(),
  };
  const session: WorkerLinkSession = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    identity,
    lease,
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled: ["local", "lan", "wan", "relay"],
    },
    routeGeneration: 1,
    preferredRoute: "local",
  };
  const grant: InstalledWorkerLinkGrant = {
    binding: {
      grantId: "22222222-2222-4222-8222-222222222222",
      grantGeneration: 1,
      sessionId: session.sessionId,
      identity,
      resource: {
        kind: "observations",
        resourceId: identity.workerId,
        attachmentId: subscriptionId,
      },
      lanes: ["events"],
      operations: ["events:subscribe"],
      maxChannels: 1,
      lease,
    },
    observation: {
      subscriptionId,
      topics: ["chat-progress", "filesystem"],
    },
    tokenHash: createHash("sha256").update("token").digest("hex"),
  };
  const command = {
    type: "chat.turn",
    chatId: "chat-1",
    clientMessageId: "client-message-1",
    executionLaneId: "execution-lane-1",
  } as WorkerCommand;
  return { command, grant, session };
}

function emitter(
  send: WorkerLinkAdapterEmitter["data"] = vi.fn(
    (_payload: Uint8Array) => true,
  ),
): WorkerLinkAdapterEmitter {
  return {
    close: vi.fn(async () => true),
    data: send,
    error: vi.fn(() => true),
    halfClose: vi.fn(() => true),
  };
}

describe("WorkerObservationHub", () => {
  it("fans provisional chat and filesystem events to exact topics", async () => {
    const { command, grant, session } = fixtures();
    const sent = vi.fn((_payload: Uint8Array) => true);
    const activeEmitter = emitter(sent);
    const hub = new WorkerObservationHub({ now: () => now });
    const channel = await hub.open({
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      emit: activeEmitter,
      grant,
      lane: "events",
      session,
    });

    expect(
      hub.publishCommandEvent(command, {
        type: "agent.message",
        message: {
          id: "message-1",
          text: "working",
          phase: "commentary",
          streaming: true,
          correlation: {
            sourceMethod: "item/agentMessage/delta",
            diagnosticId: null,
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-1",
          },
        },
      }),
    ).toBe(true);
    const filesystem: WorkerNotification = {
      type: "worktree.filesystem.changed",
      sourcePath: "/repo",
      worktreePath: "/repo/worktree",
    };
    expect(hub.publishNotification(filesystem)).toBe(true);
    expect(
      hub.publishNotification({
        type: "terminal.runtime.observed",
        terminalId: "terminal-1",
        workerProcessGeneration: "worker-generation-1",
        status: "exited",
        exitCode: 0,
        signal: null,
      }),
    ).toBe(false);

    const first = decodeWorkerObservationPayload(sent.mock.calls[0]![0]);
    const second = decodeWorkerObservationPayload(sent.mock.calls[1]![0]);
    expect(first).toMatchObject({
      subscriptionId,
      continuitySequence: 0,
      identity: {
        operationId: "client-message-1",
        turnId: "turn-1",
        messageId: "message-1",
        sequence: 0,
      },
      payload: { topic: "chat-progress", chatId: "chat-1" },
    });
    expect(second).toMatchObject({
      subscriptionId,
      continuitySequence: 1,
      payload: { topic: "filesystem", notification: filesystem },
    });

    await channel.close?.("normal");
    expect(hub.publishNotification(filesystem)).toBe(false);
  });

  it("never publishes final messages or durable turn outcomes", async () => {
    const { command, grant, session } = fixtures();
    const sent = vi.fn((_payload: Uint8Array) => true);
    const hub = new WorkerObservationHub({ now: () => now });
    await hub.open({
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      emit: emitter(sent),
      grant,
      lane: "events",
      session,
    });

    expect(
      hub.publishCommandEvent(command, {
        type: "agent.message",
        message: {
          id: "message-1",
          text: "done",
          phase: "final_answer",
        },
      }),
    ).toBe(false);
    expect(
      hub.publishNotification({
        type: "chat.turn.outcome",
        chatId: "chat-1",
        clientMessageId: "client-message-1",
        executionLaneId: "execution-lane-1",
        contextKind: "project",
        worktreeId: "worktree-1",
        scratchRootId: null,
        outcome: {
          ok: true,
          result: { threadId: "thread-1", text: "done", status: "completed" },
        },
      }),
    ).toBe(false);
    expect(sent).not.toHaveBeenCalled();
  });

  it("queues provisional events across credit pressure", async () => {
    const { command, grant, session } = fixtures();
    let writable = false;
    const sent = vi.fn((_payload: Uint8Array) => writable);
    const hub = new WorkerObservationHub({ now: () => now });
    const channel = await hub.open({
      channel: {
        channelId: "33333333-3333-4333-8333-333333333333",
        connectionId: "44444444-4444-4444-8444-444444444444",
      },
      emit: emitter(sent),
      grant,
      lane: "events",
      session,
    });
    expect(
      hub.publishCommandEvent(command, {
        type: "agent.inference-progress",
        progress: {
          kind: "clear",
          requestId: "client-message-1",
          cycle: 1,
          sequence: 0,
          observedAt: new Date(now).toISOString(),
        },
      }),
    ).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    writable = true;
    await channel.credit?.(64 * 1_024);
    expect(sent).toHaveBeenCalledTimes(2);
    await channel.close?.("normal");
  });
});
