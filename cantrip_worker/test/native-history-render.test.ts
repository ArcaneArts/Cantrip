import { describe, expect, it } from "vitest";
import { renderNativeHistoryItem } from "../src/native-history-render.js";
import type { NativeHistoryStateItem } from "../src/native-history-state.js";
import { decryptChatMessageProtectedContent } from "@cantrip/crypto";
import { protectChatMessage } from "../src/chat-message-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const context = {
  threadId: "thread",
  turnId: "turn",
  cwd: "/project",
  mode: "default" as const,
};
function item(
  body: NativeHistoryStateItem["body"],
  lifecycle: NativeHistoryStateItem["lifecycle"] = "completed",
): NativeHistoryStateItem {
  return {
    id: "native",
    identityKind: "canonical",
    revision: 1,
    ordinal: 0,
    body: { id: "native", ...body },
    lifecycle,
    completeBody: true,
    startedAtMs: null,
    completedAtMs: null,
    conflicts: [],
    origin: { generation: "runtime", sequence: 1, kind: "notification" },
  };
}
const render = (
  body: NativeHistoryStateItem["body"],
  lifecycle?: NativeHistoryStateItem["lifecycle"],
) => renderNativeHistoryItem(item(body, lifecycle), context)[0]!;

describe("native history item presentation", () => {
  it("exposes conflicting versions and isolates returned source evidence from later caller mutation", () => {
    const source = item({ type: "agentMessage", text: "first" });
    source.conflicts.push({
      body: { type: "agentMessage", text: "other" },
      lifecycle: "completed",
      completeBody: true,
      startedAtMs: null,
      completedAtMs: null,
      origin: { generation: "other", sequence: 1, kind: "snapshot" },
    });
    const [draft] = renderNativeHistoryItem(source, context);
    source.body.text = "later mutation";
    expect(draft!.source.body.text).toBe("first");
    expect(draft!.source.conflicts[0]!.body.text).toBe("other");
    expect(draft!.unresolved).toContainEqual({
      kind: "conflicting-item-versions",
      index: null,
    });
    expect(draft!.message.content).toHaveLength(2);
  });

  it("keeps verified child scope and rejects a scope belonging to a different physical thread", () => {
    const scope = {
      agentThreadId: "thread",
      rootThreadId: "root",
      parentThreadId: "root",
      rootTurnId: "root-turn",
      agentPath: ["root", "child"],
      nickname: null,
      role: null,
      depth: 1,
      isRoot: false,
    };
    const source = item({ type: "agentMessage", text: "child answer" });
    expect(
      renderNativeHistoryItem(source, { ...context, agentScope: scope })[0]!
        .message.content[0],
    ).toMatchObject({ agentScope: scope });
    expect(() =>
      renderNativeHistoryItem(source, {
        ...context,
        agentScope: { ...scope, agentThreadId: "sibling" },
      }),
    ).toThrow("another thread");
  });
  it("preserves exact assistant whitespace, phase and live status through real message encryption", async () => {
    const draft = render(
      {
        type: "agentMessage",
        text: "  exact\n\ntext  ",
        phase: "final_answer",
      },
      "started",
    );
    const key = new Uint8Array(32).fill(71);
    const service = {
      ownerId: () => "owner",
      componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
    } as WorkerEncryptionService;
    const id = "10ee8f74-b25d-41fd-bad3-e9355c6d934e";
    const protectedMessage = await protectChatMessage({
      id,
      service,
      message: { ...draft.message, idempotencyKey: "reserved-native-key" },
    });
    const opened = await decryptChatMessageProtectedContent({
      ownerId: "owner",
      messageId: id,
      componentKey: key,
      keyRevision: 1,
      encrypted: protectedMessage.protectedContent,
      publicClassification: protectedMessage.classification,
    });
    expect(opened.content).toMatchObject([
      {
        type: "text",
        text: "  exact\n\ntext  ",
        phase: "final_answer",
        streaming: true,
      },
    ]);
    expect(draft.identity.component).toBe("assistant");
    expect(draft.source.body.text).toBe("  exact\n\ntext  ");
  });

  it("retains native input order and makes unresolved attachment-only input visible", () => {
    const draft = render({
      type: "userMessage",
      clientId: "client",
      content: [
        { type: "text", text: "before " },
        { type: "image", url: "data:image/png;base64,secret" },
        { type: "text", text: " after" },
      ],
    });
    expect(draft.message.role).toBe("user");
    expect(draft.message.content.map((part) => part.type)).toEqual([
      "text",
      "activity",
      "text",
    ]);
    expect(draft.unresolved).toEqual([{ kind: "image", index: 1 }]);
    expect(JSON.stringify(draft.message.content)).not.toContain(
      "base64,secret",
    );
    expect(draft.source.body.clientId).toBe("client");
    expect(
      render({
        type: "userMessage",
        content: [{ type: "localImage", path: "/private/image" }],
      }).message.content,
    ).toHaveLength(1);
    expect(
      render({ type: "userMessage", content: [] }).identity.component,
    ).toBe("user");
  });

  it("uses supplied authorized materialization at its exact input position without reading a native path", () => {
    const [draft] = renderNativeHistoryItem(
      item({
        type: "userMessage",
        content: [
          { type: "text", text: "before" },
          { type: "mention", path: "/not-read", name: "reference" },
        ],
      }),
      {
        ...context,
        inputParts: new Map([
          [1, [{ type: "text", text: "resolved reference" }]],
        ]),
      },
    );
    expect(draft!.message.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "resolved reference" },
    ]);
    expect(draft!.unresolved).toEqual([]);
  });

  it("renders empty assistant items and keeps identical messages under distinct native identities", () => {
    const first = item({ type: "agentMessage", text: "same" });
    const other = {
      ...first,
      id: "other",
      body: { ...first.body, id: "other" },
    };
    expect(renderNativeHistoryItem(first, context)[0]!.identity).not.toEqual(
      renderNativeHistoryItem(other, context)[0]!.identity,
    );
    expect(
      render({ type: "agentMessage", text: "" }).message.content,
    ).toHaveLength(1);
  });

  it("keeps sparse and more than 100 reasoning summaries without truncating text or changing message identity", () => {
    const parts = Object.fromEntries(
      Array.from({ length: 105 }, (_, i) => [String(i), `part-${i}`]),
    );
    parts["1000000000"] = "last sparse part";
    const draft = render(
      { type: "reasoning", summary: [], summaryParts: parts },
      "started",
    );
    const activity = draft.message.content[0]!;
    expect(activity.type).toBe("activity");
    if (activity.type !== "activity" || activity.activity.type !== "reasoning")
      throw new Error("Expected reasoning");
    expect(activity.activity.status).toBe("running");
    expect(activity.activity.summary).toHaveLength(100);
    expect(activity.activity.summary.join("\n\n")).toBe(
      [...Object.values(parts)].join("\n\n"),
    );
    expect(
      render({ type: "reasoning", summary: ["authoritative replacement"] })
        .identity,
    ).toEqual(draft.identity);
  });

  it("preserves full command output and unknown timing without manufacturing completion from a parent turn", () => {
    const output = "output\n".repeat(50_000);
    const draft = render(
      {
        type: "commandExecution",
        command: "printf test",
        cwd: "/project",
        aggregatedOutput: output,
        status: "inProgress",
        exitCode: null,
        durationMs: null,
      },
      "started",
    );
    expect(draft.message.content[0]).toMatchObject({
      type: "activity",
      activity: {
        type: "command",
        output,
        status: "running",
        completedAtMs: null,
      },
    });
    expect(draft.message.content[0]).not.toHaveProperty("activity.startedAtMs");
  });

  it.each([
    { type: "plan", text: "whole plan" },
    {
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "/project/a", kind: { type: "update" }, diff: "+line" },
      ],
    },
    {
      type: "mcpToolCall",
      server: "fixture",
      tool: "echo",
      arguments: {},
      status: "completed",
      result: { content: [] },
      error: null,
      durationMs: null,
    },
    {
      type: "dynamicToolCall",
      namespace: null,
      tool: "fixture",
      status: "completed",
      success: true,
      durationMs: null,
    },
    {
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "thread",
      receiverThreadIds: ["child"],
      agentsStates: {},
      model: null,
      prompt: "child prompt",
      status: "completed",
    },
    {
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/child",
    },
    { type: "webSearch", query: "fixture", action: null },
    { type: "imageView", path: "/project/image.png" },
    { type: "enteredReviewMode", review: "review" },
    { type: "exitedReviewMode", review: "review" },
    { type: "contextCompaction" },
  ])(
    "preserves %s as structured activity with exact source evidence",
    (body) => {
      const draft = render(body);
      expect(draft.unresolved).toEqual([]);
      expect(draft.message.content[0]?.type).toBe("activity");
      expect(draft.source.body).toEqual({ id: "native", ...body });
    },
  );

  it("isolates malformed, unknown and unknown-lifecycle items without losing their identity or source", () => {
    for (const body of [
      { type: "futureItem", secret: "retained" },
      { type: "fileChange", changes: null },
    ]) {
      const draft = render(body);
      expect(draft.unresolved).toHaveLength(1);
      expect(draft.source.body).toEqual({ id: "native", ...body });
      expect(draft.identity.itemId).toBe("native");
    }
    expect(
      render({ type: "plan", text: "unknown state" }, "unknown").unresolved[0]
        ?.kind,
    ).toBe("unknown-item-lifecycle");
  });
});
