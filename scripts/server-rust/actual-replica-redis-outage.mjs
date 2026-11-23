import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";

const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const postgres = require("postgres");

export async function prepareReplicaRedisOutage(directory, target) {
  const gate = path.join(directory, "git-boundary");
  const entered = path.join(gate, "entered");
  const release = () => writeFile(path.join(gate, "release"), "");
  await mkdir(gate);
  // Hold the first inspection of the owned checkout, then execute real Git.
  const git = execFileSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  await writeFile(
    path.join(gate, "git"),
    [
      "#!/bin/sh",
      'if [ "$#" -eq 4 ] && [ "$1" = "-C" ] && [ "$2" = "$CANTRIP_QA_GIT_TARGET" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ] && [ ! -e "$CANTRIP_QA_GIT_GATE/release" ]; then',
      '  printf "%s" "$$" > "$CANTRIP_QA_GIT_GATE/entered"',
      '  while [ ! -e "$CANTRIP_QA_GIT_GATE/release" ]; do',
      '    kill -0 "$CANTRIP_QA_RUNNER_PID" 2>/dev/null || exit 1',
      "    sleep 0.05",
      "  done",
      "fi",
      'exec "$CANTRIP_QA_REAL_GIT" "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    entered,
    release,
    environment: {
      PATH: gate + path.delimiter + process.env.PATH,
      CANTRIP_QA_GIT_GATE: gate,
      CANTRIP_QA_GIT_TARGET: target,
      CANTRIP_QA_REAL_GIT: git,
      CANTRIP_QA_RUNNER_PID: String(process.pid),
    },
  };
}

async function readiness(fixture, status, coordination) {
  return eventually(
    () =>
      Promise.all(
        fixture.peers.map(async ({ server }) => {
          const response = await fetch(server.origin + "/readyz", {
            signal: AbortSignal.timeout(5000),
          });
          return { status: response.status, body: await response.json() };
        }),
      ),
    (peers) => {
      for (const peer of peers) {
        assert.equal(peer.status, status);
        assert.equal(peer.body.database.status, "ready");
        assert.deepEqual(peer.body.coordination, {
          shared: true,
          status: coordination,
        });
      }
    },
  );
}

export async function recoverReplicaAcrossRedisOutage({
  fixture,
  gate,
  worker,
  primaryWorker,
  workerId,
  primaryWorkerId,
  admitted,
  waitJob,
  result,
}) {
  const redis = fixture.redis;
  const observation = (result.sharedReplicaRedisInterruption = {
    admittedId: admitted.id,
    serverPids: fixture.peers.map(({ server }) => server.child.pid),
    primaryWorkerPid: primaryWorker.child.pid,
    replicaWorkerPid: worker.child.pid,
  });
  const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const snapshot = async () => {
    const [row] = await sql`
      SELECT json_build_object(
        'state', state, 'attempt', attempt, 'revision', state_revision,
        'command', command_id, 'lease', lease_expires_at, 'source', project_replica_id
      ) AS job FROM project_replica_jobs WHERE id = ${admitted.id}
    `;
    return row.job;
  };
  try {
    await eventually(
      () =>
        access(gate.entered).then(
          () => true,
          () => false,
        ),
      (entered) => assert.equal(entered, true),
    );
    observation.gitPid = Number(await readFile(gate.entered, "utf8"));
    process.kill(observation.gitPid, 0);
    const before = (observation.before = await snapshot());
    assert.equal(before.state, "running");
    assert.equal(before.attempt, 1);
    assert.ok(before.command && before.lease);
    assert.equal(before.source, null);
    observation.beforePrimaryWorkerClaim =
      await fixture.assertRemoteWorker(primaryWorkerId);
    observation.beforeWorkerClaim = await fixture.assertRemoteWorker(workerId);
    await redis.client.sendCommand(["SAVE"]);
    observation.redisStop = await redis.stop();
    const stoppedAt = performance.now();
    try {
      assert.equal(observation.redisStop.signal, "SIGKILL");
      observation.offlineReadiness = await readiness(
        fixture,
        503,
        "unavailable",
      );
      await delay(Math.max(0, 33_000 - (performance.now() - stoppedAt)));
      const held = (observation.whileHeld = await snapshot());
      assert.equal(held.state, "running");
      assert.equal(held.command, before.command);
      assert.equal(held.attempt, before.attempt);
      assert.equal(held.source, null);
      assert.ok(Date.parse(held.lease) > Date.parse(before.lease));
      process.kill(observation.gitPid, 0);
      await gate.release();
      await delay(2500);
      const offline = (observation.afterReleaseOffline = await snapshot());
      assert.equal(offline.state, "running");
      assert.equal(offline.command, before.command);
      assert.equal(offline.attempt, before.attempt);
      assert.equal(offline.source, null);
    } finally {
      await gate.release();
      await redis.start();
    }
    observation.recoveredReadiness = await readiness(fixture, 200, "ready");
    const instanceId =
      fixture.workerFixture.environment.CANTRIP_SERVER_INSTANCE_ID;
    const [primaryClaim, replicaClaim] = await eventually(
      () =>
        Promise.all(
          [primaryWorkerId, workerId].map((id) => fixture.workerClaim(id)),
        ),
      (claims) => {
        for (const claim of claims) {
          assert.ok(claim?.connectionId);
          assert.equal(claim.instanceId, instanceId);
        }
      },
    );
    observation.afterPrimaryWorkerClaim = primaryClaim;
    observation.afterWorkerClaim = replicaClaim;
    assert.notEqual(
      replicaClaim.connectionId,
      observation.beforeWorkerClaim.connectionId,
    );
    assert.equal(worker.child.pid, observation.replicaWorkerPid);
    assert.equal(primaryWorker.child.pid, observation.primaryWorkerPid);
    assert.equal(primaryWorker.child.exitCode, null);
    assert.equal(primaryWorker.child.signalCode, null);
    assert.deepEqual(
      fixture.peers.map(({ server }) => server.child.pid),
      observation.serverPids,
    );
    const job = await waitJob(admitted.id);
    observation.completed = await snapshot();
    assert.equal(job.attempt, 2);
    assert.deepEqual(observation.completed, {
      state: "succeeded",
      attempt: 2,
      revision: 11,
      command: null,
      lease: null,
      source: job.projectReplicaId,
    });
    result.steps.push(
      "both peers detect private Redis loss during real Git dispatch, renew the original PostgreSQL lease, and complete the same replica on one retry after coordination recovers",
    );
    return job;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
