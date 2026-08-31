import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  policyTemplateDetailSchema,
  policyTemplateListSchema,
  type PolicyTemplateDetail,
  type PolicyTemplateSummary,
} from "@cantrip/protocol/policies";
import { parsePolicyTemplateMarkdownCollection } from "@cantrip/protocol/policy-template-markdown";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const templateDirectoryCandidates = [
  path.resolve(moduleDirectory, "../../policy_templates"),
  path.resolve(moduleDirectory, "../../../policy_templates"),
];

function loadPackagedPolicyTemplates(): PolicyTemplateDetail[] {
  for (const directory of templateDirectoryCandidates) {
    let fileNames: string[];
    try {
      fileNames = readdirSync(directory)
        .filter((fileName) => fileName.endsWith(".md"))
        .sort();
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      if (code === "ENOENT") continue;
      throw error;
    }
    if (!fileNames.length) continue;
    return parsePolicyTemplateMarkdownCollection(
      Object.fromEntries(
        fileNames.map((fileName) => [
          fileName,
          readFileSync(path.join(directory, fileName), "utf8"),
        ]),
      ),
    );
  }
  throw new Error(
    `Packaged policy templates are unavailable. Checked: ${templateDirectoryCandidates.join(", ")}`,
  );
}

const packagedTemplates = loadPackagedPolicyTemplates();
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
  return template
    ? policyTemplateDetailSchema.parse(structuredClone(template))
    : null;
}
