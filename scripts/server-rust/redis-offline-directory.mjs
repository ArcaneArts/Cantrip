// Invoke actual directory reads while the private Redis process is stopped.
// Keep rejection handlers attached throughout the outage and always restart it
// before fixture cleanup, including when an implementation rejects too early.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
export async function offlineDirectory(peers, restart, result) {
  const observations = peers.map((peer) => ({
    kind: peer.kind,
    state: "pending",
  }));
  const reads = peers.map((peer, index) =>
    peer
      .call("findWorker", {
        workerId: "uncached-offline-directory-read",
      })
      .then(
        (value) =>
          Object.assign(observations[index], { state: "resolved", value }),
        (error) =>
          Object.assign(observations[index], {
            state: "rejected",
            error: String(error),
          }),
      ),
  );
  try {
    await delay(11000);
    result.offlineDirectory = structuredClone(observations);
    assert.ok(
      observations.every((v) => v.state === "pending"),
      "Uncached directory lookups remain queued during the real 11-second outage: " +
        JSON.stringify(observations),
    );
  } finally {
    await restart();
  }
  await Promise.all(reads);
  for (const observation of observations)
    assert.deepEqual(observation, {
      kind: observation.kind,
      state: "resolved",
      value: null,
    });
  result.steps.push(
    "uncached directory reads survive an 11-second real outage and complete after reconnect",
  );
}
