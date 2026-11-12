import { actualGithubReplicas } from "./actual-github-replicas.mjs";
import {
  prepareReplicaRedisOutage,
  recoverReplicaAcrossRedisOutage,
} from "./actual-replica-redis-outage.mjs";
// Existing encrypted browser APIs and two complete worker processes; all Git
// paths belong to this disposable fixture. No command/repository substitution.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import { normalizeProjectSourcePath } from "../../cantrip_worker/src/project-source-path.ts";

export async function actualProjectReplicas({
  page,
  fixture,
  root,
  projectId,
  directory,
  startWorker,
  stopWorker,
  cliBinary,
  result,
}) {
  const workerId = "actual-replica-worker";
  const dataDirectory = path.join(root, fixture.kind, "replica-worker");
  const clone = path.join(root, fixture.kind, "private-replica-checkout");
  execFileSync("git", ["clone", "--no-hardlinks", "--", directory, clone]);
  const target = normalizeProjectSourcePath(await realpath(clone));
  const revision = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const contents = await readFile(path.join(clone, "retained.txt"), "utf8");
  const redisOutage = process.argv.includes("--replica-redis-outage")
    ? await prepareReplicaRedisOutage(path.dirname(clone), target)
    : undefined;
  const requests = [];
  const capture = (request) => {
    if (
      /\/api\/(?:projects\/[^/]+\/(?:replicas|repository)|project-replica-jobs\/)/.test(
        request.url(),
      )
    )
      requests.push({ url: request.url(), body: request.postData() });
  };
  page.on("request", capture);
  const call = (operation, args = []) =>
    page.evaluate(
      async ({ operation, args }) => {
        const api = await import("/src/lib/api/project-replicas.ts");
        return api[operation](...args);
      },
      { operation, args },
    );
  let worker;
  const start = async (enrollmentCode) => {
    worker = launchActualWorker(
      fixture.workerFixture ?? fixture,
      dataDirectory,
      {
        cliBinary,
        enrollmentCode,
        workerId,
        traceShutdown: true,
        environment: redisOutage?.environment,
      },
    );
    await worker.ready();
    if (fixture.workerFixture) await fixture.assertRemoteWorker(workerId);
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) => {
        const second = workers.find((value) => value.workerId === workerId);
        assert.equal(second?.online, true);
        assert.ok(second.encryption.principalId);
        assert.equal(second.projectReplicas.directPlacement, true);
      },
    );
  };
  const stop = async () => {
    if (!worker) return;
    const current = worker;
    worker = undefined;
    (result.replicaWorkerStops ??= []).push(await current.close());
    (result.replicaWorkerDiagnostics ??= []).push(current.diagnostics());
  };
  const waitJob = (id) =>
    eventually(
      () => call("getProjectReplicaJob", [id]),
      (job) => {
        assert.equal(job.state, "succeeded", JSON.stringify(job));
        assert.equal(job.error, null);
      },
    );
  const liveReady = () =>
    eventually(
      () => page.evaluate(() => window.replicaLive.snapshot()),
      (snapshot) => {
        assert.equal(snapshot.status, "live");
        assert.equal(snapshot.activeScopeCount, snapshot.desiredScopeCount);
      },
    );
  const jobEvents = (id) =>
    page.evaluate(
      (jobId) =>
        window.replicaEvents.filter(
          (event) =>
            event.resource === "project-replica-job" &&
            event.entityId === jobId,
        ),
      id,
    );
  const jobLive = (job) =>
    eventually(
      () => jobEvents(job.id),
      (events) => {
        assert.equal(events[0]?.revision, 1);
        assert.equal(events.at(-1)?.revision, job.stateRevision);
        for (let index = 1; index < events.length; index++)
          assert.ok(
            events[index].revision > events[index - 1].revision,
            "initial execution retains ordered unique job revisions",
          );
      },
    );
  try {
    await page.evaluate(
      async ({ origin, projectId }) => {
        const { AppLiveClient, appLiveWebSocketUrl } =
          await import("/src/lib/app-live-client.ts");
        window.replicaEvents = [];
        window.replicaLive = new AppLiveClient({
          client: {
            id: "actual-replica-browser",
            name: "Replica acceptance",
            version: "1",
          },
          storage: localStorage,
          storageKey: "actual-replica-resume",
          url: appLiveWebSocketUrl(origin, location.origin),
          onEvent: (event) => window.replicaEvents.push(event),
          onResync: async () => {
            await window.folderWire.getProjectWireList();
          },
        });
        window.replicaLive.retainScope({ kind: "project", projectId });
        window.replicaLive.start();
      },
      { origin: fixture.server.origin, projectId },
    );
    await liveReady();
    const original = await call("getProjectReplicas", [projectId]);
    assert.equal(original.length, 1);
    const primaryWorker = redisOutage ? await startWorker() : undefined;
    const enrollment = await page.evaluate(
      async (workerId) =>
        (await import("/src/lib/api/workers.ts")).createWorkerEnrollmentCode({
          label: workerId,
        }),
      workerId,
    );
    await start(enrollment.code);
    const input = {
      workerId,
      placement: { mode: "direct", path: target },
      expectedRevision: revision,
      idempotencyKey: "actual-local-git-replica",
    };
    const admitted = await call("createProjectReplica", [projectId, input]);
    const completed = redisOutage
      ? await recoverReplicaAcrossRedisOutage({
          fixture,
          gate: redisOutage,
          worker,
          primaryWorker,
          workerId,
          primaryWorkerId: original[0].workerId,
          admitted,
          waitJob,
          result,
        })
      : await waitJob(admitted.id);
    assert.equal(completed.attempt, redisOutage ? 2 : 1);
    await jobLive(completed);
    const attached = await eventually(
      () => call("getProjectReplicas", [projectId]),
      (replicas) => {
        assert.equal(replicas.length, 2);
        const replica = replicas.find((value) => value.workerId === workerId);
        assert.equal(replica?.path, target);
        assert.equal(replica.head, revision);
        assert.equal(replica.placementMode, "direct");
        assert.equal(replica.ownershipKind, "user");
        assert.equal(replica.ready, true);
      },
    );
    const replica = attached.find((value) => value.workerId === workerId);
    const initialEventCount = fixture.workerFixture
      ? (await jobEvents(admitted.id)).length
      : 0;
    assert.equal(
      (await call("createProjectReplica", [projectId, input])).id,
      admitted.id,
    );
    result.steps.push(
      "encrypted browser attaches an existing local Git checkout through a second full worker with exact revision and idempotent admission",
    );
    const raw = await page.evaluate(
      async (id) =>
        (await window.folderWire.getProjectWireList()).find(
          (project) => project.id === id,
        ),
      projectId,
    );
    assert.equal(raw.capabilities.github, false);
    assert.equal(raw.capabilities.replicas, true);
    assert.ok(
      raw.replicas.every((value) =>
        /^ctrr_[A-Za-z0-9_-]{43}$/.test(value.path),
      ),
    );
    if (fixture.workerFixture) {
      await eventually(
        () => jobEvents(admitted.id),
        (events) => {
          assert.equal(events.length, initialEventCount + 1);
          assert.equal(events.at(-1).revision, completed.stateRevision);
        },
      );
      const claims = async () =>
        Promise.all(
          [original[0].workerId, workerId].map(async (id) => {
            const { connectionId, instanceId } =
              await fixture.assertRemoteWorker(id);
            return { workerId: id, connectionId, instanceId };
          }),
        );
      const before = await claims();
      const workerServerPid = fixture.workerFixture.server.child.pid;
      const replicaWorkerPid = worker.child.pid;
      const replacement = await fixture.replacePeer(0, fixture.peers[0].kind, {
        crash: true,
      });
      assert.notEqual(replacement.after.pid, replacement.before.pid);
      await liveReady();
      assert.deepEqual(await claims(), before);
      assert.equal(fixture.workerFixture.server.child.pid, workerServerPid);
      assert.equal(worker.child.pid, replicaWorkerPid);
      assert.deepEqual(
        await call("getProjectReplicaJob", [admitted.id]),
        completed,
      );
      const published = () => jobEvents(admitted.id);
      const previousEvents = await published();
      const replay = await call("createProjectReplica", [projectId, input]);
      assert.deepEqual(replay, completed);
      const events = await eventually(published, (observations) => {
        assert.equal(observations.length, previousEvents.length + 1);
        assert.equal(observations.at(-1).revision, completed.stateRevision);
      });
      result.replicaPeerRecovery = {
        replacement,
        workerServerPid,
        replicaWorkerPid,
        claims: before,
        jobId: replay.id,
        attempt: replay.attempt,
        stateRevision: replay.stateRevision,
        replayEvent: events.at(-1),
      };
      result.steps.push(
        "replacing the browser server preserves both remote worker connections, the completed replica job and its replay publication",
      );
    }
    const port = Number(new URL(fixture.server.origin).port);
    await stop();
    await stopWorker();
    await fixture.close();
    await fixture.start({ port });
    await startWorker();
    await start();
    await liveReady();
    await eventually(
      () => call("getProjectReplicas", [projectId]),
      (replicas) => {
        const retained = replicas.find((value) => value.id === replica.id);
        assert.equal(retained?.path, target);
        assert.equal(retained.head, revision);
        assert.equal(retained.ready, true);
      },
    );
    assert.equal(
      (await call("createProjectReplica", [projectId, input])).id,
      admitted.id,
    );
    result.steps.push(
      "server and both full workers restart while retaining replica identity, endpoint metadata and exact admission replay",
    );
    const denied = await page.evaluate(
      async ({ projectId, replicaId }) => {
        try {
          await (
            await import("/src/lib/api/project-replicas.ts")
          ).removeProjectReplica(projectId, replicaId, {
            deleteLocalFiles: true,
            idempotencyKey: "deny-user-checkout-deletion",
          });
          return { status: 200 };
        } catch (error) {
          return { status: error.status, message: error.message };
        }
      },
      { projectId, replicaId: replica.id },
    );
    assert.equal(denied.status, 409, JSON.stringify(denied));
    assert.equal(
      await readFile(path.join(clone, "retained.txt"), "utf8"),
      contents,
    );
    const removal = await call("removeProjectReplica", [
      projectId,
      replica.id,
      { deleteLocalFiles: false, idempotencyKey: "detach-user-checkout" },
    ]);
    const removed = await waitJob(removal.id);
    await jobLive(removed);
    await eventually(
      () => call("getProjectReplicas", [projectId]),
      (replicas) => {
        assert.equal(replicas.length, 1);
        assert.equal(replicas[0].id, original[0].id);
      },
    );
    assert.equal((await stat(clone)).isDirectory(), true);
    assert.equal(
      await readFile(path.join(clone, "retained.txt"), "utf8"),
      contents,
    );
    assert.equal(
      execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      revision,
    );
    for (const secret of [target, directory, "retained.txt"])
      assert.equal(
        JSON.stringify(requests).includes(secret),
        false,
        "replica HTTP metadata remains opaque",
      );
    result.actualReplica = {
      admitted,
      completed,
      replica,
      denied,
      requests,
      liveEvents: await page.evaluate(() => window.replicaEvents),
    };
    result.steps.push(
      "user-owned checkout deletion is refused; encrypted detach retires only the replica and preserves its actual Git files and original source",
    );
    if (process.argv.includes("--github-replicas"))
      await actualGithubReplicas({
        page,
        fixture,
        primaryWorkerId: "actual-folder-worker",
        secondaryWorkerId: workerId,
        primaryDataDirectory: path.join(root, fixture.kind, "worker"),
        secondaryDataDirectory: dataDirectory,
        diagnostics: () => worker?.diagnostics() ?? "",
        result,
      });
  } catch (error) {
    result.actualReplicaFailure = {
      message: error.message,
      stack: error.stack,
    };
    throw error;
  } finally {
    await redisOutage?.release();
    await stop();
    if (redisOutage) await stopWorker();
    await page.evaluate(() => window.replicaLive?.stop()).catch(() => {});
    page.off("request", capture);
  }
}

export function replicaProductJobEvents(runtime) {
  const replica = runtime.actualReplica;
  const events = replica.liveEvents.filter(
    (event) => event.resource === "project-replica-job",
  );
  const ids = [
    replica.admitted.id,
    ...new Set(
      events
        .map((event) => event.entityId)
        .filter((id) => id !== replica.admitted.id),
    ),
  ];
  assert.equal(ids.length, 2);
  return ids.map((id) =>
    events
      .filter((event) => event.entityId === id)
      .map((event) => {
        assert.deepEqual(event.scope, {
          kind: "project",
          projectId: replica.replica.projectId,
        });
        return { revision: event.revision, action: event.action };
      }),
  );
}
