import { describe, expect, it } from "vitest";

import {
  policyAssignmentUpdateSchema,
  policyCreateSchema,
  policyKeySchema,
  policyOrderUpdateSchema,
  policyTemplateDetailSchema,
  policyUpdateSchema,
} from "../src/policies.js";

describe("policy protocol", () => {
  it("accepts bounded policy documents and applies create defaults", () => {
    expect(
      policyCreateSchema.parse({
        key: "manual-change-protocol",
        name: "Manual Change Protocol",
        summary: "Read the policy before changing repository state.",
        bodyMarkdown: "# Manual Change Protocol\n\nUse an isolated lane.",
      }),
    ).toMatchObject({ enabled: true, mandatory: false });

    expect(policyKeySchema.safeParse("not--stable").success).toBe(false);
    expect(policyKeySchema.safeParse("Not-Stable").success).toBe(false);
    expect(
      policyCreateSchema.safeParse({
        key: "empty",
        name: "Empty",
        summary: "Summary",
        bodyMarkdown: "",
      }).success,
    ).toBe(false);
  });

  it("requires optimistic versions and actual policy updates", () => {
    expect(policyUpdateSchema.safeParse({ rowVersion: 1 }).success).toBe(false);
    expect(
      policyUpdateSchema.parse({ rowVersion: 2, mandatory: true }),
    ).toEqual({ rowVersion: 2, mandatory: true });
  });

  it("rejects duplicate order and assignment IDs", () => {
    expect(
      policyOrderUpdateSchema.safeParse({
        collectionVersion: 1,
        policyIds: ["one", "one"],
      }).success,
    ).toBe(false);
    expect(
      policyAssignmentUpdateSchema.safeParse({
        collectionVersion: 1,
        policyIds: ["one", "one"],
      }).success,
    ).toBe(false);
  });

  it("validates immutable packaged template metadata", () => {
    expect(
      policyTemplateDetailSchema.parse({
        templateKey: "manual-change-protocol",
        name: "Manual Change Protocol",
        suggestedPolicyKey: "manual-change-protocol",
        summary: "Read the full policy before changing a repository.",
        bodyMarkdown: "# Manual Change Protocol\n\nInspect before editing.",
        version: 1,
        suggestedEnabled: true,
        suggestedMandatory: true,
      }),
    ).toMatchObject({ version: 1, suggestedMandatory: true });
  });
});
