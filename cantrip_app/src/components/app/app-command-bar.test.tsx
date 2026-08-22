import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppCommandBar } from "./app-command-bar";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: PropsWithChildren) => <>{children}</>,
  DialogContent: ({
    children,
    className,
  }: PropsWithChildren<{ className?: string }>) => (
    <div className={className}>{children}</div>
  ),
  DialogDescription: ({ children }: PropsWithChildren) => <p>{children}</p>,
  DialogTitle: ({ children }: PropsWithChildren) => <h2>{children}</h2>,
}));
vi.mock("@/lib/api", () => ({
  getCachedGithubRepositories: vi.fn(),
  getGithubRepositories: vi.fn(),
  getGithubStatus: vi.fn(),
}));
vi.mock("@/lib/project-encryption", () => ({
  createGithubProject: vi.fn(),
  createManagedFolderProject: vi.fn(),
}));

const projects = [
  {
    id: "project-cantrip",
    name: "Cantrip",
    originKind: "github",
    setupStatus: "ready",
    github: { nameWithOwner: "ArcaneArts/Cantrip" },
  },
  {
    id: "project-caremap",
    name: "CareMap",
    originKind: "github",
    setupStatus: "ready",
    github: { nameWithOwner: "ArcaneArts/CareMap" },
  },
] as ProjectSummary[];

const workspaces = [
  {
    id: "primary",
    name: "Primary",
    isDefault: true,
    projectIds: ["project-cantrip"],
  },
  {
    id: "other",
    name: "Other Workspace",
    isDefault: false,
    projectIds: ["project-caremap"],
  },
] as ProjectWorkspaceSummary[];

describe("app command bar", () => {
  it("includes projects from every workspace in the default search scope", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AppCommandBar
          activeWorkspaceId="primary"
          context={{ projectId: "project-cantrip" }}
          currentProjectId="project-cantrip"
          defaultWorkerId={null}
          open
          projects={projects}
          workers={[]}
          workspaces={workspaces}
          onAction={vi.fn()}
          onCreatedProject={vi.fn()}
          onOpenChange={vi.fn()}
          onOpenFolder={vi.fn()}
          onSelectProject={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Search actions or projects…");
    expect(markup).toContain("self-start");
    expect(markup).not.toContain("top-[15vh]");
    expect(markup).toContain("Projects");
    expect(markup).toContain("ArcaneArts/Cantrip · Primary");
    expect(markup).toContain("ArcaneArts/CareMap · Other Workspace");
  });
});
