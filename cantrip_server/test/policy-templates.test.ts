import { describe, expect, it } from "vitest";

import {
  getPackagedPolicyTemplate,
  listPackagedPolicyTemplates,
} from "../src/policies/templates.js";

describe("packaged policy templates", () => {
  it("packages a compact repository-agnostic Manual Change Protocol", () => {
    const templates = listPackagedPolicyTemplates();
    expect(templates).toEqual([
      expect.objectContaining({
        templateKey: "manual-change-protocol",
        suggestedPolicyKey: "manual-change-protocol",
        suggestedEnabled: true,
        suggestedMandatory: true,
        version: 1,
      }),
    ]);
    expect(templates[0]).not.toHaveProperty("bodyMarkdown");

    const detail = getPackagedPolicyTemplate("manual-change-protocol");
    expect(detail?.bodyMarkdown).toContain("isolated worktree");
    expect(detail?.bodyMarkdown).toContain("ready pull request");
    expect(detail?.bodyMarkdown).toContain("squash auto-merge");
    expect(detail?.bodyMarkdown).not.toContain("pnpm");
    expect(detail?.bodyMarkdown).not.toContain("Cantrip's app/server");
  });

  it("does not expose mutable template instances", () => {
    const first = getPackagedPolicyTemplate("manual-change-protocol")!;
    first.name = "Changed";
    expect(getPackagedPolicyTemplate("manual-change-protocol")?.name).toBe(
      "Manual Change Protocol",
    );
    expect(getPackagedPolicyTemplate("missing")).toBeNull();
  });
});
