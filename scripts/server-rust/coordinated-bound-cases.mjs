import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./coordinated-fixture-tools.mjs";

export async function verifyBounds(context) {
  const { a, b, redis, prefix, root, step, event } = context;
  const messages = [];
  const subscriber = redis.client.duplicate();
  subscriber.on("error", () => {});
  await subscriber.connect();
  await subscriber.subscribe(prefix + ":messages", (raw) => {
    messages.push(JSON.parse(raw));
  });
  async function publish(fields) {
    await redis.client.publish(
      prefix + ":messages",
      JSON.stringify({
        sourceInstanceId: "fixture-bounds",
        messageId: randomUUID(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
        ...fields,
      }),
    );
  }
  try {
    assert.equal(
      await b.call("attach", {
        workerId: "outbound-budget",
        peer: "outbound-budget",
        ownerId: "owner",
      }),
      true,
    );
    await eventually(
      () => a.call("connected", { workerId: "outbound-budget" }),
      (v) => v === true,
      "outbound worker presence",
    );
    await a.call("gateCoord", { operation: "publish", once: false });
    const frame = (sequence) => ({
      workerId: "outbound-budget",
      transport: "surface",
      header: {
        protocolVersion: 1,
        surfaceId: "surface",
        attachmentId: "attachment",
        channel: "control",
        sequence,
      },
      payloadBase64: "AQI=",
    });
    for (let i = 0; i < 512; i++)
      assert.equal(await a.call("sendFrame", frame(i)), true);
    assert.equal(await a.call("sendFrame", frame(512)), false);
    await a.call("releaseCoord", { operation: "publish" });
    const workerFrames = () =>
      b.events.filter(
        (e) =>
          e.kind === "worker-output" && e.peer === "outbound-budget" && e.bytes,
      );
    await eventually(
      () => b.drain(),
      () => workerFrames().length === 512,
      "all bounded publications reach the real worker socket",
    );
    await eventually(
      () => a.call("sendFrame", frame(513)),
      (v) => v === true,
      "publication capacity returns after completion",
    );
    await eventually(
      () => b.drain(),
      () => workerFrames().length === 513,
      "new publication reaches socket after draining",
    );
    step(
      "512 publication bound rejects overflow and restores capacity after real delivery",
    );

    const ghost = {
      workerId: "pending-budget",
      ownerId: "owner",
      instanceId: "absent-receiver",
      connectionId: randomUUID(),
      expiresAt: Date.now() + 60000,
    };
    await redis.client.set(
      `${prefix}:worker:${ghost.workerId}`,
      JSON.stringify(ghost),
      { PX: 60000 },
    );
    await publish({
      kind: "worker-presence",
      action: "online",
      presence: ghost,
    });
    await eventually(
      () => a.call("connected", { workerId: ghost.workerId }),
      (v) => v === true,
      "real pending-budget presence",
    );
    assert.equal((await a.call("stats")).activeRequests, 0);
    for (let i = 0; i < 2048; i++) {
      await a.call("begin", {
        workerId: ghost.workerId,
        name: `bounded-pending-${i}`,
        command: { type: "worker.version" },
        options: { ownerId: "owner", timeoutMs: null },
      });
    }
    assert.equal((await a.call("stats")).activeRequests, 2048);
    await a.call("begin", {
      workerId: ghost.workerId,
      name: "bounded-pending-overflow",
      command: { type: "worker.version" },
      options: { ownerId: "owner", timeoutMs: null },
    });
    const overflow = await event(
      a,
      (e) => e.kind === "completion" && e.name === "bounded-pending-overflow",
      "pending overflow rejected",
    );
    assert.equal(overflow.ok, false);
    assert.equal(
      overflow.error.message,
      "The shared worker command queue is full.",
    );
    assert.equal((await a.call("stats")).activeRequests, 2048);
    await redis.client.del(`${prefix}:worker:${ghost.workerId}`);
    await publish({
      kind: "worker-presence",
      action: "offline",
      presence: ghost,
    });
    await eventually(
      () => a.drain(),
      (events) =>
        events.filter(
          (e) =>
            e.kind === "completion" && /^bounded-pending-[0-9]+$/.test(e.name),
        ).length === 2048,
      "offline directory rejects every retained request exactly once",
    );
    assert.equal((await a.call("stats")).activeRequests, 0);
    step(
      "2048 pending-command bound rejects overflow and releases all requests on offline claim",
    );

    const incomingWorker = "incoming-budget";
    assert.equal(
      await b.call("attach", {
        workerId: incomingWorker,
        peer: incomingWorker,
        ownerId: "owner",
      }),
      true,
    );
    const ids = new Set();
    for (let i = 0; i < 512; i++) {
      const requestId = randomUUID();
      ids.add(requestId);
      await publish({
        kind: "worker-command-request",
        targetInstanceId: "b",
        requestId,
        workerId: incomingWorker,
        ownerId: "owner",
        command: { type: "worker.version" },
        timeoutMs: null,
      });
    }
    await eventually(
      () => b.call("stats"),
      (s) => s.activeRequests === 512,
      "all 512 incoming commands reach the local bridge",
    );
    const busyId = randomUUID();
    await publish({
      kind: "worker-command-request",
      targetInstanceId: "b",
      requestId: busyId,
      workerId: incomingWorker,
      ownerId: "owner",
      command: { type: "worker.version" },
      timeoutMs: null,
    });
    const busy = await eventually(
      () =>
        messages.find(
          (m) => m.kind === "worker-command-response" && m.requestId === busyId,
        ),
      (m) => m !== undefined,
      "incoming overflow response",
    );
    assert.equal(busy.ok, false);
    assert.equal(busy.error, "Worker command relay is busy.");
    assert.equal((await b.call("stats")).activeRequests, 512);
    await b.drain();
    assert.equal(
      b.events.filter(
        (e) =>
          e.kind === "worker-output" && e.peer === incomingWorker && e.text,
      ).length,
      512,
    );
    await b.call("disconnect", { workerId: incomingWorker });
    const rejected = await eventually(
      () =>
        messages.filter(
          (m) => m.kind === "worker-command-response" && ids.has(m.requestId),
        ),
      (replies) => replies.length === 512,
      "all incoming requests released on disconnect",
    );
    assert.equal(new Set(rejected.map((r) => r.requestId)).size, 512);
    assert.ok(
      rejected.every((r) => !r.ok && r.errorCode === "worker-unavailable"),
    );
    assert.equal((await b.call("stats")).activeRequests, 0);
    step(
      "512 incoming-command bound returns busy and cleans every in-flight request on disconnect",
    );
  } finally {
    if (subscriber.isOpen) subscriber.destroy();
    await writeFile(
      path.join(root, a.name + "-bounds-redis.jsonl"),
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
  }
}
