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
