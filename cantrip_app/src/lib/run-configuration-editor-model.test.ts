import { describe, expect, it } from "vitest";

import {
  createShellRunConfigurationDocument,
  parseShellRunConfigurationEditorDocument,
  shellRunConfigurationEffectiveCommand,
} from "./run-configuration-editor-model";

describe("Shell Run configuration editor model", () => {
  it("defaults Codex environment inheritance on", () => {
    const document = createShellRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(document.environment.includeCodexEnvironment).toBe(true);
    expect(document.workingDirectory).toBe(".");
  });

  it("always resolves the effective command and marks overrides", () => {
    const document = createShellRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000001",
    );
    document.target = {
      kind: "script",
      path: "tool/run.sh",
      interpreter: "bash",
    };
    document.arguments = ["--mode", "two words"];
    expect(shellRunConfigurationEffectiveCommand(document)).toEqual({
      command: 'bash tool/run.sh --mode "two words"',
      overridden: false,
    });
    document.commandOverride = "pnpm dev";
    expect(shellRunConfigurationEffectiveCommand(document)).toMatchObject({
      command: 'pnpm dev --mode "two words"',
      overridden: true,
    });
  });

  it("reports document and platform override validation errors", () => {
    const document = createShellRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(parseShellRunConfigurationEditorDocument(document, "{")).toEqual({
      success: false,
      errors: ["Platform overrides must be valid JSON."],
    });
    const parsed = parseShellRunConfigurationEditorDocument(document, "{}");
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.errors.join(" ")).toContain("name");
  });
});
