// @vitest-environment jsdom
import {
  projectSummarySchema,
  projectWorkspaceSummarySchema,
  type WorkspaceRepositoryCandidateSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceSettings,
  promoteDefaultWorkspace,
  workspaceDeletionDescription,
} from "./workspace-settings";

const now = "2026-08-16T12:00:00.000Z";
const mainWorkspace = projectWorkspaceSummarySchema.parse({
  id: "workspace-main",
  name: "Main Workspace",
  storage: { kind: "system" },
  position: 0,
  isDefault: true,
  projectIds: [],
  revision: 1,
  createdAt: now,
  updatedAt: now,
});
const personalWorkspace = projectWorkspaceSummarySchema.parse({
  id: "workspace-personal",
  name: "Personal",
  storage: { kind: "managed" },
  position: 1,
  isDefault: false,
  projectIds: ["project-cantrip"],
  revision: 1,
  createdAt: now,
  updatedAt: now,
});
const attachedWorkspace = projectWorkspaceSummarySchema.parse({
  ...personalWorkspace,
  id: "workspace-attached",
  name: "Attached",
  storage: {
    kind: "attached",
    workerId: "worker-1",
    rootPathHandle: `ctrr_${"a".repeat(43)}`,
    displayHandle: `ctrr_${"b".repeat(43)}`,
  },
});
const cantripProject = projectSummarySchema.parse({
  id: "project-cantrip",
  name: "Cantrip",
  position: 0,
  setupStatus: "ready",
  setupError: null,
  worktreePolicy: "agent-managed",
  source: null,
  github: null,
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

  it("explains that workspace deletion removes project records but preserves files", () => {
    expect(workspaceDeletionDescription(personalWorkspace)).toBe(
      "This removes the workspace and its 1 project from Cantrip. Repository, worktree, and attached-folder files remain untouched.",
    );
    expect(workspaceDeletionDescription(mainWorkspace)).toBe(
      "This removes the workspace from Cantrip. Repository, worktree, and attached-folder files remain untouched.",
    );
  });

  it("allows every workspace to be renamed and only non-defaults promoted", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["projects"], [cantripProject]);
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
    expect(markup).toContain("Workspace management");
    expect(markup).toContain("Project workspaces");
    expect(markup).toContain("Cantrip");
    expect(markup).toContain("Personal");
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).toContain("Policies");
  });

  it("does not offer attached workspaces as default destinations", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["projects"], []);
    queryClient.setQueryData(
      ["project-workspaces"],
      [mainWorkspace, attachedWorkspace],
    );

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSettings />
      </QueryClientProvider>,
    );

    expect(markup).not.toContain("Make Attached the default workspace");
    expect(markup).toContain("Delete Attached");
    expect(markup).toContain("Import more");
  });

  it("only offers repository discovery for attached workspaces", () => {
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

    expect(markup).not.toContain("Repositories");
  });

  it("updates the attached workspace's remaining imports with the review closed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["projects"], []);
    queryClient.setQueryData(["workers"], []);
    queryClient.setQueryData(
      ["project-workspaces"],
      [personalWorkspace, attachedWorkspace],
    );
    const publishImports = (
      ...states: WorkspaceRepositoryCandidateSummary["importState"][]
    ) =>
      queryClient.setQueryData(
        ["workspace-repository-discovery", attachedWorkspace.id],
        { candidates: states.map((importState) => ({ importState })) },
      );
    publishImports("pending", "imported");

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const status = () => host.querySelector('[role="status"]');
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <WorkspaceSettings />
          </QueryClientProvider>,
        ),
      );
      expect(status()).toBeNull();

      await act(async () => {
        publishImports("queued", "importing", "pending", "imported");
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(status()?.textContent).toBe("Importing repositories… 2 remaining");
      expect(status()?.parentElement?.textContent).toContain("Attached");
      expect(host.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => {
        publishImports("imported", "importing", "pending", "imported");
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(status()?.textContent).toBe("Importing repositories… 1 remaining");

      await act(async () => {
        publishImports("imported", "failed", "pending", "imported");
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(status()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      queryClient.clear();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
