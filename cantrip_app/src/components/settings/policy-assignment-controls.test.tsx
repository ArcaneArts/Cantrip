import {
  effectivePolicyListSchema,
  policyAssignmentListSchema,
  policySummarySchema,
  type EffectivePolicySummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PolicyAssignmentControls,
  policyAssignmentPresentation,
} from "./policy-assignment-controls";

const now = "2026-08-17T12:00:00.000Z";

function policy(
  id: string,
  input: Partial<{
    enabled: boolean;
    mandatory: boolean;
    name: string;
  }> = {},
) {
  return policySummarySchema.parse({
    id,
    key: `${id}-policy`,
    name: input.name ?? `${id} policy`,
    summary: `Summary for ${id}.`,
    enabled: input.enabled ?? true,
    mandatory: input.mandatory ?? false,
    position: 0,
    templateKey: null,
    rowVersion: 1,
    workspaceAssignmentCount: 0,
    projectAssignmentCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

function effective(
  item: ReturnType<typeof policy>,
  sources: EffectivePolicySummary["sources"],
): EffectivePolicySummary {
  return {
    key: item.key,
    name: item.name,
    summary: item.summary,
    mandatory: item.mandatory,
    sources,
  };
}

describe("policy assignment controls", () => {
  it("distinguishes mandatory, inherited, direct, and disabled states", () => {
    const mandatory = policy("mandatory", { mandatory: true });
    expect(
      policyAssignmentPresentation(
        mandatory,
        false,
        effective(mandatory, [{ type: "mandatory" }]),
        "project",
      ),
    ).toMatchObject({ checked: true, disabled: true });

    const inherited = policy("inherited");
    const inheritedEffective = effective(inherited, [
      {
        type: "workspace",
        workspaceId: "workspace-one",
      },
    ]);
    expect(
      policyAssignmentPresentation(
        inherited,
        false,
        inheritedEffective,
        "project",
        new Map([["workspace-one", "Company"]]),
      ),
    ).toMatchObject({
      checked: true,
      disabled: true,
      sourceLabels: ["Inherited · Company"],
    });
    expect(
      policyAssignmentPresentation(
        inherited,
        true,
        inheritedEffective,
        "project",
      ),
    ).toMatchObject({ checked: true, disabled: false });

    const disabled = policy("disabled", { enabled: false });
    expect(
      policyAssignmentPresentation(disabled, true, undefined, "workspace"),
    ).toMatchObject({
      checked: true,
      disabled: true,
      sourceLabels: ["Assigned here", "Disabled"],
    });
  });

  it("renders one flat project row per policy with effective source labels", () => {
    const mandatory = policy("mandatory", {
      mandatory: true,
      name: "Required review",
    });
    const inherited = policy("inherited", { name: "Company conventions" });
    const direct = policy("direct", { name: "Project release checks" });
    const disabled = policy("disabled", {
      enabled: false,
      name: "Paused policy",
    });
    const policies = [mandatory, inherited, direct, disabled];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(
      ["project-policy-assignments", "project-one"],
      policyAssignmentListSchema.parse({
        collectionVersion: 4,
        policies,
        directPolicyIds: [direct.id, disabled.id],
      }),
    );
    queryClient.setQueryData(
      ["effective-policies", "project-one"],
      effectivePolicyListSchema.parse({
        policies: [
          effective(mandatory, [{ type: "mandatory" }]),
          effective(inherited, [
            {
              type: "workspace",
              workspaceId: "workspace-one",
            },
          ]),
          effective(direct, [{ type: "project", projectId: "project-one" }]),
        ],
      }),
    );
    queryClient.setQueryData(
      ["project-workspaces"],
      [
        {
          id: "workspace-one",
          name: "Company",
          position: 0,
          isDefault: true,
          projectIds: ["project-one"],
          revision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <PolicyAssignmentControls
          scope={{ kind: "project", id: "project-one", name: "Cantrip" }}
          onManagePolicies={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Required review");
    expect(markup).toContain("Company conventions");
    expect(markup).toContain("Inherited · Company");
    expect(markup).toContain("Project release checks");
    expect(markup).toContain("Paused policy");
    expect(markup).toContain("Manage policy content");
  });
});
