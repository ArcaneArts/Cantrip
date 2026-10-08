import type { AgentActivity, ChatMessage } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentTrajectory } from "./agent-trajectory";
import { resolveChatTurnIdentity } from "./timeline";
import { projectTrajectory } from "./trajectory-model";

function message(
  id: string,
  sequence: number,
  role: ChatMessage["role"],
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id,
    sequence,
    role,
    content,
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
const correlation = (
  turnId: string,
  itemId: string,
  sourceMethod = "item/completed",
) => ({ sourceMethod, diagnosticId: null, threadId: "thread", turnId, itemId });
const user = (id: string, sequence: number) =>
  message(id, sequence, "user", [{ type: "text", text: id }]);
const activity = (id: string, sequence: number, value: AgentActivity) =>
  message(id, sequence, "assistant", [{ type: "activity", activity: value }]);
const summary = (
  turnId: string,
  sequence: number,
  status: "running" | "completed",
  startedAt: number,
  completedAt: number | null,
) =>
  activity(`summary-${turnId}-${status}`, sequence, {
    type: "turnSummary",
    id: `summary-${turnId}`,
    status,
    startedAt,
    completedAt,
    durationMs: completedAt === null ? null : (completedAt - startedAt) * 1000,
    correlation: correlation(turnId, `summary-${turnId}`, "turn/completed"),
  });
const earlier = [
  user("First edit", 1),
  summary("first", 2, "completed", 1, 3),
  user("Notice", 4),
  summary("notice", 5, "completed", 4, 6),
];
const delayed = activity("late-snapshot", 8, {
  type: "fileChange",
  id: "first-snapshot",
  status: "completed",
  changes: [
    { path: "notes/earlier.txt", kind: "add", diffPreview: "+EARLIER" },
  ],
  correlation: correlation(
    "first",
    "first-snapshot",
    "cantrip/workspaceSnapshot",
  ),
});
const settings = ["first", "notice", "approval"].map((turnId) => ({
  threadId: "thread",
  turnId,
  status: "unavailable" as const,
}));

describe("historical trajectory turn attribution", () => {
  it("uses the snapshot's root scope to retain its original owner", () => {
    const scoped = activity("late-scoped", 8, {
      type: "fileChange",
      id: "scoped-snapshot",
      status: "completed",
      changes: [{ path: "notes/earlier.txt", kind: "add" }],
      correlation: correlation(
        "native-first",
        "scoped-snapshot",
        "cantrip/workspaceSnapshot",
      ),
      agentScope: {
        agentThreadId: "thread",
        rootThreadId: "thread",
        parentThreadId: null,
        rootTurnId: "first",
        agentPath: ["root"],
        nickname: null,
        role: null,
        depth: 0,
        isRoot: true,
      },
    });
    const messages = [
      ...earlier,
      user("Approval request", 7),
      scoped,
      summary("approval", 9, "running", 7, null),
    ];
    const current = projectTrajectory({
      messages,
      active: true,
      nowMs: 12000,
    })!;
    expect(current.title).toBe("Approval request");
    expect(
      current.events.some((event) => event.messageId === "late-scoped"),
    ).toBe(false);
    const original = projectTrajectory({
      messages,
      active: true,
      nowMs: 12000,
      targetTurnKey: "runtime:first",
    })!;
    expect(
      original.events.some((event) => event.messageId === "late-scoped"),
    ).toBe(true);
  });

  it.each([false, true])(
    "keeps delayed snapshot in its original turn when new native identity is available=%s",
    (nativeReady) => {
      const messages = [
        ...earlier,
        user("Approval request", 7),
        delayed,
        ...(nativeReady ? [summary("approval", 9, "running", 7, null)] : []),
      ];
      const current = projectTrajectory({
        messages,
        active: true,
        nowMs: 12000,
        nativeTurnSettings: settings,
      })!;
      expect(current.title).toBe("Approval request");
      expect(current.ordinal).toBe(3);
      expect(
        current.events.some((event) => event.messageId === "late-snapshot"),
      ).toBe(false);
      expect(current.nativeTurnSettings?.map((item) => item.turnId)).toEqual(
        nativeReady ? ["approval"] : [],
      );
      const old = projectTrajectory({
        messages,
        active: true,
        nowMs: 12000,
        targetTurnKey: "runtime:first",
      })!;
      expect(old.title).toBe("First edit");
      expect(old.ordinal).toBe(1);
      expect(
        old.events.filter((event) => event.messageId === "late-snapshot"),
      ).toHaveLength(1);
    },
  );

  it("keeps an explicitly selected current turn live through approval, then completed with its own timing", () => {
    const messages = [
      ...earlier,
      user("Approval request", 7),
      summary("approval", 8, "running", 7, null),
    ];
    const pending = projectTrajectory({
      messages,
      active: true,
      nowMs: 12000,
      targetTurnKey: "runtime:approval",
    })!;
    expect(pending).toMatchObject({
      completed: false,
      completedAtMs: null,
      elapsedMs: 5000,
    });
    expect(
      pending.events.find((event) => event.kind === "turnSummary")?.status,
    ).toBe("running");
    const finished = projectTrajectory({
      messages: [...messages, summary("approval", 10, "completed", 7, 11)],
      active: false,
      nowMs: 15000,
      targetTurnKey: pending.key,
    })!;
    expect(finished).toMatchObject({
      title: "Approval request",
      ordinal: 3,
      completed: true,
      completedAtMs: 11000,
      elapsedMs: 4000,
    });
    const next = projectTrajectory({
      messages: [
        ...messages,
        summary("approval", 10, "completed", 7, 11),
        user("Next request", 12),
        summary("next", 13, "running", 12, null),
        delayed,
      ],
      active: true,
      nowMs: 15000,
      targetTurnKey: finished.key,
    })!;
    expect(next).toMatchObject({
      title: "Approval request",
      ordinal: 3,
      completed: true,
      elapsedMs: 4000,
    });
    expect(
      next.events.some((event) => event.messageId === "late-snapshot"),
    ).toBe(false);
  });

  it("resolves a pending prompt anchor after its native identity arrives", () => {
    const opening = user("Approval request", 7);
    const before = [...earlier, opening];
    const key = projectTrajectory({
      messages: before,
      active: true,
      nowMs: 8000,
    })!.key;
    expect(key).toBe("legacy:Approval request");
    const after = projectTrajectory({
      messages: [
        ...before,
        delayed,
        summary("approval", 9, "running", 7, null),
      ],
      active: true,
      nowMs: 12000,
      targetTurnKey: key,
    });
    expect(after).toMatchObject({
      title: "Approval request",
      ordinal: 3,
      runtimeTurnId: "approval",
      completed: false,
    });
  });

  it("does not use an old workspace snapshot as the newer prompt's Inspect link", () => {
    const opening = user("Approval request", 7);
    const messages = [...earlier, opening, delayed];
    expect(
      resolveChatTurnIdentity({
        messages,
        startIndex: 5,
        turnMessages: [delayed],
      }),
    ).toEqual({ turnId: null, turnKey: "legacy:Approval request" });
  });

  it("renders the pending historical heading and file identity from the selected turn only", () => {
    const messages = [
      ...earlier,
      user("Approval request", 7),
      delayed,
      summary("approval", 9, "running", 7, null),
    ];
    const markup = renderToStaticMarkup(
      <AgentTrajectory
        active
        messages={messages}
        nativeTurnSettings={settings}
        targetTurnKey="runtime:approval"
        visible
      />,
    );
    expect(markup).toContain("Historical turn 3 · Live");
    expect(markup).not.toContain("notes/earlier.txt");
    expect(markup).not.toContain("2 native turns");
  });
});
