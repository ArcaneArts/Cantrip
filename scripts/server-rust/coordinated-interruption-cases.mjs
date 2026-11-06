import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { bridgePeer, eventually } from "./coordinated-fixture-tools.mjs";

export async function verifyRedisInterruption(context) {
  const {
    pair,
    root,
    executable,
    redis,
    step,
    event,
    requested,
    response,
    observation,
  } = context;
  const kinds = pair.split("/");
  const prefix = "cantrip:relay:v1:interruption:" + randomUUID();
  const a = bridgePeer(
    kinds[0],
    executable,
    root,
    pair.replace("/", "-") + "-outage-a",
  );
  const b = bridgePeer(
    kinds[1],
    executable,
    root,
    pair.replace("/", "-") + "-outage-b",
  );
  const workerId = "outage-worker";
  const workerKey = `${prefix}:worker:${workerId}`;
  const ttl = 4000;
  const options = (instanceId) => ({
    url: redis.url,
    instanceId,
    keyPrefix: prefix,
    presenceTtlMs: ttl,
    maximumInstances: 4,
  });
  const claim = async () => {
    const raw = await redis.client.get(workerKey);
    return raw === null ? null : JSON.parse(raw);
  };
  async function recoveredSubscribers() {
    for (const [sender, receiver, target] of [
      [a, b, "outage-b"],
      [b, a, "outage-a"],
    ]) {
      await eventually(
        async () => {
          const name = randomUUID();
          try {
            await sender.call("barrier", { target, name });
          } catch (error) {
            return { error: error.message };
          }
          await delay(30);
          await receiver.drain();
          return receiver.events.some(
            (e) => e.kind === "barrier" && e.name === name,
          );
        },
        (value) => value === true,
        "actual bidirectional pub/sub recovery",
      );
    }
  }
  try {
    await a.call("init", { options: options("outage-a"), graceMs: 1000 });
    await b.call("init", { options: options("outage-b"), graceMs: 1000 });
    for (const peer of [a, b]) await peer.call("subscribe", { workerId });
    assert.equal(
      await b.call("attach", {
        workerId,
        peer: "outage-socket",
        ownerId: "owner",
      }),
      true,
    );
    const initial = await claim();
    assert.ok(initial?.connectionId);
    const renewed = await eventually(
      claim,
      (p) => p?.expiresAt > initial.expiresAt,
      "real Redis worker lease renewal",
    );
    assert.equal(renewed.connectionId, initial.connectionId);
    step(
      "periodic renewal advances the real Redis lease without changing generation",
    );
    await a.call("begin", {
      workerId,
      name: "retained-through-outage",
      command: { type: "worker.version" },
      options: { ownerId: "owner", timeoutMs: 12000 },
    });
    const request = await requested(b, "outage-socket", 1);

    // SAVE captures the real directory and expiry timestamps. SIGKILL removes
    // both command and pub/sub connections; restart uses the saved Redis data.
    assert.equal(await redis.client.sendCommand(["SAVE"]), "OK");
    await redis.stop();
    await delay(1500);
    assert.equal(await b.call("connected", { workerId }), true);
    await b.drain();
    assert.equal(b.events.filter((e) => e.kind === "worker-close").length, 0);
    await a.drain();
    assert.equal(
      a.events.filter(
        (e) => e.kind === "completion" && e.name === "retained-through-outage",
      ).length,
      0,
    );
    step(
      "actual Redis interruption retains socket and pending command while claim is uncertain",
    );

    await redis.start();
    const retained = await eventually(
      claim,
      (p) => p?.expiresAt > renewed.expiresAt,
      "renewal after real Redis restart",
    );
    assert.equal(retained.connectionId, initial.connectionId);
    await recoveredSubscribers();
    await response(b, "outage-socket", request, { recovered: true });
    assert.deepEqual(
      (
        await event(
          a,
          (e) =>
            e.kind === "completion" && e.name === "retained-through-outage",
          "pending response after Redis recovery",
        )
      ).result,
      { recovered: true },
    );
    assert.equal((await b.call("stats")).activeRequests, 0);
    step(
      "same claim resumes renewal and bidirectional routing after Redis restart",
    );

    assert.equal(await redis.client.sendCommand(["SAVE"]), "OK");
    await redis.stop();
    await delay(ttl + 250);
    assert.equal(await b.call("connected", { workerId }), true);
    await b.drain();
    assert.equal(b.events.filter((e) => e.kind === "worker-close").length, 0);
    step(
      "expired local cache during an outage does not by itself close the worker socket",
    );
    await redis.start();
    assert.equal(await claim(), null);
    const closed = await event(
      b,
      (e) => e.kind === "worker-close" && e.peer === "outage-socket",
      "confirmed expired claim fences socket",
    );
    assert.equal(closed.code, 1012);
    assert.equal(await b.call("connected", { workerId }), false);
    step("Redis-confirmed claim expiry closes the stale socket with code 1012");

    assert.equal(
      await b.call("attach", {
        workerId,
        peer: "after-outage",
        ownerId: "owner",
      }),
      true,
    );
    const fresh = await claim();
    assert.notEqual(fresh.connectionId, initial.connectionId);
    await recoveredSubscribers();
    await a.call("begin", {
      workerId,
      name: "fresh-after-outage",
      command: { type: "worker.version" },
      options: { ownerId: "owner", timeoutMs: 3000 },
    });
    const freshRequest = await requested(b, "after-outage", 1);
    await response(b, "after-outage", freshRequest, { newGeneration: true });
    assert.deepEqual(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "fresh-after-outage",
          "new generation routes after expired claim",
        )
      ).result,
      { newGeneration: true },
    );
    step(
      "fresh attachment after expired claim restores remote command routing",
    );
  } catch (error) {
    observation.interruptionFailure = error.stack;
    observation.interruptionSnapshots = [];
    for (const peer of [a, b]) {
      try {
        await peer.drain();
        observation.interruptionSnapshots.push({
          peer: peer.name,
          events: peer.events,
          stats: await peer.call("stats"),
          coordination: await peer.call("coordinationStats"),
        });
      } catch (snapshotError) {
        observation.interruptionSnapshots.push({
          peer: peer.name,
          error: snapshotError.stack,
        });
      }
    }
    throw error;
  } finally {
    const stops = await Promise.allSettled([a.stop(), b.stop()]);
    observation.interruptionShutdown = stops.map((value, i) => ({
      peer: i === 0 ? a.name : b.name,
      passed: value.status === "fulfilled",
      failure: value.status === "rejected" ? value.reason.stack : undefined,
    }));
    const failure = stops.find((value) => value.status === "rejected");
    if (failure && !observation.interruptionFailure) throw failure.reason;
  }
}
