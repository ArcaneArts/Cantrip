import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectSwitcher } from "./project-switcher";

const recency = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/lib/project-recency", () => ({
  useRecentProjectIds: () => recency.ids,
  recordProjectAccess: vi.fn(),
}));
beforeEach(() => {
  recency.ids = [];
});

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
  it("renders the most recently accessed project at the top of the picker", () => {
    recency.ids = ["project-2", "project-1"];
    const markup = renderToStaticMarkup(
      <ProjectSwitcher
        activeWorkspaceId="default"
        projects={projects}
        selectedProjectId={null}
        workspaces={[
          { ...workspaces[0]!, projectIds: ["project-1", "project-2"] },
        ]}
        onAddProject={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onOpenProjectSettings={vi.fn()}
        onRemoveProject={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );
    expect(markup.indexOf(">CareMap<")).toBeGreaterThan(-1);
    expect(markup.indexOf(">CareMap<")).toBeLessThan(
      markup.indexOf(">Cantrip<"),
    );
  });

  it("shows the remembered workspace above the selected project", () => {
    const markup = renderToStaticMarkup(
      <ProjectSwitcher
        activeWorkspaceId="client"
        projects={projects}
        selectedProjectId="project-2"
        workspaces={workspaces}
        onAddProject={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onOpenProjectSettings={vi.fn()}
        onRemoveProject={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Switch project"');
    expect(markup).toContain("Client work");
    expect(markup).toContain("CareMap");
    expect(markup).toContain('aria-label="Project actions for CareMap"');
    expect(markup).not.toContain('aria-label="Add tab');
    expect(markup).not.toContain('aria-label="Add project to Client work"');
    expect(markup).toContain('data-slot="project-switcher-footer"');
    expect(markup).toContain("justify-between");
    expect(markup).toContain('aria-label="Manage workspaces"');
    expect(markup).not.toContain(">Manage<");
    expect(markup).toContain("New project");
    expect(markup).not.toContain("New workspace");
    expect(markup.match(/data-slot="project-switcher-project"/g)).toHaveLength(
      1,
    );
  });

  it("hides project actions when no project is selected", () => {
    const markup = renderToStaticMarkup(
      <ProjectSwitcher
        activeWorkspaceId="client"
        projects={projects}
        selectedProjectId={null}
        workspaces={workspaces}
        onAddProject={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onOpenProjectSettings={vi.fn()}
        onRemoveProject={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain("Select project");
    expect(markup).not.toContain('aria-label="Project actions');
    expect(markup).not.toContain('aria-label="Add tab');
    expect(markup).not.toContain("Select a project before adding a tab");
  });

  it("offers project actions beside the current project instead of a tab picker", () => {
    const markup = renderToStaticMarkup(
      <ProjectSwitcher
        activeWorkspaceId="default"
        projects={projects}
        selectedProjectId="project-1"
        workspaces={workspaces}
        onAddProject={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onOpenProjectSettings={vi.fn()}
        onRemoveProject={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Project actions for Cantrip"');
    expect(markup).not.toContain('aria-label="Choose tab');
    expect(markup).not.toContain('aria-label="Add tab to Cantrip"');
  });
});
