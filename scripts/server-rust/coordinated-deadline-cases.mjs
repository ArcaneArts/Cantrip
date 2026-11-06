import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./coordinated-fixture-tools.mjs";

// Inject real Redis envelopes to cover values a typed bridge caller cannot
// produce. Both implementations still use their production receive path.
export async function verifyIncomingDeadlines(context) {
  const { receiver, redis, prefix, root, step, requested, response } = context;
  const workerId = "incoming-deadline";
  const peer = "incoming-deadline";
  const messages = [];
  const subscriber = redis.client.duplicate();
  subscriber.on("error", () => {});
  await subscriber.connect();
  await subscriber.subscribe(prefix + ":messages", (raw) => {
    messages.push(JSON.parse(raw));
  });
  let requestCount = 0;
  const replies = (id) =>
    messages.filter(
      (m) => m.kind === "worker-command-response" && m.requestId === id,
    );
  async function publish(fields) {
    const requestId = randomUUID();
    const now = Date.now();
    await redis.client.publish(
      prefix + ":messages",
      JSON.stringify({
        kind: "worker-command-request",
        workerId,
        ownerId: "owner",
        targetInstanceId: "b",
        sourceInstanceId: "fixture-control",
        messageId: randomUUID(),
        requestId,
        command: { type: "worker.version" },
        createdAt: now,
        expiresAt: now + 60000,
        ...fields,
      }),
    );
    return requestId;
  }
  async function reply(id) {
    const values = await eventually(
      () => replies(id),
      (v) => v.length > 0,
      "injected request response",
    );
    assert.equal(values.length, 1);
    return values[0];
  }
  async function idle() {
    await eventually(
      () => receiver.call("stats"),
      (s) => s.activeRequests === 0,
      "injected command leaves no active request",
    );
  }
  try {
    assert.equal(
      await receiver.call("attach", {
        workerId,
        peer,
        ownerId: "owner",
      }),
      true,
    );
    const missing = await publish({});
    await requested(receiver, peer, ++requestCount);
    const missingReply = await reply(missing);
    assert.equal(missingReply.ok, false);
    assert.equal(missingReply.errorCode, "worker-command-timeout");
    await idle();
    assert.ok(missingReply.expiresAt - missingReply.createdAt === 86400000);
    step(
      "missing timeout follows Node NaN timer behavior and nullish reply TTL",
    );

    const unbounded = await publish({ timeoutMs: null });
    const unboundedRequest = await requested(receiver, peer, ++requestCount);
    await delay(80);
    assert.equal((await receiver.call("stats")).activeRequests, 1);
    assert.equal(replies(unbounded).length, 0);
    await response(receiver, peer, unboundedRequest, { unbounded: true });
    const unboundedReply = await reply(unbounded);
    assert.equal(unboundedReply.ok, true);
    assert.deepEqual(unboundedReply.result, { unbounded: true });
    await idle();
    step("explicit null timeout remains pending until the worker answers");

    for (const [name, timeoutMs, dispatches] of [
      ["numeric-string", "80", true],
      ["plain-object", {}, true],
      ["false", false, false],
      ["zero-string", "0", false],
      ["zero", 0, false],
      ["nonconvertible-object", { toString: "blocked" }, false],
    ]) {
      const before = await receiver.call("coordinationStats");
      const countBefore = requestCount;
      const id = await publish({ timeoutMs });
      if (dispatches) {
        const request = await requested(receiver, peer, ++requestCount);
        await response(receiver, peer, request);
      }
      await eventually(
        () => receiver.call("coordinationStats"),
        (s) => s.rejectedMessages === before.rejectedMessages + 1,
        `${name} rejects invalid TTL or coercion`,
      );
      await idle();
      await receiver.drain();
      assert.equal(
        receiver.events.filter(
          (e) => e.kind === "worker-output" && e.peer === peer && e.text,
        ).length,
        countBefore + Number(dispatches),
      );
      assert.equal(replies(id).length, 0);
      step(`${name} timeout preserves dispatch, coercion and strict reply TTL`);
    }

    await receiver.call("gateOwner", { workerId });
    const before = receiver.events.filter(
      (e) => e.kind === "owner-lookup" && e.workerId === workerId,
    ).length;
    const started = Date.now();
    const expiresAt = started + 350;
    const remaining = await publish({ timeoutMs: 1500, expiresAt });
    await eventually(
      () => receiver.drain(),
      (events) =>
        events.filter(
          (e) => e.kind === "owner-lookup" && e.workerId === workerId,
        ).length > before,
      "receiver pauses during real owner lookup",
    );
    await delay(180);
    await receiver.call("releaseOwner", { workerId });
    await requested(receiver, peer, ++requestCount);
    assert.equal((await reply(remaining)).errorCode, "worker-command-timeout");
    const remainingElapsed = Date.now() - started;
    assert.ok(remainingElapsed >= 300 && remainingElapsed < 850);
    await idle();
    step(
      `receiver spends only remaining envelope budget (${remainingElapsed}ms)`,
    );

    const skewStarted = Date.now();
    const skewed = await publish({
      timeoutMs: 160,
      createdAt: skewStarted + 2000,
      expiresAt: skewStarted + 2160,
    });
    await requested(receiver, peer, ++requestCount);
    assert.equal((await reply(skewed)).errorCode, "worker-command-timeout");
    const skewElapsed = Date.now() - skewStarted;
    assert.ok(skewElapsed >= 120 && skewElapsed < 650);
    await idle();
    step(
      `future sender clock cannot extend original timeout (${skewElapsed}ms)`,
    );
  } finally {
    if (subscriber.isOpen) subscriber.destroy();
    await writeFile(
      path.join(root, receiver.name + "-deadline-redis.jsonl"),
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
  }
}
