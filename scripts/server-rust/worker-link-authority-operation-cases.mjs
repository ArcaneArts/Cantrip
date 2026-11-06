import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { eventually } from "./coordinated-fixture-tools.mjs";
import {
  call,
  rejected,
  input,
  grant,
  envelope,
  barrier,
} from "./worker-link-authority-case-tools.mjs";
export async function verifyAuthorityOperations({
  a,
  b,
  redis,
  messages,
  key,
  step,
}) {
  const session = await call(a, "open", { input: input() });
  const id = session.sessionId;
  const claim = JSON.parse(await redis.client.get(key(id)));
  assert.deepEqual(claim, {
    authorityInstanceId: "a",
    expiresAt: Date.parse(session.lease.expiresAt),
    session,
  });
  assert.ok((await redis.client.pTTL(key(id))) > 0);
  assert.deepEqual(await call(a, "open", { input: input() }), session);
  assert.deepEqual(
    await call(b, "authorize", {
      session: id,
      owner: "owner",
      account: "account",
    }),
    session,
  );
  for (const fields of [
    { owner: "other", account: "account" },
    { owner: "owner", account: "other" },
  ])
    assert.equal(await call(b, "authorize", { session: id, ...fields }), null);
  assert.equal(
    await call(b, "authorize", {
      session: "missing",
      owner: "owner",
      account: "account",
    }),
    null,
  );
  step(
    "real NX directory entry, local identity reuse and remote owner/account authorization",
  );
  const expiredSession = structuredClone(session);
  expiredSession.lease.issuedAt = new Date(Date.now() - 2000).toISOString();
  expiredSession.lease.expiresAt = new Date(Date.now() - 1000).toISOString();
  await redis.client.set(
    key(id),
    JSON.stringify({
      ...claim,
      session: expiredSession,
      expiresAt: Date.parse(expiredSession.lease.expiresAt),
    }),
    { PX: 60000 },
  );
  assert.equal(
    await call(b, "authorize", {
      session: id,
      owner: "owner",
      account: "account",
    }),
    null,
  );
  assert.deepEqual(
    await call(a, "authorize", {
      session: id,
      owner: "owner",
      account: "account",
    }),
    session,
  );
  await redis.client.set(key(id), JSON.stringify(claim), {
    PX: claim.expiresAt - Date.now(),
  });
  step(
    "expired directory claim denies remote authorization; the local authority uses its live session first",
  );
  const renewed = await call(b, "renew", { session: id });
  assert.equal(renewed.sessionId, id);
  assert.ok(
    Date.parse(renewed.lease.expiresAt) >= Date.parse(session.lease.expiresAt),
  );
  assert.deepEqual((await b.call("claim", { session: id })).session, renewed);
  const peer = await call(b, "openPeer", {
    session: id,
    input: { route: "lan", routeGeneration: 1 },
  });
  assert.equal(peer.peerSession.sessionId, id);
  const peerId = peer.peerSession.peerSessionId;
  const signal = envelope(id, peerId, 0);
  assert.equal(await call(b, "signal", { session: id, input: signal }), null);
  const received = envelope(id, peerId, 0, "worker");
  await a.call("notify", {
    worker: "worker",
    input: { type: "worker-link.peer.signal", envelope: received },
  });
  const mailbox = await call(b, "mailbox", {
    session: id,
    peer: peerId,
    input: {},
  });
  assert.deepEqual(mailbox.signals, [received]);
  assert.deepEqual(
    (
      await call(b, "mailbox", {
        session: id,
        peer: peerId,
        input: { afterSignalSequence: 0 },
      })
    ).signals,
    [],
  );
  assert.equal(
    await call(b, "revokePeer", { session: id, peer: peerId }),
    true,
  );
  assert.equal(
    await call(b, "revokePeer", { session: id, peer: peerId }),
    false,
  );
  const signalResponse = messages.find(
    (m) =>
      m.kind === "worker-link-operation-response" &&
      m.ok === true &&
      !Object.hasOwn(m, "result"),
  );
  assert.ok(signalResponse, "successful void RPC response omits result");
  const signalCommand = (await a.call("commands")).find(
    (v) => v.command.type === "worker-link.peer.signal",
  );
  assert.deepEqual(signalCommand.command.envelope, signal);
  step(
    "remote renewal and complete peer signaling/mailbox/revocation with absent void result",
  );
  const issued = await call(b, "issue", { input: grant(id) });
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  const installed = (await a.call("commands")).find(
    (v) => v.command.type === "worker-link.grant.install",
  );
  assert.equal(
    installed.command.grant.tokenHash,
    createHash("sha256").update(issued.token).digest("hex"),
  );
  assert.equal(installed.command.grant.binding.sessionId, id);
  const lease = await call(b, "renewGrant", {
    session: id,
    grant: issued.binding.grantId,
  });
  assert.ok(
    Date.parse(lease.expiresAt) >= Date.parse(issued.binding.lease.expiresAt),
  );
  assert.equal(
    await call(b, "revokeGrant", {
      session: id,
      grant: issued.binding.grantId,
      reason: "resource-deleted",
    }),
    true,
  );
  assert.equal(
    await call(b, "revokeGrant", {
      session: id,
      grant: issued.binding.grantId,
    }),
    false,
  );
  step(
    "remote grant issue/renew/revoke preserves capability hash, worker binding and booleans",
  );
  const rawGrant = await call(b, "issue", { input: grant(id) });
  const rawRequest = randomUUID();
  await b.call("publish", {
    payload: {
      kind: "worker-link-operation-request",
      targetInstanceId: "a",
      requestId: rawRequest,
      operation: {
        kind: "revoke-grant",
        sessionId: id,
        grantId: rawGrant.binding.grantId,
        reason: ["released"],
        unknown: { opaque: true },
      },
    },
  });
  const rawResponse = await eventually(
    () =>
      messages.find(
        (m) =>
          m.kind === "worker-link-operation-response" &&
          m.requestId === rawRequest,
      ),
    Boolean,
    "raw accepted RPC reason response",
  );
  assert.equal(rawResponse.ok, true);
  assert.equal(rawResponse.result, true);
  assert.deepEqual(
    (await a.call("commands")).find(
      (v) =>
        v.command.type === "worker-link.grant.revoke" &&
        v.command.grantId === rawGrant.binding.grantId,
    ).command.revocation.reason,
    ["released"],
  );
  step(
    "RPC parser String membership retains the accepted original reason value in local worker commands",
  );
  for (const [fields, missing] of [
    [{}, "undefined"],
    [{ resourceKind: null }, "null"],
    [{ resourceKind: "terminal" }, "undefined"],
    [{ resourceKind: "terminal", resourceId: null }, "null"],
  ]) {
    const requestId = randomUUID();
    await b.call("publish", {
      payload: {
        kind: "worker-link-operation-request",
        targetInstanceId: "a",
        requestId,
        operation: { kind: "issue-grant", input: { sessionId: id, ...fields } },
      },
    });
    const response = await eventually(
      () =>
        messages.find(
          (m) =>
            m.kind === "worker-link-operation-response" &&
            m.requestId === requestId,
        ),
      Boolean,
      "malformed grant returns actual authority error",
    );
    assert.equal(response.ok, false);
    assert.equal(
      response.error,
      `Cannot read properties of ${missing} (reading 'length')`,
    );
  }
  assert.equal(
    (await call(b, "renew", { session: id })).sessionId,
    id,
    "malformed grant must not poison subsequent valid operations",
  );
  step(
    "parser-accepted malformed grant fields return Source property errors without poisoning authority state",
  );
  for (const p of [a, b])
    await p.call("subscribe", { name: "route", token: "route" });
  const route = await call(b, "route", { session: id, route: "relay" });
  assert.equal(route.routeGeneration, 2);
  assert.equal(route.preferredRoute, "relay");
  assert.deepEqual((await b.call("claim", { session: id })).session, route);
  await barrier(b, a, "a", "route-revocation");
  for (const p of [a, b]) {
    await p.drain();
    assert.deepEqual(
      p.events
        .filter((e) => e.kind === "relay-revoke" && e.name === "route")
        .map((e) => e.scope),
      [{ kind: "session", sessionId: id }],
    );
    await p.call("unsubscribe", { token: "route" });
  }
  assert.equal(await call(b, "revokeSession", { session: id }), true);
  assert.equal(await redis.client.get(key(id)), null);
  await rejected(
    b,
    "renew",
    { session: id },
    "WorkerLink session is unavailable.",
  );
  assert.equal(
    (await b.call("commands")).length,
    0,
    "RPC executes only at authority",
  );
  for (const request of await a.call("commands")) {
    assert.equal(request.worker, "worker");
    assert.equal(request.owner, "owner");
    assert.equal(request.timeoutMs, 5000);
  }
  step(
    "route replacement refreshes authority and notifies both relays; session revoke removes exact claim",
  );
}
