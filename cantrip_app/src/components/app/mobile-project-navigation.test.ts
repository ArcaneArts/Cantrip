import { describe, expect, it } from "vitest";

import { mobileProjectShellModel } from "./mobile-project-navigation";

function model(
  overrides: Partial<Parameters<typeof mobileProjectShellModel>[0]> = {},
) {
  return mobileProjectShellModel({
    appMode: "chat",
    compactShell: true,
    mobileTabGridOpen: false,
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
