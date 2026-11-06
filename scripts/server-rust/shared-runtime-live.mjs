import assert from "node:assert/strict";
import { requestHeaders } from "./shared-runtime-fixture-tools.mjs";

export async function publish(peer, publications, confirmed = false) {
  const response = await fetch(peer.server.origin + "/__fixture/live", {
    method: "POST",
    headers: requestHeaders(peer, { json: true }),
    body: JSON.stringify({ publications, confirmed }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text).events;
}
export function publication(
  entityId,
  ownerId = "00000000-0000-0000-0000-000000000001",
) {
  return {
    ownerId,
    scope: { kind: "current-user" },
    resource: "worker",
    action: "invalidated",
    entityId,
    revision: null,
    payload: null,
  };
}
export async function verifyLiveOrder(peers, live, result) {
  for (const [sender, peer] of peers.entries()) {
    const prefix = "shared-live-burst-" + sender + "-";
    const publications = Array.from({ length: 256 }, (_, i) =>
      publication(
        prefix + i,
        peer.records.get("bootstrap").auth.currentUser.id,
      ),
    );
    const emitted = await publish(peer, publications);
    assert.deepEqual(
      emitted.map((e) => e.entityId),
      publications.map((p) => p.entityId),
    );
    for (const [receiver, probe] of live.entries())
      for (const [sequence, input] of publications.entries()) {
        const event = await probe.message(
          (v) => v.type === "event" && v.entityId?.startsWith(prefix),
        );
        assert.equal(
          event.entityId,
          input.entityId,
          `sender${sender} -> receiver${receiver} preserves synchronous publication ${sequence}`,
        );
        if (sender === receiver) assert.deepEqual(event, emitted[sequence]);
      }
    result.cases.push(
      "synchronous 256-publication burst from peer" +
        sender +
        " preserves local and remote order",
    );
  }
  for (const [sender, peer] of peers.entries()) {
    const prefix = "shared-live-concurrent-" + sender + "-";
    const batches = Array.from({ length: 8 }, (_, batch) =>
      Array.from({ length: 64 }, (_, sequence) =>
        publication(
          prefix + batch + "-" + sequence,
          peer.records.get("bootstrap").auth.currentUser.id,
        ),
      ),
    );
    const emitted = await Promise.all(
      batches.map((batch) => publish(peer, batch)),
    );
    for (const [i, batch] of batches.entries())
      assert.deepEqual(
        emitted[i].map((e) => e.entityId),
        batch.map((p) => p.entityId),
      );
    const deliveries = await Promise.all(
      live.map(async (probe) => {
        const events = [];
        for (let i = 0; i < 512; i++)
          events.push(
            await probe.message(
              (v) => v.type === "event" && v.entityId?.startsWith(prefix),
            ),
          );
        assert.ok(
          events.every((e, i) => i === 0 || e.cursor > events[i - 1].cursor),
          "Delivered cursor advances",
        );
        assert.equal(
          new Set(events.map((e) => e.entityId)).size,
          512,
          "Every concurrent publication arrives once",
        );
        return events.map((e) => e.entityId);
      }),
    );
    assert.deepEqual(
      deliveries[1 - sender],
      deliveries[sender],
      "Concurrent producers retain their actual local publication order remotely",
    );
    result.cases.push(
      "eight concurrent HTTP producers at peer" +
        sender +
        " preserve actual local order across the remote subscriber",
    );
  }
}
