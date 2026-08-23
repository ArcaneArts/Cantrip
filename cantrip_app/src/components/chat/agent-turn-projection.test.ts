import type { AgentActivity, AgentScope, ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { buildChatTimeline } from "./timeline";
import {
  agentTurnKey,
  buildAgentTurnProjection,
  mergeAgentCardsIntoTimeline,
} from "./agent-turn-projection";

const rootScope: AgentScope = {
  agentThreadId: "root-thread",
  rootThreadId: "root-thread",
  parentThreadId: null,
  rootTurnId: "root-turn",
  agentPath: ["root"],
  nickname: null,
  role: null,
  depth: 0,
  isRoot: true,
};

const childScope: AgentScope = {
  ...rootScope,
  agentThreadId: "child-thread",
  parentThreadId: "root-thread",
  agentPath: ["root", "Scout"],
  nickname: "Scout",
  role: "explorer",
  depth: 1,
  isRoot: false,
};

function message(
  sequence: number,
  role: ChatMessage["role"],
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id: `message-${sequence}`,
    chatId: "chat",
    worktreeId: "worktree",
    executionLaneId: null,
    sequence,
    role,
    content,
    mode: "default",
    reasoningEffort: null,
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: new Date(sequence * 1_000).toISOString(),
  };
}

function communication(input: {
  id: string;
  kind: Extract<AgentActivity, { type: "agentCommunication" }>["kind"];
  message?: string | null;
  scope?: AgentScope;
  status?: AgentActivity["status"];
}): Extract<AgentActivity, { type: "agentCommunication" }> {
  return {
    type: "agentCommunication",
    id: input.id,
    kind: input.kind,
    senderThreadId: "root-thread",
    receiverThreadIds: [input.scope?.agentThreadId ?? "child-thread"],
    message: input.message ?? null,
    status: input.status ?? "completed",
    agentScope: input.scope ?? childScope,
  };
}

describe("buildAgentTurnProjection", () => {
  it("keeps child content out of the root transcript and updates one durable card", () => {
    const spawned = communication({
      id: "spawn",
      kind: "spawned",
      message: "Inspect the parser",
      scope: { ...childScope, nickname: null, role: null },
    });
    const enrichedSpawn = communication({
      id: "spawn",
      kind: "spawned",
      message: "Inspect the parser",
    });
    const returned = communication({
      id: "return",
      kind: "returned",
      message: "Parser is sound",
    });
    const projection = buildAgentTurnProjection([
      message(1, "user", [{ type: "text", text: "Please inspect" }]),
      message(2, "assistant", [{ type: "activity", activity: spawned }]),
      message(3, "assistant", [
        {
          type: "text",
          text: "Private child commentary",
          phase: "commentary",
          agentScope: childScope,
        },
      ]),
      {
        ...message(4, "assistant", [
          { type: "activity", activity: enrichedSpawn },
        ]),
        id: "recovered-spawn",
      },
      message(5, "assistant", [{ type: "activity", activity: returned }]),
      message(6, "assistant", [
        { type: "text", text: "Root answer", agentScope: rootScope },
      ]),
    ]);

    expect(projection.agents).toHaveLength(1);
    expect(projection.agents[0]).toMatchObject({
      key: agentTurnKey("root-turn", "child-thread"),
      status: "completed",
      taskSummary: "Inspect the parser",
      scope: { nickname: "Scout", role: "explorer" },
    });
    expect(projection.agents[0]?.stream).toHaveLength(3);
    expect(projection.agents[0]?.communications).toHaveLength(2);
    expect(JSON.stringify(projection.rootMessages)).not.toContain(
      "Private child commentary",
    );
    expect(JSON.stringify(projection.rootMessages)).not.toContain(
      "Inspect the parser",
    );
    expect(JSON.stringify(projection.rootMessages)).toContain("Root answer");
  });

  it("orders nested agents deterministically and inserts their cards at first activity", () => {
    const nestedScope: AgentScope = {
      ...childScope,
      agentThreadId: "nested-thread",
      parentThreadId: "child-thread",
      agentPath: ["root", "Scout", "Reviewer"],
      nickname: "Reviewer",
      depth: 2,
    };
    const messages = [
      message(1, "user", [{ type: "text", text: "Start" }]),
      message(2, "assistant", [
        {
          type: "activity",
          activity: communication({ id: "spawn-child", kind: "spawned" }),
        },
      ]),
      message(3, "assistant", [
        {
          type: "activity",
          activity: communication({
            id: "spawn-nested",
            kind: "spawned",
            scope: nestedScope,
          }),
        },
      ]),
      message(4, "assistant", [
        { type: "text", text: "Done", agentScope: rootScope },
      ]),
    ];
    const projection = buildAgentTurnProjection(messages);
    expect(projection.agents.map((agent) => agent.scope.nickname)).toEqual([
      "Scout",
      "Reviewer",
    ]);
    const entries = mergeAgentCardsIntoTimeline(
      buildChatTimeline(projection.rootMessages),
      projection.agents,
    );
    expect(entries.map((entry) => entry.type)).toEqual([
      "timeline",
      "agent",
      "agent",
      "timeline",
    ]);
  });
});
