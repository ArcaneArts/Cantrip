import assert from "node:assert/strict";
import { settingsWorker } from "./native-settings-http-fixture.mjs";

export async function runSettingsInferenceStatusHttpCases(
  h,
  visit,
  result,
  profile,
) {
  const path = "/api/workers/" + settingsWorker + "/inference";
  const status = await visit("owned worker inference snapshot", "GET", path);
  assert.deepEqual(status, h.inferenceSnapshot());
  assert.equal(
    result.observations.at(-1).headers["cache-control"],
    "private, no-store",
  );
  await visit(
    "missing worker inference snapshot",
    "GET",
    "/api/workers/missing/inference",
    {
      status: 404,
    },
  );
  if (profile === "accounts")
    await visit("foreign worker inference snapshot hidden", "GET", path, {
      client: "other",
      status: 404,
    });
  try {
    for (const key of ["ownerId", "serverId", "workerId", "workerGeneration"]) {
      h.setInferenceSnapshotOverride({
        ...status,
        [key]: "retired-or-foreign",
      });
      const rejected = await visit(
        "worker inference fence " + key,
        "GET",
        path,
        {
          status: 409,
        },
      );
      assert.equal(
        rejected.error,
        "Worker inference status changed. Retry the snapshot.",
      );
    }
    for (const invalid of [null, {}]) {
      h.setInferenceSnapshotOverride(invalid);
      await visit(
        "invalid worker inference snapshot " + JSON.stringify(invalid),
        "GET",
        path,
        {
          status: 500,
        },
      );
    }
  } finally {
    h.setInferenceSnapshotOverride(undefined);
  }
  await h.live.subscribed("inference-status", [{ kind: "current-user" }]);
  const before = h.live.history.length;
  const send = (value) => {
    assert.equal(
      h.worker.sendNotification({ type: "inference.status", status: value }),
      true,
    );
  };
  send({ ...status, revision: 1000 });
  const first = await h.live.message(
    (frame) => frame.resource === "worker-inference" && frame.revision === 1000,
  );
  assert.equal(first.entityId, settingsWorker);
  assert.equal(first.action, "status");
  assert.deepEqual(first.payload, { ...status, revision: 1000 });
  send({ ...status, revision: 1000 });
  for (const [index, key] of [
    "ownerId",
    "serverId",
    "workerId",
    "workerGeneration",
  ].entries())
    send({ ...status, revision: 1001 + index, [key]: "retired-or-foreign" });
  // The valid later publication is an ordered barrier for the rejected frames.
  send({ ...status, revision: 1005 });
  await h.live.message(
    (frame) => frame.resource === "worker-inference" && frame.revision === 1005,
  );
  assert.deepEqual(
    h.live.history
      .slice(before)
      .filter((frame) => frame.resource === "worker-inference")
      .map((frame) => frame.revision),
    [1000, 1005],
  );
  result.workerInferenceStatus = {
    ownedSnapshot: true,
    privateNoStore: true,
    httpIdentityFences: 4,
    rejectedStaleOrForeignNotifications: 5,
    acceptedRevisions: [1000, 1005],
  };
}
