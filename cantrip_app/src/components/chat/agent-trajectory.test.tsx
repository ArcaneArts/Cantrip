import type { AgentScope, ChatMessage } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  AgentTrajectory,
  TRAJECTORY_FOLLOW_THRESHOLD_PX,
  trajectorySubagentTarget,
} from "./agent-trajectory";
import { buildAgentTurnProjection } from "./agent-turn-projection";
import { projectTrajectory } from "./trajectory-model";
import { chatScrollIsNearBottom } from "./use-sticky-chat-scroll";

const { buildAgentTurnProjectionSpy } = vi.hoisted(() => ({
  buildAgentTurnProjectionSpy: vi.fn(),
}));

vi.mock("./agent-turn-projection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./agent-turn-projection")>();
  return {
    ...actual,
    buildAgentTurnProjection: (
      ...args: Parameters<typeof actual.buildAgentTurnProjection>
    ) => {
      buildAgentTurnProjectionSpy();
      return actual.buildAgentTurnProjection(...args);
    },
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  it("skips hidden trajectory work across parent and live updates while preserving filters", async () => {
    const messages: ChatMessage[] = [
      message("user-1", 1, "user", 1_000, [
        { type: "text", text: "Trace this turn" },
      ]),
      ...Array.from({ length: 1_000 }, (_, index) =>
        message(`command-${index}`, index + 2, "assistant", 1_200 + index, [
          {
            type: "activity",
            activity: {
              type: "command",
              id: `command-${index}`,
              command: `git status ${index}`,
              cwd: "/workspace",
              status: "completed",
              exitCode: 0,
              output: null,
            },
          },
        ]),
      ),
    ];
    vi.stubGlobal("window", {
      cancelAnimationFrame: vi.fn(),
      clearInterval: vi.fn(),
      requestAnimationFrame: vi.fn(() => 1),
      setInterval: vi.fn(() => 1),
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(
          <AgentTrajectory active={false} messages={messages} visible />,
        );
      });
      const search = renderer.root.findByProps({
        "aria-label": "Search trajectory events",
      });
      await act(async () =>
        search.props.onChange({ target: { value: "git status 999" } }),
      );
      buildAgentTurnProjectionSpy.mockClear();

      for (let revision = 0; revision < 100; revision += 1) {
        await act(async () => {
          renderer.update(
            <AgentTrajectory
              active={false}
              messages={messages}
              visible={false}
            />,
          );
        });
        expect(renderer.toJSON()).toBeNull();
      }
      expect(buildAgentTurnProjectionSpy).not.toHaveBeenCalled();

      for (let revision = 0; revision < 100; revision += 1) {
        const updatedMessages = messages.map((current) =>
          current.id === "command-999"
            ? {
                ...current,
                content: current.content.map((item) =>
                  item.type === "activity" && item.activity.type === "command"
                    ? {
                        ...item,
                        activity: {
                          ...item.activity,
                          output: `live output ${revision}`,
                        },
                      }
                    : item,
                ),
              }
            : current,
        );
        await act(async () => {
          renderer.update(
            <AgentTrajectory
              active={false}
              messages={updatedMessages}
              visible={false}
            />,
          );
        });
        expect(renderer.toJSON()).toBeNull();
      }
      expect(buildAgentTurnProjectionSpy).not.toHaveBeenCalled();

      await act(async () => {
        renderer.update(
          <AgentTrajectory active={false} messages={messages} visible />,
        );
      });
      expect(
        renderer.root.findByProps({
          "aria-label": "Search trajectory events",
        }).props.value,
      ).toBe("git status 999");
      expect(buildAgentTurnProjectionSpy).toHaveBeenCalledTimes(1);
      expect(
        renderer.root.findAllByProps({ "data-event-kind": "command" }),
      ).toHaveLength(1);
      await act(async () => renderer.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
      <AgentTrajectory
        active
        agentProjection={buildAgentTurnProjection(messages)}
        messages={messages}
        visible
      />,
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

  it("renders inference prefill as a hot-pink trajectory event and timeline bar", () => {
    const progress = {
      kind: "progress" as const,
      requestId: "user-prefill",
      cycle: 1,
      sequence: 1,
      phase: "prefill" as const,
      fractionComplete: 0.75,
      completedTokens: 36_000,
      totalTokens: 48_000,
      precision: "estimated" as const,
      source: "provider-observer" as const,
      startedAt: new Date(1_100).toISOString(),
      observedAt: new Date(2_000).toISOString(),
    };
    const markup = renderToStaticMarkup(
      <AgentTrajectory
        active
        inferenceProgress={progress}
        inferenceProgressHistory={[{ completedAt: null, progress }]}
        messages={[
          message("user-prefill", 1, "user", 1_000, [
            { type: "text", text: "Prefill this" },
          ]),
        ]}
        visible
      />,
    );

    expect(markup).toContain('data-event-kind="inferenceProgress"');
    expect(markup).toContain("Prefilling prompt 75%");
    expect(markup).toContain("bg-[#ff168f]");
    expect(markup).toContain("fill-[#ff168f]");
  });
});
