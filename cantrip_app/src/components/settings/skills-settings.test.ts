import type { SkillSettingsItem } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { skillMatchesSearch } from "./skills-settings";

const skill: SkillSettingsItem = {
  id: "project:image-tools",
  name: "image-tools",
  displayName: "Image Tools",
  description: "Generate and inspect raster assets.",
  scope: "repo",
  location: "project",
  path: "/workspace/.agents/skills/image-tools/SKILL.md",
  editable: true,
  deletable: true,
};

describe("skills settings search", () => {
  it("matches skill identity, description, path, and scope labels", () => {
    expect(skillMatchesSearch(skill, "image tools")).toBe(true);
    expect(skillMatchesSearch(skill, "raster")).toBe(true);
    expect(skillMatchesSearch(skill, ".agents/skills")).toBe(true);
    expect(skillMatchesSearch(skill, "project")).toBe(true);
    expect(skillMatchesSearch(skill, "database")).toBe(false);
  });
});
