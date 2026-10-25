import { describe, expect, it } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";

import {
  mobileProjectShellModel,
  mobileProjectSurfaces,
} from "./mobile-project-navigation";

function model(
  overrides: Partial<Parameters<typeof mobileProjectShellModel>[0]> = {},
) {
  return mobileProjectShellModel({
    appMode: "chat",
    compactShell: true,
    projectOverviewSelected: true,
    selectedProject: true,
    selectedProjectId: "project-1",
    showArchivedStandaloneChats: false,
    showImporter: false,
    showProjectSettings: false,
    showServerAdmin: false,
    showSettings: false,
    ...overrides,
  });
}

describe("mobileProjectShellModel", () => {
  it("does not retain the project header after switching to Chat", () => {
    expect(model().compactManagedHeader).toBe(false);
  });

  it("uses one managed header for Chat destinations", () => {
    expect(
      model({ showArchivedStandaloneChats: true }).compactManagedHeader,
    ).toBe(true);
    expect(model({ showSettings: true }).compactManagedHeader).toBe(true);
    expect(model({ showServerAdmin: true }).compactManagedHeader).toBe(true);
  });

  it("keeps the managed project header in compact IDE mode", () => {
    expect(model({ appMode: "ide" }).compactManagedHeader).toBe(true);
  });
});

describe("mobileProjectSurfaces", () => {
  const explorer = (
    tabKey: string,
    selectedPath: string | null,
    worktreeId = "worktree-1",
  ) =>
    ({
      entity: { selectedPath, worktreeId },
      kind: "explorer",
      tabKey,
    }) as ProjectSurface;
  const chat = { kind: "chat", tabKey: "chat:one" } as ProjectSurface;

  it("does not duplicate the dedicated Overview destination", () => {
    const overview = {
      entity: { definitionId: "project.overview" },
      kind: "builtin",
      tabKey: "builtin:overview",
    } as ProjectSurface;
    const tasks = {
      entity: { definitionId: "project.tasks" },
      kind: "builtin",
      tabKey: "builtin:tasks",
    } as ProjectSurface;

    expect(mobileProjectSurfaces([overview, tasks, chat])).toEqual([
      tasks,
      chat,
    ]);
  });

  it("preserves distinct file and Explorer tabs within one worktree", () => {
    const root = explorer("explorer:root", null);
    const firstFile = explorer("explorer:first-file", "src/first.ts");
    const secondFile = explorer("explorer:second-file", "src/second.ts");

    expect(mobileProjectSurfaces([chat, firstFile, root, secondFile])).toEqual([
      chat,
      firstFile,
      root,
      secondFile,
    ]);
  });

  it("keeps the active Explorer destination stable while browsing a file", () => {
    const root = explorer("explorer:root", null);
    const activeFile = explorer("explorer:file", "src/file.ts");

    expect(mobileProjectSurfaces([root, activeFile])).toEqual([
      root,
      activeFile,
    ]);
  });

  it("keeps every view in layout order rather than treating placement order as recency", () => {
    const surfaces = Array.from(
      { length: 8 },
      (_, index) =>
        ({ kind: "chat", tabKey: `chat:${index}` }) as ProjectSurface,
    );
    const result = mobileProjectSurfaces(surfaces);

    expect(result).toEqual(surfaces);
    expect(surfaces.map(({ tabKey }) => tabKey)).toEqual(
      Array.from({ length: 8 }, (_, index) => `chat:${index}`),
    );
  });

  it("retains unresolved views and handles an empty workspace", () => {
    const unresolved = {
      kind: "unresolved",
      tabKey: "loading-view",
      entity: null,
    } as ProjectSurface;
    expect(mobileProjectSurfaces([unresolved])).toEqual([unresolved]);
    expect(mobileProjectSurfaces([])).toEqual([]);
  });
});
