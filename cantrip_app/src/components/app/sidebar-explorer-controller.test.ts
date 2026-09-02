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
  resolveChatFileReferencePath,
  sidebarExplorerProvisioningDetails,
  sidebarFilePinCompletion,
  useSidebarExplorerModel,
  useSidebarFileState,
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

describe("chat file reference resolution", () => {
  it("refreshes a protected or stale worktree path before rejecting an absolute link", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValue(
        "/Users/test/Library/Application Support/art.cantrip/repositories/project",
      );

    await expect(
      resolveChatFileReferencePath({
        reference:
          "/Users/test/Library/Application Support/art.cantrip/repositories/project/README.md",
        sourcePath: "Protected path unavailable",
        worktreePath: "Protected path unavailable",
        refreshWorktreePath: refresh,
      }),
    ).resolves.toEqual({
      path: "README.md",
      refreshedWorktreePath:
        "/Users/test/Library/Application Support/art.cantrip/repositories/project",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("opens safe relative references without private path hydration", async () => {
    const refresh = vi.fn();

    await expect(
      resolveChatFileReferencePath({
        reference: "docs/README.md:14",
        sourcePath: null,
        worktreePath: "Protected path unavailable",
        refreshWorktreePath: refresh,
      }),
    ).resolves.toEqual({
      path: "docs/README.md",
      refreshedWorktreePath: null,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

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
        sidebarInlineExplorers: [],
      }).sidebarExplorerCreationInput,
    ).toBeNull();

    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: null,
        sidebarInlineExplorers: [],
      }),
    ).toMatchObject({
      sidebarExplorerCreationInput: {
        projectId: "project-1",
        worktreeId: "worktree-1",
      },
      sidebarExplorerCreationKey: "project-1:worktree-1:0",
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
        sidebarInlineExplorers: [explorer(), explorer()],
      }),
    ).toMatchObject({
      sidebarFileWorkerId: "worker-explorer",
      sidebarFileWorkerOnline: true,
      sidebarHasDesiredExplorer: true,
    });
  });

  it("provisions one bounded warm successor while a sidebar Explorer owns preview navigation", () => {
    const previewExplorer = explorer();
    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(["worker-explorer"]),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: previewExplorer,
        sidebarInlineExplorers: [previewExplorer],
      }),
    ).toMatchObject({
      sidebarExplorerCreationKey: "project-1:worktree-1:1",
      sidebarExplorerPoolSize: 1,
      sidebarHasDesiredExplorer: false,
    });

    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(["worker-explorer"]),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: previewExplorer,
        sidebarInlineExplorers: [previewExplorer, explorer()],
      }),
    ).toMatchObject({
      sidebarExplorerCreationKey: "project-1:worktree-1:2",
      sidebarExplorerPoolSize: 2,
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

describe("sidebar preview successor provisioning", () => {
  it("waits event-driven for the already-provisioned successor", async () => {
    const source = {
      id: "explorer-source",
      projectId: "project-1",
      worktreeId: "worktree-1",
    } as ExplorerSummary;
    const successor = {
      ...source,
      id: "explorer-successor",
    } as ExplorerSummary;
    const observed: {
      current: ReturnType<typeof useSidebarFileState> | null;
    } = { current: null };
    const Probe = () => {
      observed.current = useSidebarFileState();
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(StrictMode, null, createElement(Probe)),
      );
    });
    act(() => {
      observed.current?.updateSidebarExplorerPool([source]);
    });

    let settled = false;
    const waiting = observed
      .current!.waitForSidebarFileSuccessor(source.id)
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    act(() => {
      observed.current?.updateSidebarExplorerPool([source, successor]);
    });
    await expect(waiting).resolves.toBe(successor);
    await act(async () => renderer.unmount());
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
