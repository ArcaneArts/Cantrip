import assert from "node:assert/strict";
import { releaseTaskGoalTransfer } from "./actual-task-goal-provider-transfer.mjs";
import { eventually } from "./full-worker.mjs";

export async function interruptTaskGoalTransferPeer({
  peer,
  fixture,
  worker,
  workerId,
  file,
  held,
  interruption,
}) {
  const index = peer === "client" ? 0 : 1;
  const survivor = fixture.peers[1 - index];
  const survivorPid = survivor.server.child.pid;
  const origin = fixture.peers[index].server.origin;
  const outage = (interruption.peerOutage = {
    peer,
    workerPid: worker.child.pid,
    survivorPid,
    origin,
    originalClaim: await fixture.assertRemoteWorker(workerId),
  });
  assert.equal(outage.workerPid, held.pid);

  outage.replacement = await fixture.replacePeer(index, "rust", {
    crash: true,
  });
  assert.notEqual(outage.replacement.before.pid, outage.replacement.after.pid);
  assert.notEqual(
    outage.replacement.before.instanceId,
    outage.replacement.after.instanceId,
  );
  assert.equal(fixture.peers[index].server.origin, origin);
  assert.equal(survivor.server.child.pid, survivorPid);
  assert.equal(survivor.server.child.exitCode, null);
  assert.equal(survivor.server.child.signalCode, null);

  outage.release = await releaseTaskGoalTransfer(file, held.operationId);
  outage.recoveredClaim = await eventually(
    () => fixture.workerClaim(workerId),
    (claim) => {
      assert.equal(
        claim?.instanceId,
        fixture.workerFixture.environment.CANTRIP_SERVER_INSTANCE_ID,
      );
      assert.deepEqual(
        claim.continuityIdentity,
        outage.originalClaim.continuityIdentity,
      );
      assert.ok(claim.connectionId);
      if (index === 1)
        assert.notEqual(claim.connectionId, outage.originalClaim.connectionId);
      else assert.equal(claim.connectionId, outage.originalClaim.connectionId);
    },
  );
  assert.equal(worker.child.exitCode, null);
  assert.equal(worker.child.signalCode, null);
}
