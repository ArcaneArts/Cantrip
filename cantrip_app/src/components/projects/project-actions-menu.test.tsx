import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-context-menu", () => ({
  Content: ({ children, ...props }: { children: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  Item: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children: ReactNode }) => <>{children}</>,
  Separator: (props: object) => <hr {...props} />,
  Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Content: ({ children, ...props }: { children: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  Item: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children: ReactNode }) => <>{children}</>,
  Separator: (props: object) => <hr {...props} />,
  Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import {
  ProjectContextMenu,
  ProjectDropdownMenu,
  type ProjectMenuActions,
} from "./project-actions-menu";

const actions: ProjectMenuActions = {
  onOpenOverview: vi.fn(),
  onOpenSettings: vi.fn(),
  onRemove: vi.fn(),
  onReveal: vi.fn(),
  revealLabel: "Reveal in Finder",
};

describe("project action menus", () => {
  it.each([
    ["context", ProjectContextMenu, "project-actions-context-menu"],
    ["dropdown", ProjectDropdownMenu, "project-actions-dropdown-menu"],
  ] as const)(
    "renders the shared actions above the project switcher for the %s menu",
    (_kind, Menu, slot) => {
      const markup = renderToStaticMarkup(
        <Menu actions={actions}>
          <button>Project</button>
        </Menu>,
      );

      expect(markup).toContain(`data-slot="${slot}"`);
      expect(markup).toContain("z-[100]");
      expect(markup).toContain("Project Settings");
      expect(markup).toContain("Overview");
      expect(markup).toContain("Reveal in Finder");
      expect(markup).toContain("Remove project");
    },
  );

  it("omits unavailable optional actions from both menus", () => {
    const limitedActions = { onOpenSettings: vi.fn(), onRemove: vi.fn() };
    for (const Menu of [ProjectContextMenu, ProjectDropdownMenu]) {
      const markup = renderToStaticMarkup(
        <Menu actions={limitedActions}>
          <button>Project</button>
        </Menu>,
      );
      expect(markup).not.toContain("Overview");
      expect(markup).not.toContain("Reveal in Finder");
      expect(markup).toContain("Project Settings");
      expect(markup).toContain("Remove project");
    }
  });
});
