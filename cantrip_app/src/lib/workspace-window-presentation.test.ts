import { expect, it } from "vitest";
import type {
  ExplorerSummary,
  WorkspaceOwnership,
  WorkspacePane,
} from "@cantrip/protocol";
import { buildProjectSurfaceIndex } from "./project-surface";
import {
  workspaceWindowPresentation,
  openWorkspaceWindowPresentation,
} from "./workspace-window-presentation";

function pane(id: string): WorkspacePane {
  return {
    id,
    region: "center",
    titleProtection: null,
    activeTabId: `${id}-second`,
    tabs: ["first", "second"].map((suffix) => ({
      id: `${id}-${suffix}`,
      resource: { kind: "builtin", definitionId: "project.tasks" },
      builtInState: { definitionId: "project.tasks", worktreeId: null },
      preview: suffix === "first",
      titleProtection: null,
      dockPresentation: null,
    })),
  };
}
function fixture(): WorkspaceOwnership {
  return {
    version: 1,
    id: "device-project",
    projectId: "project",
    revision: 8,
    mainWindowId: "main",
    windows: ["main", "detached"].map((id) => ({
      id,
      attachmentGeneration: 0,
      panes: [pane(id)],
      centerRoot: { kind: "pane", paneId: id },
      focusedPaneId: id,
      recentPaneIds: [id],
    })),
  };
}

it("hydrates an owned file document without an Explorer and retains its view while loading", async () => {
  const ownership = fixture();
  const tab = ownership.windows[0]!.panes[0]!.tabs[0]!;
  tab.resource = {
    kind: "entity",
    definitionId: "project.file",
    resourceId: "document-1",
  };
  tab.fileMode = "preview";
  tab.builtInState = null;
  const { layout } = await openWorkspaceWindowPresentation(ownership, "main");
  const document = {
    id: "document-1",
    projectId: "project",
    workerId: "worker",
    worktreeId: "worktree",
    path: "src/main.rs",
    createdAt: "2026-08-09T12:00:00.000Z",
  };
  const surface = (documents: (typeof document)[]) =>
    buildProjectSurfaceIndex(
      layout,
      {
        browsers: [],
        chats: [],
        codeTabs: [],
        explorers: [],
        projectViews: [],
        terminals: [],
        fileDocuments: documents,
      },
      { layout: ownership, windowId: "main" },
    ).byTabKey.get(tab.id);

  expect(surface([document])).toMatchObject({
    kind: "file",
    entity: document,
    title: "main.rs",
    fileMode: "preview",
    preview: true,
    view: { id: tab.id, resource: tab.resource },
  });
  expect(surface([])).toMatchObject({
    kind: "unresolved",
    fileMode: "preview",
    preview: true,
    view: { id: tab.id, resource: tab.resource },
  });
  expect(
    surface([{ ...document, projectId: "another-project" }]),
  ).toMatchObject({
    kind: "unresolved",
    entity: null,
    view: { id: tab.id },
  });
  tab.preview = false;
  expect(surface([document])).toMatchObject({
    kind: "file",
    preview: false,
    view: { id: tab.id },
  });
});

it("retains owner file identity and preview state across loading and pinning", async () => {
  const ownership = fixture();
  const tab = ownership.windows[0]!.panes[0]!.tabs[0]!;
  tab.resource = {
    kind: "entity",
    definitionId: "project.file",
    resourceId: "file-resource",
  };
  tab.builtInState = null;
  const { layout } = await openWorkspaceWindowPresentation(ownership, "main");
  const collections = {
    browsers: [],
    chats: [],
    codeTabs: [],
    explorers: [] as ExplorerSummary[],
    projectViews: [],
    terminals: [],
  };
  const index = () =>
    buildProjectSurfaceIndex(layout, collections, {
      layout: ownership,
      windowId: "main",
    });
  expect(index().byTabKey.get(tab.id)).toMatchObject({
    kind: "unresolved",
    preview: true,
    definition: { id: "project.file" },
    view: { id: tab.id, resource: tab.resource },
  });
  // Query state must not reclassify an explicitly owned file as an Explorer.
  collections.explorers = [
    {
      id: "file-resource",
      projectId: "project",
      title: "File",
      selectedPath: null,
    } as ExplorerSummary,
  ];
  expect(index().byTabKey.get(tab.id)).toMatchObject({
    kind: "explorer",
    preview: true,
    definition: { id: "project.file" },
  });
  tab.preview = false;
  expect(index().byTabKey.get(tab.id)).toMatchObject({
    preview: false,
    view: { id: tab.id },
  });
  collections.explorers = [];
  expect(index().byTabKey.get(tab.id)).toMatchObject({
    kind: "unresolved",
    preview: false,
    definition: { id: "project.file" },
  });
  expect(
    buildProjectSurfaceIndex(layout, collections, {
      layout: ownership,
      windowId: "detached",
    }).byTabKey.size,
  ).toBe(0);
  expect(
    buildProjectSurfaceIndex(layout, collections, {
      layout: { ...ownership, projectId: "other-project" },
      windowId: "main",
    }).byTabKey.size,
  ).toBe(0);
});

it("projects only owned panes and retains opaque tab identities, order and selection", () => {
  const layout = fixture();
  const { wire, selection } = workspaceWindowPresentation(layout, "detached");
  expect(wire.revision).toBe(8);
  expect(wire.panes.map((p) => p.id)).toEqual(["detached"]);
  expect(wire.panes[0]!.members.map((m) => m.tabKey)).toEqual([
    "detached-first",
    "detached-second",
  ]);
  expect(wire.panes[0]!.members.map((m) => m.tabId)).toEqual([
    "project.tasks",
    "project.tasks",
  ]);
  expect(wire.centerRoot).toEqual({ kind: "pane", paneId: "detached" });
  expect(selection).toEqual({
    projectId: "project",
    destination: "surface",
    focusedPaneId: "detached",
    activeTabByPane: { detached: "detached-second" },
  });
  wire.panes[0]!.members[0]!.builtInState!.worktreeId = "changed";
  expect(
    layout.windows[1]!.panes[0]!.tabs[0]!.builtInState!.worktreeId,
  ).toBeNull();
});

it("uses the existing label opener without changing view identities", async () => {
  const result = await openWorkspaceWindowPresentation(fixture(), "main");
  expect(
    result.layout.panes[0]!.members.map((m) => [m.tabKey, m.title]),
  ).toEqual([
    ["main-first", "Tasks"],
    ["main-second", "Tasks"],
  ]);
});

it("retains an entity tab before its resource query has arrived", async () => {
  const layout = fixture();
  const tab = layout.windows[0]!.panes[0]!.tabs[0]!;
  tab.resource = {
    kind: "entity",
    definitionId: "project.terminal",
    resourceId: "pty-resource",
  };
  tab.builtInState = null;
  const result = await openWorkspaceWindowPresentation(layout, "main");
  expect(result.layout.panes[0]!.members[0]).toMatchObject({
    tabKey: "main-first",
    tabId: "pty-resource",
    tabKind: "terminal",
  });
  expect(result.layout.panes[0]!.members).toHaveLength(2);
});

it("represents an empty owned window as home and rejects a missing owner", () => {
  const layout = fixture();
  Object.assign(layout.windows[0]!, {
    panes: [],
    centerRoot: null,
    focusedPaneId: null,
    recentPaneIds: [],
  });
  expect(workspaceWindowPresentation(layout, "main").selection).toEqual({
    projectId: "project",
    destination: "overview",
    focusedPaneId: null,
    activeTabByPane: {},
  });
  expect(() => workspaceWindowPresentation(layout, "missing")).toThrow(
    "does not belong",
  );
});

it("projects direct conversation content without a rail member or duplicate owner", async () => {
  const ownership = fixture();
  ownership.version = 2;
  for (const window of ownership.windows)
    for (const pane of window.panes) {
      pane.conversationView = null;
      pane.selection = { kind: "tab", tabId: pane.activeTabId! };
    }
  const pane = ownership.windows[0]!.panes[0]!;
  pane.conversationView = {
    id: "direct",
    resource: {
      kind: "entity",
      definitionId: "project.agent",
      resourceId: "agent",
    },
    titleProtection: null,
    builtInState: null,
    dockPresentation: null,
    preview: false,
  };
  pane.selection = { kind: "conversation", viewId: "direct" };
  const { wire, selection } = workspaceWindowPresentation(ownership, "main");
  expect(wire.panes[0]!.members.map((member) => member.tabKey)).toEqual([
    "main-first",
    "main-second",
  ]);
  expect(wire.panes[0]!.conversationView?.tabKey).toBe("direct");
  expect(selection.activeTabByPane.main).toBe("direct");
  const { layout } = await openWorkspaceWindowPresentation(ownership, "main");
  const index = buildProjectSurfaceIndex(
    layout,
    {
      browsers: [],
      chats: [],
      codeTabs: [],
      explorers: [],
      projectViews: [],
      terminals: [],
    },
    { layout: ownership, windowId: "main" },
  );
  expect(index.byTabKey.get("direct")).toMatchObject({
    conversation: true,
    tabId: "agent",
  });
  expect(
    index.byPaneId.get("main")?.filter((surface) => !surface.conversation),
  ).toHaveLength(2);
  pane.tabs = [];
  pane.activeTabId = null;
  const directOnly = await openWorkspaceWindowPresentation(ownership, "main");
  expect(directOnly.layout.panes[0]!.members).toEqual([]);
  expect(directOnly.layout.panes[0]!.conversationView?.tabKey).toBe("direct");
});
