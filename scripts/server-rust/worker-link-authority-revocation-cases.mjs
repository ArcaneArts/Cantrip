import assert from "node:assert/strict";
import { eventually } from "./coordinated-fixture-tools.mjs";
import {
  call,
  input,
  grant,
  barrier,
} from "./worker-link-authority-case-tools.mjs";
export async function verifyAuthorityRevocations({
  a,
  b,
  redis,
  key,
  messages,
  step,
}) {
  const sessions = await Promise.all(
    [a, b].map((p, i) =>
      call(p, "open", {
        input: input({
          clientInstanceId: "scope-" + i,
          ownerId: "scope-owner",
          accountSessionId: "scope-account",
        }),
      }),
    ),
  );
  const grants = await Promise.all(
    [a, b].map((p, i) =>
      call(p, "issue", { input: grant(sessions[i].sessionId) }),
    ),
  );
  assert.equal(
    await call(a, "revokeAttachment", {
      owner: "wrong",
      kind: "terminal",
      resource: "terminal",
      attachment: "attachment",
    }),
    0,
  );
  assert.equal(
    await call(a, "revokeAttachment", {
      owner: "scope-owner",
      kind: "terminal",
      resource: "terminal",
      attachment: "wrong",
    }),
    0,
  );
  assert.equal(
    await call(a, "revokeAttachment", {
      owner: "scope-owner",
      kind: "terminal",
      resource: "terminal",
      attachment: "attachment",
      reason: "resource-deleted",
    }),
    1,
  );
  for (const [i, p] of [a, b].entries()) {
    const commands = await eventually(
      () => p.call("commands"),
      (v) =>
        v.some(
          (c) =>
            c.command.type === "worker-link.grant.revoke" &&
            c.command.grantId === grants[i].binding.grantId,
        ),
      "distributed attachment revoke",
    );
    assert.equal(
      commands.find(
        (c) =>
          c.command.grantId === grants[i].binding.grantId &&
          c.command.type === "worker-link.grant.revoke",
      ).command.revocation.reason,
      "resource-deleted",
    );
  }
  const resourceGrants = await Promise.all(
    [a, b].map((p, i) =>
      call(p, "issue", {
        input: grant(sessions[i].sessionId, { attachmentId: "second" }),
      }),
    ),
  );
  assert.equal(
    await call(b, "revokeResource", {
      owner: "scope-owner",
      kind: "terminal",
      resource: "terminal",
    }),
    1,
  );
  for (const [i, p] of [a, b].entries())
    await eventually(
      () => p.call("commands"),
      (v) =>
        v.some(
          (c) =>
            c.command.type === "worker-link.grant.revoke" &&
            c.command.grantId === resourceGrants[i].binding.grantId &&
            c.command.revocation.reason === "resource-stopped",
        ),
      "distributed resource revoke",
    );
  step(
    "resource and attachment revocation cross instances and preserve tenant/resource/attachment filters",
  );
  for (const p of [a, b])
    await p.call("subscribe", { name: "bulk", token: "bulk" });
  assert.equal(await call(a, "revokeAccount", { account: "scope-account" }), 1);
  for (const p of [a, b])
    await eventually(
      () => p.call("stats"),
      (v) => v.sessions === 0,
      "account revocation empties local state",
    );
  await barrier(a, b, "b", "bulk-account");
  for (const p of [a, b]) {
    await p.drain();
    assert.deepEqual(
      p.events
        .filter((e) => e.kind === "relay-revoke" && e.name === "bulk")
        .map((e) => e.scope),
      [{ kind: "account-session", accountSessionId: "scope-account" }],
    );
    await p.call("unsubscribe", { token: "bulk" });
  }
  for (const session of sessions)
    assert.ok(
      await redis.client.get(key(session.sessionId)),
      "Source bulk revocation retains directory claim until TTL/close",
    );
  step(
    "account revokes both local authorities and both relays while retaining Source directory TTL semantics",
  );
  const ownerSessions = await Promise.all(
    [a, b].map((p, i) =>
      call(p, "open", {
        input: input({
          clientInstanceId: "owner-" + i,
          accountSessionId: "new-account",
          ownerId: "scope-owner",
        }),
      }),
    ),
  );
  const survivor = await call(b, "open", {
    input: input({
      ownerId: "other",
      accountSessionId: "other-account",
      clientInstanceId: "other",
    }),
  });
  assert.equal(await call(a, "revokeOwner", { owner: "scope-owner" }), 1);
  await eventually(
    () => b.call("stats"),
    (v) => v.sessions === 1,
    "owner isolation",
  );
  assert.equal(
    (
      await call(a, "authorize", {
        session: survivor.sessionId,
        owner: "other",
        account: "other-account",
      })
    ).sessionId,
    survivor.sessionId,
  );
  for (const session of ownerSessions)
    assert.ok(await redis.client.get(key(session.sessionId)));
  assert.equal(
    await call(b, "revokeSession", { session: survivor.sessionId }),
    true,
  );
  step("owner-wide revocation crosses instances and preserves another tenant");
  // Set iteration is live: first removes a later callback and adds one which
  // must run during the same notification. The same callback is deduplicated.
  await a.call("subscribe", {
    name: "first",
    token: "first",
    spec: { remove: ["later"], add: [{ name: "added", token: "added" }] },
  });
  await a.call("subscribe", { name: "later", token: "later" });
  await a.call("subscribe", { name: "duplicate", token: "duplicate-1" });
  await a.call("subscribe", { name: "duplicate", token: "duplicate-2" });
  let offset = a.events.length;
  await call(a, "revokeOwner", { owner: "empty" });
  await a.drain();
  assert.deepEqual(
    a.events
      .slice(offset)
      .filter((e) => e.kind === "relay-revoke")
      .map((e) => e.name),
    ["first", "duplicate", "added"],
  );
  for (const token of ["first", "added", "duplicate-1"])
    await a.call("unsubscribe", { token });
  offset = a.events.length;
  await call(a, "revokeOwner", { owner: "empty" });
  await a.drain();
  assert.deepEqual(
    a.events.slice(offset).filter((e) => e.kind === "relay-revoke"),
    [],
    "either duplicate unsubscribe removes that callback",
  );
  await a.call("unsubscribe", { token: "duplicate-2" });
  await a.call("subscribe", {
    name: "fails",
    token: "fails",
    spec: { fail: true },
  });
  await a.call("subscribe", { name: "after-failure", token: "after-failure" });
  const beforeMessages = messages.length;
  offset = a.events.length;
  const failed = await a.call("call", {
    call: { method: "revokeOwner", owner: "empty" },
  });
  assert.deepEqual(failed, {
    ok: false,
    error: {
      name: "Error",
      class: "Error",
      message: "Controlled relay revocation listener failed.",
      unavailable: false,
    },
  });
  await barrier(a, b, "b", "failed-listener");
  await a.drain();
  assert.deepEqual(
    a.events
      .slice(offset)
      .filter((e) => e.kind === "relay-revoke")
      .map((e) => e.name),
    ["fails"],
  );
  assert.ok(
    !messages
      .slice(beforeMessages)
      .some((m) => m.kind === "worker-link-relay-revoke"),
    "listener failure stops relay publication",
  );
  for (const token of ["fails", "after-failure"])
    await a.call("unsubscribe", { token });
  step(
    "live relay listener mutation, callback deduplication, unsubscribe and failure ordering match Source",
  );
}
