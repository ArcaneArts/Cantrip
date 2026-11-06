import assert from "node:assert/strict";
import { eventually } from "./coordinated-fixture-tools.mjs";

export async function verifyTransportAdapter(context) {
  const { a, b, redis, prefix, step, event, requested, response } = context;
  const workerId = "transport-worker";
  const peer = "transport-worker";
  assert.equal(
    await b.call("attach", { workerId, peer, ownerId: "owner" }),
    true,
  );
  await eventually(
    () => a.call("connected", { workerId }),
    (v) => v === true,
    "transport worker presence",
  );
  await a.call("delegateBegin", {
    workerId,
    name: "transport-remote",
    command: { type: "worker.version" },
    options: { ownerId: "owner", timeoutMs: 2000 },
  });
  const remote = await requested(b, peer, 1);
  await response(b, peer, remote, { throughDelegate: true });
  assert.deepEqual(
    (
      await event(
        a,
        (e) => e.kind === "completion" && e.name === "transport-remote",
        "remote command delegate response",
      )
    ).result,
    { throughDelegate: true },
  );
  step(
    "runtime transport CommandDelegate routes a remote command through real Redis",
  );

  await a.call("delegateBegin", {
    workerId,
    name: "transport-wrong-owner",
    command: { type: "worker.version" },
    options: { ownerId: "other-owner", timeoutMs: 2000 },
  });
  const rejected = await event(
    a,
    (e) => e.kind === "completion" && e.name === "transport-wrong-owner",
    "delegate owner mismatch",
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.class, "WorkerUnavailableError");
  await b.drain();
  assert.equal(
    b.events.filter(
      (e) => e.kind === "worker-output" && e.peer === peer && e.text,
    ).length,
    1,
  );
  step("runtime command delegate enforces remote owner before worker dispatch");

  await b.call("delegateBegin", {
    workerId,
    name: "transport-local",
    command: { type: "worker.version" },
    options: { ownerId: "owner", timeoutMs: 2000 },
  });
  const local = await requested(b, peer, 2);
  await response(b, peer, local, { local: true });
  assert.deepEqual(
    (
      await event(
        b,
        (e) => e.kind === "completion" && e.name === "transport-local",
        "local command delegate response",
      )
    ).result,
    { local: true },
  );
  step("runtime command delegate preserves local socket correlation");

  const abandonedWorker = "transport-abandoned";
  await b.call("gateOwner", { workerId: abandonedWorker });
  await b.call("abandonAttach", {
    workerId: abandonedWorker,
    peer: "abandoned",
  });
  await b.drain();
  // This must already have started even though Rust dropped the future without
  // polling it. The released operation still has to acquire a real Redis claim.
  assert.ok(
    b.events.some(
      (e) => e.kind === "owner-lookup" && e.workerId === abandonedWorker,
    ),
  );
  assert.equal(await b.call("connected", { workerId: abandonedWorker }), false);
  await b.call("releaseOwner", { workerId: abandonedWorker });
  await eventually(
    () => b.call("connected", { workerId: abandonedWorker }),
    (v) => v === true,
    "owned attachment finishes after caller drops future",
  );
  const claim = JSON.parse(
    await redis.client.get(`${prefix}:worker:${abandonedWorker}`),
  );
  assert.equal(claim.instanceId, "b");
  assert.equal(claim.ownerId, "owner");
  await eventually(
    () => a.call("connected", { workerId: abandonedWorker }),
    (v) => v === true,
    "abandoned caller attachment is visible remotely",
  );
  await a.call("delegateBegin", {
    workerId: abandonedWorker,
    name: "transport-after-drop",
    command: { type: "worker.version" },
    options: { ownerId: "owner", timeoutMs: 2000 },
  });
  const afterDrop = await requested(b, "abandoned", 1);
  await response(b, "abandoned", afterDrop, { retained: true });
  assert.deepEqual(
    (
      await event(
        a,
        (e) => e.kind === "completion" && e.name === "transport-after-drop",
        "attachment remains usable after caller abandonment",
      )
    ).result,
    { retained: true },
  );
  step(
    "dropped attachment future still completes fenced real Redis claim and remains routable",
  );
}
