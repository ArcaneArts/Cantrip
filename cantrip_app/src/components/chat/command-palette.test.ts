import type { SkillSummary } from "@cantrip/protocol";
import { workflowDefinitionSummarySchema } from "@cantrip/protocol/workflows";
import { describe, expect, it } from "vitest";

import { filterCommandPalette } from "./command-palette";

const skills: SkillSummary[] = [
  {
    name: "release-readiness-gate",
    displayName: "Release readiness",
    description: "Produce a release decision.",
  },
];

const workflow = workflowDefinitionSummarySchema.parse({
  id: "workflow-1",
  ownerId: "owner-1",
  projectId: "project-1",
  scope: "project",
  slug: "release",
  name: "Release",
  description: "Run the release workflow.",
  source: "cantrip",
  provenance: {},
  trustState: "trusted",
  archivedAt: null,
  latestRevision: null,
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
});

describe("unified command palette", () => {
  it("combines namespaced built-ins, workflows, and skills", () => {
    const suggestions = filterCommandPalette(
      "",
      skills,
      [workflow],
      "project-1",
    );
    expect(suggestions.map(({ invocation }) => invocation)).toEqual(
      expect.arrayContaining([
        "/compact",
        "/project/release",
        "$release-readiness-gate",
      ]),
    );
  });

  it("keeps workflows scoped to the active project", () => {
    expect(
      filterCommandPalette("release", skills, [workflow], "project-2").map(
        ({ kind }) => kind,
      ),
    ).toEqual(["skill"]);
  });

  it("ranks an exact namespace prefix ahead of descriptive matches", () => {
    expect(
      filterCommandPalette("project/re", skills, [workflow], "project-1")[0],
    ).toMatchObject({ kind: "workflow", invocation: "/project/release" });
  });
});
