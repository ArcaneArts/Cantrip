import {
  policyTemplateDetailSchema,
  policyTemplateListSchema,
  type PolicyTemplateDetail,
  type PolicyTemplateSummary,
} from "@cantrip/protocol/policies";

const manualChangeProtocolBody = `# Manual Change Protocol

Use this policy whenever a user asks you to change a repository without an
existing tracked workflow that defines another delivery process.

## Delivery requirements

1. Before editing, inspect repository status, applicable AGENTS.md and policy
   instructions, upstream state, active branches and worktrees, and overlapping
   pull requests or change lanes.
2. Preserve unrelated and user-owned work. Never clean, move, reset, adopt, or
   combine changes that do not belong to the request.
3. Create a dedicated branch in an isolated worktree from the appropriate
   current upstream branch. Do not implement directly in the primary checkout.
4. Keep the change independently reviewable and mergeable. Split large goals
   into sequential milestones rather than accumulating them on one long-lived
   branch.
5. Follow the repository's contribution instructions and architecture. Run the
   formatting, tests, builds, and other checks proportional to the change, and
   report only validation that actually ran.
6. Push the isolated branch and open a ready pull request with an accurate
   summary and validation report.
7. Enable squash auto-merge when the repository supports it, then observe the
   pull request until it merges. Resolve failures or conflicts only in the
   isolated branch and never bypass repository protections.
8. After merge, safely synchronize the primary checkout when it is clean and
   remove only the worktree and branch created for this change.

For every additional dependent milestone, begin again from the latest upstream
state and repeat the complete worktree, pull request, merge-observation, and
cleanup cycle.`;

const codegraphBody = `# Codegraph

\`codegraph\` is available for repository-aware discovery of files, symbols,
and relationships such as imports, callers, callees, dependencies, affected
code, and related tests.`;

const packagedTemplates = [
  policyTemplateDetailSchema.parse({
    templateKey: "manual-change-protocol",
    name: "Manual Change Protocol",
    suggestedPolicyKey: "manual-change-protocol",
    summary:
      "Use an isolated worktree and independently merged pull request for every manual repository change. Read the full policy before changing files or Git state with `cantrip policy read manual-change-protocol`.",
    bodyMarkdown: manualChangeProtocolBody,
    version: 1,
    suggestedEnabled: true,
    suggestedMandatory: true,
  }),
  policyTemplateDetailSchema.parse({
    templateKey: "codegraph",
    name: "Codegraph",
    suggestedPolicyKey: "codegraph",
    summary:
      "`codegraph` is available for repository-aware discovery of files, symbols, and relationships such as imports, callers, callees, dependencies, affected code, and related tests.",
    bodyMarkdown: codegraphBody,
    version: 1,
    suggestedEnabled: true,
    suggestedMandatory: true,
  }),
] as const satisfies readonly PolicyTemplateDetail[];

const templatesByKey = new Map(
  packagedTemplates.map((template) => [template.templateKey, template]),
);

export function listPackagedPolicyTemplates(): PolicyTemplateSummary[] {
  return policyTemplateListSchema.parse(
    packagedTemplates.map(({ bodyMarkdown: _bodyMarkdown, ...summary }) =>
      structuredClone(summary),
    ),
  );
}

export function getPackagedPolicyTemplate(
  templateKey: string,
): PolicyTemplateDetail | null {
  const template = templatesByKey.get(templateKey);
  return template ? structuredClone(template) : null;
}

export function requirePackagedPolicyTemplate(
  templateKey: string,
): PolicyTemplateDetail {
  const template = getPackagedPolicyTemplate(templateKey);
  if (!template) {
    throw new Error(`Packaged policy template ${templateKey} is unavailable.`);
  }
  return template;
}
