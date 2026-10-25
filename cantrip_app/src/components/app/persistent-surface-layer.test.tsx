import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { PersistentSurfaceLayer } from "./persistent-surface-layer";

vi.mock("@/components/chat/workspace-chat-panel", () => ({
  WorkspaceChatPanel: ({
    chat,
    visible,
  }: {
    chat: { id: string };
    visible: boolean;
  }) => <div data-chat={chat.id} data-focus-enabled={visible} />,
}));

const surfaceProps = vi.hoisted(() => ({
  terminal: null as Record<string, unknown> | null,
  code: null as Record<string, unknown> | null,
  explorer: null as Record<string, unknown> | null,
  browser: null as Record<string, unknown> | null,
  documents: null as Record<string, unknown> | null,
}));

vi.mock("@/components/app/application-shell-surfaces", () => ({
  PersistentFileDocumentViews: (props: Record<string, unknown>) => {
    surfaceProps.documents = props;
    return null;
  },
  PersistentBrowserViews: (props: Record<string, unknown>) => {
    surfaceProps.browser = props;
    return null;
  },
  PersistentCodeViews: (props: Record<string, unknown>) => {
    surfaceProps.code = props;
    return null;
  },
  PersistentExplorerViews: (props: Record<string, unknown>) => {
    surfaceProps.explorer = props;
    return null;
  },
  PersistentTerminalViews: (props: Record<string, unknown>) => {
    surfaceProps.terminal = props;
    return null;
  },
}));

vi.mock("@/components/workspace/project-tab-bar", () => ({
  ProjectPaneTabStrip: ({ children }: { children?: ReactNode }) => children,
}));

describe("persistent surface layer", () => {
  it.each([false, true])(
    "routes Explorer files through ownership on desktop=%s",
    async (desktopRuntime) => {
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      const openProjectExplorerFile = vi.fn();
      const openExplorerFileWindow = vi.fn(async () => {});
      const explorer = { projectId: "project", worktreeId: "checkout" };
      const entry = { path: "src/main.rs" };
      let tree!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        tree = TestRenderer.create(
          <PersistentSurfaceLayer
            bindings={{
              appMode: "ide",
              openExplorers: [],
              projectSurfaces: [],
              desktopRuntime,
              openProjectExplorerFile,
              openExplorerFileWindow,
            }}
          />,
        );
      });
      try {
        const open = surfaceProps.explorer!.onOpenFile as Function;
        expect(open).toBeTypeOf("function");
        await open(explorer, entry);
        if (desktopRuntime) {
          expect(openExplorerFileWindow).toHaveBeenCalledExactlyOnceWith(
            explorer,
            entry,
          );
          expect(openProjectExplorerFile).not.toHaveBeenCalled();
        } else {
          expect(openProjectExplorerFile).toHaveBeenCalledExactlyOnceWith(
            "project",
            "checkout",
            "src/main.rs",
          );
          expect(openExplorerFileWindow).not.toHaveBeenCalled();
        }
      } finally {
        await act(async () => tree.unmount());
      }
    },
  );

  it("matches Code migration receipts by view identity, not resource identity", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <PersistentSurfaceLayer
          bindings={{
            appMode: "ide",
            openExplorers: [],
            migratedCodeTabIds: new Set(["migrated-view", "wrong-resource"]),
            projectSurfaces: [
              {
                kind: "code",
                tabKey: "migrated-view",
                tabId: "code-resource",
                member: { tabKind: "code", tabId: "code-resource" },
                entity: { id: "code-resource" },
              },
              {
                kind: "code",
                tabKey: "unmigrated-view",
                tabId: "wrong-resource",
                member: { tabKind: "code", tabId: "wrong-resource" },
                entity: { id: "wrong-resource" },
              },
            ],
          }}
        />,
      );
    });
    expect(surfaceProps.code!.migratedIds).toEqual(new Set(["code-resource"]));
    await act(async () => tree.unmount());
  });

  it("routes Code browser file requests to the shared project file opener", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const openProjectExplorerFile = vi.fn();
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <PersistentSurfaceLayer
          bindings={{
            appMode: "ide",
            openExplorers: [],
            projectSurfaces: [],
            openProjectExplorerFile,
          }}
        />,
      );
    });
    const open = surfaceProps.code!.onOpenFile as (
      tab: { projectId: string; worktreeId: string },
      entry: { path: string },
    ) => void;
    open(
      { projectId: "project", worktreeId: "checkout" },
      { path: "src/main.rs" },
    );
    expect(openProjectExplorerFile).toHaveBeenCalledWith(
      "project",
      "checkout",
      "src/main.rs",
    );
    await act(async () => tree.unmount());
  });
  it("routes chats by tab identity and grants activation focus only to the selected tab", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const surfaces = ["a", "b"].map((id) => ({
      kind: "chat",
      tabKey: `view-${id}`,
      tabId: `chat-${id}`,
      entity: { id: `chat-${id}` },
    }));
    const bindings = {
      appMode: "ide",
      openExplorers: [],
      selectedProjectId: "project",
      selectedTabKey: "view-a",
      projectSurfaces: surfaces,
      dockPanePresentations: surfaces.map((surface) => ({
        activeSurface: surface,
        pane: { id: surface.tabKey },
        portalTarget: {},
      })),
    };
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <PersistentSurfaceLayer bindings={bindings} />,
      );
    });
    const panels = () =>
      tree.root.findAll(
        (node) => node.type === "div" && Boolean(node.props["data-chat"]),
      );
    expect(
      panels().map((node) => [
        node.props["data-chat"],
        node.props["data-focus-enabled"],
      ]),
    ).toEqual([
      ["chat-a", true],
      ["chat-b", false],
    ]);
    await act(async () => {
      tree.update(
        <PersistentSurfaceLayer
          bindings={{
            ...bindings,
            selectedTabKey: "view-b",
            excludedPersistentSurfaceIds: new Set(["view-a"]),
          }}
        />,
      );
    });
    expect(panels().map((node) => node.props["data-chat"])).toEqual(["chat-b"]);
    expect(panels()[0]!.props["data-focus-enabled"]).toBe(true);
    await act(async () => tree.unmount());
  });
  it("routes document views by tab identity and excludes transferred views", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const surface = {
      kind: "file",
      definition: { id: "project.file" },
      tabKey: "file-view",
      tabId: "document",
      entity: { id: "document", projectId: "project" },
    };
    const host = {};
    const incomingViews = [{ tabId: "incoming-view" }];
    const persistFileViewMode = vi.fn(async () => {});
    const bindings = {
      appMode: "ide",
      openExplorers: [],
      selectedProjectId: "project",
      selectedTabKey: "file-view",
      projectSurfaces: [surface],
      incomingFileDocumentViews: incomingViews,
      persistFileViewMode,
      dockPanePresentations: [
        {
          activeSurface: surface,
          pane: { id: "pane" },
          portalTarget: host,
          focused: true,
        },
      ],
    };
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <PersistentSurfaceLayer bindings={bindings} />,
      );
    });
    expect(surfaceProps.documents?.surfaces).toEqual([surface]);
    expect(surfaceProps.documents?.activeTabId).toBe("file-view");
    expect(surfaceProps.documents?.incomingViews).toBe(incomingViews);
    await (surfaceProps.documents?.onModeChange as Function)(
      "file-view",
      "visual",
    );
    expect(persistFileViewMode).toHaveBeenCalledWith("file-view", "visual");
    expect(surfaceProps.documents?.placements).toEqual([
      { tabId: "file-view", paneId: "pane", portalTarget: host, focused: true },
    ]);
    await act(async () => {
      tree.update(
        <PersistentSurfaceLayer
          bindings={{
            ...bindings,
            excludedPersistentSurfaceIds: new Set(["file-view"]),
          }}
        />,
      );
    });
    expect(surfaceProps.documents?.surfaces).toEqual([]);
    await act(async () => tree.unmount());
  });
  it("routes browser ownership and callbacks through the persistent tab layer", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const browser = { id: "resource", projectId: "project" };
    const surface = {
      kind: "browser",
      tabId: browser.id,
      tabKey: "view",
      entity: browser,
    };
    const update = vi.fn();
    const create = vi.fn();
    const host = {};
    const bindings = {
      appMode: "ide",
      openExplorers: [],
      selectedProjectId: "project",
      projectSurfaces: [
        surface,
        {
          kind: "unresolved",
          tabKey: "loading-view",
          member: { tabId: "loading", tabKind: "browser" },
        },
      ],
      dockPanePresentations: [
        { activeSurface: surface, pane: { id: "pane" }, portalTarget: host },
      ],
      updateBrowserMutation: { mutate: update },
      newBrowser: { mutate: create },
    };
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <PersistentSurfaceLayer bindings={bindings} />,
      );
    });
    expect(surfaceProps.browser?.owners).toEqual([
      { tabId: "view", resourceId: "resource", browser },
      { tabId: "loading-view", resourceId: "loading" },
    ]);
    expect(surfaceProps.browser?.placements).toEqual([
      { tabId: "view", paneId: "pane", portalTarget: host },
    ]);
    const state = {
      previousTitle: null,
      title: "Page",
      url: "https://example.com/",
    };
    (surfaceProps.browser?.onPageState as Function)(browser, state);
    expect(update).toHaveBeenCalledWith({
      browserId: "resource",
      projectId: "project",
      pageState: state,
    });
    await act(async () => {
      tree.update(
        <PersistentSurfaceLayer
          bindings={{
            ...bindings,
            excludedPersistentSurfaceIds: new Set(["resource"]),
          }}
        />,
      );
    });
    expect(surfaceProps.browser?.owners).toEqual([
      { tabId: "loading-view", resourceId: "loading" },
    ]);
    await act(async () => tree.unmount());
  });
  it("places linked consoles in chat panes and reacts to GUI/CLI toggles", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const terminal = {
      id: "cli-one",
      linkedChatId: "chat-one",
      kind: "chat-console",
    };
    const otherTerminal = {
      id: "cli-two",
      linkedChatId: "chat-two",
      kind: "chat-console",
    };
    const host = {};
    const otherHost = {};
    const bindings = {
      appMode: "ide",
      openExplorers: [],
      selectedProjectId: "project-one",
      chatConsoleOpenChats: new Set<string>(),
      terminals: { data: [terminal, otherTerminal] },
      dockPanePresentations: [
        {
          activeSurface: { kind: "chat", entity: { id: "chat-one" } },
          focused: true,
          gridArea: "center-body",
          pane: { id: "center" },
          portalTarget: host,
        },
        {
          activeSurface: { kind: "chat", entity: { id: "chat-two" } },
          focused: false,
          gridArea: "right-body",
          pane: { id: "right" },
          portalTarget: otherHost,
        },
      ],
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PersistentSurfaceLayer bindings={bindings} />,
      );
    });
    expect(surfaceProps.terminal?.visiblePlacements).toEqual([]);
    await act(async () => {
      renderer.update(
        <PersistentSurfaceLayer
          bindings={{
            ...bindings,
            chatConsoleOpenChats: new Set(["chat-one", "chat-two"]),
          }}
        />,
      );
    });
    expect(surfaceProps.terminal?.visiblePlacements).toEqual([
      {
        terminal,
        focused: true,
        gridArea: "center-body",
        paneId: "center",
        portalTarget: host,
      },
      {
        terminal: otherTerminal,
        focused: false,
        gridArea: "right-body",
        paneId: "right",
        portalTarget: otherHost,
      },
    ]);
    await act(async () => {
      renderer.update(
        <PersistentSurfaceLayer
          bindings={{
            ...bindings,
            chatConsoleOpenChats: new Set(["chat-two"]),
          }}
        />,
      );
    });
    expect(surfaceProps.terminal?.visiblePlacements).toEqual([
      {
        terminal: otherTerminal,
        focused: false,
        gridArea: "right-body",
        paneId: "right",
        portalTarget: otherHost,
      },
    ]);
    await act(async () => renderer.unmount());
  });

  it.each([true, false])(
    "keeps owned file and Code placements independent when file focus is %s",
    async (fileFocused) => {
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      const fileHost = {};
      const codeHost = {};
      const fileSurface = {
        tabKey: "file-view",
        tabId: "document",
        definition: { id: "project.file" },
        kind: "file",
        entity: { id: "document" },
      };
      const code = { id: "code" };
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <PersistentSurfaceLayer
            bindings={{
              appMode: "ide",
              openExplorers: [],
              selectedProjectId: "project-1",
              selectedTabKey: fileFocused ? "file-view" : "code-view",
              projectSurfaces: [fileSurface],
              dockPanePresentations: [
                {
                  activeSurface: fileSurface,
                  focused: fileFocused,
                  gridArea: "center-body",
                  pane: { id: "center" },
                  portalTarget: fileHost,
                },
                {
                  activeSurface: {
                    entity: code,
                    kind: "code",
                    tabKey: "code-view",
                  },
                  focused: !fileFocused,
                  gridArea: "right-body",
                  pane: { id: "right" },
                  portalTarget: codeHost,
                },
              ],
            }}
          />,
        );
      });
      expect(surfaceProps.documents?.placements).toEqual([
        {
          tabId: "file-view",
          paneId: "center",
          portalTarget: fileHost,
          focused: fileFocused,
        },
      ]);
      expect(surfaceProps.code?.visiblePlacements).toEqual([
        {
          tab: code,
          focused: !fileFocused,
          gridArea: "right-body",
          paneId: "right",
          portalTarget: codeHost,
        },
      ]);
      expect(surfaceProps.explorer?.activeExplorer).toBeNull();
      expect(surfaceProps.explorer?.visiblePlacements).toEqual([]);
      expect(surfaceProps.explorer).not.toHaveProperty("transientFile");
      await act(async () => renderer.unmount());
    },
  );
});
