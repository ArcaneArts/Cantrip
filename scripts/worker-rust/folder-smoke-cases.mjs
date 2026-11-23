// Real HTTP -> durable server job -> production native worker. All filesystem
// assertions concern the disposable profile created by workspace-smoke only.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";

export async function verifyManagedFolders({
  call,
  eventually,
  root,
  workerDirectory,
  workerId,
  registerMetadata,
  projectLabel,
  workspaceName,
}) {
  const workspaceId = "88888888-8888-4888-8888-000000000009";
  const projectId = "99999999-9999-4999-8999-000000000009";
  const externalId = "99999999-9999-4999-8999-000000000010";
  const createdWorkspace = await call("POST", "/api/workspaces", {
    id: workspaceId,
    nameProtection: {
      ...workspaceName,
      blindIndex: randomBytes(32).toString("base64url"),
    },
    storage: { kind: "managed" },
  });
  assert.equal(createdWorkspace.status, 201, JSON.stringify(createdWorkspace));
  const create = await call("POST", "/api/projects/from-folder", {
    id: projectId,
    workerId,
    workspaceId,
    nameProtection: projectLabel,
  });
  assert.equal(create.status, 202, JSON.stringify(create));
  async function job(id, state) {
    const result = await eventually(
      () => call("GET", `/api/projects/${id}/folder-setup`),
      (value) => {
        assert.equal(value.status, 200);
        assert.equal(value.body.state, state, JSON.stringify(value));
      },
      `native folder job ${state}`,
    );
    return result.body;
  }
  const ready = await job(projectId, "succeeded");
  assert.equal(ready.attempt, 1);
  const target = path.join(
    workerDirectory,
    "workspaces",
    workspaceId,
    "folders",
    projectId,
  );
  assert.equal((await lstat(target)).isDirectory(), true);
  if (process.platform !== "win32")
    assert.equal((await lstat(target)).mode & 0o777, 0o700);
  await writeFile(path.join(target, "dirty.txt"), "managed data\n");
  const stats = await call("GET", `/api/projects/${projectId}/repository-stats`);
  assert.equal(stats.status, 200, JSON.stringify(stats));
  assert.deepEqual(stats.body, {
    kind: "folder",
    fileCount: 1,
    byteCount: 13,
    textFileCount: 1,
    lineCount: 1,
    excludedFileCount: 0,
    truncated: false,
  });
  const sibling = target + "-sibling";
  await mkdir(sibling);
  await writeFile(path.join(sibling, "kept.txt"), "sibling kept\n");
  const projects = await call("GET", "/api/projects");
  assert.equal(projects.status, 200, JSON.stringify(projects));
  const project = projects.body.find((project) => project.id === projectId);
  assert.equal(project.setupStatus, "ready");
  assert.equal(
    JSON.stringify(project).includes(target),
    false,
    "server stores opaque folder paths",
  );
  const removed = await call("DELETE", `/api/projects/${projectId}`, {
    deleteLocalFiles: true,
  });
  assert.equal(removed.status, 204, JSON.stringify(removed));
  await assert.rejects(lstat(target), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(sibling, "kept.txt"), "utf8"),
    "sibling kept\n",
  );

  const external = path.join(root, "corrected-external-folder");
  const handles = await registerMetadata(externalId, {
    existingPath: external,
  });
  assert.match(handles.existingPath, /^ctrr_[A-Za-z0-9_-]{43}$/);
  const attached = await call("POST", "/api/projects/from-folder", {
    id: externalId,
    workerId,
    workspaceId,
    nameProtection: projectLabel,
    existingPath: handles.existingPath,
  });
  assert.equal(attached.status, 202, JSON.stringify(attached));
  const failed = await job(externalId, "failed");
  assert.equal(failed.error.code, "existing-path-missing");
  await mkdir(external);
  await writeFile(path.join(external, "kept.txt"), "external data\n");
  const retry = await call(
    "POST",
    `/api/projects/${externalId}/folder-setup/retry`,
    { stateRevision: failed.stateRevision },
  );
  assert.equal(retry.status, 200, JSON.stringify(retry));
  assert.equal((await job(externalId, "succeeded")).attempt, 2);
  await assert.rejects(
    lstat(
      path.join(
        workerDirectory,
        "workspaces",
        workspaceId,
        "folders",
        externalId,
      ),
    ),
    { code: "ENOENT" },
  );
  const denied = await call("DELETE", `/api/projects/${externalId}`, {
    deleteLocalFiles: true,
  });
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(denied.body.code, "external-folder-delete-forbidden");
  const detached = await call("DELETE", `/api/projects/${externalId}`, {
    deleteLocalFiles: false,
  });
  assert.equal(detached.status, 204, JSON.stringify(detached));
  assert.equal(
    await readFile(path.join(external, "kept.txt"), "utf8"),
    "external data\n",
  );
}
