import { describe, expect, it } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";

import {
  MAX_MOBILE_PROJECT_SURFACES,
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

  it("represents each worktree with one Explorer instead of file tabs", () => {
    const root = explorer("explorer:root", null);
    const firstFile = explorer("explorer:first-file", "src/first.ts");
    const secondFile = explorer("explorer:second-file", "src/second.ts");

    expect(
      mobileProjectSurfaces([chat, firstFile, root, secondFile], "chat:one"),
    ).toEqual([chat, root]);
  });

  it("keeps the active Explorer destination stable while browsing a file", () => {
    const root = explorer("explorer:root", null);
    const activeFile = explorer("explorer:file", "src/file.ts");

    expect(
      mobileProjectSurfaces([root, activeFile], activeFile.tabKey),
    ).toEqual([activeFile]);
  });

  it("bounds compact navigation to the active surface and recent placements", () => {
    const surfaces = Array.from(
      { length: 8 },
      (_, index) =>
        ({ kind: "chat", tabKey: `chat:${index}` }) as ProjectSurface,
    );
    const result = mobileProjectSurfaces(surfaces, "chat:0");

    expect(result).toHaveLength(MAX_MOBILE_PROJECT_SURFACES);
    expect(result.map(({ tabKey }) => tabKey)).toEqual([
      "chat:0",
      "chat:4",
      "chat:5",
      "chat:6",
      "chat:7",
    ]);
    expect(surfaces.map(({ tabKey }) => tabKey)).toEqual(
      Array.from({ length: 8 }, (_, index) => `chat:${index}`),
    );
  });
});
