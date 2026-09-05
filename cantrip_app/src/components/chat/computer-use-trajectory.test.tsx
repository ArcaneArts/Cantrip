import {
  agentActivitySchema,
  type AgentScope,
  type ChatMessage,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { activityLabel } from "./activity";
import {
  previewActivityGroupKey,
  splitPreviewMessages,
  type ComputerUseActivity,
} from "./computer-use-activity";
import { projectTrajectory, filterTrajectoryEvents } from "./trajectory-model";
import { TrajectoryDetails } from "./trajectory-details";
import { AgentTrajectory, trajectorySubagentTarget } from "./agent-trajectory";
import { buildChatTimeline, resolveChatTurnIdentity } from "./timeline";

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
  depth: 1,
  isRoot: false,
};
function activity(
  patch: Partial<ComputerUseActivity> = {},
): ComputerUseActivity {
  return agentActivitySchema.parse({
    type: "computerUse",
    id: "cua-1",
    status: "completed",
    source: "user-preview",
    operation: "observation.snapshot",
    operationId: "11111111-1111-4111-8111-111111111111",
    requestId: "actual-request",
    binding: {
      chatId: "chat",
      workerId: "worker",
      taskId: null,
      threadId: null,
      turnId: null,
      sessionId: "native-preview-session",
    },
    target: { targetId: "owned-window", targetGeneration: 3 },
    cursor: {
      appearance: {
        version: 1,
        style: "ring",
        color: "#ffffff",
        size: 24,
        label: "Agent",
        trail: false,
        visible: true,
      },
      position: { x: 25, y: 30 },
      trailPoints: [],
      updatedAtMs: 1500,
      revision: 2,
    },
    observation: {
      revision: 4,
      image: {
        mediaType: "image/png",
        width: 640,
        height: 360,
        byteCount: 2500,
        sha256: "a".repeat(64),
        cursorIncluded: true,
      },
    },
    outcome: "completed",
    errorCode: null,
    durationMs: 250,
    startedAtMs: 1500,
    updatedAtMs: 1750,
    completedAtMs: 1750,
    raw: {
      schemaVersion: 1,
      request: null,
      response: null,
      metadata: { source: "user-preview", operation: "observation.snapshot" },
    },
    ...patch,
  }) as ComputerUseActivity;
}
function message(
  id: string,
  sequence: number,
  content: ChatMessage["content"],
  role: ChatMessage["role"] = "assistant",
): ChatMessage {
  return {
    id,
    sequence,
    content,
    role,
    chatId: "chat",
    contextKind: "project",
    worktreeId: "primary",
    scratchRootId: null,
    executionLaneId: null,
    mode: "default",
    createdAt: new Date(sequence * 1000).toISOString(),
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
function previewMessage(value = activity(), sequence = 3) {
  return message(value.id, sequence, [{ type: "activity", activity: value }]);
}
const prompt = message(
  "prompt",
  1,
  [
    {
      type: "text",
      text: "Inspect the app",
      correlation: {
        sourceMethod: "turn/start",
        diagnosticId: null,
        threadId: "root-thread",
        turnId: "root-turn",
        itemId: null,
      },
    },
  ],
  "user",
);
const agentComment = message("comment", 2, [
  {
    type: "text",
    text: "Inspecting",
    phase: "commentary",
    agentScope: rootScope,
  },
]);
const filters = {
  hiddenAgents: new Set<string>(),
  hiddenKinds: new Set<string>(),
  hiddenLanes: new Set<"input" | "model" | "tools" | "changes">(),
  hiddenStatuses: new Set<"running" | "completed" | "failed" | "declined">(),
  hiddenTimingQualities: new Set<"exact" | "derived" | "instant">(),
  query: "",
};

describe("computer use Trajectory origin and metadata", () => {
  it.each(["reversed", "shuffled"] as const)(
    "orders %s persisted preview operations by sequence for status and history",
    (order) => {
      const first = activity();
      const middle = activity({
        id: "middle-preview",
        operationId: "22222222-2222-4222-8222-222222222222",
        startedAtMs: 2500,
        updatedAtMs: 2750,
        completedAtMs: 2750,
      });
      const latest = activity({
        id: "latest-preview",
        operationId: "33333333-3333-4333-8333-333333333333",
        outcome: "cancelled",
        status: "failed",
        errorCode: "cancelled",
        startedAtMs: 4500,
        updatedAtMs: 4750,
        completedAtMs: 4750,
      });
      const other = activity({
        id: "other-session",
        operationId: "44444444-4444-4444-8444-444444444444",
        binding: { ...first.binding, sessionId: "other-session" },
        startedAtMs: 3500,
        updatedAtMs: 3750,
        completedAtMs: 3750,
      });
      const ordered = [
        previewMessage(first, 3),
        previewMessage(middle, 4),
        previewMessage(other, 5),
        previewMessage(latest, 6),
      ];
      const persisted =
        order === "reversed"
          ? [...ordered].reverse()
          : [ordered[2]!, ordered[3]!, ordered[0]!, ordered[1]!];
      // Received wall-clock timestamps need not have the same ordering as sequence.
      persisted.forEach((entry, index) => {
        entry.createdAt = new Date((10 - index) * 1000).toISOString();
      });
      const before = persisted.map((entry) => entry.id);
      const turn = projectTrajectory({
        messages: persisted,
        active: false,
        nowMs: 10000,
      })!;
      expect(turn.key).toBe(previewActivityGroupKey(first));
      expect(turn.agents[0]?.status).toBe("interrupted");
      expect(turn.events.map((event) => event.activity?.id)).toEqual([
        first.id,
        middle.id,
        latest.id,
      ]);
      expect(turn.completedAtMs).toBe(4750);
      const groups = buildChatTimeline(persisted).filter(
        (entry) => entry.type === "activityGroup",
      );
      expect(groups.map((group) => group.turnKey)).toEqual([
        previewActivityGroupKey(first),
        previewActivityGroupKey(other),
      ]);
      expect(groups[0]?.messages.map((entry) => entry.id)).toEqual([
        first.id,
        middle.id,
        latest.id,
      ]);
      expect(persisted.map((entry) => entry.id)).toEqual(before);
    },
  );
  it("keeps live and historical agent inference progress out of a preview actor group", () => {
    const progress = {
      kind: "progress" as const,
      requestId: prompt.id,
      cycle: 1,
      sequence: 2,
      phase: "prefill" as const,
      fractionComplete: 0.5,
      completedTokens: 10,
      totalTokens: 20,
      precision: "estimated" as const,
      source: "provider-observer" as const,
      startedAt: new Date(1000).toISOString(),
      observedAt: new Date(2000).toISOString(),
    };
    const input = {
      messages: [prompt, agentComment, previewMessage()],
      active: true,
      nowMs: 5000,
      inferenceProgress: progress,
      inferenceProgressHistory: [{ completedAt: null, progress }],
    };
    const preview = projectTrajectory(input)!;
    expect(preview.events.map((event) => event.kind)).toEqual(["computerUse"]);
    expect(preview.agents).toHaveLength(1);
    expect(preview.agents[0]).toMatchObject({
      root: false,
      active: false,
      label: "Preview operator",
    });
    const agent = projectTrajectory({
      ...input,
      targetTurnKey: "runtime:root-turn",
    })!;
    expect(
      agent.events.find((event) => event.kind === "inferenceProgress"),
    ).toMatchObject({
      agentIsRoot: true,
      agentLabel: "Root agent",
      status: "running",
    });
  });
  it("uses preview actor and accessibility labels while preserving agent-turn labels", () => {
    const preview = renderToStaticMarkup(
      <AgentTrajectory messages={[previewMessage()]} active={false} visible />,
    );
    expect(preview).toContain("1 actor");
    expect(preview).toContain('placeholder="Search this preview"');
    expect(preview).toContain('aria-label="Preview trajectory timeline"');
    expect(preview).toContain('aria-label="Trajectory actors"');
    expect(preview).not.toContain("1 agents");
    const agent = renderToStaticMarkup(
      <AgentTrajectory
        messages={[prompt, agentComment]}
        active={false}
        visible
      />,
    );
    expect(agent).toContain("1 agents");
    expect(agent).toContain('placeholder="Search this turn"');
    expect(agent).toContain('aria-label="Turn trajectory timeline"');
    expect(agent).toContain('aria-label="Trajectory agents"');
  });
  it("preserves ordinary empty messages when partitioning preview activity", () => {
    const empty = message("empty", 4, []);
    const ordinary = [prompt, agentComment, empty];
    expect(splitPreviewMessages(ordinary).agentMessages).toEqual(ordinary);
    expect(splitPreviewMessages(ordinary).agentMessages[2]).toBe(empty);
  });
  it("isolates idle preview activity from the preceding agent prompt and root scope", () => {
    const preview = activity();
    const messages = [prompt, agentComment, previewMessage(preview)];
    const turn = projectTrajectory({ messages, active: true, nowMs: 5000 })!;
    expect(turn.key).toBe(previewActivityGroupKey(preview));
    expect(turn.title).toBe("Preview session · native-preview-session");
    expect(turn.runtimeTurnId).toBeNull();
    expect(turn.completed).toBe(true);
    expect(turn.elapsedMs).toBe(250);
    expect(turn.completedAtMs).toBe(1750);
    expect(turn.agents).toHaveLength(1);
    expect(turn.agents[0]).toMatchObject({
      label: "Preview operator",
      root: false,
      threadId: null,
    });
    expect(turn.events).toHaveLength(1);
    expect(turn.events[0]).toMatchObject({
      agentLabel: "Preview operator",
      agentIsRoot: false,
      threadId: null,
      turnId: null,
      lane: "tools",
      timingQuality: "exact",
      startMs: 1500,
      updatedAtMs: 1750,
    });
    expect(trajectorySubagentTarget(turn.events[0]!)).toBeNull();
    expect(
      projectTrajectory({
        messages,
        active: true,
        nowMs: 5000,
        targetTurnKey: "runtime:root-turn",
      })!.events.map((event) => event.kind),
    ).toEqual(["input", "commentary"]);
    const identity = resolveChatTurnIdentity({
      messages,
      startIndex: 2,
      turnMessages: [messages[2]!],
    });
    expect(identity).toEqual({ turnId: null, turnKey: turn.key });
    const entry = buildChatTimeline(messages).find(
      (entry) => entry.type === "activityGroup" && entry.turnKey === turn.key,
    )!;
    expect(entry).toMatchObject({
      type: "activityGroup",
      kind: "tool",
      turnId: null,
      startedAt: new Date(1500).toISOString(),
      endedAt: new Date(1750).toISOString(),
    });
  });
  it("preserves agent root/child scope and actual child turn for MCP operations", () => {
    const value = activity({
      source: "agent-mcp",
      agentScope: childScope,
      binding: {
        ...activity().binding,
        threadId: "child-thread",
        turnId: "child-turn",
        sessionId: "child-session",
      },
    });
    const turn = projectTrajectory({
      messages: [prompt, agentComment, previewMessage(value)],
      active: true,
      nowMs: 5000,
    })!;
    expect(turn.key).toBe("runtime:root-turn");
    const event = turn.events.find((event) => event.kind === "computerUse")!;
    expect(event).toMatchObject({
      agentLabel: "Scout",
      agentIsRoot: false,
      threadId: "child-thread",
      turnId: "child-turn",
    });
    expect(trajectorySubagentTarget(event)?.agentKey).toContain("child-thread");
  });
  it("separates preview content in mixed messages and groups only matching real sessions", () => {
    const a = activity();
    const b = activity({
      id: "cua-2",
      operationId: "22222222-2222-4222-8222-222222222222",
      operation: "cursor.move",
      observation: null,
      startedAtMs: 4000,
      updatedAtMs: 4100,
      completedAtMs: 4100,
      durationMs: 100,
    });
    const other = activity({
      id: "cua-3",
      operationId: "33333333-3333-4333-8333-333333333333",
      binding: { ...a.binding, sessionId: null },
      operation: "preview.stop",
      cursor: null,
      observation: null,
    });
    const messages = [
      prompt,
      message("mixed", 2, [
        {
          type: "text",
          text: "Agent commentary",
          phase: "commentary",
          agentScope: rootScope,
        },
        { type: "activity", activity: a },
      ]),
      previewMessage(other, 3),
      previewMessage(b, 4),
    ];
    const current = projectTrajectory({
      messages,
      active: false,
      nowMs: 5000,
    })!;
    expect(current.key).toBe(previewActivityGroupKey(a));
    expect(current.events.map((event) => event.activity?.id)).toEqual([
      a.id,
      b.id,
    ]);
    const separate = projectTrajectory({
      messages,
      active: false,
      nowMs: 5000,
      targetTurnKey: previewActivityGroupKey(other),
    })!;
    expect(separate.title).toBe("Preview operation");
    expect(separate.events).toHaveLength(1);
    const agent = projectTrajectory({
      messages,
      active: false,
      nowMs: 5000,
      targetTurnKey: "runtime:root-turn",
    })!;
    expect(agent.events.map((event) => event.kind)).toEqual([
      "input",
      "commentary",
    ]);
    expect(
      buildChatTimeline(messages).filter(
        (entry) =>
          entry.type === "activityGroup" &&
          entry.turnKey.startsWith("preview:"),
      ),
    ).toHaveLength(2);
  });
  it.each(["failed", "declined", "cancelled"] as const)(
    "preserves %s outcome, details and status filtering",
    (outcome) => {
      const value = activity({
        outcome,
        status: outcome === "cancelled" ? "failed" : outcome,
        errorCode: outcome === "cancelled" ? "cancelled" : "permission-denied",
        observation: null,
      });
      const turn = projectTrajectory({
        messages: [previewMessage(value)],
        active: true,
        nowMs: 5000,
      })!;
      const event = turn.events[0]!;
      expect(event.status).toBe(value.status);
      expect(turn.agents[0]?.status).toBe(
        outcome === "failed" ? "failed" : "interrupted",
      );
      expect(activityLabel(value)).toContain(outcome);
      expect(
        filterTrajectoryEvents(turn.events, {
          ...filters,
          hiddenStatuses: new Set([value.status]),
        }),
      ).toEqual([]);
      expect(
        filterTrajectoryEvents(turn.events, {
          ...filters,
          query: value.operationId,
        }),
      ).toEqual([event]);
      expect(
        filterTrajectoryEvents(turn.events, { ...filters, query: "worker" }),
      ).toEqual([event]);
      const summary = renderToStaticMarkup(
        <TrajectoryDetails onBack={() => {}} event={event} />,
      );
      expect(summary).toContain("Preview operator");
      expect(summary).toContain(outcome);
      expect(summary).toContain(value.errorCode!);
      expect(summary).not.toContain("Root agent");
      const timeline = renderToStaticMarkup(
        <AgentTrajectory
          messages={[previewMessage(value)]}
          active={false}
          visible
        />,
      );
      expect(timeline).toContain(
        outcome.replace(/^./u, (c) => c.toUpperCase()),
      );
    },
  );
  it("shows bounded cursor/image metadata in details and raw view without rendering screenshot pixels", () => {
    const value = activity();
    const event = projectTrajectory({
      messages: [previewMessage(value)],
      active: false,
      nowMs: 5000,
    })!.events[0]!;
    const summary = renderToStaticMarkup(
      <TrajectoryDetails onBack={() => {}} event={event} />,
    );
    for (const text of [
      "Actor",
      "Preview operator",
      "Operation ID",
      "owned-window",
      "ring",
      "25, 30",
      "640",
      "360",
      "2500 bytes",
      "Image digest",
    ])
      expect(summary).toContain(text);
    const preview = renderToStaticMarkup(
      <TrajectoryDetails
        onBack={() => {}}
        event={event}
        initialTab="preview"
      />,
    );
    expect(preview).toContain("image pixels are not stored here");
    expect(preview).not.toContain("<img");
    const raw = renderToStaticMarkup(
      <TrajectoryDetails onBack={() => {}} event={event} initialTab="raw" />,
    );
    expect(raw).toContain("user-preview");
    expect(raw).toContain("observation.snapshot");
    expect(raw).not.toContain("data:image");
  });
});
