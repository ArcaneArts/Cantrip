import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectSwitcher } from "./project-switcher";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const projects = [
  { id: "project-1", name: "Cantrip" },
  { id: "project-2", name: "CareMap" },
] as ProjectSummary[];
const workspaces = [
  {
    id: "default",
    isDefault: true,
    name: "Default",
    projectIds: ["project-1"],
  },
  {
    id: "client",
    isDefault: false,
    name: "Client work",
    projectIds: ["project-2"],
  },
] as ProjectWorkspaceSummary[];

describe("project switcher", () => {
  it("shows the remembered workspace above the selected project", () => {
    const markup = renderToStaticMarkup(
      <ProjectSwitcher
        activeWorkspaceId="client"
        projects={projects}
        selectedProjectId="project-2"
        workspaces={workspaces}
        onAddProject={vi.fn()}
        onCreateTab={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Switch project"');
    expect(markup).toContain("Client work");
    expect(markup).toContain("CareMap");
    expect(markup).toContain('aria-label="Add tab to CareMap"');
    expect(markup).not.toContain('aria-label="Add project to Client work"');
    expect(markup).toContain('data-slot="project-switcher-footer"');
    expect(markup).toContain("justify-between");
    expect(markup).toContain('aria-label="Manage workspaces"');
    expect(markup).not.toContain(">Manage<");
    expect(markup).toContain("New project");
    expect(markup).not.toContain("New workspace");
  });

  it("hides the add-tab action when no project is selected", () => {
    const markup = renderToStaticMarkup(
      <ProjectSwitcher
        activeWorkspaceId="client"
        projects={projects}
        selectedProjectId={null}
        workspaces={workspaces}
        onAddProject={vi.fn()}
        onCreateTab={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain("Select project");
    expect(markup).not.toContain('aria-label="Add tab');
    expect(markup).not.toContain("Select a project before adding a tab");
  });
});
