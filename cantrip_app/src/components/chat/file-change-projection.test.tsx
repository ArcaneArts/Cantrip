import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { decryptChatMessageProtectedContent } from "@cantrip/crypto";
import {
  chatMessageContentSchema,
  type AgentActivity,
  type ChatMessage,
} from "@cantrip/protocol";

import { normalizeCodexThreadItem } from "../../../../cantrip_worker/src/codex/app-server.js";
import { renderNativeHistoryItem } from "../../../../cantrip_worker/src/native-history-render.js";
import { protectChatMessage } from "../../../../cantrip_worker/src/chat-message-encryption.js";
import type { WorkerEncryptionService } from "../../../../cantrip_worker/src/worker-encryption.js";
import { projectTrajectory } from "./trajectory-model";
import { TrajectoryDetails } from "./trajectory-details";

const context = {
  cwd: "/project",
  threadId: "thread",
  turnId: "turn",
  mode: "default" as const,
};
function markup(content: ChatMessage["content"]) {
  const message: ChatMessage = {
    id: "10ee8f74-b25d-41fd-bad3-e9355c6d934e",
    chatId: "chat",
    contextKind: "project",
    worktreeId: "primary",
    scratchRootId: null,
    executionLaneId: null,
    sequence: 1,
    role: "assistant",
    mode: "default",
    createdAt: new Date(1000).toISOString(),
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
  const event = projectTrajectory({
    active: false,
    nowMs: 2000,
    messages: [message],
  })?.events.find((e) => e.activity?.type === "fileChange");
  if (!event) throw new Error("Expected projected file-change event");
  return renderToStaticMarkup(
    <TrajectoryDetails event={event} initialTab="preview" onBack={() => {}} />,
  );
}

describe("native file change to trajectory Preview", () => {
  it.each([
    { kind: "add" as const, diff: "WQA_EDIT54\n", marker: "WQA_EDIT54" },
    {
      kind: "update" as const,
      diff: "@@ -1 +1 @@\n-old\n+WQA_UPDATE54\n",
      marker: "WQA_UPDATE54",
    },
    {
      kind: "delete" as const,
      diff: "WQA_REMOVED54\n",
      marker: "WQA_REMOVED54",
    },
  ])(
    "renders $kind live and through encrypted native history replay",
    async ({ kind, diff, marker }) => {
      const body = {
        type: "fileChange" as const,
        id: "patch",
        status: "completed" as const,
        changes: [
          { path: "/project/notes/wqa-edit54.txt", kind: { type: kind }, diff },
        ],
      };
      const live = normalizeCodexThreadItem(body, context.cwd, "completed", {
        sourceMethod: "item/completed",
        diagnosticId: null,
        threadId: "thread",
        turnId: "turn",
        itemId: "patch",
      });
      expect(live?.type).toBe("fileChange");
      const liveMarkup = markup([
        { type: "activity", activity: live as AgentActivity },
      ]);
      expect(liveMarkup).toContain(marker);
      expect(liveMarkup).toContain('data-file-path="notes/wqa-edit54.txt"');
      expect(liveMarkup).not.toContain("Preview unavailable.");

      const rendered = renderNativeHistoryItem(
        {
          id: "patch",
          identityKind: "canonical",
          revision: 1,
          ordinal: 0,
          body,
          lifecycle: "completed",
          completeBody: true,
          startedAtMs: 1000,
          completedAtMs: 1100,
          conflicts: [],
          origin: { generation: "runtime", sequence: 1, kind: "notification" },
        },
        context,
      )[0]!;
      const key = new Uint8Array(32).fill(7);
      const wire = await protectChatMessage({
        id: "10ee8f74-b25d-41fd-bad3-e9355c6d934e",
        message: { ...rendered.message, idempotencyKey: "fixture" },
        service: {
          ownerId: () => "owner",
          componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
        } as unknown as WorkerEncryptionService,
      });
      expect(JSON.stringify(wire)).not.toContain(marker);
      expect(JSON.stringify(wire)).not.toContain("wqa-edit54.txt");
      const restored = await decryptChatMessageProtectedContent({
        ownerId: "owner",
        messageId: "10ee8f74-b25d-41fd-bad3-e9355c6d934e",
        componentKey: key,
        keyRevision: 1,
        encrypted: JSON.parse(JSON.stringify(wire.protectedContent)),
        publicClassification: wire.classification,
      });
      const replayMarkup = markup(
        chatMessageContentSchema.parse(restored.content),
      );
      expect(replayMarkup).toContain(marker);
      expect(replayMarkup).toContain('data-file-path="notes/wqa-edit54.txt"');
      expect(replayMarkup).not.toContain("Preview unavailable.");
    },
  );

  it("keeps a native addition with no captured content honestly unavailable", () => {
    const activity = normalizeCodexThreadItem(
      {
        type: "fileChange",
        id: "patch",
        status: "completed",
        changes: [{ path: "/project/empty.txt", kind: { type: "add" } }],
      },
      context.cwd,
      "completed",
      {
        sourceMethod: "item/completed",
        diagnosticId: null,
        threadId: "thread",
        turnId: "turn",
        itemId: "patch",
      },
    );
    expect(
      markup([{ type: "activity", activity: activity as AgentActivity }]),
    ).toContain("Preview unavailable.");
  });
});
