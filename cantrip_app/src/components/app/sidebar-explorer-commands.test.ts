import type {
  ExplorerEntry,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";

import { createSidebarExplorerCommands } from "./sidebar-explorer-commands";

afterEach(() => vi.restoreAllMocks());

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
  activeWorkerId: "worker-1",
  selectedPath: "src/first.ts",
  worktreeId: "worktree-1",
} as ExplorerSummary;

function commandHarness({
  openOwnedFile = vi.fn(async () => {}),
  layout,
  projects = [],
  selectedPane = layout.panes[0],
  waitForSuccessor = vi.fn().mockResolvedValue({
    ...previewOwner,
    id: "explorer-successor",
  }),
  worktrees = [],
}: {
  openOwnedFile?: Parameters<
    typeof createSidebarExplorerCommands
  >[0]["openOwnedFile"];
  layout: ProjectTabLayoutSummary;
  projects?: ProjectSummary[];
  selectedPane?: ProjectTabLayoutSummary["panes"][number];
  waitForSuccessor?: (
    sourceExplorerId: string,
  ) => Promise<ExplorerSummary | null>;
  worktrees?: ProjectWorktreeSummary[];
}) {
  const setSidebarFilePreview = vi.fn();
  const legacyPin = vi.spyOn(api, "pinExplorer");
  const revealWorkspace = vi.fn();
  const setWorkspaceSelection = vi.fn();
  const input = {
    openOwnedFile,
    createSidebarExplorerMutation: {
      isPending: false,
      mutate: vi.fn(),
      reset: vi.fn(),
    },
    explorers: [previewOwner],
    fileState: {
      setSidebarFilePreview,
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
    projects,
    queryClient: {
      invalidateQueries: vi.fn(),
      setQueryData: vi.fn(),
    },
    revealWorkspace,
    selectedPane,
    setDesktopSidebarDrawerOpen: vi.fn(),
    setPopoutError: vi.fn(),
    setWorkspaceSelection,
    sidebarExplorerCreationInput: null,
    sidebarExplorerCreationKey: null,
    tabLayout: layout,
    worktrees,
  } as unknown as Parameters<typeof createSidebarExplorerCommands>[0];
  return {
    commands: createSidebarExplorerCommands(input),
    legacyPin,
    revealWorkspace,
    setSidebarFilePreview,
    setWorkspaceSelection,
    queryClient: input.queryClient,
    setPopoutError: input.setPopoutError,
  };
}

it("routes sidebar preview and pin through owned file views without a successor handoff", async () => {
  const openOwnedFile = vi.fn(async () => {});
  const harness = commandHarness({ layout: layout([]), openOwnedFile });
  harness.commands.openSidebarFilePreviewPath(previewOwner, entry.path);
  await vi.waitFor(() =>
    expect(openOwnedFile).toHaveBeenCalledWith(previewOwner, entry.path, true),
  );
  await harness.commands.pinSidebarFilePath(previewOwner, entry.path);
  expect(openOwnedFile).toHaveBeenLastCalledWith(
    previewOwner,
    entry.path,
    false,
  );
  expect(harness.legacyPin).not.toHaveBeenCalled();
  expect(harness.setSidebarFilePreview).not.toHaveBeenCalled();
  expect(harness.setWorkspaceSelection).not.toHaveBeenCalled();
});

it("reports owned pin failure without falling back to legacy pinning", async () => {
  const harness = commandHarness({
    layout: layout([]),
    openOwnedFile: vi.fn().mockRejectedValue(new Error("offline")),
  });
  await harness.commands.pinSidebarFilePath(previewOwner, entry.path);
  expect(harness.setPopoutError).toHaveBeenCalledWith("offline");
  expect(harness.legacyPin).not.toHaveBeenCalled();
  expect(harness.revealWorkspace).not.toHaveBeenCalled();
});

function layout(tabbedExplorerIds: string[]): ProjectTabLayoutSummary {
  return {
    panes: [
      {
        id: "group-1",
        region: "center",
        members: tabbedExplorerIds.map((tabId) => ({
          tabId,
          tabKind: "explorer",
        })),
      },
    ],
  } as unknown as ProjectTabLayoutSummary;
}

describe("sidebar Explorer ownership commands", () => {
  it("creates a named file through the selected Explorer and refreshes its worktree entries", async () => {
    const create = vi.spyOn(api, "createExplorerFile").mockResolvedValue(entry);
    const { commands, queryClient } = commandHarness({ layout: layout([]) });
    const authorization = { bindingKey: "binding", isCurrent: () => true };
    await expect(
      commands.createSidebarFile(previewOwner, "src", "next.ts", authorization),
    ).resolves.toBe(entry);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      previewOwner.id,
      {
        path: "src",
        name: "next.ts",
      },
      {
        projectId: previewOwner.projectId,
        worktreeId: previewOwner.worktreeId,
        workerId: previewOwner.activeWorkerId,
      },
    );
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: [
        "explorer-directory",
        previewOwner.projectId,
        previewOwner.worktreeId,
      ],
    });
  });
  it("does not create a file after its authorization becomes stale", async () => {
    const create = vi.spyOn(api, "createExplorerFile");
    const { commands } = commandHarness({ layout: layout([]) });
    await expect(
      commands.createSidebarFile(previewOwner, "", "no.ts", {
        bindingKey: "old",
        isCurrent: () => false,
      }),
    ).rejects.toThrow("authorization changed");
    expect(create).not.toHaveBeenCalled();
  });
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

  it("opens another file without a legacy handoff", async () => {
    const openOwnedFile = vi.fn(async () => {});
    const harness = commandHarness({
      layout: layout([]),
      openOwnedFile,
    });
    harness.commands.openSidebarFilePreview(previewOwner, entry);
    await vi.waitFor(() => expect(harness.revealWorkspace).toHaveBeenCalled());
    expect(openOwnedFile).toHaveBeenCalledExactlyOnceWith(
      previewOwner,
      entry.path,
      true,
    );
    expect(harness.setSidebarFilePreview).not.toHaveBeenCalled();
  });

  it("opens and pins through ownership even when the Explorer already has a tab", async () => {
    const openOwnedFile = vi.fn(async () => {});
    const harness = commandHarness({
      layout: layout([previewOwner.id]),
      openOwnedFile,
    });
    harness.commands.openSidebarFilePreview(previewOwner, entry);
    await harness.commands.pinSidebarFilePath(previewOwner, entry.path);
    expect(openOwnedFile.mock.calls).toEqual([
      [previewOwner, entry.path, true],
      [previewOwner, entry.path, false],
    ]);
    expect(harness.setSidebarFilePreview).not.toHaveBeenCalled();
    expect(harness.legacyPin).not.toHaveBeenCalled();
  });

  it.each([
    { ...entry, kind: "directory", viewable: true },
    { ...entry, viewable: false },
  ])("ignores non-viewable or directory entries: %j", (invalid) => {
    const openOwnedFile = vi.fn(async () => {});
    const harness = commandHarness({ layout: layout([]), openOwnedFile });
    harness.commands.openSidebarFilePreview(
      previewOwner,
      invalid as ExplorerEntry,
    );
    harness.commands.pinSidebarFile(previewOwner, invalid as ExplorerEntry);
    expect(openOwnedFile).not.toHaveBeenCalled();
  });

  it("reports preview failure without writing legacy preview state", async () => {
    const harness = commandHarness({
      layout: layout([]),
      openOwnedFile: vi.fn().mockRejectedValue(new Error("offline")),
    });
    harness.commands.openSidebarFilePreview(previewOwner, entry);
    await vi.waitFor(() =>
      expect(harness.setPopoutError).toHaveBeenCalledWith("offline"),
    );
    expect(harness.setSidebarFilePreview).not.toHaveBeenCalled();
    expect(harness.revealWorkspace).not.toHaveBeenCalled();
  });

  it("refocuses an active preview after a dock pane was selected", () => {
    const center = {
      id: "group-1",
      region: "center",
      members: [],
    } as unknown as ProjectTabLayoutSummary["panes"][number];
    const right = {
      id: "right-pane",
      region: "right",
      members: [],
    } as unknown as ProjectTabLayoutSummary["panes"][number];
    const dockLayout = {
      panes: [center, right],
    } as unknown as ProjectTabLayoutSummary;
    const harness = commandHarness({
      layout: dockLayout,
      selectedPane: right,
    });

    harness.commands.activateSidebarFilePreview();

    expect(harness.setWorkspaceSelection).toHaveBeenCalledTimes(1);
    expect(harness.setSidebarFilePreview).not.toHaveBeenCalled();
    expect(harness.revealWorkspace).toHaveBeenCalledTimes(1);
  });

  it("pins without waiting for a legacy successor or promoting an Explorer", async () => {
    const waitForSuccessor = vi.fn();
    const openOwnedFile = vi.fn(async () => {});
    const harness = commandHarness({
      layout: layout([]),
      waitForSuccessor,
      openOwnedFile,
    });
    await harness.commands.pinSidebarFilePath(previewOwner, entry.path);
    expect(openOwnedFile).toHaveBeenCalledExactlyOnceWith(
      previewOwner,
      entry.path,
      false,
    );
    expect(waitForSuccessor).not.toHaveBeenCalled();
    expect(harness.legacyPin).not.toHaveBeenCalled();
    expect(harness.revealWorkspace).toHaveBeenCalledExactlyOnceWith();
  });
});
