import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  projectsInWorkspace,
  resolveProjectWorkspace,
  searchProjects,
} from "./project-workspaces";

const projects = [
  { id: "project-1", name: "Cantrip" },
  { id: "project-2", name: "Iris" },
  { id: "project-3", name: "CareMap" },
] as ProjectSummary[];

const workspaces = [
  {
    id: "default",
    name: "Default",
    isDefault: true,
    projectIds: ["project-1", "project-2"],
  },
  {
    id: "personal",
    name: "Personal",
    isDefault: false,
    projectIds: ["project-2", "project-3"],
  },
] as ProjectWorkspaceSummary[];

describe("project workspace filtering", () => {
  it("resolves the stored workspace and falls back to Default", () => {
    expect(resolveProjectWorkspace(workspaces, "personal")?.id).toBe(
      "personal",
    );
    expect(resolveProjectWorkspace(workspaces, "missing")?.id).toBe("default");
  });

  it("shows the same project in every workspace that contains it", () => {
    expect(
      projectsInWorkspace(
        projects,
        resolveProjectWorkspace(workspaces, "default"),
      ).map(({ id }) => id),
    ).toEqual(["project-1", "project-2"]);
    expect(
      projectsInWorkspace(
        projects,
        resolveProjectWorkspace(workspaces, "personal"),
      ).map(({ id }) => id),
    ).toEqual(["project-2", "project-3"]);
  });

  it("keeps an empty search inside the active workspace", () => {
    const results = searchProjects(
      projects,
      workspaces,
      resolveProjectWorkspace(workspaces, "personal"),
      "  ",
    );

    expect(results.map(({ project }) => project.id)).toEqual([
      "project-2",
      "project-3",
    ]);
    expect(results[0]?.memberships.map(({ id }) => id)).toEqual([
      "default",
      "personal",
    ]);
  });

  it("searches project, repository, source, and workspace names globally", () => {
    const detailedProjects = projects.map((project) => ({
      ...project,
      github:
        project.id === "project-1"
          ? { nameWithOwner: "ArcaneArts/Cantrip" }
          : null,
      source:
        project.id === "project-3"
          ? { displayPath: "~/development/CareMap" }
          : null,
    })) as ProjectSummary[];
    const active = resolveProjectWorkspace(workspaces, "default");

    expect(
      searchProjects(detailedProjects, workspaces, active, "care").map(
        ({ project }) => project.id,
      ),
    ).toEqual(["project-3"]);
    expect(
      searchProjects(detailedProjects, workspaces, active, "arcanearts").map(
        ({ project }) => project.id,
      ),
    ).toEqual(["project-1"]);
    expect(
      searchProjects(detailedProjects, workspaces, active, "development").map(
        ({ project }) => project.id,
      ),
    ).toEqual(["project-3"]);
    expect(
      searchProjects(detailedProjects, workspaces, active, "personal").map(
        ({ project }) => project.id,
      ),
    ).toEqual(["project-2", "project-3"]);
  });

  it("returns no results when a global query matches no project metadata", () => {
    expect(
      searchProjects(projects, workspaces, workspaces[0]!, "missing"),
    ).toEqual([]);
  });
});
