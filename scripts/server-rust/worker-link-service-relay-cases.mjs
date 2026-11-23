import assert from "node:assert/strict";
import { eventually } from "./coordinated-fixture-tools.mjs";
import {
  call,
  input,
  grant,
  barrier,
  behavior,
  held,
  release,
  rejected,
} from "./worker-link-authority-case-tools.mjs";
async function attach(peer, name, session) {
  assert.equal(await peer.call("attachRelay", { name, session }), true);
  assert.equal(await peer.call("relayOpen", { name }), true);
}
async function closed(peer, name, code, reason) {
  const trace = await eventually(
    () => peer.drain(),
    (v) => v.some((e) => e.kind === "relay-close" && e.name === name),
    name + " actual relay close",
  );
  assert.deepEqual(
    trace.filter((e) => e.kind === "relay-close" && e.name === name),
    [{ kind: "relay-close", name, code, reason }],
  );
  assert.equal(await peer.call("relayOpen", { name }), false);
}
export async function verifyServiceRelays({ a, b, messages, step }) {
  const session = await call(a, "open", {
    input: input({ clientInstanceId: "relay-route" }),
  });
  for (const p of [a, b]) await attach(p, "relay-route", session);
  await call(b, "route", { session: session.sessionId, route: "relay" });
  for (const p of [a, b])
    await closed(p, "relay-route", 1008, "WorkerLink session ended");
  await call(b, "revokeSession", { session: session.sessionId });
  step(
    "composed Service route replacement closes local and remote actual relay connections",
  );
  for (const scope of ["account", "owner"]) {
    const sessions = await Promise.all(
      [a, b].map((p, i) =>
        call(p, "open", {
          input: input({
            clientInstanceId: `relay-${scope}-${i}`,
            ownerId: `relay-${scope}-owner`,
            accountSessionId:
              scope === "account"
                ? "relay-account"
                : `relay-owner-account-${i}`,
          }),
        }),
      ),
    );
    for (const [i, p] of [a, b].entries())
      await attach(p, `relay-${scope}`, sessions[i]);
    if (scope === "account")
      assert.equal(
        await call(a, "revokeAccount", { account: "relay-account" }),
        1,
      );
    else
      assert.equal(
        await call(b, "revokeOwner", { owner: "relay-owner-owner" }),
        1,
      );
    for (const p of [a, b]) {
      await closed(
        p,
        `relay-${scope}`,
        1008,
        scope === "account"
          ? "Account session ended"
          : "Account sessions ended",
      );
      await eventually(
        () => p.call("stats"),
        (v) => v.sessions === 0,
        "underlying local session revocation",
      );
      assert.equal((await p.call("relayStats")).connections, 0);
    }
    step(
      `composed Service ${scope} revocation closes real relay sockets across both instances`,
    );
  }
  const resource = await call(a, "open", {
    input: input({
      clientInstanceId: "relay-resource",
      ownerId: "relay-resource-owner",
      accountSessionId: "relay-resource-account",
    }),
  });
  for (const p of [a, b]) await attach(p, "relay-resource", resource);
  await call(a, "issue", { input: grant(resource.sessionId) });
  assert.equal(
    await call(b, "revokeAttachment", {
      owner: "relay-resource-owner",
      kind: "terminal",
      resource: "terminal",
      attachment: "attachment",
    }),
    0,
  );
  await eventually(
    () => a.call("stats"),
    (v) => v.grants === 0,
    "remote grant revoke completes",
  );
  await call(a, "issue", { input: grant(resource.sessionId) });
  assert.equal(
    await call(a, "revokeResource", {
      owner: "relay-resource-owner",
      kind: "terminal",
      resource: "terminal",
      reason: "resource-deleted",
    }),
    1,
  );
  await barrier(a, b, "b", "resource-revocation-preserves-relay");
  for (const p of [a, b])
    assert.equal(await p.call("relayOpen", { name: "relay-resource" }), true);
  step(
    "resource and attachment revocation remove capabilities while preserving unrelated relay connections",
  );
  await call(a, "issue", { input: grant(resource.sessionId) });
  await behavior(a, "worker-link.grant.revoke", { hold: true });
  const abandonedOffset = messages.length;
  await a.call("abandonServiceResource", {
    owner: "relay-resource-owner",
    kind: "terminal",
    resource: "terminal",
  });
  await held(a, "worker-link.grant.revoke");
  await rejected(
    b,
    "issue",
    { input: grant(resource.sessionId) },
    "The WorkerLink resource is being revoked.",
  );
  await release(a, "worker-link.grant.revoke");
  await behavior(a, "worker-link.grant.revoke", null);
  await eventually(
    () => messages.slice(abandonedOffset),
    (v) =>
      v.some(
        (m) =>
          m.kind === "worker-link-revoke" &&
          m.sourceInstanceId === "a" &&
          m.scope.resourceId === "terminal",
      ),
    "abandoned Service operation publishes after actual worker ACK",
  );
  assert.equal((await a.call("stats")).grants, 0);
  assert.equal(await a.call("relayOpen", { name: "relay-resource" }), true);
  step(
    "Service revocation starts without polling its returned future and retains its fence through worker ACK and publication",
  );
  const before = (await a.call("coordinationStats")).rejectedMessages;
  await b.call("publish", {
    payload: {
      kind: "worker-link-relay-revoke",
      targetInstanceId: "a",
      scope: { kind: "session", sessionId: "unknown\ud800" },
    },
  });
  await barrier(b, a, "a", "lone-surrogate-relay-scope");
  assert.equal((await a.call("coordinationStats")).rejectedMessages, before);
  assert.equal(await a.call("relayOpen", { name: "relay-resource" }), true);
  await call(b, "revokeSession", { session: resource.sessionId });
  for (const p of [a, b])
    await closed(p, "relay-resource", 1008, "WorkerLink session ended");
  step(
    "accepted unknown UTF16 session scope is harmless and subsequent distributed relay revocation works",
  );
}
