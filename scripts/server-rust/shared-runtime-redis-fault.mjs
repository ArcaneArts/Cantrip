// Real process interruption with its actual saved Redis directory. Readiness
// is measured; recovery requires observed publications, not a command PING.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "./shared-runtime-fixture-tools.mjs";
import { publication } from "./shared-runtime-live.mjs";

export async function verifyRedisInterruption(
  peers,
  live,
  redis,
  controls,
  result,
) {
  const key = (worker) =>
    "cantrip:relay:v1:worker:" + encodeURIComponent(worker);
  const claims = await Promise.all(
    controls.map(async (c) =>
      JSON.parse(await redis.client.get(key(c.workerId))),
    ),
  );
  assert.ok(
    claims.every((c) => c?.connectionId),
    "Actual connected worker claims exist",
  );
  await redis.client.sendCommand(["SAVE"]);
  await redis.stop();
  const samples = (result.redisInterruption = []);
  const offline = [];
  try {
    for (const [i, peer] of peers.entries()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = performance.now();
        const response = await request(peer, "GET", "/readyz", undefined, 503);
        const elapsedMs = performance.now() - started;
        samples.push({
          peer: i,
          kind: peer.kind,
          operation: "ready",
          attempt,
          elapsedMs,
          response: response.body,
        });
        assert.equal(response.body.database.status, "ready");
        assert.deepEqual(response.body.coordination, {
          shared: true,
          status: "unavailable",
        });
        assert.ok(
          elapsedMs < 1000,
          "Offline readiness must report the actual unavailable connection promptly: " +
            elapsedMs +
            "ms",
        );
      }
      const entityId = "shared-offline-confirmed-" + i;
      const started = performance.now();
      const response = await request(
        peer,
        "POST",
        "/__fixture/live",
        {
          publications: [
            publication(
              entityId,
              peer.records.get("bootstrap").auth.currentUser.id,
            ),
          ],
          confirmed: true,
        },
        500,
      );
      const elapsedMs = performance.now() - started;
      samples.push({
        peer: i,
        kind: peer.kind,
        operation: "confirmed-publication",
        elapsedMs,
        status: response.status,
      });
      assert.ok(
        elapsedMs < 1000,
        "Confirmed publication rejects unavailable coordination promptly: " +
          elapsedMs +
          "ms",
      );
      await live[i].message(
        (v) => v.type === "event" && v.entityId === entityId,
      );
      const unconfirmed = "shared-offline-unconfirmed-" + i;
      await request(
        peer,
        "POST",
        "/__fixture/live",
        {
          publications: [
            publication(
              unconfirmed,
              peer.records.get("bootstrap").auth.currentUser.id,
            ),
          ],
        },
        200,
      );
      await live[i].message(
        (v) => v.type === "event" && v.entityId === unconfirmed,
      );
      offline.push(unconfirmed);
    }
  } finally {
    await redis.start();
  }
  for (const [i, peer] of peers.entries()) {
    let recovered = false;
    const until = Date.now() + 15000;
    for (let attempt = 0; Date.now() < until; attempt++) {
      const id = `shared-recovery-${i}-${attempt}`;
      const response = await request(peer, "POST", "/__fixture/live", {
        publications: [
          publication(id, peer.records.get("bootstrap").auth.currentUser.id),
        ],
        confirmed: true,
      });
      assert.ok([200, 500].includes(response.status), JSON.stringify(response));
      await delay(50);
      if (
        response.status === 200 &&
        live.every((p) =>
          p.history.some((v) => v.type === "event" && v.entityId === id),
        )
      ) {
        recovered = true;
        break;
      }
    }
    assert.ok(
      recovered,
      "Actual bidirectional live publication recovers after Redis restart",
    );
    const healthy = await request(peer, "GET", "/readyz", undefined, 200);
    assert.deepEqual(healthy.body.coordination, {
      shared: true,
      status: "ready",
    });
  }
  await delay(100);
  for (const [i, entityId] of offline.entries()) {
    await live[1 - i].ping("after actual Redis recovery");
    assert.ok(
      !live[1 - i].history.some(
        (v) => v.type === "event" && v.entityId === entityId,
      ),
      "Publication attempted while Redis was unavailable is not replayed after reconnection",
    );
  }
  for (const [i, control] of controls.entries()) {
    await control.verifyRecovered();
    const after = JSON.parse(await redis.client.get(key(control.workerId)));
    assert.equal(
      after.connectionId,
      claims[i].connectionId,
      "Saved, unexpired worker connection claim survives the short interruption",
    );
  }
  result.cases.push(
    "real Redis interruption rejects readiness/confirmed fanout promptly and recovers actual subscriber delivery without offline publication replay",
  );
  result.cases.push(
    "unchanged workers keep their original connection claims and execute new remote WorkerLink requests after actual Redis recovery",
  );
}
