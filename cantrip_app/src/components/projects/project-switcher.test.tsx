import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectSwitcher } from "./project-switcher";

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
        onCreateWorkspace={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Switch project"');
    expect(markup).toContain("Client work");
    expect(markup).toContain("CareMap");
    expect(markup).toContain('aria-label="Add project to Client work"');
    expect(markup).not.toContain('title="Add project to Client work"');
  });
});
