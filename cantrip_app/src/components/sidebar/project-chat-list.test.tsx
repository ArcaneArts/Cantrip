import { DndContext } from "@dnd-kit/core";
import { chatSummarySchema } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChatActivityStatus } from "@/components/chat/chat-activity-status";

import { ProjectChatList, ProjectOverviewTab } from "./project-chat-list";

vi.mock("@/components/chat/chat-menu", () => ({
  ChatContextMenu: ({ children }: { children: ReactNode }) => children,
  ChatDropdownMenu: () => null,
}));
vi.mock("@/components/projects/project-actions-menu", () => ({
  ProjectContextMenu: ({ children }: { children: ReactNode }) => children,
  ProjectDropdownMenu: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/projects/project-removal-dialog", () => ({
  ProjectRemovalDialog: () => null,
}));
vi.mock("@/components/sidebar/project-sidebar-file-tree", () => ({
  ProjectSidebarFileTree: () => null,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogClose: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const chat = chatSummarySchema.parse({
  id: "chat-1",
  projectId: "project-1",
  experience: "agent",
  position: 0,
  status: "idle",
  activeWorkerId: null,
  activeWorktreeId: "worktree-1",
  placementRevision: 1,
  worktreeMode: "agent-managed",
  modelId: null,
  reasoningEffort: null,
  permissionProfileId: null,
  planMode: "default",
  hasPendingPlanQuestion: false,
  hasUnreadCompletion: true,
  automationPaused: false,
  createdAt: "2026-08-22T12:00:00.000Z",
  updatedAt: "2026-08-22T12:01:00.000Z",
  title: "Agent",
});

describe("chat activity status", () => {
  it("shows a blue completion dot after the running indicator clears", () => {
    const completed = renderToStaticMarkup(<ChatActivityStatus chat={chat} />);
    const running = renderToStaticMarkup(
      <ChatActivityStatus chat={{ ...chat, status: "running" }} />,
    );

    expect(completed).toContain("bg-sky-400");
    expect(completed).toContain("Agent turn finished; open to dismiss");
    expect(running).toContain("animate-spin");
    expect(running).not.toContain("bg-sky-400");
  });
});

describe("project root sidebar row", () => {
  it("uses the project name instead of duplicating the Overview launcher", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewTab
        active
        onOpenSettings={() => undefined}
        onRemove={() => undefined}
        onSelect={() => undefined}
        project={
          {
            id: "project-1",
            name: "BileTools",
            setupStatus: "ready",
          } as Parameters<typeof ProjectOverviewTab>[0]["project"]
        }
        revealDisabled={false}
      />,
    );

    expect(markup).toContain(">BileTools</span>");
    expect(markup).toContain("h-8");
    expect(markup).not.toContain(">Overview</span>");
  });
});

describe("sidebar surface inventory", () => {
  it("does not render project tools or duplicate open workspace surfaces", async () => {
    const props = {
      browsers: [],
      chats: [chat],
      codeTabs: [],
      explorers: [],
      fileExplorer: null,
      filePreviewPath: null,
      fileGraphAvailable: false,
      fileTreeLoading: false,
      fileTreeWorkerId: null,
      fileTreeWorkerOnline: false,
      folderSetupJobs: new Map(),
      onChangeChatWorktree: vi.fn(),
      onCloseSurface: vi.fn(),
      onDeleteBrowser: vi.fn(),
      onDeleteChat: vi.fn(),
      onDeleteCode: vi.fn(),
      onDeleteExplorer: vi.fn(),
      onDeleteProjectView: vi.fn(),
      onDeleteTerminal: vi.fn(),
      onDuplicateChat: vi.fn(),
      onFileCreateFolder: vi.fn(),
      onFileDelete: vi.fn(),
      onFileOpenGraph: vi.fn(),
      onFileOpenNative: vi.fn(),
      onFileOpenNativeRoot: vi.fn(),
      onFileOpenTerminal: vi.fn(),
      onFilePin: vi.fn(),
      onFilePreview: vi.fn(),
      onFileRename: vi.fn(),
      onOpenChatExplorer: vi.fn(),
      onOpenChatHistory: vi.fn(),
      onOpenChatTerminal: vi.fn(),
      onOpenProjectSettings: vi.fn(),
      onPinProjectTool: vi.fn(),
      onRemoveProject: vi.fn(),
      onRenameBrowser: vi.fn(),
      onRenameChat: vi.fn(),
      onRenameCode: vi.fn(),
      onRenameExplorer: vi.fn(),
      onRenameProjectView: vi.fn(),
      onRenameTerminal: vi.fn(),
      onRequestChatWorktreeCreate: vi.fn(),
      onRevealProject: vi.fn(),
      onSelectProject: vi.fn(),
      onSelectTab: vi.fn(),
      onStopAndCloseRunTerminal: vi.fn(),
      overviewSelected: false,
      projects: [
        {
          capabilities: {
            git: true,
            github: true,
            worktrees: false,
            replicas: true,
            relocation: true,
          },
          id: "project-1",
          name: "Cantrip",
          setupStatus: "ready",
          source: null,
        },
      ],
      projectSetupJobs: new Map(),
      projectViews: [
        {
          id: "history-1",
          projectId: "project-1",
          title: "History",
          kind: "history",
          worktreeId: null,
          position: 0,
          createdAt: "2026-08-22T12:00:00.000Z",
          updatedAt: "2026-08-22T12:01:00.000Z",
        },
        {
          id: "issues-1",
          projectId: "project-1",
          title: "Issues",
          kind: "issues",
          worktreeId: null,
          position: 1,
          createdAt: "2026-08-22T12:00:00.000Z",
          updatedAt: "2026-08-22T12:01:00.000Z",
        },
      ],
      selectedProjectId: "project-1",
      selectedTabKey: null,
      surfaceLaunchers: [],
      surfaces: [
        {
          definition: {
            deletable: true,
            id: "project.terminal",
            supportedPlacements: ["center", "right", "bottom"],
          },
          entity: { id: "terminal-1" },
          kind: "terminal",
          member: { position: 0 },
          paneId: "pane-bottom",
          placement: { paneId: "pane-bottom", position: 0 },
          projectId: "project-1",
          resource: {
            entity: { id: "terminal-1" },
            ref: { id: "terminal-1" },
          },
          tabId: "terminal-1",
          tabKey: "terminal:terminal-1",
          title: "Terminal",
          view: { id: "terminal-view-1" },
        },
      ],
      tabLayout: { groups: [], projectId: "project-1", revision: 2 },
      terminals: [
        {
          id: "terminal-1",
          kind: "shell",
          linkedChatId: null,
          status: "running",
          title: "Terminal",
          worktreeId: "worktree-1",
        },
      ],
      workers: [],
      worktrees: [],
      worktreeStatuses: {},
    } as unknown as Parameters<typeof ProjectChatList>[0];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={new QueryClient()}>
          <DndContext>
            <ProjectChatList {...props} />
          </DndContext>
        </QueryClientProvider>,
      );
    });

    expect(JSON.stringify(renderer.toJSON())).not.toContain("Open views");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Project tools");
    await act(async () => renderer.unmount());
  });
});
