import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";
import { protectedInteraction } from "./agent-interaction-fixtures.mjs";
import { additionalComputerUseCases } from "./computer-use-http-additional.mjs";
import { computerUseCallerLoss } from "./computer-use-caller-loss.mjs";
import { computerUseTimerCases } from "./computer-use-timer-cases.mjs";
import { computerUseContextCases } from "./computer-use-context-cases.mjs";
import { computerUseSqlTimeout } from "./computer-use-sql-timeout.mjs";
import { computerUseLimitCases } from "./computer-use-limit-cases.mjs";

import { id, input, opaque } from "./computer-use-http-fixtures.mjs";
export async function computerUseHttpCases({
  f,
  visit,
  worker,
  state,
  result,
  owner,
  timers,
  sqlTimeout,
  limits,
}) {
  const root = "/api/chats/chat/computer-use",
    open = root + "/preview",
    stop = open + "/stop",
    operation = root + "/operation";
  const reset = () => {
    for (const key of ["intercept", "events", "hold", "fail", "reply"])
      delete state[key];
  };
  const record = (name, value) => result.cases.push({ name, value });
  for (const body of [false, [], "text", { unknown: true }])
    await visit("invalid preview " + JSON.stringify(body), "POST", open, {
      status: 400,
      json: body,
    });
  await visit(
    "missing preview Chat",
    "POST",
    "/api/chats/missing/computer-use/preview",
    { status: 404, json: {} },
  );
  await visit(
    "foreign preview Chat",
    "POST",
    "/api/chats/other-chat/computer-use/preview",
    { status: 404, json: {} },
  );
  for (const [body, name] of [
    [{}, "empty object"],
    [null, "null"],
  ]) {
    const lease = await visit("preview " + name, "POST", open, { json: body });
    assert.equal(lease.workerId, "alpha");
    assert.equal(lease.chatId, "chat");
    record("preview command " + name, state.commands.at(-1));
  }
  for (const [body, status] of [
    [Buffer.alloc(0), 200],
    [Buffer.from([0]), 400],
  ])
    await visit("preview binary " + body.length, "POST", open, {
      status,
      raw: body,
      headers: { "content-type": "application/octet-stream" },
    });
  await visit("invalid Stop", "POST", stop, { status: 400, json: {} });
  await visit("foreign Stop worker", "POST", stop, {
    status: 404,
    json: { leaseId: id(3), workerId: "foreign" },
  });
  const stopped = await visit("owned Stop", "POST", stop, {
    json: { leaseId: id(3), workerId: "alpha" },
  });
  assert.deepEqual(stopped, { closed: true });
  await visit("invalid operation", "POST", operation, {
    status: 400,
    json: {},
  });
  const missingLease = input();
  delete missingLease.previewLeaseId;
  await visit("required preview lease", "POST", operation, {
    status: 400,
    json: missingLease,
  });
  await visit("wrong opaque domain", "POST", operation, {
    status: 400,
    json: {
      ...input(),
      protectedContent: { ...opaque(), domain: "chat-message-content" },
    },
  });
  await visit(
    "missing operation Chat",
    "POST",
    "/api/chats/missing/computer-use/operation",
    { status: 404, json: input() },
  );
  state.events = (command) =>
    [0, 1].map((sequence) => ({
      type: "computer-use.snapshot.chunk",
      operationId: command.request.operationId,
      sequence,
      protectedContent: opaque(),
    }));
  const snapshot = await visit("opaque snapshot", "POST", operation, {
    json: input(),
  });
  assert.equal(snapshot.chunks.length, 2);
  record("snapshot routing", state.commands.at(-1));
  state.events = (command) => [
    {
      type: "computer-use.snapshot.chunk",
      operationId: command.request.operationId,
      sequence: 1,
      protectedContent: opaque(),
    },
  ];
  await visit("out of order snapshot", "POST", operation, {
    status: 502,
    json: input(2),
  });
  reset();
  state.reply = { operationId: id(99), protectedContent: opaque() };
  await visit("wrong operation reply", "POST", operation, {
    status: 502,
    json: input(4),
  });
  reset();
  state.fail = true;
  await visit("private worker failure", "POST", operation, {
    status: 502,
    json: input(5),
  });
  await visit("failed preview", "POST", open, { status: 502, json: {} });
  await visit("failed Stop", "POST", stop, {
    status: 409,
    json: { leaseId: id(3), workerId: "alpha" },
  });
  reset();
  await f.sql([
    `UPDATE user_settings SET computer_use_enabled=false WHERE user_id=${literal(owner)}`,
  ]);
  await visit("disabled preview", "POST", open, { status: 403, json: {} });
  await visit("disabled operation", "POST", operation, {
    status: 403,
    json: input(6),
  });
  await visit(
    "close still requires current preview authority",
    "POST",
    operation,
    { status: 403, json: input(7, "session.close") },
  );
  await visit("Stop after policy revocation", "POST", stop, {
    json: { leaseId: id(3), workerId: "alpha" },
  });
  await f.sql([
    `UPDATE user_settings SET computer_use_enabled=true WHERE user_id=${literal(owner)}`,
  ]);
  const approval = (command, key) => ({
    type: "computer-use.approval.request",
    operationId: command.request.operationId,
    request: protectedInteraction(key, {
      projectId: "github",
      provenance: {
        owner: "computer-use",
        chatId: "chat",
        workerId: "alpha",
        executionLaneId: null,
        threadId: null,
        turnId: null,
        itemId: null,
      },
      classification: { kind: "permissions" },
    }),
  });
  const terminal = (key) => ({
    type: "computer-use.approval.terminal",
    chatId: "chat",
    requestKey: key,
    status: "interrupted",
  });
  for (const coordinated of [false, true]) {
    const key = id(coordinated ? 21 : 20);
    state.intercept = async () => {
      if (coordinated) {
        worker.notify(terminal(key));
        await delay(25);
      }
    };
    state.events = (command) =>
      coordinated
        ? [approval(command, key)]
        : [approval(command, key), terminal(key)];
    await visit("approval terminal " + coordinated, "POST", operation, {
      json: input(coordinated ? 11 : 10, "input.click"),
    });
    let saved;
    await eventually(
      async () => {
        [saved] = await f.sql(
          [],
          [
            `SELECT jsonb_build_object('status',status,'chat',chat_id,'worker',worker_id,'owner',interaction_owner)::text result FROM agent_interaction_requests WHERE request_key=${literal(key)}`,
          ],
        );
        return saved;
      },
      (row) => assert.equal(row?.status, "interrupted"),
    );
    record("durable terminal after approval " + coordinated, saved);
    reset();
  }
  for (const route of [
    operation,
    open,
    stop,
    "/api/internal/computer-use/authority",
  ])
    await visit("unsupported GET " + route, "GET", route, { status: 404 });
  await additionalComputerUseCases({ f, visit, state, worker, result, owner });
  await computerUseCallerLoss({ f, state, worker, result });
  await computerUseContextCases({ f, state, visit, worker, result, owner });
  if (limits) await computerUseLimitCases({ state, visit, result });
  if (timers) await computerUseTimerCases({ state, visit, result });
  if (sqlTimeout)
    await computerUseSqlTimeout({ f, state, worker, result, visit });
  worker.close();
  await eventually(
    () => state.disconnects,
    (n) => assert.ok(n >= 1),
  );
  await visit("offline preview", "POST", open, { status: 503, json: {} });
  await visit("offline Stop", "POST", stop, {
    status: 503,
    json: { leaseId: id(3), workerId: "alpha" },
  });
  await visit("offline operation", "POST", operation, {
    status: 502,
    json: input(13),
  });
}
