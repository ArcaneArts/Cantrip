import assert from "node:assert/strict";
import {
  settingsChat as chat,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
import { standaloneInteractionHttpCases } from "./agent-interaction-http-standalone.mjs";

export async function runInteractionHttpCases(c) {
  const {
      h,
      result,
      profile,
      base,
      item,
      respond,
      seed,
      response,
      durable,
      barrier,
      id,
      lane,
    } = c,
    visit = h.visit;
  const sql = (...statements) => h.fixture.sql(statements);
  const reply = async (n, body, status = 200, label = `reply ${n}`) =>
    visit(label, "POST", respond(n), { json: body, status });
  const assertNoCommand = async (operation) => {
    const before = result.commands.length;
    await operation();
    assert.equal(result.commands.length, before, "no worker side effect");
  };
  assert.deepEqual(await visit("empty interaction list", "GET", base), []);
  await visit("missing interaction", "GET", item(999), { status: 404 });
  await visit("missing interaction HEAD", "HEAD", item(999), { status: 404 });
  for (const query of [
    "limit=0",
    "limit=501",
    "limit=1.1",
    "limit=NaN",
    "limit=",
    "limit=1&limit=2",
    "status=other",
    "status=pending&status=resolved",
    "chatId=",
    "chatId=a&chatId=b",
    "extra=true",
  ])
    await visit(`invalid query ${query}`, "GET", `${base}?${query}`, {
      status: 400,
    });
  for (const query of [
    "limit=0x2",
    "limit=1e2",
    "limit=%20%202%20",
    "limit=500",
    "chatId=%E0%A4%A",
    "chatId=%FF",
    "chatId=__proto__",
    "status=pending",
  ])
    assert.deepEqual(
      await visit(`empty query ${query}`, "GET", `${base}?${query}`),
      [],
    );
  for (const [name, options] of [
    ["missing body", {}],
    ["null body", { json: null }],
    ["invalid union", { json: {} }],
    ["invalid visible", { json: { response: {} } }],
    [
      "visible unknown field is stripped",
      {
        json: { ...(await response(999)), extra: true },
        status: 404,
      },
    ],
    [
      "malformed JSON",
      { raw: "{", headers: { "content-type": "application/json" } },
    ],
    [
      "binary Buffer",
      {
        raw: Buffer.from("{}"),
        headers: { "content-type": "application/octet-stream" },
      },
    ],
    [
      "empty binary Buffer",
      {
        raw: Buffer.alloc(0),
        headers: { "content-type": "application/octet-stream" },
      },
    ],
  ])
    await visit(name, "POST", respond(999), { status: 400, ...options });
  await reply(999, await response(999), 404, "missing response target");
  if (profile !== "none") {
    await visit("unauthenticated interaction read", "GET", base, {
      client: "stranger",
      status: 401,
    });
    await visit("CSRF before resolution", "POST", respond(999), {
      csrf: false,
      json: await response(999),
      status: 403,
    });
  }

  await seed(1);
  await seed(2, { protected: true });
  await seed(3, { status: "interrupted" });
  await seed(4, { status: "expired" });
  await seed(5, { expired: true });
  let rows = await visit("mixed interaction list", "GET", base);
  assert.deepEqual(
    rows.map((r) => r.id),
    [5, 4, 3, 2, 1].map(id),
  );
  assert.equal(rows[0].status, "expired");
  for (const n of [1, 2, 3, 4, 5]) {
    const row = await visit(`inspect interaction ${n}`, "GET", item(n));
    assert.equal(row.id, id(n));
    assert.equal(row.createdAt, new Date(Date.parse(stamp) + n).toISOString());
    assert.equal(row.provenance.workerId, worker);
    assert.equal(row.provenance.chatId, chat);
    if (n === 2) {
      assert.equal("payload" in row, false);
      assert.equal(row.classification.kind, "fileChange");
    }
  }
  rows = await visit(
    "pending chat limited query",
    "GET",
    `${base}?chatId=${chat}&status=pending&limit=1`,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [id(2)],
  );
  await visit("HEAD existing request", "HEAD", item(1));
  if (profile === "accounts") {
    assert.deepEqual(
      await visit("foreign owner list", "GET", base, { client: "other" }),
      [],
    );
    await visit("foreign owner get", "GET", item(1), {
      client: "other",
      status: 404,
    });
    await visit("foreign owner respond", "POST", respond(1), {
      client: "other",
      json: await response(1),
      status: 404,
    });
  }
  const visible = await response(1),
    protectedReply = await response(2, true);
  await assertNoCommand(async () => {
    await reply(1, protectedReply, 409, "opaque response on visible request");
    await reply(2, visible, 409, "visible response on protected request");
    await reply(
      2,
      { ...protectedReply, classification: { kind: "permissions" } },
      409,
      "opaque classification mismatch",
    );
    await reply(
      1,
      { ...visible, response: { kind: "fileChange", decision: "invalid" } },
      400,
      "invalid response decision",
    );
    for (const n of [3, 4, 5])
      await reply(n, await response(n), 409, `terminal state ${n}`);
  });
  await seed(6, { noChat: true });
  const orphan = await response(6);
  await assertNoCommand(() => reply(6, orphan, 409, "orphan request conflict"));
  await sql(`UPDATE chats SET model_id=NULL WHERE id=${literal(chat)}`);
  await assertNoCommand(() =>
    reply(1, visible, 500, "missing legacy selected model"),
  );
  await sql(
    `UPDATE chats SET model_id='inventory-provider-model-1' WHERE id=${literal(chat)}`,
  );
  await sql(
    "UPDATE model_routes SET enabled=false WHERE model_id='inventory-provider-model-1'",
  );
  await assertNoCommand(() =>
    reply(1, visible, 500, "selected legacy model has no enabled runtime"),
  );
  await sql(
    "UPDATE model_routes SET enabled=true WHERE model_id='inventory-provider-model-1'",
  );
  let resolved = await reply(1, visible);
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.response, visible.response);
  await durable(1, "legacy visible acknowledged");
  resolved = await reply(2, protectedReply);
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(
    resolved.protectedResponse,
    protectedReply.protectedResponse,
  );
  await durable(2, "legacy protected acknowledged");
  await sql(`UPDATE chats SET model_id=NULL WHERE id=${literal(chat)}`);
  await assertNoCommand(async () => {
    await reply(1, visible, 200, "visible replay without model");
    await reply(2, protectedReply, 200, "opaque replay without model");
    const alternate = await response(2, true, "fileChange", ":alternate");
    alternate.idempotencyKey = protectedReply.idempotencyKey;
    const replay = await reply(
      2,
      alternate,
      200,
      "same key different opaque response replay",
    );
    assert.deepEqual(
      replay.protectedResponse,
      protectedReply.protectedResponse,
    );
    await reply(
      1,
      { ...visible, idempotencyKey: "other" },
      409,
      "visible replay key conflict",
    );
    await reply(
      2,
      { ...protectedReply, idempotencyKey: "other" },
      409,
      "opaque replay key conflict",
    );
  });
  await sql(
    `UPDATE chats SET model_id='inventory-provider-model-1' WHERE id=${literal(chat)}`,
  );
  for (const [n, mode] of [
    [7, "error"],
    [8, "invalid"],
  ]) {
    await seed(n);
    c.setMode(mode);
    await reply(n, await response(n), 409, `worker ${mode}`);
    assert.equal(
      (await durable(n, `worker ${mode} leaves pending`)).status,
      "pending",
    );
  }
  c.setMode("normal");

  await seed(22, {
    computer: true,
    protected: true,
    kind: "permissions",
    status: "interrupted",
  });
  await assertNoCommand(async () => {
    await reply(
      22,
      await response(22, true, "permissions"),
      409,
      "terminal computer-use approval",
    );
    await seed(23, { computer: true, kind: "permissions" });
    assert.deepEqual(
      await reply(
        23,
        await response(23, false, "permissions"),
        409,
        "visible computer-use approval",
      ),
      { error: "Computer-use approvals require a protected response." },
    );
  });

  // Native activation bypasses the legacy model lookup and uses the same lane.
  await sql(
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,state,runtime_session_id,codex_thread_id) VALUES(${literal(lane)},${literal(chat)},${literal(tree)},${literal(worker)},'agent','active','settings-runtime','thread')`,
    `UPDATE chats SET model_id=NULL WHERE id=${literal(chat)}`,
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,activation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,status) VALUES('interaction-native-operation',${literal(h.owner)},${literal(worker)},${literal(chat)},'interaction-operation-generation','interaction-activation',${literal(lane)},'gui','turn/start','start','${"a".repeat(64)}','{}',${json({ runtimeGeneration: "interaction-runtime" })},'{}','applied')`,
    `INSERT INTO native_command_activations(chat_id,generation,operation_id,execution_lane_id,worker_id,runtime_generation,active) VALUES(${literal(chat)},'interaction-activation','interaction-native-operation',${literal(lane)},${literal(worker)},'interaction-runtime',true)`,
  );
  await seed(9);
  await reply(9, await response(9), 409, "stale execution lane");
  for (const n of [10, 11]) {
    await seed(n, { lane, protected: n === 11 });
    const value = await reply(n, await response(n, n === 11));
    assert.equal(value.status, "resolved");
    const command = result.commands.at(-1);
    assert.equal(command.type, "chat.native-control");
    assert.equal(command.nativeActivationGeneration, "interaction-activation");
    assert.equal(command.nativeRuntimeGeneration, "interaction-runtime");
    await durable(n, "native reply " + n);
  }
  await seed(12, { lane });
  const held = c.hold(),
    pending = reply(
      12,
      await response(12),
      200,
      "accepted reply concurrent winner",
    );
  await c.waitHeld();
  await sql(
    `UPDATE agent_interaction_requests SET status='resolved',response=${json({ kind: "fileChange", decision: "decline" })},resolution_idempotency_key='concurrent-winner',resolved_by_user_id=${literal(h.owner)},resolved_at=${literal(stamp)} WHERE id=${literal(id(12))}`,
  );
  held.release();
  assert.deepEqual((await pending).response, {
    kind: "fileChange",
    decision: "decline",
  });
  c.setMode("normal");
  await durable(12, "accepted native preserves concurrent winner");

  // Current computer-use authority is required even for a durable replay.
  await sql(
    `UPDATE user_settings SET computer_use_enabled=true WHERE user_id=${literal(h.owner)}`,
  );
  for (const [n, activeLane] of [
    [13, null],
    [14, lane],
  ]) {
    await seed(n, {
      computer: true,
      protected: true,
      kind: "permissions",
      lane: activeLane,
    });
    const body = await response(n, true, "permissions"),
      before = result.commands.length;
    const value = await reply(n, body);
    assert.equal(value.status, "resolved");
    assert.equal(result.commands.length, before + 1);
    const command = result.commands.at(-1);
    assert.equal(command.type, "computer-use.approval.respond");
    assert.equal(command.ownerId, h.fixture.normalize(h.owner));
    assert.equal(command.executionLaneId, activeLane);
    assert.equal(
      command[activeLane ? "agentAuthority" : "previewAuthority"].chatId,
      chat,
    );
    await assertNoCommand(() =>
      reply(n, body, 200, `computer-use replay ${n}`),
    );
    await sql(
      `UPDATE user_settings SET computer_use_enabled=false WHERE user_id=${literal(h.owner)}`,
    );
    await assertNoCommand(() =>
      reply(n, body, 503, `computer-use disabled replay ${n}`),
    );
    await sql(
      `UPDATE user_settings SET computer_use_enabled=true WHERE user_id=${literal(h.owner)}`,
    );
    await durable(n, "computer-use acknowledged " + n);
  }
  for (const [n, mode] of [
    [15, "error"],
    [16, "invalid"],
  ]) {
    await seed(n, { computer: true, protected: true, kind: "permissions" });
    c.setMode(mode);
    assert.deepEqual(
      await reply(
        n,
        await response(n, true, "permissions"),
        409,
        `computer-use worker ${mode}`,
      ),
      { error: "The worker no longer accepts this computer-use approval." },
    );
    assert.equal(
      (await durable(n, "computer-use failure " + n)).status,
      "pending",
    );
  }
  c.setMode("normal");

  // Two actual outstanding RPCs exhaust the configured worker concurrency.
  for (const n of [25, 26, 28]) await seed(n, { lane });
  await seed(29, { computer: true, protected: true, kind: "permissions" });
  const limited = c.hold(),
    firstLimitBody = await response(25),
    firstLimit = reply(25, firstLimitBody, 200, "first held worker reply");
  await c.waitHeld(1);
  const secondLimit = reply(
    26,
    await response(26),
    200,
    "second held worker reply",
  );
  await c.waitHeld(2);
  await reply(
    28,
    await response(28),
    429,
    "normal reply preserves relay limit status",
  );
  // Computer-use approvals use the ordinary lane. Held native replies exhaust
  // only the control lane, so this independent acknowledgement must complete.
  c.setMode("normal");
  const independentBody = await response(29, true, "permissions");
  const independent = await reply(
    29,
    independentBody,
    200,
    "computer-use approval bypasses exhausted control lane",
  );
  assert.equal(independent.status, "resolved");
  assert.deepEqual(
    independent.protectedResponse,
    independentBody.protectedResponse,
  );
  // Source also completes independent replies in either order. Keep both
  // outstanding for the quota proof, then control each actual acknowledgment.
  limited.releaseOne(0);
  await firstLimit;
  limited.releaseOne(1);
  await secondLimit;
  c.setMode("normal");
  result.recovery.push({
    case: "concurrent-worker-limit",
    outstanding: 2,
    normalStatus: 429,
    computerUseStatus: 200,
    ordinaryLaneIndependent: true,
  });

  // Inject a real database failure after the worker has acknowledged.
  await seed(17, { lane });
  await seed(19, { computer: true, protected: true, kind: "permissions" });
  await sql(
    "CREATE FUNCTION fixture_interaction_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled interaction persistence failure'; END $$",
    `CREATE TRIGGER fixture_interaction_failure BEFORE UPDATE ON agent_interaction_requests FOR EACH ROW WHEN (NEW.id IN (${literal(id(17))},${literal(id(19))}) AND NEW.status='resolved') EXECUTE FUNCTION fixture_interaction_failure()`,
  );
  const failedBody = await response(17),
    beforeFailure = result.commands.length;
  await reply(
    17,
    failedBody,
    500,
    "persistence failure after worker acknowledgment",
  );
  assert.equal(result.commands.length, beforeFailure + 1);
  assert.equal(
    (await durable(17, "acknowledged persistence failure")).status,
    "pending",
  );
  const cuaFailureBody = await response(19, true, "permissions");
  assert.deepEqual(
    await reply(
      19,
      cuaFailureBody,
      503,
      "computer-use acknowledged persistence failure",
    ),
    { error: "The computer-use approval could not be resolved." },
  );
  assert.equal(
    (await durable(19, "computer-use SQL failure remains pending")).status,
    "pending",
  );
  await sql(
    "DROP TRIGGER fixture_interaction_failure ON agent_interaction_requests",
    "DROP FUNCTION fixture_interaction_failure()",
  );
  assert.equal(
    (await reply(17, failedBody, 200, "retry acknowledged persistence failure"))
      .status,
    "resolved",
  );
  assert.equal(
    (
      await reply(
        19,
        cuaFailureBody,
        200,
        "retry acknowledged computer-use persistence failure",
      )
    ).status,
    "resolved",
  );
  result.recovery.push({
    case: "worker-acknowledged-sql-failure",
    retainedPending: true,
    retryResolved: true,
  });

  await seed(18, { lane });
  const disconnectedBody = await response(18),
    disconnected = c.hold(),
    controller = new AbortController(),
    client = h.fixture.client(),
    abandoned = fetch(h.fixture.server.origin + respond(18), {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
      },
      body: JSON.stringify(disconnectedBody),
      signal: controller.signal,
    }).then(
      () => assert.fail("held reply unexpectedly completed"),
      (error) => error,
    );
  await c.waitHeld();
  controller.abort();
  assert.equal((await abandoned).name, "AbortError");
  disconnected.release();
  c.setMode("normal");
  await eventually(
    () => durable(18),
    (r) => assert.equal(r.status, "resolved"),
    15000,
  );
  result.recovery.push({
    case: "client-disconnected-after-worker-dispatch",
    resolved: true,
  });
  await barrier("interaction-after-disconnect");
  await reply(18, disconnectedBody, 200, "disconnected reply durable replay");
  await standaloneInteractionHttpCases(c);
  await seed(20, { lane });
  await seed(21, { computer: true, protected: true, kind: "permissions" });
  h.worker.close();
  await eventually(
    async () => {
      const client = h.fixture.client(),
        response = await fetch(h.fixture.server.origin + "/api/workers", {
          headers: {
            origin: "http://127.0.0.1:5173",
            cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          },
          signal: AbortSignal.timeout(15000),
        });
      assert.equal(response.status, 200);
      return (await response.json()).find((w) => w.workerId === worker).online;
    },
    (online) => assert.equal(online, false),
    15000,
  );
  await assertNoCommand(async () => {
    await reply(20, await response(20), 503, "native worker offline");
    assert.deepEqual(
      await reply(
        21,
        await response(21, true, "permissions"),
        503,
        "computer-use worker offline",
      ),
      { error: "The worker no longer accepts this computer-use approval." },
    );
    await reply(
      13,
      await response(13, true, "permissions"),
      200,
      "resolved computer-use replay offline",
    );
  });
  await barrier("interaction-before-restart");

  // Retire active work before restart; startup interrupts remaining pending
  // approvals, while durable resolved responses remain replayable offline.
  await sql(
    `UPDATE native_command_activations SET active=false WHERE chat_id=${literal(chat)}`,
    `UPDATE chat_execution_lanes SET state='released' WHERE id=${literal(lane)}`,
    `UPDATE chats SET status='idle' WHERE id=${literal(chat)}`,
  );
  h.worker.close();
  await h.live.close();
  await h.fixture.close();
  await h.fixture.start();
  await assertNoCommand(async () => {
    await reply(
      1,
      visible,
      200,
      "resolved visible survives server restart offline",
    );
    await reply(
      2,
      protectedReply,
      200,
      "resolved protected survives server restart offline",
    );
  });
  assert.equal(
    (await visit("pending approval interrupted at startup", "GET", item(7)))
      .status,
    "interrupted",
  );
  result.recovery.push({
    case: "restart-offline",
    resolvedVisible: true,
    resolvedProtected: true,
    pendingInterrupted: true,
  });
}
