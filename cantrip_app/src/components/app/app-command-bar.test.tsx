import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppCommandBar } from "./app-command-bar";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: PropsWithChildren) => <>{children}</>,
  DialogContent: ({
    children,
    className,
    showClose: _showClose,
    ...props
  }: PropsWithChildren<ComponentProps<"div"> & { showClose?: boolean }>) => (
    <div className={className} {...props}>
      {children}
    </div>
  ),
  DialogDescription: ({ children }: PropsWithChildren) => <p>{children}</p>,
  DialogTitle: ({ children }: PropsWithChildren) => <h2>{children}</h2>,
}));
vi.mock("@/lib/api", () => ({
  getCachedGithubRepositories: vi.fn(),
  getGithubRepositories: vi.fn(),
  getGithubStatus: vi.fn(),
  getProjectScriptCommands: vi.fn(),
}));
vi.mock("@/lib/project-encryption", () => ({
  createGithubProject: vi.fn(),
  createManagedFolderProject: vi.fn(),
}));
vi.mock("@/components/projects/repository-import-options-dialog", () => ({
  RepositoryImportOptionsDialog: () => null,
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
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["project-script-commands", "project-cantrip", "worktree-cantrip"],
      [
        {
          id: "package:package.json:dev",
          kind: "package",
          name: "dev",
          command: "pnpm run dev",
          description: "vite --host 0.0.0.0",
          source: "package.json",
        },
      ],
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
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
          onRunScriptCommand={vi.fn()}
          onSelectProject={vi.fn()}
          scriptWorktreeId="worktree-cantrip"
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Search actions, scripts, or projects…");
    expect(markup).toContain("self-start");
    expect(markup).toContain('data-elite-ignore=""');
    expect(markup).not.toContain("top-[15vh]");
    expect(markup).toContain("Projects");
    expect(markup).toContain("Project scripts");
    expect(markup).toContain("pnpm run dev");
    expect(markup).toContain("ArcaneArts/Cantrip · Primary");
    expect(markup).toContain("ArcaneArts/CareMap · Other Workspace");
  });
});
