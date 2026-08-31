import { describe, expect, it } from "vitest";

import {
  POLICY_CONTEXT_BYTES_LIMIT,
  agentPolicyContextSchema,
  effectivePolicyListSchema,
  encryptedPolicyBootstrapSchema,
  policyAssignmentListSchema,
  policyAssignmentUpdateSchema,
  policyCreateSchema,
  policyDeleteSchema,
  policyFromTemplateCreateSchema,
  policyKeySchema,
  policyOrderUpdateSchema,
  policyCliReadResultSchema,
  policyTemplateDetailSchema,
  policyTemplateResetSchema,
  policyUpdateSchema,
} from "../src/policies.js";
import {
  parsePolicyTemplateMarkdown,
  parsePolicyTemplateMarkdownCollection,
} from "../src/policy-template-markdown.js";

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

  it("parses packaged Markdown templates from their documented shape", () => {
    const template = parsePolicyTemplateMarkdown(
      "review-policy.md",
      [
        "# Review Policy",
        "> Review every change before delivery.",
        "",
        "## Requirements",
        "",
        "Run the relevant checks.",
      ].join("\n"),
    );

    expect(template).toMatchObject({
      templateKey: "review-policy",
      name: "Review Policy",
      suggestedPolicyKey: "review-policy",
      summary: "Review every change before delivery.",
      bodyMarkdown: "## Requirements\n\nRun the relevant checks.",
      suggestedDefault: false,
      suggestedEnabled: true,
      suggestedMandatory: true,
    });
    expect(() =>
      parsePolicyTemplateMarkdown("missing-summary.md", "# Missing\n\nBody"),
    ).toThrow("blockquote summary");
    expect(() =>
      parsePolicyTemplateMarkdownCollection({
        "one/review-policy.md": "# Review One\n> First summary\n\nFirst body",
        "two/review-policy.md": "# Review Two\n> Second summary\n\nSecond body",
      }),
    ).toThrow("unique");
  });

  it("allows an empty bootstrap when no template is a default", () => {
    expect(
      encryptedPolicyBootstrapSchema.parse({
        expectedBootstrapVersion: 0,
        policies: [],
      }),
    ).toEqual({ expectedBootstrapVersion: 0, policies: [] });
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
    expect(
      policyAssignmentListSchema.safeParse({
        collectionVersion: 1,
        policies: [],
        directPolicyIds: ["one", "one"],
      }).success,
    ).toBe(false);
    expect(
      policyAssignmentListSchema.safeParse({
        collectionVersion: 1,
        policies: [],
        directPolicyIds: ["missing"],
      }).success,
    ).toBe(false);
  });

  it("bounds template creation, reset, and deletion inputs", () => {
    expect(policyFromTemplateCreateSchema.parse({})).toEqual({});
    expect(
      policyFromTemplateCreateSchema.parse({
        key: "manual-change-protocol-2",
      }),
    ).toEqual({ key: "manual-change-protocol-2" });
    expect(policyTemplateResetSchema.parse({ rowVersion: 2 })).toEqual({
      rowVersion: 2,
      restoreDefaults: false,
    });
    expect(policyDeleteSchema.parse({ rowVersion: 3 })).toEqual({
      rowVersion: 3,
    });
    expect(() => policyTemplateResetSchema.parse({ rowVersion: 0 })).toThrow();
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
        suggestedDefault: false,
        suggestedEnabled: true,
        suggestedMandatory: true,
      }),
    ).toMatchObject({
      version: 1,
      suggestedDefault: false,
      suggestedMandatory: true,
    });
  });

  it("bounds and deduplicates agent-facing policy data", () => {
    const effective = {
      key: "manual-change-protocol",
      name: "Manual Change Protocol",
      summary: "Read the current policy before changing repository state.",
      mandatory: true,
      sources: [{ type: "mandatory" as const }],
    };
    expect(
      effectivePolicyListSchema.safeParse({ policies: [effective, effective] })
        .success,
    ).toBe(false);
    expect(
      agentPolicyContextSchema.safeParse(
        "🙂".repeat(POLICY_CONTEXT_BYTES_LIMIT / 2),
      ).success,
    ).toBe(false);
    expect(
      policyCliReadResultSchema.parse({
        policy: {
          key: effective.key,
          name: effective.name,
          summary: effective.summary,
          bodyMarkdown: "# Current instructions",
        },
      }).policy,
    ).not.toHaveProperty("id");
  });
});
