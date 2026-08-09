import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  projectsInWorkspace,
  resolveProjectWorkspace,
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
});
