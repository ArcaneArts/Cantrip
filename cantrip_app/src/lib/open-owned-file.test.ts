import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  applyWorkspaceCommand,
  type ExplorerSummary,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { WorkspaceCommandClient } from "./workspace-command-client";
import { openOwnedFile } from "./open-owned-file";
import { createExplorer, getExplorers } from "./api/explorers";
vi.mock("./api/explorers", () => ({
  createExplorer: vi.fn(),
  getExplorers: vi.fn(),
}));
const resource: ExplorerSummary = {
  id: "file-resource",
  projectId: "project",
  worktreeId: "tree",
  selectedPath: "src/lib.rs",
  fileMode: "preview",
  title: "lib.rs",
  position: 0,
  activeWorkerId: "worker",
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getExplorers).mockResolvedValue([]);
  vi.mocked(createExplorer).mockResolvedValue(resource);
});
function fixture(beforeExecute: () => Promise<void> = async () => {}) {
  let layout: WorkspaceOwnership = {
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        panes: [],
        centerRoot: null,
        focusedPaneId: null,
        recentPaneIds: [],
      },
    ],
  };
  const controller = new WorkspaceCommandClient(layout, "main", 0, {
    classify: () => "uncertain",
    read: async () => layout,
    execute: async (command) => {
      await beforeExecute();
      const result = applyWorkspaceCommand(layout, command);
      layout = result.layout;
      return { ...result, appliedRevision: layout.revision, replayed: false };
    },
  });
  return {
    controller,
    queryClient: new QueryClient(),
    projectId: "project",
    worktreeId: "tree",
    path: "src/lib.rs",
    focusWindow: vi.fn(async () => {}),
  };
}
it("creates a file-specific backing without legacy placement and coalesces concurrent opens", async () => {
  const input = fixture();
  await Promise.all([openOwnedFile(input), openOwnedFile(input)]);
  expect(createExplorer).toHaveBeenCalledTimes(1);
  expect(createExplorer).toHaveBeenCalledWith(
    "project",
    "lib.rs",
    "tree",
    undefined,
    undefined,
    {
      attachToTabLayout: false,
      initialViewState: { selectedPath: "src/lib.rs", fileMode: "edit" },
    },
  );
  const tabs = input.controller
    .getSnapshot()
    .authoritative.windows.flatMap((w) => w.panes)
    .flatMap((p) => p.tabs);
  expect(tabs).toHaveLength(1);
  expect(tabs[0]!.resource).toEqual({
    kind: "entity",
    definitionId: "project.file",
    resourceId: resource.id,
  });
});
it("reuses only the exact project/worktree/path and preserves its explicit mode", async () => {
  const input = fixture();
  await openOwnedFile(input);
  vi.mocked(createExplorer).mockClear();
  vi.mocked(getExplorers).mockResolvedValue([
    { ...resource, id: "other", worktreeId: "other-tree" },
    resource,
  ]);
  await openOwnedFile(input);
  expect(createExplorer).not.toHaveBeenCalled();
  expect(input.queryClient.getQueryData(["explorers", "project"])).toEqual([
    resource,
  ]);
});
it("does not place a tab after creation fails", async () => {
  vi.mocked(createExplorer).mockRejectedValue(new Error("worker unavailable"));
  const input = fixture();
  await expect(openOwnedFile(input)).rejects.toThrow("worker unavailable");
  expect(
    input.controller.getSnapshot().authoritative.windows[0]!.panes,
  ).toEqual([]);
});

it("pins a file preview without changing its view or backing identity", async () => {
  const input = fixture();
  await openOwnedFile({ ...input, preview: true });
  const before =
    input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!;
  expect(before.preview).toBe(true);
  vi.mocked(getExplorers).mockResolvedValue([resource]);
  await openOwnedFile({ ...input, preview: false });
  const after =
    input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!;
  expect(after.id).toBe(before.id);
  expect(after.resource).toEqual(before.resource);
  expect(after.preview).toBe(false);
  expect(createExplorer).toHaveBeenCalledOnce();
});

it("retains the backing after creation while placement acknowledgement is delayed", async () => {
  let release!: () => void;
  let started!: () => void;
  const executing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const input = fixture(async () => {
    started();
    await gate;
  });
  const first = openOwnedFile(input);
  await executing;
  expect(createExplorer).toHaveBeenCalledOnce();
  const second = openOwnedFile(input);
  await Promise.resolve();
  expect(getExplorers).toHaveBeenCalledOnce();
  expect(createExplorer).toHaveBeenCalledOnce();
  release();
  await Promise.all([first, second]);
  expect(
    input.controller
      .getSnapshot()
      .authoritative.windows.flatMap((w) => w.panes)
      .flatMap((p) => p.tabs),
  ).toHaveLength(1);
});

it("releases a failed creation so an explicit retry can succeed", async () => {
  vi.mocked(createExplorer).mockRejectedValueOnce(new Error("offline"));
  const input = fixture();
  await expect(openOwnedFile(input)).rejects.toThrow("offline");
  await openOwnedFile(input);
  expect(createExplorer).toHaveBeenCalledTimes(2);
});

it("does not attach a late-created resource after its controller is disposed", async () => {
  let finish!: (value: ExplorerSummary) => void;
  let started!: () => void;
  const creating = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(createExplorer).mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const input = fixture();
  const opening = openOwnedFile(input);
  await creating;
  input.controller.dispose();
  finish(resource);
  await expect(opening).rejects.toThrow("context changed");
  expect(
    input.queryClient.getQueryData(["explorers", "project"]),
  ).toBeUndefined();
  expect(input.focusWindow).not.toHaveBeenCalled();
});
