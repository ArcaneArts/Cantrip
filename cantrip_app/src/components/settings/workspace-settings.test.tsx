import { projectWorkspaceSummarySchema } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  WorkspaceSettings,
  promoteDefaultWorkspace,
} from "./workspace-settings";

const now = "2026-08-16T12:00:00.000Z";
const mainWorkspace = projectWorkspaceSummarySchema.parse({
  id: "workspace-main",
  name: "Main Workspace",
  position: 0,
  isDefault: true,
  projectIds: [],
  createdAt: now,
  updatedAt: now,
});
const personalWorkspace = projectWorkspaceSummarySchema.parse({
  id: "workspace-personal",
  name: "Personal",
  position: 1,
  isDefault: false,
  projectIds: [],
  createdAt: now,
  updatedAt: now,
});

describe("workspace settings", () => {
  it("transfers the cached default marker to a promoted workspace", () => {
    const promoted = { ...personalWorkspace, isDefault: true };

    expect(
      promoteDefaultWorkspace([mainWorkspace, personalWorkspace], promoted),
    ).toEqual([{ ...mainWorkspace, isDefault: false }, promoted]);
  });

  it("allows every workspace to be renamed and only non-defaults promoted", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["projects"], []);
    queryClient.setQueryData(
      ["project-workspaces"],
      [mainWorkspace, personalWorkspace],
    );

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSettings />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Rename Main Workspace");
    expect(markup).toContain("Rename Personal");
    expect(markup).toContain("Make Personal the default workspace");
    expect(markup).not.toContain("Make Main Workspace the default workspace");
    expect(markup).not.toContain("Delete Main Workspace");
    expect(markup).toContain("Delete Personal");
    expect(markup).toContain("Policies");
  });
});
