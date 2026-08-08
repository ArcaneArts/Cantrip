import { codexCustomizationInventorySchema } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  boundedResourceText,
  customizationCapabilityRows,
  parseSkillRootsDraft,
  selectableExternalImportIds,
} from "./customization-panel";

const available = {
  available: true,
  reason: null,
  stability: "stable" as const,
};
const unsupported = {
  available: false,
  reason: "No native App Server method was reported.",
  stability: "unsupported" as const,
};

describe("Codex customization inspection", () => {
  it("presents independently negotiated read and write capabilities", () => {
    const inventory = codexCustomizationInventorySchema.parse({
      capabilities: {
        isolatedCodexHome: true,
        collaborationModes: available,
        threadGoals: available,
        nativeSubagents: available,
        customAgents: unsupported,
        hooks: available,
        skills: {
          list: available,
          configure: unsupported,
          extraRoots: unsupported,
        },
        mcp: {
          status: available,
          resourceRead: available,
          oauth: unsupported,
          reload: unsupported,
        },
        plugins: {
          list: unsupported,
          read: unsupported,
          install: unsupported,
          uninstall: unsupported,
        },
        externalImports: { detect: available, apply: unsupported },
      },
      skills: { items: [], errors: [] },
      hooks: { items: [], warnings: [], errors: [] },
      mcpServers: [],
    });

    const rows = customizationCapabilityRows(inventory);
    expect(rows).toHaveLength(18);
    expect(
      rows.find(({ label }) => label === "Native subagents")?.capability,
    ).toMatchObject({ available: true, stability: "stable" });
    expect(
      rows.find(({ label }) => label === "Custom agents")?.capability,
    ).toMatchObject({ available: false, stability: "unsupported" });
    expect(
      rows.find(({ label }) => label === "List skills")?.capability.available,
    ).toBe(true);
    expect(
      rows.find(({ label }) => label === "Configure skills")?.capability
        .available,
    ).toBe(false);
  });

  it("bounds text resource rendering without changing short content", () => {
    expect(boundedResourceText("small", 8)).toEqual({
      text: "small",
      truncated: false,
    });
    expect(boundedResourceText("0123456789", 5)).toEqual({
      text: "01234",
      truncated: true,
    });
  });

  it("normalizes a process-scoped skill roots draft", () => {
    expect(
      parseSkillRootsDraft(
        "  .agents/skills\nshared/skills\r\n.agents/skills\n\n",
      ),
    ).toEqual([".agents/skills", "shared/skills"]);
  });

  it("only selects external candidates that contain no plugin data", () => {
    const baseDetails = {
      skillNames: [],
      pluginNames: [],
      mcpServerNames: [],
      hookNames: [],
      subagentNames: [],
      commandNames: [],
      memoryFiles: [],
      sessionCount: 0,
    };
    expect(
      selectableExternalImportIds([
        {
          id: "commands",
          itemType: "COMMANDS",
          description: "Project commands",
          cwd: null,
          details: baseDetails,
        },
        {
          id: "plugins",
          itemType: "PLUGINS",
          description: "Project plugins",
          cwd: null,
          details: { ...baseDetails, pluginNames: ["example"] },
        },
        {
          id: "mixed",
          itemType: "SKILLS",
          description: "Skills with plugin metadata",
          cwd: null,
          details: { ...baseDetails, pluginNames: ["embedded"] },
        },
      ]),
    ).toEqual(["commands"]);
  });
});
