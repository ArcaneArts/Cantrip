import {
  standaloneChatSummarySchema,
  type WorkerSummary,
} from "@cantrip/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { StandaloneChatSidebar } from "./standalone-chat-sidebar";

vi.mock("@/components/chat/chat-menu", () => ({
  ChatContextMenu: ({ children }: { children: ReactNode }) => children,
  ChatDropdownMenu: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const chat = standaloneChatSummarySchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  contextKind: "standalone",
  projectId: null,
  experience: "agent",
  position: 0,
  status: "idle",
  activeWorkerId: "worker-a",
  activeWorktreeId: null,
  activeScratchRootId: "00000000-0000-4000-8000-000000000002",
  placementRevision: 1,
  worktreeMode: null,
  modelId: null,
  reasoningEffort: null,
  customSubagentModel: false,
  subagentModelId: null,
  subagentReasoningEffort: null,
  permissionProfileId: null,
  planMode: "default",
  hasPendingPlanQuestion: false,
  hasUnreadCompletion: true,
  automationPaused: false,
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:01:00.000Z",
  title: "Research notes",
});

describe("standalone Chat sidebar", () => {
  it("archives an idle chat on middle click without selecting it", async () => {
    const onArchive = vi.fn();
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <StandaloneChatSidebar
          archivedCount={0}
          archivedSelected={false}
          chats={[chat]}
          creating={false}
          selectedChatId={null}
          workers={[]}
          onArchive={onArchive}
          onFork={() => undefined}
          onNewChat={() => undefined}
          onOpenArchived={() => undefined}
          onOpenSettings={() => undefined}
          onRename={() => undefined}
          onSelect={onSelect}
          onSwitchIde={() => undefined}
        />,
      );
    });
    const row = renderer.root.findByProps({
      "data-standalone-chat-id": chat.id,
    });
    const mouseDown = { button: 1, preventDefault: vi.fn() };
    const auxiliaryClick = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    row.props.onMouseDown(mouseDown);
    row.props.onAuxClick(auxiliaryClick);

    expect(mouseDown.preventDefault).toHaveBeenCalledOnce();
    expect(auxiliaryClick.preventDefault).toHaveBeenCalledOnce();
    expect(auxiliaryClick.stopPropagation).toHaveBeenCalledOnce();
    expect(onArchive).toHaveBeenCalledExactlyOnceWith(chat);
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("shows standalone navigation without project surfaces", () => {
    const markup = renderToStaticMarkup(
      <StandaloneChatSidebar
        archivedCount={2}
        archivedSelected={false}
        chats={[chat]}
        creationDisabled={false}
        creating={false}
        selectedChatId={chat.id}
        workers={[{ workerId: "worker-a", online: true } as WorkerSummary]}
        onArchive={() => undefined}
        onFork={() => undefined}
        onNewChat={() => undefined}
        onOpenArchived={() => undefined}
        onOpenSettings={() => undefined}
        onRename={() => undefined}
        onSelect={() => undefined}
        onSwitchIde={() => undefined}
      />,
    );

    expect(markup).toContain(" IDE</button>");
    expect(markup).toContain('aria-label="New chat"');
    expect(markup).toContain('title="New chat"');
    expect(markup).not.toContain(">New Chat</button>");
    expect(markup).toContain("Research notes");
    expect(markup).toContain("Agent turn finished");
    expect(markup).toContain("Archived");
    expect(markup).toContain(">2</span>");
    expect(markup).toContain("Settings");
    expect(markup).not.toContain("Project files");
    expect(markup).not.toContain("Worktree");
    expect(markup).not.toContain("Terminal");
  });

  it("can hide the large mode switch for the desktop titlebar menu", () => {
    const markup = renderToStaticMarkup(
      <StandaloneChatSidebar
        archivedCount={0}
        archivedSelected={false}
        chats={[]}
        creating={false}
        selectedChatId={null}
        showModeSwitch={false}
        workers={[]}
        onArchive={() => undefined}
        onFork={() => undefined}
        onNewChat={() => undefined}
        onOpenArchived={() => undefined}
        onOpenSettings={() => undefined}
        onRename={() => undefined}
        onSelect={() => undefined}
        onSwitchIde={() => undefined}
      />,
    );

    expect(markup).not.toContain(" IDE</button>");
    expect(markup).toContain('aria-label="New chat"');
  });

  it("renders Archived as selected navigation without a dialog", () => {
    const markup = renderToStaticMarkup(
      <StandaloneChatSidebar
        archivedCount={1}
        archivedSelected
        chats={[chat]}
        creating={false}
        selectedChatId={null}
        workers={[]}
        onArchive={() => undefined}
        onFork={() => undefined}
        onNewChat={() => undefined}
        onOpenArchived={() => undefined}
        onOpenSettings={() => undefined}
        onRename={() => undefined}
        onSelect={() => undefined}
        onSwitchIde={() => undefined}
      />,
    );

    expect(markup).toContain("bg-muted");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("No archived chats");
  });
});
