import type { SkillSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  activeSkillMention,
  filterSkills,
  insertSkillMention,
  skillMentionSegments,
} from "./skill-mentions";

const skills: SkillSummary[] = [
  {
    name: "skill-creator",
    displayName: "Skill Creator",
    description: "Create reusable skills",
  },
  {
    name: "browser:control-in-app-browser",
    displayName: "Browser control",
    description: "Control the in-app browser",
  },
];

describe("skill mentions", () => {
  it("finds a mention at the caret anywhere in a prompt", () => {
    expect(activeSkillMention("Use $skill-cr please", 13)).toEqual({
      start: 4,
      end: 13,
      query: "skill-cr",
    });
    expect(activeSkillMention("costs$20", 8)).toBeNull();
  });

  it("ranks names and supports plugin-prefixed skills", () => {
    expect(filterSkills(skills, "skill")[0]?.name).toBe("skill-creator");
    expect(filterSkills(skills, "browser:")[0]?.name).toBe(
      "browser:control-in-app-browser",
    );
  });

  it("replaces the active token without sending the prompt", () => {
    const mention = activeSkillMention("Use $skill-cr please", 13);
    expect(mention).not.toBeNull();
    expect(
      insertSkillMention("Use $skill-cr please", mention!, "skill-creator"),
    ).toEqual({
      text: "Use $skill-creator please",
      caret: 19,
    });
  });

  it("marks only complete, available skill tags for highlighting", () => {
    expect(
      skillMentionSegments(
        "$skill-creator then $missing and $browser:control-in-app-browser",
        skills,
      ).filter((segment) => segment.skill),
    ).toMatchObject([
      { text: "$skill-creator", skill: { name: "skill-creator" } },
      {
        text: "$browser:control-in-app-browser",
        skill: { name: "browser:control-in-app-browser" },
      },
    ]);
  });
});
