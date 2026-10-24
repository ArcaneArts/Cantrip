import type {
  ChatSummary,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { createElement, StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  createProjectExplorerFileOpening,
  sidebarExplorerProvisioningDetails,
  sidebarFilePinCompletion,
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
          paneId: "group-1",
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
    const preview = {
      active: true,
      explorerId: pinned.id,
      paneId: "group-1",
      path: "src/first.ts",
      projectId: "project-1",
    };
    const observed: {
      current: ReturnType<typeof useSidebarExplorerModel> | null;
    } = { current: null };
    const Probe = ({ explorers }: { explorers: ExplorerSummary[] }) => {
      observed.current = useSidebarExplorerModel({
        unavailablePaneIds: new Set(),
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
