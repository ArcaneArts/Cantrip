import {
  policyTemplateDetailSchema,
  policyTemplateListSchema,
  type PolicyTemplateDetail,
  type PolicyTemplateSummary,
} from "@cantrip/protocol/policies";
import { parsePolicyTemplateMarkdownCollection } from "@cantrip/protocol/policy-template-markdown";

const templateSources = import.meta.glob("../../../policy_templates/*.md", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const packagedTemplates =
  parsePolicyTemplateMarkdownCollection(templateSources);
const templatesByKey = new Map(
  packagedTemplates.map((template) => [template.templateKey, template]),
);

export function filterPolicyTemplates(
  templates: readonly PolicyTemplateSummary[],
  query: string,
): PolicyTemplateSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...templates];
  return templates.filter((template) =>
    [template.name, template.templateKey, template.summary]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

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
  return template
    ? policyTemplateDetailSchema.parse(structuredClone(template))
    : null;
}
