import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import path from "node:path";
export async function verifyReplicaLifecycle({
  root,
  fixture,
  run,
  compare,
  command,
  direct,
  checkout,
  getDirectory,
  setDirectory,
}) {
  async function provision(overrides = {}) {
    const request = command({ projectId: randomUUID(), ...overrides });
    const ready = (await compare(request)).value;
    return { request, ready };
  }
  function lifecycle(replica, type, overrides = {}) {
    return command({
      type,
      projectId: replica.request.projectId,
      repository: replica.request.repository,
      sourcePath: replica.ready.path,
      placement: replica.ready.placement,
      repositoryFingerprint: replica.ready.repositoryFingerprint,
      expectedRevision: replica.ready.resolvedRevision,
      policy: "verify-only",
      deleteLocalFiles: true,
      ...overrides,
    });
  }
  const sync = (replica, extra = {}) =>
    lifecycle(replica, "project.replica.synchronize", extra);
  const remove = (replica, extra = {}) =>
    lifecycle(replica, "project.replica.remove", extra);
  const managed = await provision();
  assert.equal((await compare(sync(managed))).value.changed, false);
  await writeFile(
    path.join(fixture.seed, "README.md"),
    "Advanced published replica fixture\n",
  );
  await run("-C", fixture.seed, "add", "README.md");
  await run("-C", fixture.seed, "commit", "-m", "Advance origin");
  const advanced = await run("-C", fixture.seed, "rev-parse", "HEAD");
  for (const name of ["repository", "direct", "link", "held"])
    await run(
      "-C",
      fixture.seed,
      "push",
      path.join(path.dirname(fixture.remote), name + ".git"),
      "main",
    );
  await compare(sync(managed, { expectedRevision: advanced }), {
    status: "blocked",
  });
  const ff = sync(managed, {
    expectedRevision: advanced,
    policy: "fast-forward-primary",
  });
  assert.equal((await compare(ff)).value.changed, true);
  assert.equal((await compare(ff)).value.changed, false);
  const sentinel = path.join(managed.ready.path, "keep.txt");
  await writeFile(sentinel, "keep dirty user data");
  await compare(ff, { status: "blocked" });
  await rm(sentinel);
  await compare(sync(managed, { expectedRevision: "f".repeat(40) }), {
    status: "blocked",
  });
  await writeFile(path.join(managed.ready.path, "local.txt"), "unpublished");
  await run("-C", managed.ready.path, "add", "local.txt");
  await run("-C", managed.ready.path, "commit", "-m", "Unpublished");
  const unpublished = await run("-C", managed.ready.path, "rev-parse", "HEAD");
  await compare(sync(managed, { expectedRevision: unpublished }), {
    status: "blocked",
  });
  await compare(ff, { status: "blocked" });
  await compare(remove(managed), { status: "blocked" });
  await run(
    "-C",
    managed.ready.path,
    "checkout",
    "-B",
    "diverged",
    fixture.revision,
  );
  await writeFile(
    path.join(managed.ready.path, "diverged.txt"),
    "local divergence",
  );
  await run("-C", managed.ready.path, "add", "diverged.txt");
  await run("-C", managed.ready.path, "commit", "-m", "Diverged");
  await compare(ff, { status: "blocked" });
  await run("-C", managed.ready.path, "checkout", "--detach", fixture.revision);
  await compare(ff, { status: "blocked" });
  await run("-C", managed.ready.path, "checkout", "-B", "main", advanced);
  const ignored = path.join(managed.ready.path, "ignored-cache");
  await writeFile(
    path.join(managed.ready.path, ".git", "info", "exclude"),
    "ignored-cache/\n",
  );
  await mkdir(ignored);
  await writeFile(path.join(ignored, "keep.bin"), "keep ignored data");
  await compare(remove(managed), { status: "blocked" });
  assert.equal(
    await readFile(path.join(ignored, "keep.bin"), "utf8"),
    "keep ignored data",
  );
  await rm(ignored, { recursive: true });
  const secondary = path.join(root, "secondary");
  await run(
    "-C",
    managed.ready.path,
    "worktree",
    "add",
    "--detach",
    secondary,
    advanced,
  );
  await compare(remove(managed), { status: "blocked" });
  await run("-C", managed.ready.path, "worktree", "remove", secondary);
  await compare(remove(managed, { deleteLocalFiles: false }), {
    status: "removed",
  });
  assert.ok((await lstat(managed.ready.path)).isDirectory());
  await compare(remove(managed), { status: "removed" });
  await compare(remove(managed), { status: "removed" });
  await compare({ ...ff, sourcePath: "relative" }, { ok: false });

  const directOwned = await provision({
    placement: { mode: "direct", path: path.join(root, "owned-direct") },
  });
  await compare(sync(directOwned, { repositoryFingerprint: undefined }), {
    status: "blocked",
  });
  await compare(sync(directOwned, { repositoryFingerprint: "f".repeat(64) }), {
    status: "blocked",
  });
  await compare(
    sync(directOwned, {
      placement: {
        ...directOwned.ready.placement,
        canonicalPath: path.join(root, "wrong"),
      },
    }),
    { status: "blocked" },
  );
  await compare(
    sync(directOwned, {
      placement: {
        ...directOwned.ready.placement,
        canonicalPath: directOwned.ready.path + "/",
      },
    }),
    { status: "blocked" },
  );
  await compare(
    sync(directOwned, {
      sourcePath: directOwned.ready.path + "/",
      placement: {
        ...directOwned.ready.placement,
        canonicalPath: directOwned.ready.path + "/",
      },
    }),
    { status: "blocked" },
  );
  await compare(sync(directOwned));
  await writeFile(
    path.join(directOwned.ready.path, "README.md"),
    "dirty direct",
  );
  await compare(remove(directOwned), { status: "blocked" });
  await run("-C", directOwned.ready.path, "checkout", "--", "README.md");
  await compare(remove(directOwned, { repositoryFingerprint: undefined }), {
    status: "blocked",
  });
  await compare(remove(directOwned, { deleteLocalFiles: false }), {
    status: "removed",
  });
  await compare(remove(directOwned, { deleteLocalFiles: false }), {
    status: "removed",
  });
  await compare(remove(directOwned), { status: "blocked" });
  assert.ok((await lstat(directOwned.ready.path)).isDirectory());
  await assert.rejects(
    lstat(
      path.join(directOwned.ready.path, ".git", "cantrip-project-owner.json"),
    ),
    { code: "ENOENT" },
  );
  const user = path.join(root, "user-checkout");
  await checkout(user);
  const userOwned = await provision({
    placement: { mode: "direct", path: user },
  });
  assert.equal(userOwned.ready.placement.ownership, "user");
  await compare(remove(userOwned), { status: "blocked" });
  await compare(remove(userOwned, { repository: null }), { status: "blocked" });
  await compare(
    remove(userOwned, { repository: null, deleteLocalFiles: false }),
    { status: "removed" },
  );
  assert.ok((await lstat(user)).isDirectory());

  setDirectory(path.join(root, "worker-links"));
  const link = await provision({
    placement: { mode: "managed-link", path: path.join(root, "link") },
  });
  await compare(sync(link));
  await writeFile(
    link.ready.placement.linkPath + ".sentinel",
    "outside survives",
  );
  await compare(remove(link), { status: "removed" });
  await assert.rejects(lstat(link.ready.path), { code: "ENOENT" });
  await assert.rejects(lstat(link.ready.placement.linkPath), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(link.ready.placement.linkPath + ".sentinel", "utf8"),
    "outside survives",
  );
  const retained = await provision({
    placement: { mode: "managed-link", path: path.join(root, "retained-link") },
  });
  await compare(remove(retained, { deleteLocalFiles: false }), {
    status: "removed",
  });
  await compare(remove(retained), { status: "blocked" });
  await compare(remove(retained, { deleteLocalFiles: false }), {
    status: "removed",
  });
  assert.ok((await lstat(retained.ready.placement.linkPath)).isSymbolicLink());
  setDirectory(path.join(root, "worker-missing-link"));
  const missing = await provision({
    placement: { mode: "managed-link", path: path.join(root, "missing-link") },
  });
  await rm(missing.ready.path, { recursive: true });
  await compare(remove(missing), { status: "removed" });
  await assert.rejects(lstat(missing.ready.placement.linkPath), {
    code: "ENOENT",
  });
  setDirectory(path.join(root, "worker-replaced-link"));
  const replaced = await provision({
    placement: { mode: "managed-link", path: path.join(root, "replaced-link") },
  });
  await rm(replaced.ready.placement.linkPath);
  await writeFile(replaced.ready.placement.linkPath, "replacement survives");
  const warned = (await compare(remove(replaced), { status: "removed" })).value;
  assert.equal(warned.linkRemoved, false);
  assert.ok(warned.warning);
  assert.equal(
    await readFile(replaced.ready.placement.linkPath, "utf8"),
    "replacement survives",
  );

  setDirectory(path.join(root, "worker-workspace"));
  const workspace = await provision({
    workspaceStorage: { kind: "managed", workspaceId: randomUUID() },
  });
  await compare(sync(workspace));
  // Source removal retains its worker-level storage restriction even though
  // workspace-scoped provision/synchronization are available.
  await compare(remove(workspace), { status: "blocked" });
  setDirectory(path.join(root, "worker-delete-direct"));
  const deleted = await provision({
    placement: { mode: "direct", path: path.join(root, "delete-direct") },
  });
  await compare(remove(deleted), { status: "removed" });
  await compare(remove(deleted), { status: "removed" });
  const queued = await provision({
    placement: { mode: "direct", path: path.join(root, "queue-direct") },
  });
  const replies = await compare([sync(queued), remove(queued)], {
    batch: true,
  });
  assert.equal(replies[0].value.status, "ready");
  assert.equal(replies[1].value.status, "removed");
  const rawTarget = path.join(root, "missing-raw-\ufffd");
  const raw = await provision({
    placement: { mode: "direct", path: rawTarget },
  });
  await rm(raw.ready.path, { recursive: true });
  const rawRequested = rawTarget.slice(0, -1) + "\ud800";
  await compare(
    remove(raw, {
      sourcePath: rawRequested,
      placement: { ...raw.ready.placement, canonicalPath: rawRequested },
    }),
    { status: "removed" },
  );
  await compare(
    command({
      type: "project.replica.remove",
      sourcePath: path.join(
        getDirectory(),
        "repositories",
        "fixture",
        "missing-\ud800",
      ),
      deleteLocalFiles: true,
    }),
    { status: "removed" },
  );
  return {
    actualNodeAndNative: true,
    exactCliArgumentsAndOrder: true,
    privateStateAndGitStateCompared: true,
    verifyOnlyAndFastForward: true,
    unreachableAheadDivergedDetachedAndDirtyGuards: true,
    ignoredFilesAndExtraWorktreesPreserved: true,
    publishedHistoryRequiredForDeletion: true,
    userOwnedAndRetainedCheckoutsPreserved: true,
    missingAndReplacedLinks: true,
    removalLifecycleOrdering: true,
    serializedSyncAndRemoval: true,
    sourceStorageRestrictionsPreserved: true,
  };
}
