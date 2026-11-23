import assert from "node:assert/strict";
import {
  customizationRoutes as routes,
  customizationId as id,
  customizationMarker as marker,
} from "./chat-customization-http-worker.mjs";
import { settingsChat as chat } from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";

export async function runChatCustomizationHttpCases({
  h,
  result,
  profile,
  controller: worker,
}) {
  const base = `/api/chats/${chat}/`,
    visit = h.visit,
    scope = await visit(
      "customization target",
      "GET",
      base + "customizations/target",
    );
  assert.deepEqual(scope, {
    workerId: h.scope.workerId,
    projectId: h.scope.projectId,
    chatId: chat,
    providerId: "inventory-provider",
  });
  async function call(n, row, options = {}) {
    const [method, path, operation, schema] = row,
      input =
        method === "GET" ? null : await worker.request(n, operation, scope),
      route = base + path + (method === "GET" ? `?operationId=${id(n)}` : "");
    const response = await visit(
      options.name ?? `${operation} ${n}`,
      method,
      route,
      {
        ...(input ? { json: input } : {}),
        status: operation === "customization.external.apply" ? 202 : 200,
        ...options,
      },
    );
    if ((options.status ?? 200) < 300 && method !== "HEAD") {
      const opened = await worker.open(response, schema);
      assert.equal(opened.status, options.failed ? "failed" : "succeeded");
      if (options.failed) assert.equal(opened.error.message, marker);
    }
    return { response, input };
  }
  await visit(
    "target ignores malformed operation query",
    "GET",
    base + "customizations/target?operationId=invalid",
  );
  for (const path of [
    "skills",
    "customizations",
    "customizations/external-preview",
  ])
    for (const query of [
      "",
      "?operationId=invalid",
      `?operationId=${id(1)}&operationId=${id(2)}`,
      "?operationId=%FF",
    ])
      await visit(
        `operation identity ${path} ${query}`,
        "GET",
        base + path + query,
        { status: 400 },
      );
  if (profile !== "none") {
    await visit(
      "customization requires login",
      "GET",
      base + "customizations/target",
      { client: "stranger", status: 401 },
    );
    await visit(
      "customization mutation requires CSRF",
      "PATCH",
      base + "customizations/skill",
      {
        csrf: false,
        json: await worker.request(90, "customization.skill.configure", scope),
        status: 403,
      },
    );
  }
  if (profile === "accounts") {
    await visit(
      "foreign customization target",
      "GET",
      base + "customizations/target",
      { client: "other", status: 404 },
    );
    await visit(
      "foreign customization mutation",
      "PATCH",
      base + "customizations/skill",
      {
        client: "other",
        json: await worker.request(91, "customization.skill.configure", scope),
        status: 404,
      },
    );
  }
  for (const [index, row] of routes.entries()) await call(index + 1, row);
  for (const [n, suffix, expected] of [
    [30, "true", true],
    [31, "false", false],
    [32, "1", false],
    [33, "true&refresh=true", false],
  ]) {
    const wire = await visit(
      `inventory refresh ${suffix}`,
      "GET",
      base + `customizations?operationId=${id(n)}&refresh=${suffix}`,
    );
    await worker.open(wire, routes[1][3]);
    assert.equal(result.commands.at(-1).forceReload, expected);
  }
  for (const [n, body] of [
    [40, {}],
    [41, null],
    [42, { operationId: id(42) }],
  ])
    await visit(
      `invalid protected customization ${n}`,
      "PATCH",
      base + "customizations/skill",
      { json: body, status: 400 },
    );
  const wrong = await worker.request(
    43,
    "customization.skill.configure",
    scope,
  );
  await visit(
    "wrong protected operation",
    "POST",
    base + "customizations/mcp-reload",
    { json: wrong, status: 400 },
  );
  await visit(
    "strict protected request fields",
    "PATCH",
    base + "customizations/skill",
    { json: { ...wrong, extra: true }, status: 400 },
  );
  await visit(
    "scope changed before worker invocation",
    "PATCH",
    base + "customizations/skill",
    {
      json: { ...wrong, scope: { ...scope, providerId: "other" } },
      status: 409,
    },
  );
  for (const raw of [Buffer.from("{}"), Buffer.alloc(0)])
    await visit(
      `customization Buffer body ${raw.length}`,
      "PATCH",
      base + "customizations/skill",
      {
        raw,
        headers: { "content-type": "application/octet-stream" },
        status: 400,
      },
    );
  await visit(
    "customization malformed JSON",
    "PATCH",
    base + "customizations/skill",
    { raw: "{", headers: { "content-type": "application/json" }, status: 400 },
  );
  const before = result.commands.length;
  await visit(
    "missing context follows operation validation",
    "GET",
    "/api/chats/missing/skills",
    { status: 400 },
  );
  await visit(
    "missing customization context",
    "GET",
    `/api/chats/missing/skills?operationId=${id(44)}`,
    { status: 404 },
  );
  assert.equal(result.commands.length, before);
  await h.fixture.sql([
    `UPDATE chats SET model_id=NULL WHERE id=${literal(chat)}`,
  ]);
  await visit(
    "target model selection error remains outside worker catch",
    "GET",
    base + "customizations/target",
    { status: 500 },
  );
  await visit(
    "skills model selection error uses worker failure response",
    "GET",
    base + `skills?operationId=${id(45)}`,
    { status: 502 },
  );
  await h.fixture.sql([
    `UPDATE chats SET model_id='inventory-provider-model-1' WHERE id=${literal(chat)}`,
  ]);
  for (const [n, mode] of [
    [50, "rpc-error"],
    [51, "invalid"],
    [52, "wrong-id"],
    [53, "wrong-operation"],
    [54, "wrong-scope"],
  ]) {
    worker.setMode(mode);
    await call(n, routes[0], {
      status: 502,
      name: `customization worker ${mode}`,
    });
  }
  worker.setMode("failed");
  for (const [n, index] of [
    [60, 4],
    [61, 5],
    [62, 8],
  ])
    await call(n, routes[index], { failed: true });
  worker.setMode("normal");
  const beforeTamper = result.runtimeCalls.length;
  await visit(
    "worker authenticates opaque mutation before native IO",
    "PATCH",
    base + "customizations/skill",
    {
      json: await worker.request(69, "customization.skill.configure", scope, {
        tamper: true,
      }),
      status: 502,
    },
  );
  assert.equal(result.runtimeCalls.length, beforeTamper);
  const repeated = await call(70, routes[4]),
    nativeCalls = result.runtimeCalls.length;
  await visit(
    "mutating operation replay is owned by unchanged worker",
    "PATCH",
    base + "customizations/skill",
    { json: repeated.input, status: 502 },
  );
  assert.equal(
    result.runtimeCalls.length,
    nativeCalls,
    "worker replay guard prevents another native mutation",
  );
  const firstRead = await call(71, routes[0]),
    secondRead = await call(71, routes[0]);
  assert.notEqual(
    firstRead.response.protectedResponse.envelope.nonce,
    secondRead.response.protectedResponse.envelope.nonce,
  );
  const held = worker.hold(),
    pending = call(80, routes[4]);
  await eventually(
    () => held.requested,
    (v) => assert.equal(v, true),
    15000,
  );
  // Source captures scope before dispatch and validates the reply against that
  // captured scope. An unrelated routing change must not rewrite its authority.
  await h.fixture.sql([
    `UPDATE chats SET model_id='customization-other-provider-model-1' WHERE id=${literal(chat)}`,
  ]);
  held.release();
  await pending;
  worker.setMode("normal");
  const changed = await visit(
    "current customization scope changes",
    "GET",
    base + "customizations/target",
  );
  assert.equal(changed.providerId, "customization-other-provider");
  await visit(
    "old scope cannot begin another operation",
    "PATCH",
    base + "customizations/skill",
    {
      json: await worker.request(81, "customization.skill.configure", scope),
      status: 409,
    },
  );
  await h.fixture.sql([
    `UPDATE chats SET model_id='inventory-provider-model-1' WHERE id=${literal(chat)}`,
  ]);
  result.recovery.push({
    case: "scope-captured-before-native-io",
    oldReplyAccepted: true,
    staleNextRequestRejected: true,
  });
  await h.live.subscribed("before-customization-disconnect", [
    { kind: "chat", chatId: chat },
  ]);
  const count = h.live.history.filter(
      (e) => e.type === "event" && e.resource === "customization",
    ).length,
    abandonedGate = worker.hold(),
    body = await worker.request(82, "customization.skill.configure", scope),
    abort = new AbortController(),
    client = h.fixture.client(),
    abandoned = fetch(h.fixture.server.origin + base + "customizations/skill", {
      method: "PATCH",
      headers: {
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    }).then(
      () => assert.fail("held customization unexpectedly completed"),
      (error) => error,
    );
  await eventually(
    () => abandonedGate.requested,
    (v) => assert.equal(v, true),
    15000,
  );
  abort.abort();
  assert.equal((await abandoned).name, "AbortError");
  abandonedGate.release();
  worker.setMode("normal");
  await eventually(
    () =>
      h.live.history.filter(
        (e) => e.type === "event" && e.resource === "customization",
      ).length,
    (n) => assert.equal(n, count + 1),
    15000,
  );
  result.recovery.push({
    case: "client-disconnected-during-native-customization",
    invalidated: true,
  });
  const limited = worker.hold(),
    firstLimit = call(83, routes[0]);
  await eventually(
    () => limited.requests,
    (n) => assert.equal(n, 1),
    15000,
  );
  const secondLimit = call(84, routes[0]);
  await eventually(
    () => limited.requests,
    (n) => assert.equal(n, 2),
    15000,
  );
  const beforeLimit = result.commands.length;
  await visit(
    "customization worker relay concurrency limit",
    "PATCH",
    base + "customizations/skill",
    {
      json: await worker.request(85, "customization.skill.configure", scope),
      status: 429,
    },
  );
  const unavailable = await visit(
    "permission capability catches relay limit",
    "GET",
    base + "permission-profiles",
  );
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /^Permission profiles are unavailable: /u);
  assert.equal(
    result.commands.length,
    beforeLimit,
    "relay-rejected commands never reach the worker",
  );
  limited.releaseOne(0);
  await firstLimit;
  limited.releaseOne(1);
  await secondLimit;
  worker.setMode("normal");
  result.recovery.push({
    case: "worker-concurrency-limit",
    customizationStatus: 429,
    permissionCapabilityFallback: true,
  });
}
