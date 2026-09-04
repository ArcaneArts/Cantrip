import type {
  ExplorerEntry,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { SidebarFilePinHandoffState } from "./application-shell-model";
import { createSidebarExplorerCommands } from "./sidebar-explorer-commands";

const revealProjectInNativeFileManager = vi.hoisted(() => vi.fn());

vi.mock("@/lib/desktop-project-share", () => ({
  revealProjectInNativeFileManager,
}));

const entry = {
  kind: "file",
  name: "next.ts",
  path: "src/next.ts",
  viewable: true,
} as ExplorerEntry;

const previewOwner = {
  id: "explorer-preview",
  projectId: "project-1",
  selectedPath: "src/first.ts",
  worktreeId: "worktree-1",
} as ExplorerSummary;

function commandHarness({
  handoff = null,
  layout,
  projects = [],
  waitForSuccessor = vi.fn().mockResolvedValue({
    ...previewOwner,
    id: "explorer-successor",
  }),
  worktrees = [],
}: {
  handoff?: SidebarFilePinHandoffState | null;
  layout: ProjectTabLayoutSummary;
  projects?: ProjectSummary[];
  waitForSuccessor?: (
    sourceExplorerId: string,
  ) => Promise<ExplorerSummary | null>;
  worktrees?: ProjectWorktreeSummary[];
}) {
  const setSidebarFilePreview = vi.fn();
  const pinMutation = { isPending: false, mutate: vi.fn(), reset: vi.fn() };
  const revealWorkspace = vi.fn();
  const input = {
    abandonSidebarFilePinHandoff: vi.fn(),
    createSidebarExplorerMutation: {
      isPending: false,
      mutate: vi.fn(),
      reset: vi.fn(),
    },
    explorers: [previewOwner],
    fileState: {
      setSidebarFilePinHandoff: vi.fn(),
      setSidebarFilePreview,
      sidebarFilePinHandoffRef: { current: handoff },
      sidebarFilePreview: {
        active: true,
        explorerId: previewOwner.id,
        paneId: "group-1",
        path: "src/first.ts",
        projectId: previewOwner.projectId,
      },
      waitForSidebarFileSuccessor: waitForSuccessor,
    },
    lifecycle: {
      explorerLifecycleRef: { current: new Map() },
      sidebarExplorerCreationKeyRef: { current: null },
      sidebarFilePreviewLifecycleRef: { current: null },
    },
    newGraphExplorer: { isPending: false, mutate: vi.fn(), reset: vi.fn() },
    newTerminal: { isPending: false, mutate: vi.fn(), reset: vi.fn() },
    openCreatedTab: vi.fn(),
    pinSidebarFileMutation: pinMutation,
    projects,
    queryClient: {
      invalidateQueries: vi.fn(),
      setQueryData: vi.fn(),
    },
    revealWorkspace,
    selectedPane: layout.panes[0],
    setDesktopSidebarDrawerOpen: vi.fn(),
    setPopoutError: vi.fn(),
    setWorkspaceSelection: vi.fn(),
    sidebarExplorerCreationInput: null,
    sidebarExplorerCreationKey: null,
    tabLayout: layout,
    worktrees,
  } as unknown as Parameters<typeof createSidebarExplorerCommands>[0];
  return {
    commands: createSidebarExplorerCommands(input),
    pinMutation,
    revealWorkspace,
    setSidebarFilePreview,
  };
}

function layout(tabbedExplorerIds: string[]): ProjectTabLayoutSummary {
  return {
    panes: [
      {
        id: "group-1",
        members: tabbedExplorerIds.map((tabId) => ({
          tabId,
          tabKind: "explorer",
        })),
      },
    ],
  } as unknown as ProjectTabLayoutSummary;
}

describe("sidebar Explorer ownership commands", () => {
  it("reveals a folder from the Explorer's active worktree", () => {
    revealProjectInNativeFileManager.mockResolvedValue(undefined);
    const project = {
      id: previewOwner.projectId,
      source: { workerId: "worker-1" },
    } as ProjectSummary;
    const worktree = {
      id: previewOwner.worktreeId,
      projectId: previewOwner.projectId,
    } as ProjectWorktreeSummary;
    const { commands } = commandHarness({
      layout: layout([]),
      projects: [project],
      worktrees: [worktree],
    });
    const folder = {
      kind: "directory",
      name: "src",
      path: "src",
      viewable: false,
    } as ExplorerEntry;

    commands.openSidebarFolderNative(previewOwner, folder, false);

    expect(revealProjectInNativeFileManager).toHaveBeenCalledWith(
      project,
      false,
      "src",
      worktree,
    );

    commands.openSidebarRootNative(previewOwner, true);
    expect(revealProjectInNativeFileManager).toHaveBeenLastCalledWith(
      project,
      true,
      "",
      worktree,
    );
  });

  it("does not send an immediate second preview click into the owner being pinned", () => {
    const handoff = {
      destinationExplorer: null,
      destinationExplorerId: previewOwner.id,
      ready: false,
      sourceExplorer: previewOwner,
      sourcePath: "src/first.ts",
      transactionId: "pin-1",
    } satisfies SidebarFilePinHandoffState;
    const harness = commandHarness({ handoff, layout: layout([]) });

    harness.commands.openSidebarFilePreview(previewOwner, entry);

    expect(harness.setSidebarFilePreview).not.toHaveBeenCalled();
    expect(harness.revealWorkspace).not.toHaveBeenCalled();
  });

  it("never mutates an unrelated pinned Explorer as a preview destination", () => {
    const harness = commandHarness({
      layout: layout([previewOwner.id]),
    });

    harness.commands.openSidebarFilePreview(previewOwner, entry);
    harness.commands.pinSidebarFile(previewOwner, entry);

    expect(harness.setSidebarFilePreview).not.toHaveBeenCalled();
    expect(harness.pinMutation.mutate).not.toHaveBeenCalled();
  });

  it("does not pin the active preview until its warm successor is ready", async () => {
    let resolveSuccessor!: (explorer: ExplorerSummary) => void;
    const waitForSuccessor = vi.fn(
      () =>
        new Promise<ExplorerSummary>((resolve) => {
          resolveSuccessor = resolve;
        }),
    );
    const harness = commandHarness({
      layout: layout([]),
      waitForSuccessor,
    });

    const pinning = harness.commands.pinSidebarFilePath(
      previewOwner,
      entry.path,
    );
    await Promise.resolve();
    expect(waitForSuccessor).toHaveBeenCalledWith(previewOwner.id);
    expect(harness.pinMutation.mutate).not.toHaveBeenCalled();

    resolveSuccessor({
      ...previewOwner,
      id: "explorer-successor",
    });
    await pinning;
    expect(harness.pinMutation.mutate).toHaveBeenCalledTimes(1);
  });
});
