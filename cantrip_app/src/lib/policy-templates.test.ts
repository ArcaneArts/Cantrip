import { describe, expect, it } from "vitest";

import {
  filterPolicyTemplates,
  getPackagedPolicyTemplate,
  listPackagedPolicyTemplates,
} from "./policy-templates";

describe("packaged policy templates", () => {
  it("bundles the root Markdown catalog and supports chooser search", () => {
    const templates = listPackagedPolicyTemplates();

    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      templateKey: "manual-change-protocol",
      name: "Manual Change Protocol",
      suggestedDefault: false,
    });
    expect(filterPolicyTemplates(templates, "isolated worktree")).toHaveLength(
      1,
    );
    expect(filterPolicyTemplates(templates, "codegraph")).toEqual([]);
    expect(
      getPackagedPolicyTemplate("manual-change-protocol")?.bodyMarkdown,
    ).toContain("## Delivery requirements");
  });
});
