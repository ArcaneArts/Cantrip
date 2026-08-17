import {
  policyListSchema,
  policySummarySchema,
} from "@cantrip/protocol/policies";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PolicySettings,
  nextAvailablePolicyKey,
  policyDeletionMessage,
  reorderedPolicies,
} from "./policy-settings";

const now = "2026-08-17T12:00:00.000Z";
const policies = [
  policySummarySchema.parse({
    id: "one",
    key: "manual-change-protocol",
    name: "Manual Change Protocol",
    summary: "Use an isolated worktree and pull request.",
    enabled: true,
    mandatory: true,
    position: 0,
    templateKey: "manual-change-protocol",
    rowVersion: 1,
    workspaceAssignmentCount: 2,
    projectAssignmentCount: 1,
    createdAt: now,
    updatedAt: now,
  }),
  policySummarySchema.parse({
    id: "two",
    key: "review-policy",
    name: "Review policy",
    summary: "Review before delivery.",
    enabled: false,
    mandatory: false,
    position: 1,
    templateKey: null,
    rowVersion: 2,
    workspaceAssignmentCount: 0,
    projectAssignmentCount: 0,
    createdAt: now,
    updatedAt: now,
  }),
];

describe("policy settings", () => {
  it("generates stable available keys and reorders complete lists", () => {
    expect(nextAvailablePolicyKey("Manual Change Protocol", policies)).toBe(
      "manual-change-protocol-2",
    );
    expect(nextAvailablePolicyKey("  New policy! ", policies)).toBe(
      "new-policy",
    );
    expect(
      reorderedPolicies(policies, "two", "one").map(({ id, position }) => ({
        id,
        position,
      })),
    ).toEqual([
      { id: "two", position: 0 },
      { id: "one", position: 1 },
    ]);
  });

  it("describes assignment removal before deletion", () => {
    expect(policyDeletionMessage(policies[0]!)).toContain(
      "remove 3 explicit workspace/project assignments",
    );
    expect(policyDeletionMessage(policies[1]!)).toContain(
      "packaged template, if any, remains available",
    );
  });

  it("renders flat sortable rows with scope and provenance", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ["policies"],
      policyListSchema.parse({ collectionVersion: 1, policies }),
    );
    queryClient.setQueryData(["policy-templates"], []);
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <PolicySettings />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Manual Change Protocol");
    expect(markup).toContain("Mandatory");
    expect(markup).toContain("3 assignments");
    expect(markup).toContain("Drag Manual Change Protocol to reorder");
    expect(markup).toContain("Template");
  });
});
