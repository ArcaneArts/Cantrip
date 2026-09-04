import type {
  ChatSummary,
  ProjectRepositoryStats,
  ProjectSummary,
  ProjectTokenUsage,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";
import { projectSurfaceIdentityForTab } from "@/lib/project-surface-registry";

import {
  formatByteCount,
  ProjectOverview,
  projectSurfaceRuntimeState,
} from "./project-overview";

const now = "2026-08-11T12:00:00.000Z";
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
const worktree = {
  id: "worktree-1",
  projectSourceId: "source-1",
  projectId: project.id,
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
  head: "abcdef1234567890",
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: now,
  createdAt: now,
  updatedAt: now,
} satisfies ProjectWorktreeSummary;
const stats = {
  kind: "git",
  commitCount: 321,
  trackedFileCount: 2_345,
  trackedByteCount: 3.5 * 1024 ** 3,
  textFileCount: 2_300,
  lineCount: 12_345,
  excludedFileCount: 45,
  truncated: true,
} satisfies ProjectRepositoryStats;
const usage = {
  agentTime: {
    activeAgentCount: 2,
    agentTimeMs: 1_200_000,
    wallTimeMs: 600_000,
    averageConcurrency: 2,
  },
  total: {
    inputTokens: 8_000,
    outputTokens: 2_500,
    cachedInputTokens: 1_000,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 500,
    totalTokens: 10_500,
  },
  daily: [
    {
      date: "2026-08-11",
      inputTokens: 8_000,
      outputTokens: 2_500,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 500,
      totalTokens: 10_500,
    },
  ],
  providers: [
    {
      id: "provider-1",
      name: "ChatGPT",
      inputTokens: 8_000,
      outputTokens: 2_500,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 500,
      totalTokens: 10_500,
      agentTime: {
        activeAgentCount: 2,
        agentTimeMs: 1_200_000,
        wallTimeMs: 600_000,
        averageConcurrency: 2,
      },
    },
  ],
  models: [
    {
      id: "model-1",
      name: "GPT 5.6 Sol",
      inputTokens: 8_000,
      outputTokens: 2_500,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 500,
      totalTokens: 10_500,
      agentTime: {
        activeAgentCount: 2,
        agentTimeMs: 1_200_000,
        wallTimeMs: 600_000,
        averageConcurrency: 2,
      },
    },
  ],
  range: { start: "2025-08-12", end: "2026-08-11" },
} satisfies ProjectTokenUsage;

function chatSurface(status: ChatSummary["status"]): ProjectSurface {
  const chat = {
    id: "chat-1",
    projectId: project.id,
    title: "Ship project overview",
    experience: "agent",
    position: 0,
    status,
    activeWorkerId: "worker-1",
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
  const identity = projectSurfaceIdentityForTab({
    kind: "chat",
    projectId: project.id,
    resourceId: chat.id,
  });
  return {
    definition: identity.definition,
    entity: chat,
    paneId: "group-1",
    kind: "chat",
    member: {
      tabKey: `chat:${chat.id}`,
      paneId: "group-1",
      projectId: project.id,
      tabKind: "chat",
      tabId: chat.id,
      title: chat.title,
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
    placement: {
      paneId: "group-1",
      position: 0,
      viewId: identity.viewId,
    },
    projectId: project.id,
    resource: { entity: chat, ref: identity.resource },
    tabId: chat.id,
    tabKey: `chat:${chat.id}`,
    title: chat.title,
    view: {
      id: identity.viewId,
      projectId: project.id,
      resource: identity.resource,
    },
  };
}

describe("project overview", () => {
  it("renders repository metrics and running project services", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverview
        creatingKinds={new Set()}
        project={project}
        stats={stats}
        statsLoading={false}
        usage={usage}
        usageLoading={false}
        surfaces={[chatSurface("running")]}
        workerOnline
        worktrees={[worktree]}
        onCreateSurface={vi.fn()}
        onOpenSurface={vi.fn()}
        onRevealProject={vi.fn()}
        revealLabel="Finder"
      />,
    );

    expect(markup).toContain('data-content-gutter="standard"');

    expect(markup).toContain("ArcaneArts/Cantrip");
    expect(markup).toContain("12,345");
    expect(markup).toContain("321");
    expect(markup).toContain("3.5 GB");
    expect(markup).toContain("10.5K");
    expect(markup).toContain("Input and output tokens");
    expect(markup).toContain("AI active time");
    expect(markup).toContain("20m");
    expect(markup).toContain("10m wall · 2.0x concurrency");
    expect(markup).toContain("Ship project overview");
    expect(markup).toContain('aria-label="Open Ship project overview"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("Running");
    expect(markup).toContain("Worker online");
    expect(markup).toContain('class="w-full space-y-5 p-4 sm:p-6 lg:p-8"');
    expect(markup).not.toContain("max-w-6xl");
    expect(markup).toContain("xl:grid-cols-7");
    expect(markup).toContain("xl:grid-cols-[minmax(0,1fr)_18rem]");
    expect(markup).not.toContain("lg:grid-cols-7");
    expect(markup).not.toContain("lg:grid-cols-[minmax(0,1fr)_18rem]");
    expect(markup).toContain("Open in Finder");
    expect(markup).not.toContain("Reveal in Finder");
    expect(markup.indexOf("Open in Finder")).toBeLessThan(
      markup.indexOf('href="https://github.com/ArcaneArts/Cantrip"'),
    );
    expect(markup).not.toContain("bounded line scan");
    expect(markup.match(/data-elite-global=/g)).toHaveLength(11);
    expect(markup).toContain(
      'data-elite-global="project-overview:project-1:hero"',
    );
    expect(markup).toContain(
      'data-elite-global="project-overview:project-1:metric:open-tabs"',
    );
    expect(markup).toContain(
      'data-elite-global="project-overview:project-1:services"',
    );
    expect(markup).toContain(
      'data-elite-global="project-overview:project-1:repository"',
    );
    expect(markup).toContain(
      'data-elite-global="project-overview:project-1:workspace"',
    );
  });

  it("formats tracked repository sizes at stable unit boundaries", () => {
    expect(formatByteCount(0)).toBe("0 B");
    expect(formatByteCount(1024)).toBe("1 KB");
    expect(formatByteCount(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });

  it("uses filesystem terminology for managed-folder statistics", () => {
    const folderProject = {
      ...project,
      originKind: "managed-folder" as const,
      capabilities: {
        git: false,
        github: false,
        worktrees: false,
        replicas: false,
        relocation: false,
      },
      github: null,
      source: {
        ...project.source,
        sourceKind: "folder" as const,
        path: "/worker/folders/project-1",
        displayPath: "folders/project-1",
      },
    } satisfies ProjectSummary;
    const folderStats = {
      kind: "folder" as const,
      fileCount: 7,
      byteCount: 2_048,
      textFileCount: 5,
      lineCount: 123,
      excludedFileCount: 2,
      truncated: false,
    } satisfies ProjectRepositoryStats;
    const folderRoot = {
      ...worktree,
      id: "folder-root-1",
      rootKind: "folder-root" as const,
      name: "Folder root",
      path: folderProject.source.path,
      displayPath: folderProject.source.displayPath,
      branch: null,
      head: null,
    } satisfies ProjectWorktreeSummary;
    const markup = renderToStaticMarkup(
      <ProjectOverview
        creatingKinds={new Set()}
        project={folderProject}
        stats={folderStats}
        statsLoading={false}
        usageLoading={false}
        surfaces={[]}
        workerOnline
        worktrees={[folderRoot]}
        onCreateSurface={vi.fn()}
        onOpenSurface={vi.fn()}
      />,
    );

    expect(markup).toContain("Lines of text");
    expect(markup).toContain("Folder size");
    expect(markup).toContain("2 KB");
    expect(markup).toContain("Files in this folder");
    expect(markup).toContain("folders/project-1");
    expect(markup).toContain("Folder");
    expect(markup).not.toContain("worktree");
    expect(markup).not.toContain("Detached");
    expect(markup).not.toContain("Primary");
    expect(markup).not.toContain("Reachable repository history");
  });

  it("uses repository terminology for imported local Git projects", () => {
    const localGitProject = {
      ...project,
      originKind: "managed-folder" as const,
      folderManagement: "external" as const,
      capabilities: {
        git: true,
        github: false,
        worktrees: false,
        replicas: false,
        relocation: false,
      },
      github: null,
      source: {
        ...project.source,
        placementMode: "direct" as const,
        ownershipKind: "user" as const,
      },
    } satisfies ProjectSummary;
    const markup = renderToStaticMarkup(
      <ProjectOverview
        creatingKinds={new Set()}
        project={localGitProject}
        stats={stats}
        statsLoading={false}
        usageLoading={false}
        surfaces={[]}
        workerOnline
        worktrees={[worktree]}
        onCreateSurface={vi.fn()}
        onOpenSurface={vi.fn()}
      />,
    );

    expect(markup).toContain("Lines of code");
    expect(markup).toContain("Repository size");
    expect(markup).toContain("Reachable repository history");
    expect(markup).toContain("1 worktree");
    expect(markup).toContain("Primary");
    expect(markup).not.toContain("Lines of text");
  });

  it("renders a useful empty state before the first project tab exists", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverview
        creatingKinds={new Set()}
        project={project}
        statsLoading
        usageLoading
        surfaces={[]}
        workerOnline={false}
        worktrees={[worktree]}
        onCreateSurface={vi.fn()}
        onOpenSurface={vi.fn()}
      />,
    );

    expect(markup).toContain("No project tabs yet");
    expect(markup).toContain("Worker offline");
  });

  it("leaves compact surface navigation to the mobile bottom bar", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverview
        compact
        creatingKinds={new Set()}
        project={project}
        stats={stats}
        statsLoading={false}
        usageLoading={false}
        surfaces={[chatSurface("running")]}
        workerOnline
        worktrees={[worktree]}
        onCreateSurface={vi.fn()}
        onOpenSurface={vi.fn()}
      />,
    );

    expect(markup).not.toContain(
      'data-elite-global="project-overview:project-1:open-tabs"',
    );
    expect(markup).not.toContain("Active services");
    expect(markup).not.toContain("Ship project overview");
  });

  it("surfaces approval and failure states without marking them as running", () => {
    expect(
      projectSurfaceRuntimeState(chatSurface("waiting-for-approval")),
    ).toEqual({
      label: "Needs approval",
      running: false,
      tone: "warning",
    });
    expect(projectSurfaceRuntimeState(chatSurface("failed"))).toEqual({
      label: "Failed",
      running: false,
      tone: "destructive",
    });
  });
});
