import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  projectReplicaSummarySchema,
  projectWorktreeSummarySchema,
  unprobedCodexRuntimeReport,
  workerSummarySchema,
} from "@cantrip/protocol";

import {
  ProjectSurfaceCreateMenu,
  projectSurfaceCreateDefinitions,
  projectSurfaceCreateOptions,
  projectSurfaceWorkerPlacements,
  surfaceSupportsExplicitPlacement,
} from "./project-surface-create-menu";
import { ProjectSurfaceIcon } from "./project-surface-icon";

const now = "2026-08-11T12:00:00.000Z";

function worker(
  workerId: string,
  options: {
    browser?: boolean;
    code?: boolean;
    desktop?: boolean;
    online?: boolean;
  } = {},
) {
  return workerSummarySchema.parse({
    workerId,
    name: workerId === "worker-a" ? "Alpha" : "Beta",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    code: {
      available: options.code ?? true,
      version: options.code === false ? null : "1.109.5",
      upstreamRevision:
        options.code === false
          ? null
          : "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
      patchset: options.code === false ? 0 : 1,
      transport: "web-proxy",
      maxSessions: 4,
      reason: options.code === false ? "Not installed" : null,
    },
    remoteSurfaces: {
      browser: options.browser ?? true,
      desktop: options.desktop ?? true,
      transports: ["websocket"],
      maxSessions: 4,
    },
    startedAt: now,
    lastSeenAt: now,
    online: options.online ?? true,
  });
}

function replica(workerId: string) {
  return projectReplicaSummarySchema.parse({
    id: `replica-${workerId}`,
    projectId: "project-one",
    workerId,
    workerName: workerId,
    workerOnline: true,
    path: `/repos/${workerId}`,
    displayPath: workerId,
    repositoryFingerprint: null,
    primaryWorktreeId: `primary-${workerId}`,
    branch: "main",
    head: "abc123",
    dirty: false,
    ready: true,
    worktreeCount: 2,
    lastObservedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

function worktree(
  workerId: string,
  name: string,
  options: { isDefault?: boolean; isPrimary?: boolean } = {},
) {
  return projectWorktreeSummarySchema.parse({
    id: `${name.toLowerCase()}-${workerId}`,
    projectSourceId: `replica-${workerId}`,
    projectId: "project-one",
    workerId,
    name,
    path: `/repos/${workerId}/${name}`,
    displayPath: `${workerId}/${name}`,
    isPrimary: options.isPrimary ?? false,
    isDefault: options.isDefault ?? false,
    origin: "cantrip",
    lifecycleState: "ready",
    branch: "main",
    head: "abc123",
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

describe("project surface creation menu", () => {
  it("uses the dedicated agent icon for chat-backed surfaces", () => {
    const markup = renderToStaticMarkup(<ProjectSurfaceIcon kind="chat" />);

    expect(markup).toContain("lucide-bot");
    expect(markup).not.toContain("lucide-message-square");
  });

  it("defines every project surface once in display order", () => {
    expect(projectSurfaceCreateDefinitions).toEqual([
      { kind: "chat", label: "Agent" },
      { kind: "task", label: "Task" },
      { kind: "terminal", label: "Terminal" },
      { kind: "explorer", label: "Explorer" },
      { kind: "code", label: "Code" },
      { kind: "browser", label: "Browser" },
      { kind: "history", label: "Git" },
      { kind: "remote-desktop", label: "Remote Desktop" },
    ]);
  });

  it("uses the checklist icon for Task creation", () => {
    const markup = renderToStaticMarkup(<ProjectSurfaceIcon kind="task" />);

    expect(markup).toContain("lucide-list-todo");
  });

  it("marks only actively creating surface kinds as disabled", () => {
    const options = projectSurfaceCreateOptions(
      new Set(["terminal", "history"]),
    );

    expect(
      options.filter(({ disabled }) => disabled).map(({ kind }) => kind),
    ).toEqual(["terminal", "history"]);
    expect(options.find(({ kind }) => kind === "chat")?.disabled).toBe(false);
  });

  it("leaves every option enabled at the empty-set boundary", () => {
    expect(
      projectSurfaceCreateOptions().every(({ disabled }) => !disabled),
    ).toBe(true);
  });

  it("derives compatible worker, replica, and worktree placement choices", () => {
    const placements = projectSurfaceWorkerPlacements("terminal", {
      projectId: "project-one",
      replicas: [replica("worker-a"), replica("worker-b")],
      workers: [worker("worker-b", { online: false }), worker("worker-a")],
      worktrees: [
        worktree("worker-a", "Feature"),
        worktree("worker-a", "Primary", {
          isDefault: true,
          isPrimary: true,
        }),
      ],
    });

    expect(placements.map(({ worker }) => worker.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(placements[0]).toMatchObject({
      disabled: false,
      reason: null,
      replica: { id: "replica-worker-a" },
    });
    expect(placements[0]?.worktrees.map(({ name }) => name)).toEqual([
      "Primary",
      "Feature",
    ]);
    expect(placements[1]).toMatchObject({
      disabled: true,
      reason: "Offline",
    });
  });

  it("checks surface capabilities without requiring replicas for machine surfaces", () => {
    const context = {
      projectId: "project-one",
      replicas: [],
      workers: [worker("worker-a", { code: false })],
      worktrees: [],
    };
    expect(projectSurfaceWorkerPlacements("code", context)[0]).toMatchObject({
      disabled: true,
      reason: "Code unavailable",
    });
    expect(projectSurfaceWorkerPlacements("browser", context)[0]).toMatchObject(
      { disabled: false, reason: null },
    );
    expect(surfaceSupportsExplicitPlacement("history")).toBe(false);
    expect(surfaceSupportsExplicitPlacement("remote-desktop")).toBe(true);
  });

  it("preserves the caller-provided trigger", () => {
    const markup = renderToStaticMarkup(
      <ProjectSurfaceCreateMenu
        onCreate={vi.fn()}
        trigger={<button aria-label="Add project surface" />}
      />,
    );

    expect(markup).toContain('aria-label="Add project surface"');
    expect(markup).toContain('data-state="closed"');
  });
});
