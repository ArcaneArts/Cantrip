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
import {
  effectivePolicyListSchema,
  policyAssignmentListSchema,
  policySummarySchema,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ProjectSettingsPage,
  projectSettingsTabsForProject,
  projectWorktreeBindings,
  projectWorktreeState,
} from "./project-settings-page";

const now = "2026-08-08T12:00:00.000Z";
const worktree: ProjectWorktreeSummary = {
  id: "worktree-primary",
  projectSourceId: "source-1",
  projectId: "project-1",
  rootKind: "git-worktree",
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
  it("hides worktree and replica settings for managed folders", () => {
    const tabs = projectSettingsTabsForProject({
      capabilities: {
        git: false,
        github: false,
        worktrees: false,
        replicas: false,
        relocation: false,
      },
    });

    expect(tabs.map(({ id }) => id)).not.toContain("worktrees");
    expect(tabs.map(({ id }) => id)).not.toContain("replicas");
    expect(tabs.map(({ id }) => id)).toEqual([
      "general",
      "environment",
      "archive",
      "automations",
      "workflows",
      "tunnels",
      "policies",
      "skills",
      "mcp",
    ]);
  });

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
      experience: "agent",
      position: 0,
      status: "idle",
      activeWorkerId: null,
      activeWorktreeId: worktree.id,
      placementRevision: 1,
      worktreeMode: "pinned",
      modelId: null,
      reasoningEffort: null,
      permissionProfileId: null,
      planMode: "default",
      hasPendingPlanQuestion: false,
      hasUnreadCompletion: false,
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
      directoryPath: null,
      service: { enabled: false, command: "" },
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
      selectedPath: null,
      fileMode: "preview",
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

  it("renders project features under their dedicated settings tabs", () => {
    const project = {
      id: "project-1",
      name: "Cantrip",
      position: 0,
      originKind: "github",
      capabilities: {
        git: true,
        github: true,
        worktrees: true,
        replicas: true,
        relocation: true,
      },
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
        sourceKind: "git",
        workerId: "worker-1",
        path: "/worker/repos/cantrip",
        displayPath: "~/repos/cantrip",
        placementMode: "managed",
        ownershipKind: "cantrip",
        requestedPath: null,
        linkPath: null,
      },
      replicas: [],
      createdAt: now,
      updatedAt: now,
    } satisfies ProjectSummary;
    const renderSection = (
      initialSection:
        | "general"
        | "environment"
        | "workflows"
        | "replicas"
        | "policies"
        | "worktrees"
        | "tunnels" = "general",
    ) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const projectPolicy = policySummarySchema.parse({
        id: "policy-1",
        key: "project-review",
        name: "Project review",
        summary: "Review changes in this project.",
        enabled: true,
        mandatory: false,
        position: 0,
        templateKey: null,
        rowVersion: 1,
        workspaceAssignmentCount: 0,
        projectAssignmentCount: 1,
        createdAt: now,
        updatedAt: now,
      });
      queryClient.setQueryData(
        ["project-policy-assignments", project.id],
        policyAssignmentListSchema.parse({
          collectionVersion: 1,
          policies: [projectPolicy],
          directPolicyIds: [projectPolicy.id],
        }),
      );
      queryClient.setQueryData(
        ["effective-policies", project.id],
        effectivePolicyListSchema.parse({
          policies: [
            {
              key: projectPolicy.key,
              name: projectPolicy.name,
              summary: projectPolicy.summary,
              mandatory: false,
              sources: [{ type: "project", projectId: project.id }],
            },
          ],
        }),
      );
      return renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <ProjectSettingsPage
            desktopRuntime={false}
            initialSection={initialSection}
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
            onOpenImportedChat={() => undefined}
          />
        </QueryClientProvider>,
      );
    };

    const markup = renderSection();

    expect(markup).toContain("ArcaneArts/Cantrip");
    expect(markup).toContain("~/repos/cantrip");
    expect(markup).toContain("Workflows");
    expect(markup).toContain("Environment");
    expect(markup).toContain("Archive");
    expect(markup).toContain("Worktrees");
    expect(markup).toContain("Replicas");
    expect(markup).toContain("Tunnels");
    expect(markup).toContain("Policies");
    expect(markup).toContain("Skills");
    expect(markup).toContain("MCP");
    expect(markup).not.toContain("MCP servers");
    expect(markup).not.toContain("New workflow");
    expect(markup).not.toContain("Agent managed");
    expect(markup).not.toContain("Worker offline");
    expect(markup).toContain('data-slot="project-settings"');

    const workflowsMarkup = renderSection("workflows");
    expect(workflowsMarkup).toContain("New workflow");
    expect(workflowsMarkup).not.toContain("Agent managed");

    const environmentMarkup = renderSection("environment");
    expect(environmentMarkup).toContain("Environment configuration");
    expect(environmentMarkup).toContain(".codex/environments/environment.toml");

    const worktreesMarkup = renderSection("worktrees");
    expect(worktreesMarkup).toContain("Agent managed");
    expect(worktreesMarkup).toContain("Required for writes");
    expect(worktreesMarkup).toContain("Primary");
    expect(worktreesMarkup).toContain("Worker offline");
    expect(worktreesMarkup).toContain('aria-label="Search worktrees"');
    expect(worktreesMarkup).not.toContain("New workflow");

    const replicasMarkup = renderSection("replicas");
    expect(replicasMarkup).toContain("Project placement");
    expect(replicasMarkup).toContain("Worker replicas");
    expect(replicasMarkup).not.toContain("Agent managed");

    const tunnelsMarkup = renderSection("tunnels");
    expect(tunnelsMarkup).toContain("Project tunnels");
    expect(tunnelsMarkup).toContain("Project Tunnels");
    expect(tunnelsMarkup).toContain("All Tunnels");
    expect(tunnelsMarkup).not.toContain("New workflow");

    const policiesMarkup = renderSection("policies");
    expect(policiesMarkup).toContain("Project review");
    expect(policiesMarkup).toContain("Assigned directly to this project");
    expect(policiesMarkup).not.toContain("New workflow");
  });
});
