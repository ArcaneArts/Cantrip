import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A disposable existing checkout, admitted by the normal direct-placement job. */
export async function seedEditorRepository(directory, workerId) {
  const repository = path.join(directory, "repository");
  const name = "Editor-Recovery-QA";
  const nameWithOwner = `Cantrip-QA/${name}`;
  const url = `https://github.com/${nameWithOwner}.git`;
  await mkdir(repository, { recursive: true });
  await writeFile(
    path.join(repository, "qa.txt"),
    "Cantrip editor recovery baseline\n",
  );
  await writeFile(
    path.join(repository, "second.txt"),
    "Cantrip second preview file\n",
  );
  const git = (...args) => exec("git", ["-C", repository, ...args]);
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Cantrip QA");
  await git("config", "user.email", "qa@cantrip.invalid");
  await git("add", "qa.txt", "second.txt");
  await git("commit", "-m", "Initialize disposable worktree fixture");
  // Direct attachment validates the configured identity locally. Nothing is
  // created at this synthetic remote and the fixture never pushes to it.
  await git("remote", "add", "origin", url);
  return {
    name,
    repository,
    input: {
      workerId,
      repositoryId: `qa-${path.basename(directory)}`,
      nameWithOwner,
      url,
      placement: { mode: "direct", path: repository },
    },
  };
}

/** Expose actual client operations only in this fixture's compiled app. */
export function editorRepositoryFixturePlugin(seed) {
  return {
    name: "cantrip-qa-repository-seed",
    enforce: "pre",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/cantrip_app/src/main.tsx"))
        return null;
      return {
        code: `${source}\nimport { createGithubProject as qaCreateProject, getProjects as qaGetProjects } from '@/lib/project-encryption';
import { createProjectWorktree as qaCreateWorktree, getProjectWorktrees as qaGetWorktrees } from '@/lib/api/worktrees';
let qaProjectId = sessionStorage.getItem("__qaRepositoryProjectId");
globalThis.__qaRepositoryFixture = {
  async create() { const project = await qaCreateProject(${JSON.stringify(seed.input)}); qaProjectId = project.id; sessionStorage.setItem("__qaRepositoryProjectId", project.id); return project; },
  async project() { return (await qaGetProjects()).find(project => project.id === qaProjectId); },
  async worktrees() { return qaGetWorktrees(qaProjectId); },
  async createWorktree(input) { return qaCreateWorktree(qaProjectId, input); },
};\n`,
        map: null,
      };
    },
  };
}
