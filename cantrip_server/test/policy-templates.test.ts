import { describe, expect, it } from "vitest";

import {
  getPackagedPolicyTemplate,
  listPackagedPolicyTemplates,
} from "../src/policies/templates.js";

describe("packaged policy templates", () => {
  it("keeps optional templates separate from default policies", () => {
    const templates = listPackagedPolicyTemplates();
    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateKey: "manual-change-protocol",
          suggestedPolicyKey: "manual-change-protocol",
          suggestedDefault: false,
          suggestedEnabled: true,
          suggestedMandatory: true,
          version: 1,
        }),
        expect.objectContaining({
          templateKey: "codegraph",
          suggestedPolicyKey: "codegraph",
          suggestedDefault: true,
          suggestedEnabled: true,
          suggestedMandatory: true,
          version: 1,
        }),
      ]),
    );
    expect(templates).toHaveLength(2);
    expect(
      templates
        .filter(({ suggestedDefault }) => suggestedDefault)
        .map(({ templateKey }) => templateKey),
    ).toEqual(["codegraph"]);
    expect(templates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bodyMarkdown: expect.anything() }),
      ]),
    );

    const detail = getPackagedPolicyTemplate("manual-change-protocol");
    expect(detail?.bodyMarkdown).toContain("isolated worktree");
    expect(detail?.bodyMarkdown).toContain("ready pull request");
    expect(detail?.bodyMarkdown).toContain("squash auto-merge");
    expect(detail?.bodyMarkdown).not.toContain("pnpm");
    expect(detail?.bodyMarkdown).not.toContain("Cantrip's app/server");

    const codegraph = getPackagedPolicyTemplate("codegraph");
    expect(codegraph?.name).toBe("Codegraph");
    expect(codegraph?.bodyMarkdown).toContain("repository-aware discovery");
    expect(codegraph?.bodyMarkdown).toContain("callers, callees, dependencies");
    expect(codegraph?.bodyMarkdown).not.toMatch(
      /\b(?:always|must|required)\b/iu,
    );
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
