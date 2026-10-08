import type {
  AgentActivity,
  ChatMessage,
  NativeInitialTurnSettings,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NativeTurnSettingsEvidence } from "@/lib/native-turn-settings-evidence";
import type { AgentTranscriptEntry } from "./agent-turn-projection";
import { ChatTranscriptEntries } from "./chat-transcript-entries";

const initialSettings: NativeInitialTurnSettings = {
  model: "session-model",
  modelProvider: "provider",
  reasoningEffort: "medium",
  effectiveReasoningEffort: "medium",
  serviceTier: null,
  effectiveServiceTier: null,
  collaborationMode: "default",
};
const correlation = (turnId = "turn-1", threadId = "root-thread") => ({
  threadId,
  turnId,
  itemId: null,
  diagnosticId: null,
  sourceMethod: "turn/completed",
});
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
    worktreeId: "worktree",
    scratchRootId: null,
    executionLaneId: null,
    mode: "default",
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    modelId: "original-model",
    modelRouteId: "original-route",
    providerId: "provider",
    providerName: "Provider",
    providerModelName: "original-model",
    createdAt: "2026-10-08T00:00:00.000Z",
  };
}
const user = (id = "user", sequence = 1) =>
  message(id, sequence, "user", [{ type: "text", text: id }]);
const summary = (
  id = "summary",
  sequence = 2,
  settings = initialSettings,
  turnId = "turn-1",
): ChatMessage =>
  message(id, sequence, "assistant", [
    {
      type: "activity",
      activity: {
        type: "turnSummary",
        id,
        status: "completed",
        durationMs: 1000,
        startedAt: 1000,
        completedAt: 2000,
        correlation: correlation(turnId),
        initialSettings: settings,
      },
    },
  ]);
function render(
  messages: ChatMessage[],
  evidence: NativeTurnSettingsEvidence[] = [],
) {
  const entries: AgentTranscriptEntry[] = messages.map((message) => ({
    type: "timeline",
    entry: { type: "message", message, turnMetadata: null },
  }));
  return renderToStaticMarkup(
    <ChatTranscriptEntries
      entries={entries}
      nativeTurnSettings={evidence}
      copiedMessageId={null}
      editedMessageRef={{ current: null }}
      editingSentMessage={null}
      forkPending={false}
      latestEditableMessageId={null}
      latestLiveActivityGroupKey={null}
      retryPending={false}
      onCancelEditingMessage={() => {}}
      onChangeEditingMessage={() => {}}
      onCopyResponse={async () => {}}
      onEditMessage={() => {}}
      onForkMessage={() => {}}
      onOpenFile={() => {}}
      onSubmitEditedMessage={() => {}}
    />,
  );
}
const labels = (html: string) =>
  [...html.matchAll(/<p[^>]*>(.*?)<\/p>/g)]
    .map((match) => match[1])
    .filter((text) => text?.includes("Provider ·"));

describe("transcript turn model attribution", () => {
  it("uses the immutable native model after a session override", () => {
    expect(labels(render([user(), summary()]))).toEqual([
      "Provider · session-model",
    ]);
  });
  it("loads archived settings only for the represented thread and turn", () => {
    const reply = message("reply", 2, "assistant", [
      { type: "text", text: "done", correlation: correlation() },
    ]);
    expect(
      labels(
        render(
          [user(), reply],
          [
            {
              ...correlation("turn-1", "other-thread"),
              status: "available",
              initialSettings: { ...initialSettings, model: "other-model" },
            },
            { ...correlation(), status: "available", initialSettings },
          ],
        ),
      ),
    ).toEqual(["Provider · session-model"]);
  });
  it("keeps historical turns tied to their own captured settings", () => {
    expect(
      labels(
        render([
          user(),
          summary(),
          user("new-user", 3),
          summary(
            "new-summary",
            4,
            { ...initialSettings, model: "new-model" },
            "turn-2",
          ),
        ]),
      ),
    ).toEqual(["Provider · session-model", "Provider · new-model"]);
  });
  it("marks the configured route when native evidence is missing", () => {
    expect(labels(render([user()]))).toEqual([
      "Configured route: Provider · original-model",
    ]);
  });
  it("does not silently pick a model when captures conflict", () => {
    expect(
      labels(
        render(
          [user(), summary()],
          [
            {
              ...correlation(),
              status: "available",
              initialSettings: { ...initialSettings, model: "disagrees" },
            },
          ],
        ),
      ),
    ).toEqual(["Configured route: Provider · original-model"]);
  });
  it("ignores child turn settings when labeling the root prompt", () => {
    const child = summary(
      "child-summary",
      3,
      { ...initialSettings, model: "child-model" },
      "child-turn",
    );
    const activity = (
      child.content[0] as { type: "activity"; activity: AgentActivity }
    ).activity;
    activity.correlation = correlation("child-turn", "child-thread");
    activity.agentScope = {
      agentThreadId: "child-thread",
      rootThreadId: "root-thread",
      rootTurnId: "turn-1",
      parentThreadId: "root-thread",
      agentPath: ["root", "child"],
      nickname: null,
      role: null,
      depth: 1,
      isRoot: false,
    };
    expect(labels(render([user(), summary(), child]))).toEqual([
      "Provider · session-model",
    ]);
  });
  it("does not give a pending prompt an earlier workspace snapshot's model", () => {
    const snapshot = message("snapshot", 4, "assistant", [
      {
        type: "activity",
        activity: {
          type: "fileChange",
          id: "worktree-diff:old",
          status: "completed",
          changes: [],
          correlation: {
            ...correlation(),
            sourceMethod: "cantrip/workspaceSnapshot",
          },
        },
      },
    ]);
    expect(
      labels(render([user(), summary(), user("pending", 3), snapshot])),
    ).toEqual([
      "Provider · session-model",
      "Configured route: Provider · original-model",
    ]);
  });
});
