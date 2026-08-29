import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ShellHeader } from "./shell-header";

describe("ShellHeader mobile Chat chrome", () => {
  it("renders one Chat header after switching from a selected IDE project", () => {
    const markup = renderToStaticMarkup(
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
      />,
    );

    expect(markup.match(/<header/g)).toHaveLength(1);
    expect(markup).toContain("Beth");
    expect(markup).toContain("Standalone conversation · idle");
    expect(markup).toContain('title="Open sidebar"');
    expect(markup).not.toContain("Imperium");
  });
});
