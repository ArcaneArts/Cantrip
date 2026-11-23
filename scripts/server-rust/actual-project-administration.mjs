// Existing encrypted browser SDK and unchanged full worker. Only a disposable
// local Git checkout's catalog classification is seeded for GitHub-only policy.
import assert from "node:assert/strict";
import path from "node:path";
import { cp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { startRetirementProbe } from "./actual-run-retirement.mjs";

export async function actualProjectAdministration({
  page,
  fixture,
  root,
  executable,
  workerId,
  workerDataDirectory,
  attached,
  existingPath,
  create,
  waitJob,
  filesystem,
  startWorker,
  stopWorker,
  result,
}) {
  const call = (module, operation, args) =>
    page.evaluate(
      async ({ module, operation, args }) =>
        (await import(module))[operation](...args),
      { module, operation, args },
    );
  const remove = (id, files) =>
    call("/src/lib/api/projects.ts", "removeProject", [id, files]);
  const failure = async (operation, status) => {
    const value = await page.evaluate(async ({ module, name, args }) => {
      try {
        await (await import(module))[name](...args);
        return { resolved: true };
      } catch (error) {
        return {
          status: error.status,
          code: error.code,
          message: error.message,
        };
      }
    }, operation);
    assert.equal(value.status, status, JSON.stringify(value));
    return value;
  };
  const resultState = (result.projectAdministration = {});
  await failure(
    {
      module: "/src/lib/api/projects.ts",
      name: "removeProject",
      args: [attached.id, true],
    },
    409,
  );
  assert.equal(
    await readFile(path.join(existingPath, "retained.txt"), "utf8"),
    "Existing user file remains intact.\n",
  );
  await remove(attached.id, false);
  assert.equal(
    await readFile(path.join(existingPath, "retained.txt"), "utf8"),
    "Existing user file remains intact.\n",
  );
  result.steps.push(
    "existing browser removal refuses to delete an attached user folder and preserves its actual bytes when removing only the project",
  );
  const local = await create("Administration local Git", existingPath);
  await waitJob(local.id, "succeeded");
  for (const target of [null, workerId]) {
    const updated = await call(
      "/src/lib/project-encryption.ts",
      "updateProjectPreferredWorker",
      [local.id, { workerId: target }],
    );
    assert.equal(updated.preferredWorkerId, target);
    assert.equal(updated.name, "Administration local Git");
  }
  await failure(
    {
      module: "/src/lib/project-encryption.ts",
      name: "updateProjectWorktreePolicy",
      args: [local.id, "direct"],
    },
    409,
  );
  const port = Number(new URL(fixture.server.origin).port);
  await stopWorker();
  await fixture.close();
  const repo = await repositoryFixture({
    kind: fixture.kind,
    root: path.join(root, fixture.name),
    executable,
    databaseMode: fixture.databaseMode,
    databaseUrl: fixture.environment.DATABASE_URL,
  });
  try {
    await repo.seed(
      `UPDATE projects SET origin_kind='github',folder_management=NULL,git_capability=true,github_capability=true,worktree_policy='agent-managed',github_repository_blind_index='project-administration-fixture' WHERE id=${literal(local.id)}`,
    );
  } finally {
    await repo.close();
  }
  await fixture.start({ port });
  await startWorker();
  for (const policy of ["direct", "required-for-writes", "agent-managed"]) {
    const updated = await call(
      "/src/lib/project-encryption.ts",
      "updateProjectWorktreePolicy",
      [local.id, policy],
    );
    assert.equal(updated.worktreePolicy, policy);
    assert.equal(updated.name, "Administration local Git");
  }
  const ordered = (await page.evaluate(() => window.folderCrypto.getProjects()))
    .map((p) => p.id)
    .reverse();
  await call("/src/lib/api/chats.ts", "reorderProjects", [ordered]);
  assert.deepEqual(
    (await page.evaluate(() => window.folderCrypto.getProjects())).map(
      (p) => p.id,
    ),
    ordered,
  );
  result.steps.push(
    "existing encrypted browser APIs retain labels while updating preferred workers, all worktree policies and complete project ordering through the real worker",
  );
  const removed = [];
  for (const deleteFiles of [false, true]) {
    const project = await create("Administration managed " + deleteFiles);
    await waitJob(project.id, "succeeded");
    const directory = await filesystem(project.id);
    const marker = path.join(directory, "retained.txt");
    await writeFile(marker, "Owned deletion acceptance\n");
    const worktrees = await call(
      "/src/lib/api/worktrees.ts",
      "getProjectWorktrees",
      [project.id],
    );
    const primary = worktrees.find((w) => w.isPrimary);
    assert.ok(primary);
    const retired = await startRetirementProbe({
      page,
      root,
      projectId: project.id,
      primary: directory,
      worktree: primary,
      result,
      projectDeletion: true,
    });
    await remove(project.id, deleteFiles);
    await retired();
    if (deleteFiles) await assert.rejects(stat(directory), { code: "ENOENT" });
    else
      assert.equal(
        await readFile(marker, "utf8"),
        "Owned deletion acceptance\n",
      );
    await failure(
      {
        module: "/src/lib/api/projects.ts",
        name: "removeProject",
        args: [project.id, deleteFiles],
      },
      404,
    );
    removed.push(project.id);
    (resultState.managed ??= []).push({
      deleteFiles,
      directory,
      runtime: structuredClone(result.actualRunRetirement),
    });
  }
  await remove(local.id, false);
  assert.equal(
    await readFile(path.join(existingPath, "retained.txt"), "utf8"),
    "Existing user file remains intact.\n",
  );
  removed.push(local.id, attached.id);
  const legacyReplicas = (resultState.legacyReplicas = []);
  for (const deleteFiles of [false, true]) {
    const directory = path.join(
      workerDataDirectory,
      "repositories",
      "legacy-replica-" + crypto.randomUUID(),
    );
    await mkdir(path.dirname(directory), { recursive: true });
    await cp(existingPath, directory, { recursive: true });
    const project = await create(
      "Legacy managed replica " + deleteFiles,
      directory,
    );
    await waitJob(project.id, "succeeded");
    await stopWorker();
    await fixture.close();
    const legacy = await repositoryFixture({
      kind: fixture.kind,
      root: path.join(root, fixture.name),
      executable,
      databaseMode: fixture.databaseMode,
      databaseUrl: fixture.environment.DATABASE_URL,
    });
    try {
      await legacy.seed(
        `UPDATE projects SET origin_kind='github',folder_management=NULL,git_capability=true,github_capability=true,worktree_policy='agent-managed',github_repository_blind_index='legacy-replica-fixture' WHERE id=${literal(project.id)}`,
      );
      await legacy.seed(
        `UPDATE project_sources SET source_kind='git',absolute_path=${literal(directory)},display_path=${literal(directory)},ownership_kind='cantrip',placement_mode='managed',requested_path=NULL,link_path=NULL WHERE project_id=${literal(project.id)}`,
      );
      await legacy.seed(
        `UPDATE project_worktrees SET absolute_path=${literal(directory)},display_path=${literal(directory)} WHERE project_source_id IN (SELECT id FROM project_sources WHERE project_id=${literal(project.id)})`,
      );
    } finally {
      await legacy.close();
    }
    await fixture.start({ port });
    if (deleteFiles) {
      await failure(
        {
          module: "/src/lib/api/projects.ts",
          name: "removeProject",
          args: [project.id, true],
        },
        503,
      );
      assert.equal(
        await readFile(path.join(directory, "retained.txt"), "utf8"),
        "Existing user file remains intact.\n",
      );
    }
    await startWorker();
    await remove(project.id, deleteFiles);
    if (deleteFiles) await assert.rejects(stat(directory), { code: "ENOENT" });
    else
      assert.equal(
        await readFile(path.join(directory, "retained.txt"), "utf8"),
        "Existing user file remains intact.\n",
      );
    legacyReplicas.push({
      projectId: project.id,
      deleteFiles,
      directory,
      offlineDeletionRejected: deleteFiles,
    });
    removed.push(project.id);
  }
  await stopWorker();
  await fixture.close();
  await fixture.start({ port });
  await startWorker();
  const retained = await page.evaluate(() => window.folderCrypto.getProjects());
  assert.ok(retained.every((p) => !removed.includes(p.id)));
  for (const item of resultState.managed) {
    if (item.deleteFiles)
      await assert.rejects(stat(item.directory), { code: "ENOENT" });
    else
      assert.equal(
        await readFile(path.join(item.directory, "retained.txt"), "utf8"),
        "Owned deletion acceptance\n",
      );
  }
  for (const item of legacyReplicas) {
    if (item.deleteFiles)
      await assert.rejects(stat(item.directory), { code: "ENOENT" });
    else
      assert.equal(
        await readFile(path.join(item.directory, "retained.txt"), "utf8"),
        "Existing user file remains intact.\n",
      );
  }
  result.steps.push(
    "legacy Cantrip-owned replicas use actual worker file deletion, reject offline cleanup, preserve files when requested and retain both outcomes after server and worker restart",
  );
  result.steps.push(
    "actual project deletion preserves or removes managed files as requested, retains user files and survives production server/worker restart with no deleted project returning",
  );
}
