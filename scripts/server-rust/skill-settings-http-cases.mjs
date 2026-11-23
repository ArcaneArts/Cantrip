import assert from "node:assert/strict";
import {
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  skillSettingsRoutes as routes,
  skillSettingsId as id,
  skillSettingsMarker as marker,
  skillSettingsAudienceKey as key,
} from "./skill-settings-http-worker.mjs";
import { runSkillAudienceHttpCases } from "./skill-audience-http-cases.mjs";
import { literal, json } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
import { LiveProbe } from "./live-sockets.mjs";

export async function runSkillSettingsHttpCases({
  h,
  result,
  profile,
  controller: c,
}) {
  const context = {
      workerId: worker,
      providerId: "inventory-provider",
      projectId: null,
    },
    scope = (value) => ({ ...value, chatId: null }),
    sql = (...s) => h.fixture.sql(s),
    listing = (n, value = context) =>
      "/api/skills?" +
      new URLSearchParams({
        workerId: value.workerId,
        providerId: value.providerId,
        ...(value.projectId ? { projectId: value.projectId } : {}),
        operationId: id(n),
      });
  async function call(
    n,
    index,
    { target = context, status = 200, name, failed = false, ...options } = {},
  ) {
    const [method, path, operation, schema] = routes[index];
    const body =
      method === "GET"
        ? undefined
        : await c.request(n, operation, scope(target));
    const raw = await h.visit(
      name ?? `${operation} ${n}`,
      method,
      method === "GET" ? listing(n, target) : path,
      { ...(body ? { json: body } : {}), status, ...options },
    );
    if (status < 300) {
      const opened = await c.open(raw, schema);
      assert.equal(opened.status, failed ? "failed" : "succeeded");
      if (failed) assert.equal(opened.error.message, marker);
    }
    return { raw, body };
  }
  const audiences = await runSkillAudienceHttpCases({ h, result, profile });
  for (const [offset, target] of [
    [0, context],
    [10, { ...context, projectId: project }],
  ])
    for (const index of routes.keys())
      await call(1 + offset + index, index, { target });
  const unrouted = { ...context, providerId: "unrouted-provider" };
  for (const index of [0, 1, 2, 3]) {
    await call(16 + index, index, { target: unrouted });
    assert.equal(Object.hasOwn(result.commands.at(-1), "model"), false);
    assert.equal(Object.hasOwn(result.commands.at(-1), "provider"), false);
  }
  await call(20, 4, {
    target: unrouted,
    status: 409,
    name: "configuration alone requires a configured model route",
  });
  for (const query of [
    "",
    "workerId=" + worker,
    "workerId=&providerId=inventory-provider",
    "workerId=a&workerId=b&providerId=inventory-provider",
    "workerId=" + worker + "&providerId=inventory-provider&projectId=",
  ])
    await h.visit(
      "invalid skills context " + query,
      "GET",
      "/api/skills?" + query,
      { status: 400 },
    );
  for (const query of ["", "invalid", `${id(20)}&operationId=${id(21)}`, "%FF"])
    await h.visit(
      "invalid skills operation " + query,
      "GET",
      `/api/skills?workerId=${worker}&providerId=inventory-provider&operationId=${query}`,
      { status: 400 },
    );
  const extra = await h.visit(
    "list ignores unknown query fields",
    "GET",
    listing(22) + "&extra=true",
  );
  await c.open(extra, routes[0][3]);
  for (const [n, target] of [
    [23, { ...context, providerId: "missing" }],
    [24, { ...context, workerId: "missing" }],
    [25, { ...context, projectId: "missing" }],
  ])
    await call(n, 0, { target, status: 404 });
  await call(26, 0, {
    target: { ...context, workerId: audiences.otherWorker },
    status: 503,
  });
  await sql(
    `INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES('skill-settings-other-source',${literal(project)},${literal(audiences.otherWorker)},'/fixture/skill-settings-other','/fixture/skill-settings-other')`,
    `UPDATE project_worktrees SET project_source_id='skill-settings-other-source',worker_id=${literal(audiences.otherWorker)} WHERE id=${literal(tree)}`,
  );
  const unavailableSource = await call(27, 0, {
    target: { ...context, projectId: project },
    status: 404,
  });
  assert.deepEqual(unavailableSource.raw, {
    error: "Project source not found.",
  });
  await sql(
    `UPDATE project_worktrees SET project_source_id='settings-source',worker_id=${literal(worker)} WHERE id=${literal(tree)}`,
    `UPDATE project_worktrees SET lifecycle_state='removing' WHERE id=${literal(tree)}`,
  );
  await call(28, 0, {
    target: { ...context, projectId: project },
    status: 404,
  });
  await sql(
    `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id=${literal(tree)}`,
  );
  if (profile !== "none") {
    await call(29, 0, { client: "stranger", status: 401 });
    await call(30, 2, { csrf: false, status: 403 });
  }
  if (profile === "accounts")
    for (const index of routes.keys())
      await call(31 + index, index, { client: "other", status: 404 });

  for (const body of [{}, null, { operationId: id(40) }])
    await h.visit(
      "invalid protected settings " + JSON.stringify(body),
      "POST",
      "/api/skills/read",
      { json: body, status: 409 },
    );
  const protectedRead = await c.request(
    41,
    "skills.settings.read",
    scope(context),
  );
  for (const [name, body] of [
    [
      "wrong operation",
      { ...protectedRead, operation: "skills.settings.write" },
    ],
    ["unknown protected field", { ...protectedRead, extra: true }],
    [
      "chat scope invalid for settings",
      { ...protectedRead, scope: { ...protectedRead.scope, chatId: "chat" } },
    ],
    [
      "null provider invalid for settings",
      { ...protectedRead, scope: { ...protectedRead.scope, providerId: null } },
    ],
  ])
    await h.visit(name, "POST", "/api/skills/read", {
      json: body,
      status: 409,
    });
  for (const raw of [Buffer.from("{}"), Buffer.alloc(0)])
    await h.visit(
      "settings Buffer body " + raw.length,
      "POST",
      "/api/skills/read",
      {
        raw,
        headers: { "content-type": "application/octet-stream" },
        status: 409,
      },
    );
  await h.visit("settings malformed JSON", "POST", "/api/skills/read", {
    raw: "{",
    headers: { "content-type": "application/json" },
    status: 400,
  });
  const [savedRoutes] = await h.fixture.sql(
    [],
    [
      "SELECT jsonb_agg(jsonb_build_object('id',id,'enabled',enabled))::text result FROM model_routes WHERE provider_id='inventory-provider'",
    ],
  );
  await sql(
    "UPDATE model_routes SET enabled=false WHERE provider_id='inventory-provider'",
  );
  await call(42, 0, {
    name: "settings list retains disabled configured runtime",
  });
  assert.ok(result.commands.at(-1).model);
  await call(43, 4, {
    name: "settings configure retains disabled configured runtime",
  });
  await sql(
    `UPDATE model_routes r SET enabled=s.enabled FROM jsonb_to_recordset(${json(savedRoutes)}) s(id text,enabled boolean) WHERE r.id=s.id`,
  );
  for (const [n, mode] of [
    [50, "rpc-error"],
    [52, "invalid"],
    [54, "wrong-id"],
    [56, "wrong-operation"],
    [58, "wrong-scope"],
  ]) {
    c.setMode(mode);
    await call(n, 0, { status: 502, name: "list worker " + mode });
    await call(n + 1, 1, { status: 409, name: "mutation worker " + mode });
  }
  c.setMode("failed");
  for (const index of routes.keys())
    await call(60 + index, index, { failed: true });
  c.setMode("normal");
  const beforeTamper = result.nativeCalls.length;
  await h.visit(
    "worker authenticates settings before IO",
    "PUT",
    "/api/skills/file",
    {
      json: await c.request(69, "skills.settings.write", scope(context), {
        tamper: true,
      }),
      status: 409,
    },
  );
  assert.equal(result.nativeCalls.length, beforeTamper);
  const repeated = await call(70, 2),
    beforeReplay = result.nativeCalls.length;
  await h.visit(
    "settings mutation replay stays worker-owned",
    "PUT",
    "/api/skills/file",
    { json: repeated.body, status: 409 },
  );
  assert.equal(result.nativeCalls.length, beforeReplay);
  const read1 = await call(71, 1),
    read2 = await call(71, 1);
  assert.notEqual(
    read1.raw.protectedResponse.envelope.nonce,
    read2.raw.protectedResponse.envelope.nonce,
  );
  const limited = c.hold(),
    first = call(72, 0);
  await eventually(
    () => limited.requests,
    (n) => assert.equal(n, 1),
    15000,
  );
  const second = call(73, 0);
  await eventually(
    () => limited.requests,
    (n) => assert.equal(n, 2),
    15000,
  );
  const beforeLimit = result.commands.length;
  await call(74, 0, {
    status: 502,
    name: "settings list relay limit retains502",
  });
  await call(75, 2, {
    status: 409,
    name: "settings mutation relay limit retains409",
  });
  await h.visit(
    "audiences do not require worker RPC capacity",
    "GET",
    audiences.route(),
  );
  assert.equal(result.commands.length, beforeLimit);
  limited.releaseOne(0);
  await first;
  limited.releaseOne(1);
  await second;
  c.setMode("normal");
  result.recovery.push({
    case: "actual-worker-concurrency-limit",
    listStatus: 502,
    mutationStatus: 409,
  });
  const held = c.hold(),
    pending = call(80, 2, { target: { ...context, projectId: project } });
  await eventually(
    () => held.requests,
    (n) => assert.equal(n, 1),
    15000,
  );
  await sql(
    `UPDATE project_worktrees SET absolute_path='/worker-owned/changed-settings' WHERE id=${literal(tree)}`,
  );
  held.release();
  await pending;
  c.setMode("normal");
  await call(81, 0, { target: { ...context, projectId: project } });
  assert.equal(result.commands.at(-1).cwd, "/worker-owned/changed-settings");
  await sql(
    `UPDATE project_worktrees SET absolute_path='/worker-owned/settings' WHERE id=${literal(tree)}`,
  );
  result.recovery.push({
    case: "captured-settings-context-during-worker-request",
    verified: true,
  });
  await h.live.subscribed("before-skill-settings-disconnect", [
    { kind: "current-user" },
    { kind: "project", projectId: project },
  ]);
  const count = h.live.history.filter(
      (e) => e.type === "event" && e.resource === "customization",
    ).length,
    gate = c.hold(),
    abort = new AbortController(),
    client = h.fixture.client();
  const abandoned = fetch(h.fixture.server.origin + "/api/skills/file", {
    method: "PUT",
    headers: {
      origin: "http://127.0.0.1:5173",
      "content-type": "application/json",
      cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
    },
    body: JSON.stringify(
      await c.request(82, "skills.settings.write", scope(context)),
    ),
    signal: abort.signal,
  }).then(
    () => assert.fail("held settings unexpectedly completed"),
    (error) => error,
  );
  await eventually(
    () => gate.requests,
    (n) => assert.equal(n, 1),
    15000,
  );
  abort.abort();
  assert.equal((await abandoned).name, "AbortError");
  gate.release();
  c.setMode("normal");
  await eventually(
    () =>
      h.live.history.filter(
        (e) => e.type === "event" && e.resource === "customization",
      ).length,
    (n) => assert.equal(n, count + 1),
    15000,
  );
  result.recovery.push({
    case: "disconnected-client-settings-write",
    invalidated: true,
  });
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
  for (const index of routes.keys())
    await call(90 + index, index, { status: 503 });
  await audiences.update("offline audience update still succeeds", {
    ...audiences.context,
    audienceKey: key(61),
    audience: "both",
  });
  const saved = await h.visit(
    "offline audience state",
    "GET",
    audiences.route(),
  );
  await audiences.durable("before actual server restart");
  const history = h.live.history.slice(),
    port = Number(new URL(h.fixture.server.origin).port);
  h.live.close();
  await h.fixture.close();
  await h.fixture.start({ port });
  h.live = await new LiveProbe(h.fixture).open();
  await h.live.initialized();
  h.live.history.unshift(...history);
  assert.deepEqual(
    await h.visit(
      "audiences retained across server restart",
      "GET",
      audiences.route(),
    ),
    saved,
  );
  await audiences.durable("after actual server restart");
  result.recovery.push({
    case: "offline-audiences-and-server-restart",
    retained: true,
  });
}
