import type { SkillSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { filterCommandPalette } from "./command-palette";

const skills: SkillSummary[] = [
  {
    name: "release-readiness-gate",
    displayName: "Release readiness",
    description: "Produce a release decision.",
  },
];

describe("unified command palette", () => {
  it("combines built-ins and skills", () => {
    const suggestions = filterCommandPalette("", skills);
    expect(suggestions.map(({ invocation }) => invocation)).toEqual(
      expect.arrayContaining(["/compact", "$release-readiness-gate"]),
    );
  });

  it("ranks an exact command prefix ahead of descriptive matches", () => {
    expect(filterCommandPalette("compact", skills)[0]).toMatchObject({
      kind: "builtin",
      invocation: "/compact",
    });
  });
});
