import type { SkillSummary } from "@cantrip/protocol";
import {
  workflowAutomationTriggerSchema,
  workflowDefinitionSummarySchema,
} from "@cantrip/protocol/workflows";
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
const command = workflowAutomationTriggerSchema.parse({
  id: "trigger-1",
  workflowId: "workflow-1",
  workflowRevisionId: "revision-1",
  ownerId: "owner-1",
  projectId: "project-1",
  name: "Release now",
  type: "saved-command",
  enabled: true,
  configuration: { command: "release-now", minimumIntervalSeconds: 1 },
  structuredInput: {},
  budget: {},
  permissionManifest: { approvalMode: "preauthorized" },
  selectedModelRouteId: null,
  selectedPermissionProfileId: null,
  nextRunAt: null,
  lastDeliveredAt: null,
  lastRunId: null,
  lastError: null,
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
      [command],
    );
    expect(suggestions.map(({ invocation }) => invocation)).toEqual(
      expect.arrayContaining([
        "/compact",
        "/project/release",
        "/command/release-now",
        "$release-readiness-gate",
      ]),
    );
  });

  it("omits disabled and cross-project saved commands", () => {
    const disabled = { ...command, enabled: false };
    expect(
      filterCommandPalette("command", skills, [workflow], "project-1", [
        disabled,
      ]).some(({ kind }) => kind === "saved-command"),
    ).toBe(false);
    expect(
      filterCommandPalette("command", skills, [workflow], "project-2", [
        command,
      ]).some(({ kind }) => kind === "saved-command"),
    ).toBe(false);
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
