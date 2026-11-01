import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { navigateMobileSettingsBack, ShellHeader } from "./shell-header";

const mouseBack = vi.hoisted(() => ({ callback: null as (() => void) | null }));
vi.mock("./use-mouse-back", () => ({
  useMouseBack: (callback: (() => void) | null) => {
    mouseBack.callback = callback;
  },
}));

describe("file document header", () => {
  it.each([false, true])(
    "displays only the document filename without an Explorer (popout: %s)",
    (isPopout) => {
      const markup = renderToStaticMarkup(
        <TooltipProvider>
          <ShellHeader
            bindings={{
              appMode: "ide",
              showContentTitlebar: true,
              isPopout,
              contentScrolled: true,
              selectedFileDocument: { path: "src/lib.rs" },
              explorerDisplayPath: "/checkouts/feature/src/lib.rs",
            }}
          />
        </TooltipProvider>,
      );
      expect(markup).toContain("lib.rs");
      expect(markup).not.toContain("/checkouts/feature/src/lib.rs");
      expect(markup).not.toContain("src/lib.rs");
      expect(markup).not.toContain("bg-border transition-opacity");
      expect(markup).not.toContain(">Cantrip<");
    },
  );
  it.each(["explorer", "code"])(
    "uses the filename for a file opened in a legacy %s surface",
    (kind) => {
      const markup = renderToStaticMarkup(
        <TooltipProvider>
          <ShellHeader
            bindings={{
              appMode: "ide",
              showContentTitlebar: true,
              selectedExplorer:
                kind === "explorer"
                  ? { title: "Explorer", selectedPath: "src/lib.rs" }
                  : undefined,
              activeExplorerHeader:
                kind === "explorer"
                  ? { selectedPath: "src/lib.rs" }
                  : undefined,
              selectedCodeTab: kind === "code" ? { title: "Code" } : undefined,
              codeHeader:
                kind === "code"
                  ? { explorer: { selectedPath: "src/lib.rs" } }
                  : undefined,
              explorerDisplayPath: "/checkouts/feature/src/lib.rs",
              activeWorktree: { displayPath: "/checkouts/feature" },
            }}
          />
        </TooltipProvider>,
      );
      expect(markup).toContain(">lib.rs<");
      expect(markup).not.toContain("/checkouts/feature");
      expect(markup).not.toContain("src/lib.rs");
    },
  );
});

describe("desktop settings workspace", () => {
  it.each([
    ["showSettings", "setShowSettings"],
    ["showProjectSettings", "setShowProjectSettings"],
    ["showProjectOverview", "setShowProjectOverview"],
  ])("wires mouse Back from %s to its return action", (flag, setter) => {
    const close = vi.fn();
    renderToStaticMarkup(
      <ShellHeader
        bindings={{ appMode: "ide", [flag]: true, [setter]: close }}
      />,
    );
    expect(mouseBack.callback).not.toBeNull();
    mouseBack.callback?.();
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("returns from Overview without selecting or closing a tab", () => {
    const setShowProjectOverview = vi.fn();
    const header = ShellHeader({
      bindings: {
        appMode: "ide",
        showProjectOverview: true,
        setShowProjectOverview,
        sidebarToggleVisible: true,
      },
    });
    const markup = renderToStaticMarkup(header);
    expect(markup).toContain("Back to Project");
    expect(markup).toContain("Overview");
    expect(markup).not.toContain("Expand sidebar");
    header.props.children[0].props.onClick();
    expect(setShowProjectOverview).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("closes project settings without changing account settings or the selected tab", () => {
    const setShowSettings = vi.fn();
    const setShowProjectSettings = vi.fn();
    const header = ShellHeader({
      bindings: {
        appMode: "ide",
        showProjectSettings: true,
        showSettings: false,
        compactShell: false,
        overlayTitlebar: true,
        sidebarToggleVisible: true,
        setShowSettings,
        setShowProjectSettings,
      },
    });
    const markup = renderToStaticMarkup(header);
    expect(markup).toContain("Back to Project");
    expect(markup).toContain("Project Settings");
    expect(markup).not.toContain("Expand sidebar");
    header.props.children[0].props.onClick();
    expect(setShowProjectSettings).toHaveBeenCalledExactlyOnceWith(false);
    expect(setShowSettings).not.toHaveBeenCalled();
  });
  it.each(["ide", "chat"])(
    "returns to the preserved %s workspace",
    (appMode) => {
      const setShowSettings = vi.fn();
      const header = ShellHeader({
        bindings: {
          appMode,
          showSettings: true,
          compactShell: false,
          overlayTitlebar: true,
          sidebarToggleVisible: true,
          setShowSettings,
        },
      });
      const markup = renderToStaticMarkup(header);
      expect(markup).toContain(
        appMode === "ide" ? "Back to Project" : "Back to Chat",
      );
      expect(markup).toContain("padding-left:5.5rem");
      expect(markup).not.toContain("Expand sidebar");
      header.props.children[0].props.onClick();
      expect(setShowSettings).toHaveBeenCalledExactlyOnceWith(false);
    },
  );
});

describe("project overview safe area", () => {
  it.each([
    ["ide", true],
    ["chat", true],
    ["ide", false],
    ["chat", false],
  ])(
    "reserves the mobile safe area only in compact %s mode (%s)",
    (appMode, compactShell) => {
      const setShowProjectOverview = vi.fn();
      const header = ShellHeader({
        bindings: {
          appMode,
          compactShell,
          showProjectOverview: true,
          setShowProjectOverview,
        },
      });

      expect(
        header.props.className.split(" ").includes("mobile-safe-top"),
      ).toBe(compactShell);
      expect(renderToStaticMarkup(header)).toContain(
        appMode === "ide" ? "Back to Project" : "Back to Chat",
      );
      header.props.children[0].props.onClick();
      expect(setShowProjectOverview).toHaveBeenCalledExactlyOnceWith(false);
    },
  );
});

describe("ShellHeader mobile Chat chrome", () => {
  it("renders one Chat header after switching from a selected IDE project", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider delayDuration={0}>
        <ShellHeader
          bindings={{
            appMode: "chat",
            compactManagedHeader: false,
            compactShell: true,
            desktopSidebarDrawer: true,
            projectOverviewSelected: true,
            selectedProject: {
              id: "project-1",
              name: "Imperium",
              source: { displayPath: "/worker/repositories/Imperium" },
            },
            selectedStandaloneChat: { title: "Beth", status: "idle" },
            setDesktopSidebarDrawerOpen: vi.fn(),
            setStandaloneFilesOpen: vi.fn(),
            showContentTitlebar: true,
            sidebarToggleVisible: true,
            standaloneFilesOpen: false,
            switchToIde: vi.fn(),
          }}
        />
      </TooltipProvider>,
    );

    expect(markup.match(/<header/g)).toHaveLength(1);
    expect(markup).toContain("Beth");
    expect(markup).toContain("Standalone conversation · idle");
    expect(markup).toContain('aria-label="Open sidebar"');
    expect(markup).toContain("relative size-9");
    expect(markup).not.toContain("absolute size-8");
    expect(markup).not.toContain(" title=");
    expect(markup).not.toContain("Imperium");
  });
});

describe("mobile settings back navigation", () => {
  it("returns a section to the settings root before exiting", () => {
    const returnToRoot = vi.fn();
    const exitSettings = vi.fn();

    navigateMobileSettingsBack(true, returnToRoot, exitSettings);

    expect(returnToRoot).toHaveBeenCalledOnce();
    expect(exitSettings).not.toHaveBeenCalled();
  });

  it("exits normally from the settings root", () => {
    const returnToRoot = vi.fn();
    const exitSettings = vi.fn();

    navigateMobileSettingsBack(false, returnToRoot, exitSettings);

    expect(returnToRoot).not.toHaveBeenCalled();
    expect(exitSettings).toHaveBeenCalledOnce();
  });
});

function dockFocusedBindings(mainFile = false, region = "right") {
  const dock = {
    kind: "history",
    tabKey: "view:history",
    title: "History",
    paneId: "dock",
    projectId: "project",
    definition: { supportedPlacements: ["center", "right", "bottom"] },
    entity: {
      id: "history",
      title: "History",
      kind: "history",
      worktreeId: "dock-tree",
    },
  };
  const file = {
    kind: "file",
    tabKey: "file:document",
    entity: { path: "src/lib.rs", worktreeId: "main-tree", workerId: "worker" },
  };
  return {
    appMode: "ide",
    overlayTitlebar: true,
    showContentTitlebar: true,
    selectedProject: {
      id: "project",
      name: "Repository",
      capabilities: { git: true, worktrees: true },
    },
    selectedSurface: dock,
    selectedPaneSurfaces: [dock],
    selectedProjectView: dock.entity,
    selectedTabKey: dock.tabKey,
    gitHistoryProject: { name: "Repository" },
    gitHistoryHeader: {
      section: "history",
      branch: "dock-branch",
      head: "abcdef12345678",
      commitsLoaded: 23,
    },
    activeWorktreeId: "dock-tree",
    activeWorktreeTarget: {
      kind: "history",
      tabId: "history",
      projectId: "project",
    },
    workspaceSelection: {
      destination: "surface",
      focusedPaneId: "dock",
      activeTabByPane: { main: file.tabKey, dock: dock.tabKey },
    },
    tabLayout: {
      data: {
        panes: [
          { id: "main", region: "center", anchorTabKey: file.tabKey },
          { id: "dock", region, anchorTabKey: dock.tabKey },
        ],
      },
    },
    projectSurfaceIndex: {
      byPaneId: new Map([
        ["main", mainFile ? [file] : []],
        ["dock", [dock]],
      ]),
    },
    worktrees: {
      data: [
        { id: "main-tree", displayPath: "/main" },
        { id: "dock-tree", displayPath: "/dock" },
      ],
    },
    workers: { data: [] },
    runConfigurationRuntimes: { data: [] },
    newBrowser: { mutate: vi.fn() },
    newChat: { mutate: vi.fn() },
    newCodeTab: { mutate: vi.fn() },
    newExplorer: { mutate: vi.fn() },
    newRemoteDesktop: { mutate: vi.fn() },
    newTerminal: { mutate: vi.fn() },
    renderProjectRunConfigurationControl: () => null,
  };
}
function windowMarkup(bindings: Readonly<Record<string, any>>) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ShellHeader bindings={bindings} />
    </TooltipProvider>,
  );
}
describe("desktop main tab window title", () => {
  it.each(["right", "bottom"])(
    "keeps an empty main title while %s History owns or remembers focus",
    (region) => {
      const bindings = dockFocusedBindings(false, region);
      for (const destination of ["surface", "overview"]) {
        bindings.workspaceSelection.destination = destination;
        const markup = windowMarkup(bindings);
        for (const text of [
          "History",
          "Repository",
          "dock-branch",
          "abcdef12",
          "commits loaded",
          "Choose a project",
        ])
          expect(markup).not.toContain(text);
      }
    },
  );
  it.each(["right", "bottom"])(
    "keeps the main filename when the %s History pane receives focus",
    (region) => {
      const markup = windowMarkup(dockFocusedBindings(true, region));
      expect(markup).toContain(">lib.rs<");
      for (const text of [
        "History",
        "dock-branch",
        "abcdef12",
        "commits loaded",
        "/dock",
        "src/lib.rs",
      ])
        expect(markup).not.toContain(text);
    },
  );
  it("uses the main tab during focus reconciliation while the focused selection is stale", () => {
    const bindings = dockFocusedBindings(true);
    bindings.workspaceSelection.focusedPaneId = "main";
    const markup = windowMarkup(bindings);
    expect(markup).toContain(">lib.rs<");
    expect(markup).not.toContain(">History<");
  });
  it("leaves History metadata in its panel even when History is the main tab", () => {
    const bindings = dockFocusedBindings();
    bindings.tabLayout.data.panes = [
      { id: "dock", region: "center", anchorTabKey: "view:history" },
    ];
    const markup = windowMarkup(bindings);
    expect(markup).toContain(">History<");
    for (const text of [
      "dock-branch",
      "abcdef12",
      "commits loaded",
      "Repository",
    ])
      expect(markup).not.toContain(text);
  });
  it.each([false, true])(
    "merges a History popout's tabs and controls into one header (overlay=%s)",
    (overlayTitlebar) => {
      const markup = windowMarkup({
        ...dockFocusedBindings(),
        isPopout: true,
        overlayTitlebar,
        renderProjectRunConfigurationControl: () => (
          <button>Window controls</button>
        ),
      });
      expect(markup).toContain("data-popout-tab-titlebar");
      expect(markup).toContain('role="tablist"');
      expect(markup.match(/>History</g)).toHaveLength(1);
      expect(markup).toContain("Window controls");
      expect(markup).not.toContain("h-16");
      expect(markup.includes("padding-left:5.5rem")).toBe(overlayTitlebar);
    },
  );
  it("keeps settings available over an empty main workspace", () => {
    const markup = windowMarkup({
      ...dockFocusedBindings(),
      showSettings: true,
    });
    expect(markup).toContain("Back to Project");
    expect(markup).toContain("Settings");
  });
});
