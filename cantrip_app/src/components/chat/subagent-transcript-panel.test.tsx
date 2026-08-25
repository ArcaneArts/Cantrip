import type { AgentScope, ChatMessage } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { buildAgentTurnProjection } from "./agent-turn-projection";
import { SubagentTranscriptPanel } from "./subagent-transcript-panel";

const parentScope: AgentScope = {
  agentThreadId: "parent",
  rootThreadId: "root",
  parentThreadId: "root",
  rootTurnId: "turn",
  agentPath: ["root", "Scout"],
  nickname: "Scout",
  role: "explorer",
  depth: 1,
  isRoot: false,
};

function childMessage(
  id: string,
  sequence: number,
  scope: AgentScope,
  text: string,
): ChatMessage {
  return {
    id,
    chatId: "chat",
    contextKind: "project",
    worktreeId: "worktree",
    scratchRootId: null,
    executionLaneId: null,
    sequence,
    role: "assistant",
    content: [{ type: "text", text, agentScope: scope }],
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

describe("SubagentTranscriptPanel", () => {
  it("renders nested read-only navigation and no agent controls", () => {
    const nestedScope: AgentScope = {
      ...parentScope,
      agentThreadId: "nested",
      parentThreadId: "parent",
      agentPath: ["root", "Scout", "Reviewer"],
      nickname: "Reviewer",
      role: "reviewer",
      depth: 2,
    };
    const projection = buildAgentTurnProjection([
      childMessage("parent-message", 1, parentScope, "Parent work"),
      childMessage("nested-message", 2, nestedScope, "Nested work"),
    ]);
    const nested = projection.agents.find(
      (agent) => agent.scope.agentThreadId === "nested",
    );
    const html = renderToStaticMarkup(
      <SubagentTranscriptPanel
        focusItemKey={null}
        modelSummary="GPT-5.6 · high"
        onOpenFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectRoot={vi.fn()}
        projection={projection}
        rootTurnId={nested?.scope.rootTurnId ?? null}
        selectedAgentKey={nested?.key ?? "missing"}
      />,
    );
    expect(html).toContain("Scout");
    expect(html).toContain("Reviewer");
    expect(html).toContain("Nested work");
    expect(html).toContain("Read-only subagent stream");
    expect(html).not.toContain('aria-label="Agents in this turn"');
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("Stop agent");
    expect(html).not.toContain("Steer");
    expect(html).not.toContain("Approve");
  });

  it("renders the full agent list only in the root overview", () => {
    const projection = buildAgentTurnProjection([
      childMessage("parent-message", 1, parentScope, "Parent work"),
    ]);
    const html = renderToStaticMarkup(
      <SubagentTranscriptPanel
        focusItemKey={null}
        modelSummary="GPT-5.6 · high"
        onOpenFile={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectRoot={vi.fn()}
        projection={projection}
        rootTurnId="turn"
        selectedAgentKey={null}
      />,
    );
    expect(html).toContain('aria-label="Agents in this turn"');
    expect(html).toContain("Scout");
    expect(html).not.toContain("Parent work");
  });
});
