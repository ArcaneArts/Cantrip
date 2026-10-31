import { replicaConcurrencyCases } from "./replica-concurrency-cases.mjs";
import { replicaConvertedCases } from "./replica-converted-cases.mjs";
import { replicaIsolationCases } from "./replica-isolation-cases.mjs";
import { replicaLeaseCases } from "./replica-lease-cases.mjs";
import { replicaShutdownCases } from "./replica-shutdown-cases.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sendHeartbeat } from "../../cantrip_worker/src/heartbeat.ts";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { heartbeat } from "./security-fixtures.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
async function until(read, check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
    }
    await delay(timeoutMs > 20000 ? 250 : 20);
  }
}
export async function replicaConnectedCases({
  fixture,
  visit,
  root,
  profile,
  kind,
  id,
}) {
  const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
  const revision = "a".repeat(40),
    nextRevision = "b".repeat(40);
  const repository = fixture.records.get("import").github.nameWithOwner;
  let faultMode = "success";
  let folderDeleteMode = "success";
  const leaseState = { holdSync: false, staleSync: false };
  const commands = [],
    workers = [],
    releases = new Map(),
    reconnect = new Map();
  const read = async (url) => {
    const response = await fetch(fixture.server.origin + url, {
      headers: {
        cookie: [...fixture.client().cookies]
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const waitJob = (job, state, timeoutMs) =>
    until(
      () => read(`/api/project-replica-jobs/${job}`),
      (value) => assert.equal(value.state, state, JSON.stringify(value)),
      timeoutMs,
    );
  const live = await new LiveProbe(fixture).open();
  try {
    await live.initialized();
    await live.subscribed("replica-scope", [
      currentUser,
      { kind: "project", projectId: id },
    ]);
    for (const [index, workerId] of ["replica-a", "replica-b"].entries()) {
      const workerHeartbeat = {
        ...heartbeat,
        workerId,
        managedFolders: { ...heartbeat.managedFolders, remove: true },
        projectReplicas: {
          provision: true,
          synchronize: true,
          remove: true,
          exactRevision: true,
          directPlacement: true,
          managedLinkPlacement: true,
          attachExisting: true,
          recursiveParentCreation: true,
          workspaceScopedRoots: true,
        },
      };
      await visit(workerId + " code", "POST", "/api/workers/enrollment-codes", {
        status: 201,
        json: { label: workerId },
      });
      await visit(
        workerId + " enroll",
        "POST",
        "/api/internal/workers/enroll",
        {
          status: 201,
          client: "worker",
          json: {
            code: fixture.records.get(workerId + " code").code,
            heartbeat: workerHeartbeat,
          },
        },
      );
      const config = {
        dataDirectory: path.join(root, profile, kind, workerId),
        name: workerId,
        serverUrl: fixture.server.origin,
        enrollmentCode: null,
        replacement: null,
        token: fixture.records.get(workerId + " enroll").credential,
        tokenSource: "persisted",
        workerId,
      };
      saveWorkerCredential({
        credential: config.token,
        dataDirectory: config.dataDirectory,
        serverUrl: config.serverUrl,
        workerId,
      });
      let connected = false;
      const makeWorker = () =>
        new WorkerConnection(
          config,
          async (command, emit) => {
            if (command.type === "worktree.observation.configure")
              return { accepted: true, paths: [] };
            if (command.type === "project.folder.delete") {
              commands.push({ workerId, command });
              if (folderDeleteMode === "throw")
                throw new Error("Controlled converted-folder deletion failure");
              return { deleted: folderDeleteMode !== "absent" };
            }
            if (!command.type.startsWith("project.replica."))
              throw new Error("Unsupported controlled command " + command.type);
            commands.push({ workerId, command });
            if (command.type === "project.replica.link.repair")
              return {
                status: "ready",
                projectId: id,
                path: command.sourcePath,
                linkPath: command.linkPath,
                repaired: true,
              };
            emit({
              type: "project.replica.progress",
              jobId: command.jobId,
              attempt: command.attempt + 1,
              progress: { stage: "fetching", percent: 90 },
            });
            emit({
              type: "project.replica.progress",
              jobId: "99999999-9999-4999-8999-999999999999",
              attempt: command.attempt,
              progress: { stage: "fetching", percent: 91 },
            });
            emit({
              type: "project.replica.progress",
              jobId: command.jobId,
              attempt: command.attempt,
              progress: { stage: "verifying", percent: 25 },
            });
            if (command.type === "project.replica.provision") {
              const capacityIndex =
                command.projectId === id
                  ? null
                  : Number(command.projectId.slice(-12));
              const sourcePath = handle(
                capacityIndex === null ? 10 + index : 50 + capacityIndex,
              );
              const displayPath = handle(
                capacityIndex === null ? 20 + index : 70 + capacityIndex,
              );
              if (index === 0)
                await new Promise((resolve) =>
                  releases.set(command.jobId, resolve),
                );
              return {
                status: "ready",
                jobId: command.jobId,
                attempt: command.attempt,
                path: sourcePath,
                displayPath,
                repositoryFingerprint: String(index + 1).repeat(64),
                resolvedRevision: revision,
                branch: "main",
                reused: false,
                placement:
                  index === 0
                    ? {
                        mode: "managed-link",
                        materialization: "cloned",
                        ownership: "cantrip",
                        canonicalPath: sourcePath,
                        requestedPath: command.placement.path,
                        linkPath: handle(
                          capacityIndex === null ? 5 : 170 + capacityIndex,
                        ),
                      }
                    : null,
              };
            }
            if (
              command.type === "project.replica.synchronize" &&
              leaseState.holdSync &&
              workerId === "replica-a"
            )
              await new Promise((resolve) =>
                releases.set(command.jobId, resolve),
              );
            if (
              command.type === "project.replica.synchronize" &&
              leaseState.staleSync &&
              workerId === "replica-b"
            ) {
              leaseState.staleSync = false;
              return {
                status: "ready",
                jobId: command.jobId,
                attempt: command.attempt + 1,
                path: command.sourcePath,
                previousRevision: revision,
                resolvedRevision: nextRevision,
                branch: "main",
                changed: true,
              };
            }
            if (
              command.type === "project.replica.synchronize" &&
              faultMode === "blocked"
            )
              return {
                status: "blocked",
                jobId: command.jobId,
                attempt: command.attempt,
                error: { code: "replica-not-ready", retryable: true },
              };
            if (
              command.type === "project.replica.synchronize" &&
              faultMode === "throw"
            )
              throw new Error("Controlled replica synchronization failure");
            if (command.type === "project.replica.synchronize")
              return {
                status: "ready",
                jobId: command.jobId,
                attempt: command.attempt,
                path: command.sourcePath,
                previousRevision: revision,
                resolvedRevision: nextRevision,
                branch: "main",
                changed: true,
              };
            if (command.type === "project.replica.remove")
              return {
                status: "removed",
                jobId: command.jobId,
                attempt: command.attempt,
                path: command.sourcePath,
                localFilesDeleted: command.deleteLocalFiles,
              };
            throw new Error("Unexpected replica command " + command.type);
          },
          undefined,
          undefined,
          undefined,
          1000,
          () => {
            connected = true;
          },
        );
      const connect = async () => {
        connected = false;
        const worker = makeWorker();
        workers.push(worker);
        worker.start();
        await until(
          () => connected,
          (value) => assert.equal(value, true),
        );
        await sendHeartbeat(config, workerHeartbeat);
        return worker;
      };
      reconnect.set(workerId, connect);
      await connect();
    }
    const replicasPath = `/api/projects/${id}/replicas`;
    await visit("connected provision", "POST", replicasPath, {
      status: 202,
      json: {
        workerId: "replica-a",
        repository,
        placement: { mode: "managed-link", path: handle(4) },
        idempotencyKey: "connected-first",
      },
    });
    const first = fixture.records.get("connected provision");
    await until(
      () => read(`/api/project-replica-jobs/${first.id}`),
      (job) => {
        assert.equal(job.state, "running");
        assert.equal(job.progress.percent, 25);
        assert.equal(job.progress.stage, "verifying");
        assert.equal(job.stateRevision, 3);
      },
    );
    await visit(
      "held progress",
      "GET",
      `/api/project-replica-jobs/${first.id}`,
    );
    assert.deepEqual(await read(replicasPath), []);
    await until(
      () => releases.has(first.id),
      (value) => assert.equal(value, true),
    );
    releases.get(first.id)();
    releases.delete(first.id);
    await waitJob(first.id, "succeeded");
    await visit(
      "first succeeded",
      "GET",
      `/api/project-replica-jobs/${first.id}`,
    );
    await visit("first replicas", "GET", replicasPath);
    const firstReplica = fixture.records.get("first replicas")[0];
    assert.equal(firstReplica.ready, true);
    assert.equal(firstReplica.path, handle(10));
    assert.equal(firstReplica.placementMode, "managed-link");
    if (profile === "accounts")
      await replicaIsolationCases({
        fixture,
        visit,
        read,
        replicasPath,
        firstReplica,
        first,
        repository,
        nextRevision,
        commands,
        id,
      });
    await visit(
      "managed link repair",
      "POST",
      `${replicasPath}/${firstReplica.id}/repair-link`,
    );
    await visit(
      "synchronize",
      "POST",
      `${replicasPath}/${firstReplica.id}/synchronize`,
      {
        status: 202,
        json: {
          repository,
          expectedRevision: nextRevision,
          policy: "fast-forward-primary",
          idempotencyKey: "connected-sync",
        },
      },
    );
    const sync = fixture.records.get("synchronize");
    await waitJob(sync.id, "succeeded");
    await visit(
      "sync succeeded",
      "GET",
      `/api/project-replica-jobs/${sync.id}`,
    );
    await visit("synced replicas", "GET", replicasPath);
    assert.equal(fixture.records.get("synced replicas")[0].head, nextRevision);
    await visit("second provision", "POST", replicasPath, {
      status: 202,
      json: {
        workerId: "replica-b",
        repository,
        idempotencyKey: "connected-second",
      },
    });
    const second = fixture.records.get("second provision");
    await waitJob(second.id, "succeeded");
    await visit("two replicas", "GET", replicasPath);
    const replicas = fixture.records.get("two replicas");
    assert.equal(replicas.length, 2);
    const secondReplica = replicas.find(
      (value) => value.workerId === "replica-b",
    );
    assert.ok(secondReplica);
    await visit(
      "remove second",
      "POST",
      `${replicasPath}/${secondReplica.id}/remove`,
      {
        status: 202,
        json: {
          repository,
          deleteLocalFiles: false,
          idempotencyKey: "connected-remove",
        },
      },
    );
    const removal = fixture.records.get("remove second");
    await waitJob(removal.id, "succeeded");
    await visit(
      "removal succeeded",
      "GET",
      `/api/project-replica-jobs/${removal.id}`,
    );
    await visit("remaining replica", "GET", replicasPath);
    assert.equal(fixture.records.get("remaining replica").length, 1);
    assert.equal(
      fixture.records.get("remaining replica")[0].id,
      firstReplica.id,
    );
    await visit(
      "last source protected",
      "POST",
      `${replicasPath}/${firstReplica.id}/remove`,
      {
        status: 409,
        json: {
          repository,
          deleteLocalFiles: false,
          idempotencyKey: "last-source",
        },
      },
    );
    await live.ping("replica completion barrier");
    const jobIds = [first.id, sync.id, second.id, removal.id];
    const events = live.history.filter(
      (event) =>
        event.type === "event" &&
        event.resource === "project-replica-job" &&
        jobIds.includes(event.entityId),
    );
    for (const job of jobIds)
      assert.deepEqual(
        events
          .filter((event) => event.entityId === job)
          .map((event) => event.revision),
        [1, 3, 4],
        "admission, ordered valid progress and completion; stale events must not publish",
      );
    assert.equal(commands.length, 5);
    for (const { command } of commands) {
      assert.equal(command.projectId, id);
      assert.deepEqual(command.repository, { nameWithOwner: repository });
      if (command.type !== "project.replica.link.repair")
        assert.equal(command.attempt, 1);
    }
    if (process.argv.includes("--faults")) {
      faultMode = "blocked";
      await visit(
        "worker blocks synchronization",
        "POST",
        `${replicasPath}/${firstReplica.id}/synchronize`,
        {
          status: 202,
          json: {
            repository,
            expectedRevision: nextRevision,
            idempotencyKey: "fault-sync",
          },
        },
      );
      const faultJob = fixture.records.get("worker blocks synchronization");
      let blocked = await waitJob(faultJob.id, "blocked");
      await visit(
        "worker blocked job",
        "GET",
        `/api/project-replica-jobs/${faultJob.id}`,
      );
      assert.deepEqual(blocked.error, {
        code: "replica-not-ready",
        retryable: true,
      });
      await visit(
        "unsafe cancellation refused",
        "POST",
        `/api/project-replica-jobs/${faultJob.id}/cancel`,
        { status: 409, json: { stateRevision: blocked.stateRevision } },
      );
      faultMode = "throw";
      await visit(
        "retry worker error",
        "POST",
        `/api/project-replica-jobs/${faultJob.id}/retry`,
        { json: { stateRevision: blocked.stateRevision } },
      );
      const failed = await waitJob(faultJob.id, "failed");
      await visit(
        "worker failed job",
        "GET",
        `/api/project-replica-jobs/${faultJob.id}`,
      );
      assert.deepEqual(failed.error, { code: "worker-error", retryable: true });
      assert.equal(failed.attempt, 2);
      faultMode = "success";
      await visit(
        "retry recovers",
        "POST",
        `/api/project-replica-jobs/${faultJob.id}/retry`,
        { json: { stateRevision: failed.stateRevision } },
      );
      const recovered = await waitJob(faultJob.id, "succeeded");
      await visit(
        "recovered job",
        "GET",
        `/api/project-replica-jobs/${faultJob.id}`,
      );
      assert.equal(recovered.attempt, 3);
      assert.equal(recovered.error, null);
      await live.ping("fault recovery barrier");
      const faultEvents = live.history.filter(
        (event) =>
          event.type === "event" &&
          event.resource === "project-replica-job" &&
          event.entityId === faultJob.id,
      );
      assert.deepEqual(
        faultEvents.map((event) => event.revision),
        [1, 3, 4, 5, 7, 8, 9, 11, 12],
      );
      events.push(...faultEvents);
      assert.equal(commands.length, 8);
    }
    if (process.argv.includes("--reconnect")) {
      workers[1].close();
      await visit("provision disconnected worker", "POST", replicasPath, {
        status: 202,
        json: {
          workerId: "replica-b",
          repository,
          idempotencyKey: "reconnect-provision",
        },
      });
      const reconnectJob = fixture.records.get("provision disconnected worker");
      const blocked = await waitJob(reconnectJob.id, "blocked");
      assert.equal(blocked.attempt, 1);
      assert.deepEqual(blocked.error, {
        code: "worker-offline",
        retryable: true,
      });
      await visit(
        "reconnect blocked job",
        "GET",
        `/api/project-replica-jobs/${reconnectJob.id}`,
      );
      await reconnect.get("replica-b")();
      const completed = await waitJob(reconnectJob.id, "succeeded");
      assert.equal(completed.attempt, 2);
      assert.equal(completed.error, null);
      await visit(
        "reconnected job succeeded",
        "GET",
        `/api/project-replica-jobs/${reconnectJob.id}`,
      );
      await visit("reconnected replica catalog", "GET", replicasPath);
      const catalog = fixture.records.get("reconnected replica catalog");
      assert.equal(catalog.length, 2);
      assert.ok(
        catalog.find(
          (replica) => replica.workerId === "replica-b" && replica.ready,
        ),
      );
      const dispatched = commands.filter(
        ({ command }) => command.jobId === reconnectJob.id,
      );
      assert.equal(
        dispatched.length,
        1,
        "offline attempt never reaches worker; reconnect dispatches once",
      );
      assert.equal(dispatched[0].command.attempt, 2);
      await live.ping("worker reconnect barrier");
      const reconnectEvents = live.history.filter(
        (event) =>
          event.type === "event" &&
          event.resource === "project-replica-job" &&
          event.entityId === reconnectJob.id,
      );
      assert.deepEqual(
        reconnectEvents.map((event) => event.revision),
        [1, 3, 6, 7],
      );
      events.push(...reconnectEvents);
    }
    if (process.argv.includes("--lease-recovery"))
      await replicaLeaseCases({
        fixture,
        visit,
        read,
        waitJob,
        until,
        replicasPath,
        firstReplica,
        repository,
        nextRevision,
        leaseState,
        releases,
        commands,
        live,
        events,
      });
    const shutdown = process.argv.includes("--shutdown")
      ? await replicaShutdownCases({
          fixture,
          visit,
          read,
          waitJob,
          until,
          replicasPath,
          firstReplica,
          repository,
          nextRevision,
          leaseState,
          releases,
          commands,
          workers,
          reconnect,
          id,
        })
      : null;
    const converted = process.argv.includes("--converted-removal")
      ? await replicaConvertedCases({
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
          setFolderDeleteMode: (mode) => {
            folderDeleteMode = mode;
          },
        })
      : null;
    const concurrency = process.argv.includes("--concurrency")
      ? await replicaConcurrencyCases({
          fixture,
          visit,
          read,
          until,
          waitJob,
          commands,
          releases,
          repository,
        })
      : null;
    return fixture.normalize({
      concurrency,
      converted,
      commands: concurrency ? commands.slice(0, concurrency.before) : commands,
      shutdown,
      events: events.map(({ entityId, revision, scope, resource, action }) => ({
        entityId,
        revision,
        scope,
        resource,
        action,
      })),
    });
  } finally {
    for (const release of releases.values()) release();
    for (const worker of workers) worker.close();
    await live.close();
  }
}
