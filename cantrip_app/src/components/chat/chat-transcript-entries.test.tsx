import type { ChatMessage } from "@cantrip/protocol";
import { useMemo, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { AgentTranscriptEntry } from "./agent-turn-projection";

const messageContentRender = vi.hoisted(() => vi.fn());

vi.mock("./message-content", async () => {
  const { memo } = await import("react");
  return {
    MessageContent: memo(function TestMessageContent({
      message,
    }: {
      message: ChatMessage;
    }) {
      messageContentRender(message.id);
      return (
        <span>
          {message.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .join("")}
        </span>
      );
    }),
  };
});

import { ChatTranscriptEntries } from "./chat-transcript-entries";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const messageCount = 500;
const messages = Array.from(
  { length: messageCount },
  (_, index): ChatMessage => ({
    id: "message-" + index,
    chatId: "chat-1",
    contextKind: "project",
    worktreeId: "worktree-1",
    scratchRootId: null,
    executionLaneId: null,
    sequence: index + 1,
    role: "assistant",
    content: [{ type: "text", text: "Historical response " + index }],
    mode: "default",
    reasoningEffort: null,
    modelId: "model-1",
    modelRouteId: "route-1",
    providerId: "provider-1",
    providerName: "Provider",
    providerModelName: "Model",
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: "2026-08-24T12:00:00.000Z",
  }),
);

function transcriptEntries(streamingText: string): AgentTranscriptEntry[] {
  return messages.map((message, index) => ({
    type: "timeline",
    entry: {
      type: "message",
      message:
        index === messageCount - 1
          ? {
              ...message,
              content: [{ type: "text", text: streamingText }],
            }
          : message,
      turnMetadata: null,
    },
  }));
}

function userTranscriptEntry(): AgentTranscriptEntry {
  return {
    type: "timeline",
    entry: {
      type: "message",
      message: {
        ...messages[0]!,
        id: "user-message",
        role: "user",
        content: [{ type: "text", text: "User request" }],
      },
      turnMetadata: null,
    },
  };
}

function completedTurnTranscriptEntry(): AgentTranscriptEntry {
  const workMessage = (
    id: string,
    sequence: number,
    content: ChatMessage["content"],
  ): ChatMessage => ({
    ...messages[0]!,
    id,
    sequence,
    content,
  });
  return {
    type: "timeline",
    entry: {
      type: "activityGroup",
      kind: "turn",
      key: "turn:completed-work",
      messages: [
        workMessage("command-one", 1, [
          {
            type: "activity",
            activity: {
              type: "command",
              id: "command-one",
              command: "rg --files",
              cwd: ".",
              status: "completed",
              exitCode: 0,
              output: null,
            },
          },
        ]),
        workMessage("command-two", 2, [
          {
            type: "activity",
            activity: {
              type: "command",
              id: "command-two",
              command: "pnpm test",
              cwd: ".",
              status: "completed",
              exitCode: 0,
              output: null,
            },
          },
        ]),
        workMessage("thought", 3, [
          {
            type: "text",
            text: "Thought between operation groups.",
            phase: "commentary",
          },
        ]),
        workMessage("tool-one", 4, [
          {
            type: "activity",
            activity: {
              type: "mcpToolCall",
              id: "tool-one",
              status: "completed",
              server: "cantrip",
              tool: "policy_list",
              error: null,
              durationMs: 10,
            },
          },
        ]),
        workMessage("tool-two", 5, [
          {
            type: "activity",
            activity: {
              type: "mcpToolCall",
              id: "tool-two",
              status: "completed",
              server: "cantrip",
              tool: "policy_read",
              error: null,
              durationMs: 10,
            },
          },
        ]),
      ],
      startedAt: "2026-08-24T12:00:00.000Z",
      endedAt: "2026-08-24T12:00:10.000Z",
      turnId: "turn-completed-work",
      turnKey: "runtime:turn-completed-work",
    },
  };
}

const editedMessageRef = { current: null };
const noAction = () => undefined;
const noAsyncAction = async () => undefined;

function ComposerRenderHarness() {
  const [draft, setDraft] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [streamingText, setStreamingText] = useState("Streaming response");
  const entries = useMemo(
    () => transcriptEntries(streamingText),
    [streamingText],
  );
  return (
    <>
      <textarea
        aria-label="Composer"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      />
      <span>{scrollTop}</span>
      <button
        aria-label="Update stream"
        type="button"
        onClick={() => setStreamingText("Updated streaming response")}
      >
        Update stream
      </button>
      <ChatTranscriptEntries
        copiedMessageId={null}
        editedMessageRef={editedMessageRef}
        editingSentMessage={null}
        entries={entries}
        forkPending={false}
        latestEditableMessageId={null}
        latestLiveActivityGroupKey={null}
        retryPending={false}
        onCancelEditingMessage={noAction}
        onChangeEditingMessage={noAction}
        onCopyResponse={noAsyncAction}
        onEditMessage={noAction}
        onForkMessage={noAction}
        onOpenFile={noAction}
        onSubmitEditedMessage={noAction}
        onViewSubagent={noAction}
        onViewTrajectory={noAction}
      />
    </>
  );
}

describe("ChatTranscriptEntries render isolation", () => {
  it("groups completed operations around visibly spaced thoughts", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ChatTranscriptEntries
          copiedMessageId={null}
          editedMessageRef={editedMessageRef}
          editingSentMessage={null}
          entries={[completedTurnTranscriptEntry()]}
          forkPending={false}
          latestEditableMessageId={null}
          latestLiveActivityGroupKey={null}
          retryPending={false}
          onCancelEditingMessage={noAction}
          onChangeEditingMessage={noAction}
          onCopyResponse={noAsyncAction}
          onEditMessage={noAction}
          onForkMessage={noAction}
          onOpenFile={noAction}
          onSubmitEditedMessage={noAction}
          onViewSubagent={noAction}
          onViewTrajectory={noAction}
        />,
      );
    });

    const completedDisclosure = renderer.root.findByProps({
      "aria-expanded": false,
    });
    await act(async () => completedDisclosure.props.onClick());
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("Ran pnpm test · +1 more");
    expect(rendered).toContain("Called cantrip/policy_read · +1 more");
    expect(rendered).toContain("Thought between operation groups.");
    expect(rendered).not.toContain("rg --files");
    expect(
      renderer.root.findByProps({ "data-slot": "completed-turn-work" }).props
        .className,
    ).toContain("gap-3");
    expect(
      renderer.root.findAllByProps({
        "data-slot": "completed-turn-thought",
      }),
    ).toHaveLength(1);

    const groupedDisclosures = renderer.root.findAllByProps({
      "aria-expanded": false,
    });
    expect(groupedDisclosures).toHaveLength(2);
    await act(async () => groupedDisclosures[0]!.props.onClick());
    expect(JSON.stringify(renderer.toJSON())).toContain("rg --files");
    await act(async () => renderer.unmount());
  });

  it("marks user message cards for high contrast outline styling", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ChatTranscriptEntries
          copiedMessageId={null}
          editedMessageRef={editedMessageRef}
          editingSentMessage={null}
          entries={[userTranscriptEntry()]}
          forkPending={false}
          latestEditableMessageId={null}
          latestLiveActivityGroupKey={null}
          retryPending={false}
          onCancelEditingMessage={noAction}
          onChangeEditingMessage={noAction}
          onCopyResponse={noAsyncAction}
          onEditMessage={noAction}
          onForkMessage={noAction}
          onOpenFile={noAction}
          onSubmitEditedMessage={noAction}
          onViewSubagent={noAction}
          onViewTrajectory={noAction}
        />,
      );
    });

    const userMessage = renderer.root.findByProps({
      "data-chat-message-role": "user",
    });
    expect(userMessage.props.className).toContain("border-transparent");
    expect(userMessage.props.className).toContain("bg-muted/80");

    await act(async () => renderer.unmount());
  });

  it("skips historical rows for composer updates and rerenders only changed live content", async () => {
    messageContentRender.mockClear();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ComposerRenderHarness />);
    });
    expect(messageContentRender).toHaveBeenCalledTimes(messageCount);

    const composer = renderer.root.findByProps({ "aria-label": "Composer" });
    for (let index = 1; index <= 100; index += 1) {
      await act(async () => {
        composer.props.onChange({ target: { value: "x".repeat(index) } });
        composer.props.onScroll({ currentTarget: { scrollTop: index } });
      });
    }
    expect(messageContentRender).toHaveBeenCalledTimes(messageCount);

    await act(async () => {
      renderer.root
        .findByProps({ "aria-label": "Update stream" })
        .props.onClick();
    });
    expect(messageContentRender).toHaveBeenCalledTimes(messageCount + 1);

    await act(async () => renderer.unmount());
  });
});
