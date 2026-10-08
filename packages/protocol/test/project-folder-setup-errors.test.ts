import { describe, expect, it } from "vitest";
import { projectFolderSetupJobErrorSchema } from "../src/project-provisioning.js";

describe("safe existing-folder setup reasons", () => {
  it.each([
    "existing-path-missing",
    "existing-path-not-directory",
    "existing-path-permission-denied",
    "attachment-failed",
  ])("retains %s without raw worker diagnostics", (code) => {
    expect(
      projectFolderSetupJobErrorSchema.parse({
        code,
        retryable: false,
        message: "Private worker path and raw diagnostics",
      }),
    ).toEqual({ code, retryable: false });
  });
});
