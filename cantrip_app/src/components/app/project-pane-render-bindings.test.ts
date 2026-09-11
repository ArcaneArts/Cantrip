import type { ProjectPaneSummary } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { VisibleProjectPane } from "@/components/app/project-workspace-frame-model";
import type { ProjectSurface } from "@/lib/project-surface";

import { projectPaneRenderBindings } from "./project-pane-render-bindings";

const timestamp = "2026-09-04T12:00:00.000Z";
const pane: ProjectPaneSummary = {
  id: "pane-center",
  projectId: "project-1",
  region: "center",
  title: "Center",
  position: 0,
  anchorTabKey: "builtin:history",
  createdAt: timestamp,
  updatedAt: timestamp,
  members: [],
};
const surface = {
  kind: "builtin",
  tabKey: "builtin:history",
  entity: { definitionId: "git.history" },
} as ProjectSurface;

function presentation(
  focused: boolean,
  activeSurface: ProjectSurface = surface,
): VisibleProjectPane {
  return {
    activeSurface,
    activeTabKey: activeSurface.tabKey,
    focused,
    gridArea: "center-body",
    pane,
    surfaces: [activeSurface],
  };
}

function bindings() {
  const operation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn() });
  return {
    activeProjectOverviewSection: "overview",
    newBrowser: operation(),
    newChat: operation(),
    newCodeTab: operation(),
    newExplorer: operation(),
    newRemoteDesktop: operation(),
    newTerminal: operation(),
    remoteDesktop: { data: undefined },
    runConfigurationRuntimes: { data: [] },
    runConfigurations: { data: { entries: [] }, isSuccess: true },
    selectedProject: { capabilities: { git: true } },
    setCodeHeader: vi.fn(),
    setExplorerHeader: vi.fn(),
    setGitHistoryHeader: vi.fn(),
    workers: { data: [] },
    worktrees: { data: [] },
  };
}

describe("project pane render bindings", () => {
  it("shows each pane's linked CLI and restores its chat when toggled off", () => {
    const chat = { id: "chat-one", activeWorkerId: "worker-one" };
    const otherChat = { id: "chat-two" };
    const terminal = {
      id: "cli-one",
      linkedChatId: chat.id,
      kind: "chat-console",
    };
    const otherTerminal = {
      id: "cli-two",
      linkedChatId: otherChat.id,
      kind: "chat-console",
    };
    const chatSurface = {
      kind: "chat",
      tabKey: "chat:chat-one",
      entity: chat,
    } as ProjectSurface;
    const shell = {
      ...bindings(),
      chatConsoleOpenChats: new Set([chat.id, otherChat.id]),
      terminals: { data: [terminal, otherTerminal] },
      selectedTerminal: otherTerminal,
      linkedConsoleChat: otherChat,
    };
    const resolved = projectPaneRenderBindings(
      shell,
      presentation(false, chatSurface),
    );
    expect(resolved.selectedTerminal).toBe(terminal);
    expect(resolved.linkedConsoleChat).toBe(chat);
    expect(resolved.selectedStandaloneTerminal).toBeUndefined();
    expect(resolved.terminalSurfaceVisible).toBe(true);
    shell.chatConsoleOpenChats.delete(chat.id);
    const closed = projectPaneRenderBindings(
      shell,
      presentation(false, chatSurface),
    );
    expect(closed.selectedTerminal).toBeUndefined();
    expect(closed.linkedConsoleChat).toBeUndefined();
    expect(closed.selectedChat).toBe(chat);
    expect(closed.terminalSurfaceVisible).toBe(false);
  });

  it("lets only the focused pane publish shell header state", () => {
    const shell = bindings();

    const focused = projectPaneRenderBindings(shell, presentation(true));
    expect(focused.setCodeHeader).toBe(shell.setCodeHeader);
    expect(focused.setExplorerHeader).toBe(shell.setExplorerHeader);
    expect(focused.setGitHistoryHeader).toBe(shell.setGitHistoryHeader);

    const unfocused = projectPaneRenderBindings(shell, presentation(false));
    expect(unfocused.setCodeHeader).toBeUndefined();
    expect(unfocused.setExplorerHeader).toBeUndefined();
    expect(unfocused.setGitHistoryHeader).toBeTypeOf("function");
    unfocused.setGitHistoryHeader(null);
    expect(shell.setGitHistoryHeader).not.toHaveBeenCalled();
    expect(
      projectPaneRenderBindings(shell, presentation(false)).setGitHistoryHeader,
    ).toBe(unfocused.setGitHistoryHeader);
  });

  it.each(["github.issues", "github.pull-requests", "github.actions"] as const)(
    "keeps an unavailable %s singleton placed when GitHub capability is lost",
    (definitionId) => {
      const shell = {
        ...bindings(),
        selectedProject: {
          capabilities: { git: true, github: false, worker: true },
        },
      };
      const unavailableSurface = {
        entity: { definitionId },
        kind: "builtin",
        paneId: pane.id,
        projectId: pane.projectId,
        tabKey: `builtin:${definitionId}`,
      } as ProjectSurface;
      const input = presentation(true, unavailableSurface);

      const resolved = projectPaneRenderBindings(shell, input);

      expect(resolved.selectedProjectToolUnavailable).toBe(true);
      expect(resolved.selectedPane).toBe(pane);
      expect(resolved.selectedSurface).toBe(unavailableSurface);
      expect(input.surfaces).toEqual([unavailableSurface]);
    },
  );
});
