import type { AgentScope, ChatMessage } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgentTrajectory,
  TRAJECTORY_FOLLOW_THRESHOLD_PX,
  trajectorySubagentTarget,
} from "./agent-trajectory";
import { projectTrajectory } from "./trajectory-model";
import { chatScrollIsNearBottom } from "./use-sticky-chat-scroll";

function message(
  id: string,
  sequence: number,
  role: ChatMessage["role"],
  createdAtMs: number,
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    worktreeId: "worktree-primary",
    executionLaneId: null,
    sequence,
    role,
    mode: "default",
    createdAt: new Date(createdAtMs).toISOString(),
    content,
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
  };
}

describe("AgentTrajectory", () => {
  it("keeps following while the viewport remains within the latest event", () => {
    expect(
      chatScrollIsNearBottom(
        {
          clientHeight: 600,
          scrollHeight: 1_500,
          scrollTop: 1_500 - 600 - 96,
        },
        TRAJECTORY_FOLLOW_THRESHOLD_PX,
      ),
    ).toBe(true);
  });

  it("renders dynamic agent tracks and targets child events at the sidebar", () => {
    const childScope: AgentScope = {
      agentThreadId: "child-thread",
      rootThreadId: "root-thread",
      parentThreadId: "root-thread",
      rootTurnId: "root-turn",
      agentPath: ["root", "Scout"],
      nickname: "Scout",
      role: "explorer",
      depth: 1,
      isRoot: false,
    };
    const messages = [
      message("user", 1, "user", 1_000, [
        { type: "text", text: "Delegate this" },
      ]),
      message("child-command", 2, "assistant", 1_200, [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "child-command",
            command: "git status",
            cwd: "/workspace",
            status: "running",
            exitCode: null,
            output: null,
            agentScope: childScope,
          },
        },
      ]),
    ];
    const markup = renderToStaticMarkup(
      <AgentTrajectory active messages={messages} visible />,
    );
    expect(markup).toContain("2 agents");
    expect(markup).toContain("Root agent");
    expect(markup).toContain("Scout");
    expect(markup).toContain("Agents");

    const childEvent = projectTrajectory({
      active: true,
      messages,
      nowMs: 1_300,
    })?.events.find((event) => event.agentLabel === "Scout");
    expect(childEvent && trajectorySubagentTarget(childEvent)).toEqual({
      agentKey: childEvent?.agentKey,
      focusItemKey: "root-turn:child-thread:activity:child-command",
    });
  });

  it("renders a turn summary, lane controls, filters, and stable event rows", () => {
    const markup = renderToStaticMarkup(
      <AgentTrajectory
        active={false}
        messages={[
          message("user-1", 1, "user", 1_000, [
            { type: "text", text: "Trace this turn" },
          ]),
          message("command-1", 2, "assistant", 1_200, [
            {
              type: "activity",
              activity: {
                type: "command",
                id: "command-1",
                command: "git status",
                cwd: "/workspace",
                status: "completed",
                exitCode: 0,
                output: null,
              },
            },
          ]),
        ]}
        visible
      />,
    );
    expect(markup).toContain('data-turn-key="legacy:user-1"');
    expect(markup).toContain("Trace this turn");
    expect(markup).toContain("2 events");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Search trajectory events"');
    expect(markup).toContain("Filters");
    expect(markup).toContain("Made changes");
    expect(markup).toContain('aria-label="Trajectory events"');
    expect(markup).toContain('data-slot="trajectory-event-viewport"');
    expect(markup).toContain('data-event-kind="input"');
    expect(markup).toContain('data-event-kind="command"');
    expect(markup).toContain("mixed timing precision");
  });

  it("identifies a pinned historical target and offers a return action", () => {
    const markup = renderToStaticMarkup(
      <AgentTrajectory
        active={false}
        messages={[
          message("user-1", 1, "user", 1_000, [
            { type: "text", text: "Historical request" },
          ]),
        ]}
        onBackToCurrent={() => undefined}
        targetTurnKey="legacy:user-1"
        visible
      />,
    );
    expect(markup).toContain("Historical turn 1");
    expect(markup).toContain('aria-label="Back to current trajectory"');
  });

  it("offers a return action when a pinned target leaves loaded history", () => {
    const markup = renderToStaticMarkup(
      <AgentTrajectory
        active={false}
        messages={[]}
        onBackToCurrent={() => undefined}
        targetTurnKey="runtime:missing-turn"
        visible
      />,
    );
    expect(markup).toContain("Historical turn unavailable");
    expect(markup).toContain("Back to current");
  });
});
