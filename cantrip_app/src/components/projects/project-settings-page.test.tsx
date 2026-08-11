import type {
  ChatSummary,
  CodeTabSummary,
  ExplorerSummary,
  GitStatus,
  ProjectSummary,
  ProjectViewSummary,
  ProjectWorktreeSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ProjectSettingsPage,
  projectWorktreeBindings,
  projectWorktreeState,
} from "./project-settings-page";

const now = "2026-08-08T12:00:00.000Z";
const worktree: ProjectWorktreeSummary = {
  id: "worktree-primary",
  projectSourceId: "source-1",
  projectId: "project-1",
  workerId: "worker-1",
  name: "Primary",
  path: "/worker/repos/cantrip",
  displayPath: "~/repos/cantrip",
  isPrimary: true,
  isDefault: true,
  origin: "user",
  lifecycleState: "ready",
  branch: "main",
  head: "abcdef123456",
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: now,
  createdAt: now,
  updatedAt: now,
};
const cleanStatus: GitStatus = {
  branch: "main",
  head: "abcdef123456",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  branches: [],
};

describe("project settings", () => {
  it("summarizes clean, dirty, offline, and conflicting worktrees", () => {
    expect(projectWorktreeState(worktree, cleanStatus, true).label).toBe(
      "Clean",
    );
    expect(projectWorktreeState(worktree, undefined, false).label).toBe(
      "Worker offline",
    );
    expect(
      projectWorktreeState(
        worktree,
        {
          ...cleanStatus,
          files: [
            {
              path: "README.md",
              originalPath: null,
              indexStatus: "M",
              worktreeStatus: " ",
              staged: true,
              unstaged: false,
            },
          ],
        },
        true,
      ).label,
    ).toBe("1 changed file");
    expect(
      projectWorktreeState(
        worktree,
        {
          ...cleanStatus,
          files: [
            {
              path: "README.md",
              originalPath: null,
              indexStatus: "U",
              worktreeStatus: "U",
              staged: true,
              unstaged: true,
            },
          ],
        },
        true,
      ).label,
    ).toBe("Conflicts");
  });

  it("collects the project tabs bound to a worktree", () => {
    const chat = {
      id: "chat-1",
      projectId: "project-1",
      title: "Implementation",
      position: 0,
      status: "idle",
      activeWorkerId: null,
      activeWorktreeId: worktree.id,
      worktreeMode: "pinned",
      modelId: null,
      permissionProfileId: null,
      planMode: "default",
      hasPendingPlanQuestion: false,
      automationPaused: false,
      createdAt: now,
      updatedAt: now,
    } satisfies ChatSummary;
    const terminal = {
      id: "terminal-1",
      projectId: "project-1",
      title: "Shell",
      position: 1,
      status: "idle",
      activeWorkerId: "worker-1",
      worktreeId: worktree.id,
      linkedChatId: null,
      createdAt: now,
      updatedAt: now,
    } satisfies TerminalSummary;
    const explorer = {
      id: "explorer-1",
      projectId: "project-1",
      title: "Files",
      position: 2,
      activeWorkerId: "worker-1",
      worktreeId: worktree.id,
      createdAt: now,
      updatedAt: now,
    } satisfies ExplorerSummary;
    const history = {
      id: "view-1",
      projectId: "project-1",
      title: "History",
      kind: "history",
      worktreeId: worktree.id,
      position: 3,
      createdAt: now,
      updatedAt: now,
    } satisfies ProjectViewSummary;
    const code = {
      id: "code-1",
      projectId: "project-1",
      title: "Workbench",
      position: 4,
      activeWorkerId: "worker-1",
      worktreeId: worktree.id,
      profileId: "default",
      themeMode: "follow-cantrip",
      status: "idle",
      lastError: null,
      createdAt: now,
      updatedAt: now,
    } satisfies CodeTabSummary;

    expect(
      projectWorktreeBindings(
        worktree.id,
        [chat],
        [terminal],
        [explorer],
        [history],
        [code],
      ),
    ).toEqual(["Implementation", "Shell", "Files", "Workbench", "History"]);
  });

  it("renders project metadata, policies, and inventory in one surface", () => {
    const project = {
      id: "project-1",
      name: "Cantrip",
      position: 0,
      setupStatus: "ready",
      setupError: null,
      worktreePolicy: "agent-managed",
      github: {
        repositoryId: "repo-1",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
      source: {
        id: "source-1",
        workerId: "worker-1",
        path: "/worker/repos/cantrip",
        displayPath: "~/repos/cantrip",
      },
      createdAt: now,
      updatedAt: now,
    } satisfies ProjectSummary;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ProjectSettingsPage
          project={project}
          chats={[]}
          codeTabs={[]}
          terminals={[]}
          explorers={[]}
          projectViews={[]}
          workers={[]}
          worktrees={[worktree]}
          statuses={{ [worktree.id]: cleanStatus }}
          onCreateChat={() => undefined}
          onCreateCode={() => undefined}
          onCreateTerminal={() => undefined}
          onCreateExplorer={() => undefined}
          onCreateHistory={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("ArcaneArts/Cantrip");
    expect(markup).toContain("~/repos/cantrip");
    expect(markup).toContain("Agent managed");
    expect(markup).toContain("Required for writes");
    expect(markup).toContain("Skills");
    expect(markup).toContain("Primary");
    expect(markup).toContain("Worker offline");
  });
});
