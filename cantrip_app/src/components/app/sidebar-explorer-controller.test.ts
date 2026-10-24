import type {
  ChatSummary,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import type { ProjectSurface } from "@/lib/project-surface";
import { createElement, StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  createProjectExplorerFileOpening,
  sidebarExplorerProvisioningDetails,
  useExplorerLifecycleRefs,
  useExplorerLifecycleRegistration,
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

describe("owned file lifecycle registration", () => {
  it("reports dirty files without saving or closing and unregisters cleanly", async () => {
    const onDirtyFile = vi.fn();
    const queryClient = new QueryClient();
    let lifecycle!: ReturnType<typeof useExplorerLifecycleRefs>;
    let registration!: ReturnType<typeof useExplorerLifecycleRegistration>;
    function Harness() {
      lifecycle = useExplorerLifecycleRefs();
      registration = useExplorerLifecycleRegistration({
        lifecycle,
        queryClient,
        onDirtyFile,
      });
      return null;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness));
    });
    const actions = {
      dirty: false,
      cancelClose: vi.fn(),
      flushViewState: vi.fn(async () => true),
      prepareClose: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      save: vi.fn(async () => true),
    };
    registration.handleExplorerLifecycleChange("file", actions);
    expect(onDirtyFile).not.toHaveBeenCalled();
    const dirty = { ...actions, dirty: true };
    registration.handleExplorerLifecycleChange("file", dirty);
    expect(lifecycle.explorerLifecycleRef.current.get("file")).toBe(dirty);
    expect(onDirtyFile).toHaveBeenCalledExactlyOnceWith("file");
    registration.handleExplorerLifecycleChange("file", null);
    expect(lifecycle.explorerLifecycleRef.current.has("file")).toBe(false);
    expect(onDirtyFile).toHaveBeenCalledTimes(1);
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.prepareClose).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});

describe("project file opening", () => {
  it("opens chat links under the resolved checkout ID through workspace ownership", async () => {
    const openOwnedFile = vi.fn(async () => {});
    const setPopoutError = vi.fn();
    const showAppToast = vi.fn();
    const queryClient = new QueryClient();
    const worktrees = [
      {
        id: "primary",
        projectId: project.id,
        path: "/project",
        displayPath: "/project",
        isPrimary: true,
      },
      {
        id: "task",
        projectId: project.id,
        path: "/managed/task",
        displayPath: "/managed/task",
        isPrimary: false,
      },
    ] as ProjectWorktreeSummary[];
    // A task checkout may have been registered since this shell last rendered.
    queryClient.setQueryData(["worktrees", project.id], worktrees);
    const { openChatFileLink } = createProjectExplorerFileOpening({
      openOwnedFile,
      queryClient,
      selectedProject: project,
      setPopoutError,
      showAppToast,
      worktrees: [],
    });
    const chat = {
      projectId: project.id,
      activeWorktreeId: "primary",
    } as ChatSummary;

    openChatFileLink(chat, "/managed/task/docs/BASELINE.md:14");
    await Promise.resolve();
    expect(openOwnedFile).toHaveBeenLastCalledWith(
      project.id,
      "task",
      "docs/BASELINE.md",
    );

    openChatFileLink(chat, "src/app.ts", "task");
    await Promise.resolve();
    expect(openOwnedFile).toHaveBeenLastCalledWith(
      project.id,
      "task",
      "src/app.ts",
    );
    expect(setPopoutError).not.toHaveBeenCalled();
    expect(showAppToast).not.toHaveBeenCalled();
    expect(chat.activeWorktreeId).toBe("primary");
    queryClient.clear();
  });

  it.each([false, true])(
    "uses only the owned opener and reports failure (failure=%s)",
    async (failure) => {
      const openOwnedFile = vi.fn(async () => {
        if (failure) throw new Error("workspace offline");
      });
      const setPopoutError = vi.fn();
      const queryClient = {
        invalidateQueries: vi.fn(),
        setQueryData: vi.fn(),
      };
      const { openProjectExplorerFile } = createProjectExplorerFileOpening({
        openOwnedFile,
        queryClient: queryClient as never,
        selectedProject: undefined,
        setPopoutError,
        showAppToast: vi.fn(),
        worktrees: [],
      });

      openProjectExplorerFile("project-1", "worktree-1", "src/app.ts");
      await Promise.resolve();

      expect(openOwnedFile).toHaveBeenCalledExactlyOnceWith(
        "project-1",
        "worktree-1",
        "src/app.ts",
      );
      expect(queryClient.setQueryData).not.toHaveBeenCalled();
      if (failure)
        expect(setPopoutError).toHaveBeenCalledWith("workspace offline");
      else expect(setPopoutError).not.toHaveBeenCalled();
    },
  );
});

function explorer(workerId: string | null = "worker-explorer") {
  return {
    activeWorkerId: workerId,
    worktreeId: "worktree-1",
  } as ExplorerSummary;
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
      }).sidebarExplorerCreationInput,
    ).toBeNull();

    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: null,
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
      }),
    ).toMatchObject({
      sidebarFileWorkerId: "worker-explorer",
      sidebarFileWorkerOnline: true,
      sidebarHasDesiredExplorer: true,
    });
  });

  it("needs only one sidebar tree and does not provision a warm successor", () => {
    const previewExplorer = explorer();
    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(["worker-explorer"]),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: { ...previewExplorer, worktreeId: "another-worktree" },
      }),
    ).toMatchObject({
      sidebarExplorerCreationKey: "project-1:worktree-1",
      sidebarHasDesiredExplorer: false,
    });

    expect(
      sidebarExplorerProvisioningDetails({
        onlineWorkerIds: new Set(["worker-explorer"]),
        selectedProject: project,
        selectedProjectWorkerId: "worker-project",
        sidebarDesiredWorktreeId: "worktree-1",
        sidebarExplorer: previewExplorer,
      }),
    ).toMatchObject({
      sidebarExplorerCreationKey: "project-1:worktree-1",
      sidebarHasDesiredExplorer: true,
    });
  });
});

describe("sidebar tree ownership", () => {
  it("never repurposes a tabbed Explorer as the sidebar tree under Strict Mode", async () => {
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
      panes: [
        {
          id: "group-1",
          members: [{ tabId: pinned.id, tabKind: "explorer" }],
        },
      ],
    } as unknown as ProjectTabLayoutSummary;
    const worktrees = [
      { id: "worktree-1", isPrimary: true },
    ] as ProjectWorktreeSummary[];
    const observed: {
      current: ReturnType<typeof useSidebarExplorerModel> | null;
    } = { current: null };
    const Probe = ({
      explorers,
      selectedSurface,
    }: {
      explorers: ExplorerSummary[];
      selectedSurface?: ProjectSurface;
    }) => {
      observed.current = useSidebarExplorerModel({
        unavailablePaneIds: new Set(),
        environment: {
          explorerFileTarget: null,
          popoutTarget: null,
          projectOverviewPopoutTarget: null,
        },
        explorers,
        openCreatedTab: vi.fn(),
        selectedProjectId: "project-1",
        selectedSurface,
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
    expect(observed.current?.sidebarExplorer).toBe(replacement);
    const featureTree = {
      ...replacement,
      id: "feature-tree",
      worktreeId: "feature",
    };
    await act(async () => {
      renderer.update(
        createElement(
          StrictMode,
          null,
          createElement(Probe, {
            explorers: [pinned, replacement, featureTree],
            selectedSurface: {
              kind: "file",
              entity: { worktreeId: "feature" },
            } as ProjectSurface,
          }),
        ),
      );
    });
    expect(observed.current?.sidebarDesiredWorktreeId).toBe("feature");
    expect(observed.current?.sidebarExplorer).toBe(featureTree);
    expect(observed.current?.openExplorers).toEqual([pinned]);
    await act(async () => renderer.unmount());
  });
});
