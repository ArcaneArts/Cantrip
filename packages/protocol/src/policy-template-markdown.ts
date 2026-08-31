import {
  policyKeySchema,
  policyTemplateDetailSchema,
  policyTemplateListSchema,
  type PolicyTemplateDetail,
} from "./policies.js";

function policyTemplateKeyFromSource(sourceName: string): string {
  const fileName = sourceName.split(/[\\/]/u).at(-1) ?? sourceName;
  if (!fileName.endsWith(".md")) {
    throw new Error(`Policy template ${sourceName} must use a .md extension.`);
  }
  return policyKeySchema.parse(fileName.slice(0, -3));
}

export function parsePolicyTemplateMarkdown(
  sourceName: string,
  markdown: string,
): PolicyTemplateDetail {
  const lines = markdown
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  let lineIndex = 0;
  while (lines[lineIndex]?.trim() === "") lineIndex += 1;

  const heading = /^#\s+(.+)$/u.exec(lines[lineIndex] ?? "");
  if (!heading) {
    throw new Error(
      `Policy template ${sourceName} must begin with a level-one Markdown heading.`,
    );
  }
  const name = heading[1]!.trim();
  lineIndex += 1;
  while (lines[lineIndex]?.trim() === "") lineIndex += 1;

  const summaryLines: string[] = [];
  while (lineIndex < lines.length) {
    const summaryLine = /^>\s?(.*)$/u.exec(lines[lineIndex] ?? "");
    if (!summaryLine) break;
    summaryLines.push(summaryLine[1]!.trim());
    lineIndex += 1;
  }
  if (!summaryLines.length) {
    throw new Error(
      `Policy template ${sourceName} must include a blockquote summary after its heading.`,
    );
  }
  while (lines[lineIndex]?.trim() === "") lineIndex += 1;

  const bodyMarkdown = lines.slice(lineIndex).join("\n").trim();
  if (!bodyMarkdown) {
    throw new Error(
      `Policy template ${sourceName} must include policy content after its summary.`,
    );
  }

  const templateKey = policyTemplateKeyFromSource(sourceName);
  return policyTemplateDetailSchema.parse({
    templateKey,
    name,
    suggestedPolicyKey: templateKey,
    summary: summaryLines.join(" "),
    bodyMarkdown,
    version: 1,
    suggestedDefault: false,
    suggestedEnabled: true,
    suggestedMandatory: true,
  });
}

export function parsePolicyTemplateMarkdownCollection(
  sources: Readonly<Record<string, string>>,
): PolicyTemplateDetail[] {
  const templates = Object.entries(sources)
    .map(([sourceName, markdown]) =>
      parsePolicyTemplateMarkdown(sourceName, markdown),
    )
    .sort((left, right) => left.templateKey.localeCompare(right.templateKey));
  const uniqueKeys = new Set(templates.map(({ templateKey }) => templateKey));
  if (uniqueKeys.size !== templates.length) {
    throw new Error("Packaged policy template keys must be unique.");
  }
  policyTemplateListSchema.parse(templates);
  return templates;
}
