import assert from "node:assert/strict";
import { eventually } from "./coordinated-fixture-tools.mjs";
import {
  call,
  rejected,
  input,
  behavior,
  held,
  release,
  completion,
} from "./worker-link-authority-case-tools.mjs";
export async function verifyAuthorityFences({
  a,
  b,
  redis,
  key,
  messages,
  step,
}) {
  await behavior(a, "worker-link.session.install", { hold: true });
  await a.call("begin", {
    name: "nx-conflict",
    call: { method: "open", input: input({ clientInstanceId: "conflict" }) },
  });
  await held(a, "worker-link.session.install");
  const installing = (await a.call("commands"))
    .filter((v) => v.command.type === "worker-link.session.install")
    .at(-1).command.session;
  const foreign = {
    authorityInstanceId: "b",
    expiresAt: Date.parse(installing.lease.expiresAt),
    session: installing,
  };
  assert.equal(
    await redis.client.set(key(installing.sessionId), JSON.stringify(foreign), {
      NX: true,
      PX: foreign.expiresAt - Date.now(),
    }),
    "OK",
  );
  await release(a, "worker-link.session.install");
  assert.deepEqual(await completion(a, "nx-conflict"), {
    ok: false,
    error: {
      name: "Error",
      class: "WorkerLinkUnavailableError",
      message:
        "WorkerLink session authority is already owned by another server.",
      unavailable: true,
    },
  });
  assert.deepEqual(
    JSON.parse(await redis.client.get(key(installing.sessionId))),
    foreign,
  );
  assert.equal((await a.call("stats")).sessions, 0);
  await behavior(a, "worker-link.session.install", null);
  step(
    "NX conflict after worker install revokes local session and retains foreign authority claim",
  );
  const lost = await call(a, "open", {
    input: input({ clientInstanceId: "lost" }),
  });
  await behavior(a, "worker-link.session.renew", { hold: true });
  await a.call("begin", {
    name: "lost-renewal",
    call: { method: "renew", session: lost.sessionId },
  });
  await held(a, "worker-link.session.renew");
  const replaced = {
    ...(await b.call("claim", { session: lost.sessionId })),
    authorityInstanceId: "b",
  };
  await redis.client.set(key(lost.sessionId), JSON.stringify(replaced), {
    PX: replaced.expiresAt - Date.now(),
  });
  await release(a, "worker-link.session.renew");
  assert.deepEqual(await completion(a, "lost-renewal"), {
    ok: false,
    error: {
      name: "Error",
      class: "WorkerLinkUnavailableError",
      message: "WorkerLink session authority was lost during the operation.",
      unavailable: true,
    },
  });
  assert.deepEqual(
    JSON.parse(await redis.client.get(key(lost.sessionId))),
    replaced,
  );
  const fallback = await call(a, "open", {
    input: input({ clientInstanceId: "fallback" }),
  });
  await a.call("begin", {
    name: "fallback-renewal",
    call: { method: "renew", session: fallback.sessionId },
  });
  await held(a, "worker-link.session.renew");
  await redis.client.del(key(fallback.sessionId));
  await release(a, "worker-link.session.renew");
  assert.equal((await completion(a, "fallback-renewal")).ok, true);
  assert.equal(
    (await b.call("claim", { session: fallback.sessionId }))
      .authorityInstanceId,
    "a",
  );
  await behavior(a, "worker-link.session.renew", null);
  // An existing local session does not bypass the coordination lookup.
  await redis.client.del(key(fallback.sessionId));
  await rejected(
    a,
    "renew",
    { session: fallback.sessionId },
    "WorkerLink session is unavailable.",
  );
  step(
    "lost renewal preserves foreign claim; absent claim is re-elected after mutation and required before operations",
  );
  await behavior(a, "worker-link.session.install", { hold: true });
  await a.call("abandon", {
    call: { method: "open", input: input({ clientInstanceId: "abandoned" }) },
  });
  await held(a, "worker-link.session.install");
  const abandoned = (await a.call("commands"))
    .filter((v) => v.command.type === "worker-link.session.install")
    .at(-1).command.session;
  await release(a, "worker-link.session.install");
  await eventually(
    () => b.call("claim", { session: abandoned.sessionId }),
    (v) => v?.authorityInstanceId === "a",
    "caller-drop operation completes directory claim",
  );
  await behavior(a, "worker-link.session.install", null);
  step(
    "dropping caller future does not cancel in-flight session installation/claim",
  );
  await behavior(a, "worker-link.session.renew", { hold: true });
  const offset = messages.length;
  await b.call("begin", {
    name: "bounded-error",
    call: { method: "renew", session: abandoned.sessionId },
  });
  await held(a, "worker-link.session.renew");
  const request = await eventually(
    () =>
      messages
        .slice(offset)
        .find((m) => m.kind === "worker-link-operation-request"),
    Boolean,
    "actual request correlation",
  );
  const text = "x".repeat(499) + "😀";
  await a.call("publish", {
    payload: {
      kind: "worker-link-operation-response",
      targetInstanceId: "b",
      requestId: request.requestId,
      ok: false,
      error: text,
    },
  });
  const bounded = await completion(b, "bounded-error");
  assert.deepEqual(bounded, {
    ok: false,
    error: {
      name: "Error",
      class: "WorkerLinkUnavailableError",
      message: text.slice(0, 500),
      unavailable: true,
    },
  });
  assert.equal(bounded.error.message.charCodeAt(499), 0xd83d);
  await release(a, "worker-link.session.renew");
  await behavior(a, "worker-link.session.renew", null);
  await eventually(
    () => messages,
    (v) =>
      v.some(
        (m) =>
          m.kind === "worker-link-operation-response" &&
          m.requestId === request.requestId &&
          m.ok === true,
      ),
    "late real response",
  );
  await b.drain();
  assert.equal(
    b.events.filter(
      (e) => e.kind === "completion" && e.name === "bounded-error",
    ).length,
    1,
  );
  step(
    "500 UTF16-unit error bound preserves split surrogate; late successful response is ignored",
  );
  const ghost = {
    ...(await b.call("claim", { session: abandoned.sessionId })),
    authorityInstanceId: "missing-authority",
  };
  await redis.client.set(key(abandoned.sessionId), JSON.stringify(ghost), {
    PX: ghost.expiresAt - Date.now(),
  });
  const start = Date.now();
  await rejected(
    b,
    "renew",
    { session: abandoned.sessionId },
    "WorkerLink authority did not answer in time.",
  );
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed >= 9900 && elapsed < 15000,
    `real 10-second RPC deadline ${elapsed}`,
  );
  step("unreachable authority observes actual 10-second operation timeout");
  const closeOffset = messages.length;
  assert.equal(
    await b.call("attachRelay", { name: "shutdown-b", session: abandoned }),
    true,
  );
  assert.equal(
    await a.call("attachRelay", { name: "shutdown-a", session: lost }),
    true,
  );
  await b.call("begin", {
    name: "close-pending",
    call: { method: "renew", session: abandoned.sessionId },
  });
  await eventually(
    () => messages.slice(closeOffset),
    (v) => v.some((m) => m.kind === "worker-link-operation-request"),
    "pending RPC published before close",
  );
  assert.equal(await call(b, "close"), null);
  await b.drain();
  assert.deepEqual(
    b.events.filter((e) => e.kind === "relay-close" && e.name === "shutdown-b"),
    [
      {
        kind: "relay-close",
        name: "shutdown-b",
        code: 1001,
        reason: "Server is shutting down",
      },
    ],
  );
  assert.deepEqual(await completion(b, "close-pending"), {
    ok: false,
    error: {
      name: "Error",
      class: "WorkerLinkUnavailableError",
      message: "WorkerLink service closed.",
      unavailable: true,
    },
  });
  await rejected(
    b,
    "renew",
    { session: abandoned.sessionId },
    "WorkerLink service is closed.",
  );
  assert.equal(await call(a, "close"), null);
  await a.drain();
  assert.deepEqual(
    a.events.filter((e) => e.kind === "relay-close" && e.name === "shutdown-a"),
    [
      {
        kind: "relay-close",
        name: "shutdown-a",
        code: 1001,
        reason: "Server is shutting down",
      },
    ],
  );
  assert.deepEqual(
    JSON.parse(await redis.client.get(key(lost.sessionId))),
    replaced,
    "close exact-authority release retains foreign claim",
  );
  assert.equal(await redis.client.get(key(fallback.sessionId)), null);
  assert.equal(
    (await redis.client.get(key(abandoned.sessionId))) !== null,
    true,
    "close must not remove replacement authority claim",
  );
  step(
    "close rejects pending RPCs, fences claim releases and rejects subsequent operations",
  );
  step(
    "composed Service shutdown closes relay sockets before releasing authority state",
  );
}
