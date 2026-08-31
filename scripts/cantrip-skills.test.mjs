import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installSkillTemplates,
  readSkillTemplates,
  skillTemplatesSha256,
} from "./cantrip-skills.mjs";

async function fixture(name = "sample-skill") {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-skills-"));
  const skill = path.join(root, name);
  await mkdir(skill);
  await writeFile(
    path.join(skill, "SKILL.md"),
    `---\nname: ${name}\ndescription: A fixture skill.\n---\n\n# Fixture\n`,
  );
  return { root, skill };
}

test("validates and deterministically fingerprints packaged skills", async () => {
  const { root } = await fixture();
  try {
    const first = await readSkillTemplates(root);
    const second = await readSkillTemplates(root);
    assert.equal(first[0]?.name, "sample-skill");
    assert.match(skillTemplatesSha256(first), /^[0-9a-f]{64}$/u);
    assert.equal(skillTemplatesSha256(first), skillTemplatesSha256(second));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects mismatched names and symlinks", async () => {
  const mismatch = await fixture("directory-name");
  const linked = await fixture("linked-skill");
  try {
    await writeFile(
      path.join(mismatch.skill, "SKILL.md"),
      "---\nname: other-name\ndescription: Mismatch.\n---\n",
    );
    await assert.rejects(
      readSkillTemplates(mismatch.root),
      /must declare frontmatter name/u,
    );
    await symlink(
      path.join(linked.skill, "SKILL.md"),
      path.join(linked.skill, "linked.md"),
    );
    await assert.rejects(
      readSkillTemplates(linked.root),
      /cannot contain symlinks/u,
    );
  } finally {
    await Promise.all([
      rm(mismatch.root, { recursive: true, force: true }),
      rm(linked.root, { recursive: true, force: true }),
    ]);
  }
});

test("refuses to overwrite an upstream bundled skill", async () => {
  const source = await fixture();
  const destination = await mkdtemp(
    path.join(tmpdir(), "cantrip-skill-samples-"),
  );
  try {
    const packages = await readSkillTemplates(source.root);
    await installSkillTemplates(packages, destination);
    await assert.rejects(
      installSkillTemplates(packages, destination),
      /collides with an upstream bundled skill/u,
    );
  } finally {
    await Promise.all([
      rm(source.root, { recursive: true, force: true }),
      rm(destination, { recursive: true, force: true }),
    ]);
  }
});
