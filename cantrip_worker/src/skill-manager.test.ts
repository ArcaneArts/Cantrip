import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codexAccountHome } from "./codex/account-home.js";
import { SkillManager, parseSkillFrontmatter } from "./skill-manager.js";

let root: string;
let dataDirectory: string;
let homeDirectory: string;
let adminDirectory: string;
let projectDirectory: string;
let manager: SkillManager;
const context = {
  cwd: "",
  providerId: "provider-one",
  providerKind: "chatgpt" as const,
};

async function createSkill(
  skillsRoot: string,
  directory: string,
  name: string,
  description: string,
) {
  const skillDirectory = path.join(skillsRoot, directory);
  await mkdir(path.join(skillDirectory, "references"), { recursive: true });
  await writeFile(
    path.join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow the workflow.\n`,
  );
  await writeFile(
    path.join(skillDirectory, "references", "notes.md"),
    "Original notes.\n",
  );
  return skillDirectory;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cantrip-skill-manager-"));
  dataDirectory = path.join(root, "data");
  homeDirectory = path.join(root, "home");
  adminDirectory = path.join(root, "admin-skills");
  projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory, { recursive: true });
  manager = new SkillManager(dataDirectory, homeDirectory, adminDirectory);
  context.cwd = projectDirectory;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("skill manager", () => {
  it("parses quoted skill frontmatter", () => {
    expect(
      parseSkillFrontmatter(
        "---\nname: \"release-check\"\ndescription: 'Review a release.'\n---\nBody\n",
      ),
    ).toEqual({ name: "release-check", description: "Review a release." });
  });

  it("lists project skills before account, user, system, and admin skills", async () => {
    await createSkill(
      path.join(projectDirectory, ".agents", "skills"),
      "project-review",
      "project-review",
      "Review this repository.",
    );
    const accountSkills = path.join(
      codexAccountHome(dataDirectory, context.providerId),
      "skills",
    );
    await createSkill(
      accountSkills,
      "personal-release",
      "personal-release",
      "Prepare a release.",
    );
    await createSkill(
      path.join(homeDirectory, ".agents", "skills"),
      "user-docs",
      "user-docs",
      "Write documentation.",
    );
    await createSkill(
      path.join(accountSkills, ".system"),
      "skill-installer",
      "skill-installer",
      "Install skills.",
    );
    await createSkill(
      adminDirectory,
      "company-policy",
      "company-policy",
      "Apply company policy.",
    );

    const inventory = await manager.list(context);

    expect(inventory.project.map(({ name }) => name)).toEqual([
      "project-review",
    ]);
    expect(inventory.global.map(({ location }) => location)).toEqual([
      "account",
      "user",
      "system",
      "admin",
    ]);
    expect(
      inventory.global.find(({ location }) => location === "system"),
    ).toMatchObject({
      editable: false,
      deletable: false,
    });
  });

  it("browses and edits files while validating SKILL.md", async () => {
    await createSkill(
      path.join(projectDirectory, ".agents", "skills"),
      "project-review",
      "project-review",
      "Review this repository.",
    );
    const item = (await manager.list(context)).project[0]!;
    const document = await manager.read(context, item.id, "SKILL.md");
    expect(document.files.map(({ path: file }) => file)).toEqual([
      "SKILL.md",
      "references/notes.md",
    ]);

    await manager.write(
      context,
      item.id,
      "references/notes.md",
      "Updated notes.\n",
    );
    expect(
      await readFile(
        path.join(
          projectDirectory,
          ".agents",
          "skills",
          "project-review",
          "references",
          "notes.md",
        ),
        "utf8",
      ),
    ).toBe("Updated notes.\n");
    await expect(
      manager.write(context, item.id, "SKILL.md", "Missing frontmatter"),
    ).rejects.toThrow("name and description frontmatter");
  });

  it("moves deletions into worker recovery storage", async () => {
    const accountDirectory = await createSkill(
      path.join(codexAccountHome(dataDirectory, context.providerId), "skills"),
      "personal-release",
      "personal-release",
      "Prepare a release.",
    );
    const item = (await manager.list(context)).global.find(
      ({ location }) => location === "account",
    )!;

    const result = await manager.delete(context, item.id);

    await expect(access(accountDirectory)).rejects.toThrow();
    expect(result.recoveryPath).toContain(
      path.join(dataDirectory, "skill-recovery"),
    );
    expect(
      await readFile(path.join(result.recoveryPath!, "SKILL.md"), "utf8"),
    ).toContain("name: personal-release");
  });
});
