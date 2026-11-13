// Test-only TCP fault injection. Hold Redis commands at their actual network
// boundary while independent clients continue using the real server.
import assert from "node:assert/strict";
import { createServer, createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

function frame(bytes) {
  const end = bytes.indexOf("\r\n");
  if (end < 0) return null;
  assert.equal(bytes[0], 42, "Redis command is an array");
  const count = Number(bytes.toString("ascii", 1, end)),
    args = [];
  let cursor = end + 2;
  for (let index = 0; index < count; index++) {
    const line = bytes.indexOf("\r\n", cursor);
    if (line < 0) return null;
    assert.equal(bytes[cursor], 36, "Redis argument is a bulk string");
    const length = Number(bytes.toString("ascii", cursor + 1, line));
    const start = line + 2;
    if (bytes.length < start + length + 2) return null;
    args.push(bytes.subarray(start, start + length));
    cursor = start + length + 2;
  }
  return {
    args,
    bytes: bytes.subarray(0, cursor),
    rest: bytes.subarray(cursor),
  };
}
async function proxy(port) {
  const sockets = new Set();
  let gate;
  let subscriber;
  const server = createServer((downstream) => {
    const upstream = createConnection({ host: "127.0.0.1", port });
    sockets.add(downstream);
    sockets.add(upstream);
    for (const socket of [downstream, upstream]) {
      socket.on("error", () => {
        downstream.destroy();
        upstream.destroy();
      });
      socket.on("close", () => {
        sockets.delete(socket);
        if (subscriber === downstream) subscriber = undefined;
        downstream.destroy();
        upstream.destroy();
      });
    }
    upstream.pipe(downstream);
    let bytes = Buffer.alloc(0),
      paused = false;
    const flush = () => {
      while (!paused) {
        const command = frame(bytes);
        if (!command) return;
        bytes = command.rest;
        if (command.args[0].toString() === "SUBSCRIBE") subscriber = downstream;
        if (gate?.matches(command.args)) {
          const held = gate;
          gate = undefined;
          paused = true;
          held.release = () => {
            upstream.write(command.bytes);
            paused = false;
            flush();
          };
          held.resolve();
          return;
        }
        upstream.write(command.bytes);
      }
    };
    downstream.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      flush();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `redis://127.0.0.1:${server.address().port}`,
    disconnectSubscriber() {
      assert.ok(subscriber, "the Redis subscription is connected");
      subscriber.destroy();
    },
    arm(matches) {
      assert.equal(gate, undefined);
      let resolve;
      const reached = new Promise((r) => {
        resolve = r;
      });
      const held = { matches, resolve, release: null };
      gate = held;
      return {
        async reached() {
          let timer;
          try {
            await Promise.race([
              reached,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Real Redis EVAL did not reach the fault boundary",
                      ),
                    ),
                  15000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        },
        release() {
          held.release?.();
        },
      };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function compareAndSetFaults({
  port,
  control,
  fixture,
  kind,
  name,
  options,
  sessionTemplate,
}) {
  const wire = await proxy(port);
  let peer, held;
  try {
    peer = fixture(kind, name);
    await peer.call("init", {
      options: {
        ...options,
        url: wire.url,
        instanceId: "cas-authority",
        maximumInstances: 100,
      },
    });
    const workerId = "cas-worker",
      connectionId = "same-connection",
      workerKey = options.keyPrefix + ":worker:" + workerId;
    await peer.call("claimWorker", {
      input: { workerId, connectionId, ownerId: "owner" },
    });
    const observed = [];
    async function replaceBetweenReadAndEval(key, op, fields) {
      held = wire.arm(
        (args) => args[0].toString() === "EVAL" && args[3]?.toString() === key,
      );
      const pending = peer.call(op, fields);
      pending.catch(() => {});
      await held.reached();
      const previous = JSON.parse(await control.get(key));
      const changed = { ...previous, concurrentWrite: randomUUID() };
      await control.set(key, JSON.stringify(changed), { PX: 60000 });
      held.release();
      held = null;
      assert.equal(
        await pending,
        false,
        `${op} must not overwrite a concurrently replaced raw claim`,
      );
      assert.deepEqual(
        JSON.parse(await control.get(key)),
        changed,
        `${op} preserves the intervening write`,
      );
      observed.push(op);
    }
    await replaceBetweenReadAndEval(workerKey, "refreshWorker", {
      workerId,
      connectionId,
    });
    await replaceBetweenReadAndEval(workerKey, "releaseWorker", {
      workerId,
      connectionId,
    });
    const session = structuredClone(sessionTemplate),
      at = Date.now();
    session.sessionId = randomUUID();
    Object.assign(session.lease, {
      issuedAt: new Date(at - 1000).toISOString(),
      expiresAt: new Date(at + 30000).toISOString(),
      absoluteExpiresAt: new Date(at + 60000).toISOString(),
    });
    const claim = {
      authorityInstanceId: "cas-authority",
      expiresAt: at + 30000,
      session,
    };
    assert.equal(await peer.call("claimSession", { claim }), null);
    const sessionKey = options.keyPrefix + ":worker-link:" + session.sessionId;
    await replaceBetweenReadAndEval(sessionKey, "refreshSession", { claim });
    await replaceBetweenReadAndEval(sessionKey, "releaseSession", {
      sessionId: session.sessionId,
      authorityInstanceId: "cas-authority",
    });
    return observed;
  } finally {
    held?.release();
    try {
      await peer?.stop();
    } finally {
      await wire.close();
    }
  }
}

export async function verifyDelayedSubscription({
  port,
  control,
  fixture,
  options,
}) {
  const wire = await proxy(port);
  const channel = options.keyPrefix + ":messages";
  const observer = control.duplicate();
  observer.on("error", () => {});
  let peer;
  try {
    await observer.connect();
    const publications = [];
    await observer.subscribe(channel, (message) => {
      const envelope = JSON.parse(message);
      if (envelope.kind === "worker-command-request")
        publications.push(envelope.requestId);
    });
    peer = fixture("rust", "delayed-subscriber");
    await peer.call("init", {
      options: { ...options, url: wire.url, maximumInstances: 100 },
    });
    assert.equal(await peer.call("health"), true);
    const isSubscribe = (args) => args[0].toString() === "SUBSCRIBE";
    const stalled = wire.arm(isSubscribe);
    wire.disconnectSubscriber();
    await stalled.reached();
    assert.equal(await control.ping(), "PONG");
    assert.equal(await peer.call("health"), false);
    await assert.rejects(
      peer.call("publish", {
        payload: { kind: "worker-command-request", requestId: "during-gap" },
      }),
      /Redis coordination is unavailable/,
    );

    // Keep the first SUBSCRIBE unacknowledged and observe a second attempt.
    const retry = wire.arm(isSubscribe);
    await retry.reached();
    assert.equal(await peer.call("health"), false);
    retry.release();
    const deadline = Date.now() + 5000;
    while (!(await peer.call("health"))) {
      assert.ok(Date.now() < deadline, "subscription did not recover");
      await delay(20);
    }
    await peer.call("publish", {
      payload: { kind: "worker-command-request", requestId: "after-recovery" },
    });
    while (!publications.includes("after-recovery")) {
      assert.ok(Date.now() < deadline, "recovered request was not published");
      await delay(20);
    }
    assert.deepEqual(publications, ["after-recovery"]);
  } finally {
    if (observer.isOpen) observer.destroy();
    try {
      await peer?.stop();
    } finally {
      await wire.close();
    }
  }
}
