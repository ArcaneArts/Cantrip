import type {
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { createElement, StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  sidebarExplorerProvisioningDetails,
  sidebarFilePinCompletion,
  useSidebarExplorerModel,
} from "./sidebar-explorer-controller";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "project-1",
  setupStatus: "ready",
  source: { path: "/project", workerId: "worker-project" },
  capabilities: { worktrees: true },
} as ProjectSummary;

function explorer(workerId: string | null = "worker-explorer") {
  return { activeWorkerId: workerId } as ExplorerSummary;
}

describe("sidebar Explorer provisioning", () => {
  it("requires a desired worktree when the project supports worktrees", () => {
    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: null,
        sidebarExplorer: null,
        sidebarInlineExplorer: null,
      }).sidebarExplorerCreationInput,
    ).toBeNull();

    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: null,
        sidebarInlineExplorer: null,
      }),
    ).toMatchObject({
      sidebarExplorerCreationInput: {
        projectId: "project-1",
        worktreeId: "worktree-1",
      },
      sidebarExplorerCreationKey: "project-1:worktree-1",
      sidebarHasDesiredExplorer: false,
    });
  });

  it("prefers the Explorer worker and reports its live availability", () => {
    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(["worker-explorer"]),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: explorer(),
        sidebarInlineExplorer: explorer(),
      }),
    ).toMatchObject({
      sidebarFileWorkerId: "worker-explorer",
      sidebarFileWorkerOnline: true,
      sidebarHasDesiredExplorer: true,
    });
  });

  it("does not provision a speculative spare while one sidebar Explorer owns preview navigation", () => {
    const previewExplorer = explorer();
    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(["worker-explorer"]),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: previewExplorer,
        sidebarInlineExplorer: previewExplorer,
      }),
    ).toMatchObject({
      sidebarExplorerCreationKey: "project-1:worktree-1",
      sidebarHasDesiredExplorer: true,
    });
  });
});

describe("sidebar file pin completion", () => {
  const source = {
    id: "explorer-source",
    projectId: "project-1",
  } as ExplorerSummary;
  const destination = {
    id: "explorer-pinned",
    projectId: "project-1",
  } as ExplorerSummary;
  const handoff = {
    destinationExplorer: destination,
    destinationExplorerId: destination.id,
    ready: true,
    sourceExplorer: source,
    sourcePath: "scripts/setup.ps1",
    transactionId: "pin-1",
  };

  it("activates a completed dock even if its transient preview rerendered inactive", () => {
    expect(
      sidebarFilePinCompletion(
        handoff,
        {
          active: false,
          explorerId: source.id,
          groupId: "group-1",
          path: handoff.sourcePath,
          projectId: source.projectId,
        },
        source.projectId,
      ),
    ).toEqual({ action: "activate", clearPreview: true, destination });
  });

  it("refreshes without stealing focus after the user changes projects", () => {
    expect(sidebarFilePinCompletion(handoff, null, "project-2")).toEqual({
      action: "refresh",
      destination,
    });
  });
});

describe("sidebar preview ownership handoff", () => {
  it("keeps the promoted preview surface addressable without returning it to the file tree under Strict Mode", async () => {
    const pinned = {
      id: "explorer-pinned",
      projectId: "project-1",
      selectedPath: "src/first.ts",
      worktreeId: "worktree-1",
    } as ExplorerSummary;
    const replacement = {
      id: "explorer-replacement",
      projectId: "project-1",
      selectedPath: null,
      worktreeId: "worktree-1",
    } as ExplorerSummary;
    const tabLayout = {
      groups: [
        {
          id: "group-1",
          members: [{ tabId: pinned.id, tabKind: "explorer" }],
        },
      ],
    } as ProjectTabLayoutSummary;
    const worktrees = [
      { id: "worktree-1", isPrimary: true },
    ] as ProjectWorktreeSummary[];
    const preview = {
      active: true,
      explorerId: pinned.id,
      groupId: "group-1",
      path: "src/first.ts",
      projectId: "project-1",
    };
    const observed: {
      current: ReturnType<typeof useSidebarExplorerModel> | null;
    } = { current: null };
    const Probe = ({ explorers }: { explorers: ExplorerSummary[] }) => {
      observed.current = useSidebarExplorerModel({
        detachedGroupId: null,
        environment: {
          explorerFileTarget: null,
          popoutTarget: null,
          projectOverviewPopoutTarget: null,
        },
        explorers,
        fileState: {
          sidebarFilePinHandoff: null,
          sidebarFilePreview: preview,
        },
        openCreatedTab: vi.fn(),
        selectedProjectId: "project-1",
        selectedSurface: undefined,
        tabLayout,
        worktrees,
      });
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          StrictMode,
          null,
          createElement(Probe, { explorers: [pinned] }),
        ),
      );
    });
    expect(observed.current?.sidebarPreviewExplorer).toBe(pinned);
    expect(observed.current?.sidebarExplorer).toBeNull();

    await act(async () => {
      renderer.update(
        createElement(
          StrictMode,
          null,
          createElement(Probe, { explorers: [pinned, replacement] }),
        ),
      );
    });
    expect(observed.current?.sidebarPreviewExplorer).toBe(pinned);
    expect(observed.current?.sidebarExplorer).toBe(replacement);
    await act(async () => renderer.unmount());
  });
});
