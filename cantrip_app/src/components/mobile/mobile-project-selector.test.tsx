import type {
  ProjectFolderSetupJobSummary,
  ProjectReplicaJobSummary,
  ProjectSummary,
  ProjectWorkspaceSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { MobileProjectHeader } from "./mobile-project-header";
import { MobileProjectSelector } from "./mobile-project-selector";

const projects = [
  {
    id: "project-1",
    name: "Cantrip",
    originKind: "github",
    capabilities: {
      git: true,
      github: true,
      worktrees: true,
      replicas: true,
      relocation: true,
    },
    setupStatus: "ready",
    github: { nameWithOwner: "ArcaneArts/Cantrip" },
    source: { workerId: "worker-1", displayPath: "~/Cantrip" },
  },
  {
    id: "project-2",
    name: "CareMap",
    originKind: "github",
    capabilities: {
      git: true,
      github: true,
      worktrees: true,
      replicas: true,
      relocation: true,
    },
    setupStatus: "ready",
    github: { nameWithOwner: "ArcaneArts/CareMap" },
    source: { workerId: "worker-1", displayPath: "~/CareMap" },
  },
] as ProjectSummary[];
const workspaces = [
  {
    id: "default",
    name: "Default",
    isDefault: true,
    projectIds: ["project-1"],
  },
  {
    id: "other",
    name: "Other",
    isDefault: false,
    projectIds: ["project-2"],
  },
] as ProjectWorkspaceSummary[];
const workers = [
  { workerId: "worker-1", name: "Local Worker", online: true },
] as WorkerSummary[];

function renderMobile(children: ReactNode) {
  return renderToStaticMarkup(
    <TooltipProvider delayDuration={0}>{children}</TooltipProvider>,
  );
}

describe("mobile project selector", () => {
  it("renders root controls and only the active workspace before search", () => {
    const markup = renderMobile(
      <MobileProjectSelector
        activeWorkspace={workspaces[0]!}
        currentUserName="Local User"
        loading={false}
        projects={projects}
        workers={workers}
        workspaces={workspaces}
        onCreateWorkspace={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onNewProject={vi.fn()}
        onOpenAdmin={vi.fn()}
        onOpenSettings={vi.fn()}
        onSwitchChat={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain("Local Worker online");
    expect(markup).toContain('aria-label="Search projects"');
    expect(markup).toContain("Add project to Default");
    expect(markup).not.toContain("New Project");
    expect(markup).toContain('aria-label="Open settings"');
    expect(markup).toContain('aria-label="Switch to Chats"');
    expect(markup).toContain("ArcaneArts/Cantrip");
    expect(markup).not.toContain("ArcaneArts/CareMap");
  });

  it("shows durable clone progress for a project that is being prepared", () => {
    const project = {
      ...projects[0]!,
      setupStatus: "cloning",
    } as ProjectSummary;
    const setupJob = {
      id: "setup-job",
      kind: "provision",
      progress: { percent: 47 },
    } as ProjectReplicaJobSummary;
    const markup = renderMobile(
      <MobileProjectSelector
        activeWorkspace={workspaces[0]!}
        currentUserName="Local User"
        loading={false}
        projects={[project]}
        projectSetupJobs={new Map([[project.id, setupJob]])}
        workers={workers}
        workspaces={workspaces}
        onCreateWorkspace={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onNewProject={vi.fn()}
        onOpenAdmin={vi.fn()}
        onOpenSettings={vi.fn()}
        onSwitchChat={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain("Cloning · 47%");
  });

  it("shows worker-bound folder preparation and offline recovery states", () => {
    const project = {
      ...projects[0]!,
      originKind: "managed-folder",
      capabilities: {
        git: false,
        github: false,
        worktrees: false,
        replicas: false,
        relocation: false,
      },
      github: null,
      setupStatus: "preparing",
      source: null,
    } as ProjectSummary;
    const setupJob = {
      state: "blocked",
      error: {
        code: "worker-offline",
        retryable: true,
      },
    } as ProjectFolderSetupJobSummary;
    const markup = renderMobile(
      <MobileProjectSelector
        activeWorkspace={workspaces[0]!}
        currentUserName="Local User"
        folderSetupJobs={new Map([[project.id, setupJob]])}
        loading={false}
        projects={[project]}
        workers={workers}
        workspaces={workspaces}
        onCreateWorkspace={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onNewProject={vi.fn()}
        onOpenAdmin={vi.fn()}
        onOpenSettings={vi.fn()}
        onSwitchChat={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain("Worker offline");
    expect(markup).toContain("lucide-folder");
    expect(markup).not.toContain("lucide-folder-git");
  });

  it("keeps local Git projects available through an online secondary source", () => {
    const project = {
      ...projects[0]!,
      originKind: "managed-folder",
      folderManagement: "external",
      capabilities: {
        git: true,
        github: false,
        worktrees: false,
        replicas: false,
        relocation: false,
      },
      github: null,
      replicas: [
        { workerId: "worker-1", ready: true },
        { workerId: "worker-2", ready: true },
      ],
    } as ProjectSummary;
    const markup = renderMobile(
      <MobileProjectSelector
        activeWorkspace={workspaces[0]!}
        currentUserName="Local User"
        loading={false}
        projects={[project]}
        workers={
          [
            { workerId: "worker-1", name: "Home", online: false },
            { workerId: "worker-2", name: "Replica", online: true },
          ] as WorkerSummary[]
        }
        workspaces={workspaces}
        onCreateWorkspace={vi.fn()}
        onManageWorkspaces={vi.fn()}
        onNewProject={vi.fn()}
        onOpenAdmin={vi.fn()}
        onOpenSettings={vi.fn()}
        onSwitchChat={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectWorkspace={vi.fn()}
      />,
    );

    expect(markup).toContain("Ready");
    expect(markup).toContain("lucide-folder-git");
    expect(markup).not.toContain("Worker offline");
  });

  it("exposes project settings and close actions in the overview header", () => {
    const markup = renderMobile(
      <MobileProjectHeader
        context="ArcaneArts/Cantrip"
        onCloseProject={vi.fn()}
        onOpenProjectSettings={vi.fn()}
        title="Cantrip"
      />,
    );

    expect(markup).toContain('aria-label="Project settings"');
    expect(markup).toContain('aria-label="Close project"');
    expect(markup.indexOf('aria-label="Close project"')).toBeLessThan(
      markup.indexOf("Cantrip"),
    );
  });

  it("keeps project actions in the compact header", () => {
    const markup = renderMobile(
      <MobileProjectHeader
        actions={
          <div data-run-configuration-control="true">Run configuration</div>
        }
        context="ArcaneArts/Cantrip"
        title="Cantrip"
      />,
    );

    expect(markup).toContain('data-slot="mobile-project-header-actions"');
    expect(markup).toContain('data-run-configuration-control="true"');
    expect(markup).toContain("Run configuration");
  });

  it("exposes a compact app mode switch after project actions", () => {
    const markup = renderMobile(
      <MobileProjectHeader
        actions={<div data-run-configuration-control="true" />}
        appMode="ide"
        onSwitchAppMode={vi.fn()}
        title="Cantrip"
      />,
    );

    expect(markup).toContain('aria-label="Switch to Chats"');
    expect(
      markup.indexOf('data-run-configuration-control="true"'),
    ).toBeLessThan(markup.indexOf('aria-label="Switch to Chats"'));
  });

  it("offers a return to the IDE from compact Chat headers", () => {
    const markup = renderMobile(
      <MobileProjectHeader
        appMode="chat"
        onSwitchAppMode={vi.fn()}
        title="Standalone chat"
      />,
    );

    expect(markup).toContain('aria-label="Switch to IDE"');
  });

  it("keeps the Run control at the right edge after project settings", () => {
    const markup = renderMobile(
      <MobileProjectHeader
        actions={<div data-run-configuration-control="true" />}
        onOpenProjectSettings={vi.fn()}
        title="Cantrip"
      />,
    );

    expect(markup.indexOf('aria-label="Project settings"')).toBeLessThan(
      markup.indexOf('data-run-configuration-control="true"'),
    );
  });
});
