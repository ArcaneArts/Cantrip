import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  applyWorkspaceCommand,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { WorkspaceCommandClient } from "./workspace-command-client";
import { openOwnedFile } from "./open-owned-file";
import { createFileDocument, getFileDocuments } from "./api/file-documents";
import type { FileDocument } from "./api/file-documents";
import { getProjectWorktrees } from "./api/worktrees";
import { surfaceTitleEncryption } from "./surface-title-encryption";
vi.mock("./surface-title-encryption", () => ({
  surfaceTitleEncryption: { fileDocumentId: vi.fn() },
}));
vi.mock("./api/worktrees", () => ({ getProjectWorktrees: vi.fn() }));
vi.mock("./api/file-documents", () => ({
  createFileDocument: vi.fn(),
  getFileDocuments: vi.fn(),
}));
const resource: FileDocument = {
  id: "file-resource",
  projectId: "project",
  worktreeId: "tree",
  path: "src/lib.rs",
  workerId: "worker",
  createdAt: "2026-10-23T00:00:00.000Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(surfaceTitleEncryption.fileDocumentId).mockReturnValue(
    "scoped-document-id",
  );
  vi.mocked(getFileDocuments).mockResolvedValue([]);
  vi.mocked(createFileDocument).mockResolvedValue(resource);
  vi.mocked(getProjectWorktrees).mockResolvedValue([
    { id: "tree", projectId: "project", workerId: "worker" },
  ] as Awaited<ReturnType<typeof getProjectWorktrees>>);
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
it("uses the same scoped document identity across independent controllers", async () => {
  await Promise.all([openOwnedFile(fixture()), openOwnedFile(fixture())]);
  expect(createFileDocument).toHaveBeenCalledTimes(2);
  for (const [input] of vi.mocked(createFileDocument).mock.calls) {
    expect(input.id).toBe("scoped-document-id");
  }
  expect(surfaceTitleEncryption.fileDocumentId).toHaveBeenCalledWith({
    projectId: "project",
    workerId: "worker",
    worktreeId: "tree",
    path: "src/lib.rs",
  });
});

it("creates a file-specific backing without legacy placement and coalesces concurrent opens", async () => {
  const input = fixture();
  const results = await Promise.all([
    openOwnedFile(input),
    openOwnedFile(input),
  ]);
  expect(createFileDocument).toHaveBeenCalledTimes(1);
  expect(createFileDocument).toHaveBeenCalledWith({
    id: expect.any(String),
    projectId: "project",
    workerId: "worker",
    worktreeId: "tree",
    path: "src/lib.rs",
  });
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
  for (const result of results) {
    expect(result.resource).toEqual(resource);
    expect(
      result.receipt.layout.windows
        .flatMap((w) => w.panes)
        .flatMap((p) => p.tabs)
        .map((tab) => tab.id),
    ).toEqual([tabs[0]!.id]);
  }
});
it("reuses only the exact project/worktree/path without changing view state", async () => {
  const input = fixture();
  await openOwnedFile(input);
  vi.mocked(createFileDocument).mockClear();
  vi.mocked(getFileDocuments).mockResolvedValue([
    { ...resource, id: "other", worktreeId: "other-tree" },
    resource,
  ]);
  await openOwnedFile(input);
  expect(createFileDocument).not.toHaveBeenCalled();
  expect(input.queryClient.getQueryData(["file-documents", "project"])).toEqual(
    [resource],
  );
});
it("does not return a usable open result after the context changes during native focus", async () => {
  const input = fixture();
  const open = input.controller.openResource.bind(input.controller);
  vi.spyOn(input.controller, "openResource").mockImplementation(
    async (...args) => ({
      ...(await open(...args)),
      focusWindowId: "another-window",
    }),
  );
  input.focusWindow.mockImplementation(async () => {
    input.controller.dispose();
  });
  await expect(openOwnedFile(input)).rejects.toThrow("context changed");
  expect(input.focusWindow).toHaveBeenCalledWith("another-window");
});

it("does not place a tab after creation fails", async () => {
  vi.mocked(createFileDocument).mockRejectedValue(
    new Error("worker unavailable"),
  );
  const input = fixture();
  await expect(openOwnedFile(input)).rejects.toThrow("worker unavailable");
  expect(
    input.controller.getSnapshot().authoritative.windows[0]!.panes,
  ).toEqual([]);
});

it("opens a catalog document that has no existing tab without creating another resource", async () => {
  vi.mocked(getFileDocuments).mockResolvedValue([resource]);
  const input = fixture();
  await openOwnedFile(input);
  expect(createFileDocument).not.toHaveBeenCalled();
  expect(getProjectWorktrees).not.toHaveBeenCalled();
  expect(
    input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!
      .resource,
  ).toEqual({
    kind: "entity",
    definitionId: "project.file",
    resourceId: resource.id,
  });
  expect(
    input.queryClient.getQueryData(["explorers", "project"]),
  ).toBeUndefined();
});

it("does not invent a worker binding when the selected worktree is absent", async () => {
  vi.mocked(getProjectWorktrees).mockResolvedValue([]);
  const input = fixture();
  await expect(openOwnedFile(input)).rejects.toThrow("worktree was not found");
  expect(createFileDocument).not.toHaveBeenCalled();
  expect(
    input.controller.getSnapshot().authoritative.windows[0]!.panes,
  ).toEqual([]);
});

it("does not interpret a catalog failure as permission to create a duplicate", async () => {
  vi.mocked(getFileDocuments).mockRejectedValue(
    new Error("catalog unavailable"),
  );
  const input = fixture();
  await expect(openOwnedFile(input)).rejects.toThrow("catalog unavailable");
  expect(createFileDocument).not.toHaveBeenCalled();
  expect(getProjectWorktrees).not.toHaveBeenCalled();
});

it("pins a file preview without changing its view or backing identity", async () => {
  const input = fixture();
  await openOwnedFile({ ...input, preview: true });
  const before =
    input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!;
  expect(before.preview).toBe(true);
  vi.mocked(getFileDocuments).mockResolvedValue([resource]);
  await openOwnedFile({ ...input, preview: false });
  const after =
    input.controller.getSnapshot().authoritative.windows[0]!.panes[0]!.tabs[0]!;
  expect(after.id).toBe(before.id);
  expect(after.resource).toEqual(before.resource);
  expect(after.preview).toBe(false);
  expect(createFileDocument).toHaveBeenCalledOnce();
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
  expect(createFileDocument).toHaveBeenCalledOnce();
  const second = openOwnedFile(input);
  await Promise.resolve();
  expect(getFileDocuments).toHaveBeenCalledOnce();
  expect(createFileDocument).toHaveBeenCalledOnce();
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
  vi.mocked(createFileDocument).mockRejectedValueOnce(new Error("offline"));
  const input = fixture();
  await expect(openOwnedFile(input)).rejects.toThrow("offline");
  await openOwnedFile(input);
  expect(createFileDocument).toHaveBeenCalledTimes(2);
});

it("does not attach a late-created resource after its controller is disposed", async () => {
  let finish!: (value: FileDocument) => void;
  let started!: () => void;
  const creating = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(createFileDocument).mockImplementation(() => {
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
    input.queryClient.getQueryData(["file-documents", "project"]),
  ).toBeUndefined();
  expect(input.focusWindow).not.toHaveBeenCalled();
});
