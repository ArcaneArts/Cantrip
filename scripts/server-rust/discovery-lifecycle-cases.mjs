import assert from "node:assert/strict";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { projectLabel } from "./security-fixtures.mjs";

// Only the controlled worker is scripted. All admission, persistence, scheduling,
// recovery, events and shutdown execute the unmodified production server path.
export async function discoveryLifecycleCases({
  fixture,
  visit,
  read,
  until,
  name,
  handle,
  counts,
  workerId,
  setHandler,
  connectWorker,
  stopWorker,
  setCapability,
}) {
  const ids = Array.from(
    { length: 6 },
    (_, i) => `99999999-9999-4999-8999-${String(i + 1).padStart(12, "0")}`,
  );
  const projects = [
    "88888888-8888-4888-8888-000000000101",
    "88888888-8888-4888-8888-000000000102",
  ];
  const commands = [],
    heldScans = new Map(),
    heldImports = new Map();
  let active = 0,
    maxActive = 0,
    holdScan = ids[1],
    holdImport = projects[0];
  const scanUrl = (id) => `/api/workspaces/${id}/repository-discovery`;
  const importUrl = (id) => `/api/workspaces/${id}/repository-imports`;
  const index = (id) => ids.indexOf(id);
  const root = (i) => handle(60 + i),
    checkout = (i) => handle(100 + i),
    display = (i) => handle(120 + i);
  const scanned = (id, state) =>
    until(
      () => read(scanUrl(id)),
      (snapshot) =>
        assert.equal(snapshot.job.state, state, JSON.stringify(snapshot)),
    );
  const claimOrder = [];
  setHandler(async (command) => {
    commands.push(command);
    if (command.type === "repository.operation") {
      const i = index(command.projectId);
      assert.ok(i >= 0);
      return {
        operationId: command.operationId,
        protectedResponse: projectLabel.protectedLabel,
        workspaceRootAttachment: {
          rootPathHandle: root(i),
          displayHandle: handle(80 + i),
        },
      };
    }
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const i = ids.findIndex((_, i) => root(i) === command.rootPath);
      assert.ok(i >= 0);
      claimOrder.push({
        kind:
          command.type === "workspace.repositories.discover"
            ? "scan"
            : "import",
        workspaceId: ids[i],
        attempt: command.attempt,
      });
      if (command.type === "workspace.repositories.discover") {
        if (ids[i] === holdScan)
          await new Promise((resolve) => heldScans.set(ids[i], resolve));
        return {
          jobId: command.jobId,
          attempt: command.attempt,
          counts: counts(1),
          truncated: false,
          diagnosticCode: null,
          candidates: [
            {
              path: checkout(i),
              displayPath: display(i),
              originUrl: null,
              github: null,
              repositoryFingerprint: (i + 1).toString(16).repeat(64),
              classification: "local-git",
              diagnosticCode: null,
            },
          ],
        };
      }
      if (holdImport === projects[i === 0 ? 0 : 1])
        await new Promise((resolve) => heldImports.set(ids[i], resolve));
      return {
        candidateId: command.candidateId,
        attempt: command.attempt,
        path: checkout(i),
        displayPath: display(i),
        originUrl: null,
        github: null,
        repositoryFingerprint: command.expectedRepositoryFingerprint,
        classification: "local-git",
        diagnosticCode: null,
        branch: "main",
        head: "f".repeat(40),
      };
    } finally {
      active--;
    }
  });
  const attach = async (i) =>
    visit("lifecycle attach " + i, "POST", "/api/workspaces/attached", {
      status: 201,
      json: {
        id: ids[i],
        nameProtection: {
          ...name,
          blindIndex: Buffer.alloc(32, 160 + i).toString("base64url"),
        },
        storage: { kind: "attached", workerId },
        operationId: ids[i],
        protectedRequest: projectLabel.protectedLabel,
      },
    });
  const enqueueImport = async (i, project) => {
    const snapshot = await read(scanUrl(ids[i]));
    return visit(
      "lifecycle import " + i + " revision " + snapshot.job.stateRevision,
      "POST",
      importUrl(ids[i]),
      {
        status: 202,
        json: {
          expectedStateRevision: snapshot.job.stateRevision,
          candidates: [
            {
              candidateId: snapshot.candidates[0].id,
              projectId: project,
              nameProtection: projectLabel,
            },
          ],
        },
      },
    );
  };
  let resumedLive;
  try {
    await attach(0);
    await scanned(ids[0], "succeeded");
    await visit("lifecycle initial import candidate", "GET", scanUrl(ids[0]));
    await attach(1);
    await until(
      () => heldScans.has(ids[1]),
      (value) => assert.equal(value, true),
    );
    await visit("lifecycle held scan", "GET", scanUrl(ids[1]));
    await enqueueImport(0, projects[0]);
    await attach(2);
    await attach(3);
    for (const i of [2, 3]) {
      const snapshot = await visit(
        "lifecycle queued scan " + i,
        "GET",
        scanUrl(ids[i]),
      );
      assert.equal(snapshot.job.state, "queued");
      assert.equal(snapshot.job.attempt, 0);
      assert.equal(snapshot.job.stateRevision, 1);
    }
    assert.equal(active, 1);
    assert.equal(maxActive, 1);
    assert.equal(
      claimOrder.length,
      2,
      "held scan prevents every other scan and import from dispatching",
    );
    holdScan = null;
    heldScans.get(ids[1])();
    heldScans.delete(ids[1]);
    await until(
      () => heldImports.has(ids[0]),
      (value) => assert.equal(value, true),
    );
    assert.deepEqual(
      claimOrder.map((c) => [c.kind, c.workspaceId]),
      [
        ["scan", ids[0]],
        ["scan", ids[1]],
        ["scan", ids[2]],
        ["scan", ids[3]],
        ["import", ids[0]],
      ],
    );
    for (const i of [1, 2, 3]) await scanned(ids[i], "succeeded");
    holdImport = null;
    heldImports.get(ids[0])();
    heldImports.delete(ids[0]);
    await until(
      () => read(scanUrl(ids[0])),
      (snapshot) =>
        assert.equal(snapshot.candidates[0].importState, "imported"),
    );
    await visit(
      "lifecycle serialized import completed",
      "GET",
      scanUrl(ids[0]),
    );
    const priority = { maxActive, order: claimOrder.slice() };

    stopWorker();
    await until(
      () => read("/api/workers"),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId).online,
          false,
        ),
    );
    await visit("lifecycle offline scan admission", "POST", scanUrl(ids[3]), {
      status: 202,
      json: {},
    });
    const blocked = (await scanned(ids[3], "blocked")).job;
    assert.equal(blocked.attempt, 2);
    assert.equal(blocked.stateRevision, 6);
    assert.deepEqual(blocked.error, {
      code: "worker-offline",
      retryable: true,
    });
    await visit("lifecycle offline blocked scan", "GET", scanUrl(ids[3]));
    await connectWorker();
    const reconnected = (await scanned(ids[3], "succeeded")).job;
    assert.equal(reconnected.attempt, 3);
    assert.equal(reconnected.stateRevision, 9);
    await visit("lifecycle reconnect completed scan", "GET", scanUrl(ids[3]));

    await setCapability(false);
    const beforeMissing = commands.length;
    await visit(
      "lifecycle capability missing scan admission",
      "POST",
      scanUrl(ids[2]),
      { status: 202, json: {} },
    );
    const unavailable = (await scanned(ids[2], "failed")).job;
    assert.deepEqual(unavailable.error, {
      code: "capability-missing",
      retryable: false,
    });
    assert.equal(commands.length, beforeMissing);
    await visit("lifecycle capability missing scan", "GET", scanUrl(ids[2]));
    await setCapability(true);
    await visit("lifecycle explicit scan retry", "POST", scanUrl(ids[2]), {
      status: 202,
      json: {},
    });
    const retried = (await scanned(ids[2], "succeeded")).job;
    assert.equal(retried.attempt, 3);
    assert.equal(retried.stateRevision, 9);
    await visit(
      "lifecycle explicit scan retry completed",
      "GET",
      scanUrl(ids[2]),
    );

    await attach(4);
    await scanned(ids[4], "succeeded");
    await visit("lifecycle import shutdown candidate", "GET", scanUrl(ids[4]));
    await setCapability(false);
    const beforeImport = commands.length;
    await enqueueImport(4, projects[1]);
    const rejectedImport = await until(
      () => read(scanUrl(ids[4])),
      (snapshot) => assert.equal(snapshot.candidates[0].importState, "failed"),
    );
    assert.deepEqual(rejectedImport.candidates[0].importError, {
      code: "capability-missing",
      retryable: false,
    });
    assert.equal(commands.length, beforeImport);
    await visit("lifecycle capability missing import", "GET", scanUrl(ids[4]));
    await setCapability(true);
    holdImport = projects[1];
    await enqueueImport(4, projects[1]);
    await until(
      () => heldImports.has(ids[4]),
      (value) => assert.equal(value, true),
    );
    await attach(5);
    const queued = await visit(
      "lifecycle scan queued behind held import",
      "GET",
      scanUrl(ids[5]),
    );
    assert.equal(queued.job.state, "queued");
    assert.equal(queued.job.attempt, 0);
    const runningImport = await visit(
      "lifecycle import held for shutdown",
      "GET",
      scanUrl(ids[4]),
    );
    assert.equal(runningImport.candidates[0].importAttempt, 2);
    assert.equal(runningImport.candidates[0].importState, "importing");
    const server = fixture.server,
      port = Number(new URL(server.origin).port);
    try {
      await fixture.close();
    } finally {
      fixture.discoveryShutdownStages = server.events.filter(
        (e) => e.event === "server.shutdown.stage",
      );
    }
    stopWorker();
    holdImport = null;
    heldImports.get(ids[4])();
    heldImports.delete(ids[4]);
    await until(
      () => active,
      (n) => assert.equal(n, 0),
    );
    await fixture.start({ port });
    const retained = await visit(
      "lifecycle shutdown retains blocked import",
      "GET",
      scanUrl(ids[4]),
    );
    assert.equal(retained.job.stateRevision, 9);
    assert.equal(retained.candidates[0].importAttempt, 2);
    assert.equal(retained.candidates[0].importState, "blocked");
    assert.deepEqual(retained.candidates[0].importError, {
      code: "worker-offline",
      retryable: true,
    });
    const startup = (await scanned(ids[5], "blocked")).job;
    assert.equal(startup.attempt, 1);
    assert.equal(startup.stateRevision, 3);
    resumedLive = await new LiveProbe(fixture).open();
    await resumedLive.initialized();
    await resumedLive.subscribed("discovery lifecycle recovery", [currentUser]);
    await connectWorker();
    const recoverySnapshots = (fixture.discoveryRecoverySnapshots = []);
    const resumed = await until(
      async () => {
        const snapshot = await read(scanUrl(ids[4]));
        recoverySnapshots.push(fixture.normalize(snapshot));
        return snapshot;
      },
      (snapshot) => {
        // Both implementations read the job and candidates in separate queries.
        // A completion can commit between those reads. Wait for the complete
        // expected state; the final revision and ordered Live assertions remain.
        assert.equal(snapshot.candidates[0].importState, "imported");
        assert.equal(snapshot.job.stateRevision, 12);
        assert.equal(snapshot.candidates[0].importAttempt, 3);
        assert.equal(snapshot.candidates[0].projectId, projects[1]);
      },
    );
    assert.equal(resumed.job.stateRevision, 12);
    assert.equal(resumed.candidates[0].importAttempt, 3);
    assert.equal(resumed.candidates[0].projectId, projects[1]);
    const completed = (await scanned(ids[5], "succeeded")).job;
    assert.equal(completed.attempt, 2);
    assert.equal(completed.stateRevision, 6);
    await visit("lifecycle shutdown resumed import", "GET", scanUrl(ids[4]));
    await visit("lifecycle shutdown resumed scan", "GET", scanUrl(ids[5]));
    await resumedLive.ping("discovery lifecycle completed");
    const events = resumedLive.history
      .filter(
        (e) =>
          e.type === "event" &&
          e.resource === "workspace-repository-discovery-job" &&
          e.revision !== null,
      )
      .map(({ scope, resource, action, entityId, revision, payload }) => ({
        scope,
        resource,
        action,
        entityId,
        revision,
        payload,
      }));
    assert.deepEqual(
      events.filter((e) => e.entityId === ids[5]).map((e) => e.revision),
      [5, 6],
    );
    assert.deepEqual(
      events.filter((e) => e.entityId === ids[4]).map((e) => e.revision),
      [11, 12],
    );
    assert.equal(maxActive, 1);
    return fixture.normalize({
      priority,
      offline: { blocked, reconnected },
      capability: { unavailable, retried },
      shutdown: { retained, resumed, completed, events },
      commands,
    });
  } finally {
    holdScan = null;
    holdImport = null;
    for (const release of heldScans.values()) release();
    for (const release of heldImports.values()) release();
    await resumedLive?.close();
  }
}
