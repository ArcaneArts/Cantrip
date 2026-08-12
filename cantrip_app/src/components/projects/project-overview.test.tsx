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
const worktree = {
  id: "worktree-1",
  projectSourceId: "source-1",
  projectId: project.id,
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
  commitCount: 321,
  trackedFileCount: 2_345,
  trackedByteCount: 3.5 * 1024 ** 3,
  textFileCount: 2_300,
  lineCount: 12_345,
  excludedFileCount: 45,
  truncated: true,
} satisfies ProjectRepositoryStats;
const usage = {
  total: { inputTokens: 8_000, outputTokens: 2_500, totalTokens: 10_500 },
  daily: [
    {
      date: "2026-08-11",
      inputTokens: 8_000,
      outputTokens: 2_500,
      totalTokens: 10_500,
    },
  ],
  providers: [
    {
      id: "provider-1",
      name: "ChatGPT",
      inputTokens: 8_000,
      outputTokens: 2_500,
      totalTokens: 10_500,
    },
  ],
  models: [
    {
      id: "model-1",
      name: "GPT 5.6 Sol",
      inputTokens: 8_000,
      outputTokens: 2_500,
      totalTokens: 10_500,
    },
  ],
  range: { start: "2025-08-12", end: "2026-08-11" },
} satisfies ProjectTokenUsage;

function chatSurface(status: ChatSummary["status"]): ProjectSurface {
  const chat = {
    id: "chat-1",
    projectId: project.id,
    title: "Ship project overview",
    position: 0,
    status,
    activeWorkerId: "worker-1",
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
  return {
    entity: chat,
    groupId: "group-1",
    kind: "chat",
    member: {
      tabKey: `chat:${chat.id}`,
      groupId: "group-1",
      projectId: project.id,
      tabKind: "chat",
      tabId: chat.id,
      title: chat.title,
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
    projectId: project.id,
    tabId: chat.id,
    tabKey: `chat:${chat.id}`,
    title: chat.title,
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
      />,
    );

    expect(markup).toContain("ArcaneArts/Cantrip");
    expect(markup).toContain("12,345");
    expect(markup).toContain("321");
    expect(markup).toContain("3.5 GB");
    expect(markup).toContain("10.5K");
    expect(markup).toContain("Input and output tokens");
    expect(markup).toContain("Ship project overview");
    expect(markup).toContain('aria-label="Open Ship project overview"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("Running");
    expect(markup).toContain("Worker online");
    expect(markup).not.toContain("bounded line scan");
  });

  it("formats tracked repository sizes at stable unit boundaries", () => {
    expect(formatByteCount(0)).toBe("0 B");
    expect(formatByteCount(1024)).toBe("1 KB");
    expect(formatByteCount(1.5 * 1024 ** 3)).toBe("1.5 GB");
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

  it("replaces the full surface inventory with a compact tabs action", () => {
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
        onOpenTabs={vi.fn()}
      />,
    );

    expect(markup).toContain("Open tabs");
    expect(markup).toContain("1 open · 1 running");
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
