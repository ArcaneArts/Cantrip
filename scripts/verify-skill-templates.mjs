import { readSkillTemplates, skillTemplatesSha256 } from "./cantrip-skills.mjs";

const packages = await readSkillTemplates();
console.log(
  `Verified ${packages.length} packaged Cantrip skill${packages.length === 1 ? "" : "s"} (${skillTemplatesSha256(packages)}).`,
);
