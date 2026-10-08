import { describe, expect, it } from "vitest";
import type { ProjectFolderSetupJobError } from "@cantrip/protocol";
import {
  projectFolderSetupErrorMessage,
  projectSetupErrorMessage,
} from "./job-status-message";
describe("folder attachment failure messages", () => {
  it.each([
    ["existing-path-missing", "does not exist"],
    ["existing-path-not-directory", "not a directory"],
    ["existing-path-permission-denied", "permission"],
    ["attachment-failed", "attach the existing folder"],
  ])("presents safe actionable reason %s", (code, expected) => {
    const message = projectFolderSetupErrorMessage(
      code as ProjectFolderSetupJobError["code"],
    );
    expect(message).toContain(expected);
    expect(message).toContain("owning worker");
    expect(projectSetupErrorMessage(code)).toBe(message);
  });
  it("distinguishes existing-folder fallback from managed creation and offline state", () => {
    expect(
      projectFolderSetupErrorMessage("materialization-failed", "existing"),
    ).toContain("attach the existing folder");
    expect(projectFolderSetupErrorMessage("materialization-failed")).toContain(
      "create the managed folder",
    );
    expect(
      projectFolderSetupErrorMessage("worker-offline", "existing"),
    ).toContain("offline");
    expect(
      projectFolderSetupErrorMessage("capability-missing", "existing"),
    ).toContain("folder attachment");
  });
});
