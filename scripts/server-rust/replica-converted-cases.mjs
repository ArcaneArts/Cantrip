import assert from "node:assert/strict";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";

const literal = (value) => "'" + value.replaceAll("'", "''") + "'";

// Seed a representative completed conversion while the HTTP server is stopped.
// Removal itself uses the production HTTP routes, executor and worker transport.
export async function replicaConvertedCases({
  fixture,
  visit,
  read,
  waitJob,
  until,
  replicasPath,
  repository,
  commands,
  workers,
  reconnect,
  root,
  profile,
  kind,
  id,
  setFolderDeleteMode,
}) {
  const executable =
    process.env.CANTRIP_RUST_PROJECT_REPOSITORY_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  const snapshots = [],
    events = [];
  const offlineDatabase = async (operation) => {
    const port = Number(new URL(fixture.server.origin).port);
    await fixture.close();
    for (const worker of workers) worker.close();
    const database = await repositoryFixture({
      kind,
      executable,
      root: path.join(root, profile),
      databaseMode: fixture.databaseMode,
      databaseUrl: fixture.environment.DATABASE_URL,
    });
    try {
      await operation(database);
    } finally {
      await database.close();
    }
    await fixture.start({ port });
    for (const connect of reconnect.values()) await connect();
    await until(
      () => read(replicasPath),
      (replicas) => {
        assert.ok(
          replicas.every((replica) => replica.workerOnline),
          "all retained replica workers reconnect after restart",
        );
      },
    );
  };
  for (const deleteLocalFiles of [false, true]) {
    const key = deleteLocalFiles ? "converted-delete" : "converted-retain";
    let replica = (await read(replicasPath)).find(
      (value) => value.workerId === "replica-b",
    );
    if (!replica) {
      await visit(`${key} provision`, "POST", replicasPath, {
        status: 202,
        json: {
          workerId: "replica-b",
          repository,
          idempotencyKey: key + "-provision",
        },
      });
      const provision = fixture.records.get(`${key} provision`);
      const ready = await waitJob(provision.id, "succeeded");
      replica = (await read(replicasPath)).find(
        (value) => value.id === ready.projectReplicaId,
      );
    }
    assert.ok(replica);
    await offlineDatabase(async (database) => {
      await database.seed(
        `INSERT INTO project_github_conversion_jobs(id,owner_id,project_id,project_source_id,worker_id,repository_blind_index,repository_id,repository_full_name,repository_url,confirmation_token,state,completed_at) SELECT ${literal(key)},owner_id,id,${literal(replica.id)},'replica-b',github_repository_blind_index,github_repository_id,github_repository_full_name,github_repository_url,'opaque-confirmation','succeeded',now() FROM projects WHERE id=${literal(id)}`,
      );
    });
    const live = await new LiveProbe(fixture).open();
    try {
      await live.initialized();
      await live.subscribed(key, [
        currentUser,
        { kind: "project", projectId: id },
      ]);
      const before = commands.length;
      setFolderDeleteMode(deleteLocalFiles ? "throw" : "success");
      await visit(
        `${key} removal`,
        "POST",
        `${replicasPath}/${replica.id}/remove`,
        {
          status: 202,
          json: { repository, deleteLocalFiles, idempotencyKey: key },
        },
      );
      const job = fixture.records.get(`${key} removal`);
      if (deleteLocalFiles) {
        const failed = await waitJob(job.id, "failed");
        assert.deepEqual(failed.error, {
          code: "worker-error",
          retryable: true,
        });
        await visit(
          `${key} failed`,
          "GET",
          `/api/project-replica-jobs/${job.id}`,
        );
        setFolderDeleteMode("absent");
        await visit(
          `${key} retry`,
          "POST",
          `/api/project-replica-jobs/${job.id}/retry`,
          {
            json: { stateRevision: failed.stateRevision },
          },
        );
      }
      const completed = await waitJob(job.id, "succeeded");
      assert.equal(completed.attempt, deleteLocalFiles ? 2 : 1);
      assert.equal(completed.error, null);
      await visit(
        `${key} succeeded`,
        "GET",
        `/api/project-replica-jobs/${job.id}`,
      );
      const dispatched = commands.slice(before);
      assert.deepEqual(
        dispatched.map(({ command }) => command.type),
        deleteLocalFiles
          ? ["project.folder.delete", "project.folder.delete"]
          : [],
      );
      for (const { workerId, command } of dispatched) {
        assert.equal(workerId, "replica-b");
        assert.equal(command.projectId, id);
        assert.ok(command.workspaceStorage);
      }
      await live.message(
        (event) =>
          event.type === "event" &&
          event.resource === "project-replica-job" &&
          event.entityId === job.id &&
          event.revision === completed.stateRevision,
      );
      await live.ping(key + " completion barrier");
      const jobEvents = live.history.filter(
        (event) =>
          event.type === "event" &&
          event.resource === "project-replica-job" &&
          event.entityId === job.id,
      );
      assert.deepEqual(
        jobEvents.map((event) => event.revision),
        deleteLocalFiles ? [1, 3, 4, 6] : [1, 3],
      );
      events.push(
        ...jobEvents.map(({ entityId, revision, scope, resource, action }) => ({
          entityId,
          revision,
          scope,
          resource,
          action,
        })),
      );
    } finally {
      await live.close();
    }
    await offlineDatabase(async (database) => {
      const result = await database.request({
        op: "query-json",
        sql: `SELECT jsonb_build_object('localFilesDeleted',c.local_files_deleted_at IS NOT NULL,'removed',s.removed_at IS NOT NULL,'worktreeState',w.lifecycle_state) AS result FROM project_github_conversion_jobs c JOIN project_sources s ON s.id=c.project_source_id JOIN project_worktrees w ON w.project_source_id=s.id AND w.is_primary=true WHERE c.id=${literal(key)}`,
      });
      assert.equal(result.rejected, false, result.diagnostic);
      assert.deepEqual(result.value, {
        localFilesDeleted: deleteLocalFiles,
        removed: true,
        worktreeState: "missing",
      });
      snapshots.push({ key, ...result.value });
    });
    await visit(`${key} replicas after restart`, "GET", replicasPath);
    assert.ok(
      !fixture.records
        .get(`${key} replicas after restart`)
        .some((value) => value.id === replica.id),
    );
  }
  return { snapshots, events };
}
