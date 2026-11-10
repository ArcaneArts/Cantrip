import assert from "node:assert/strict";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, json } from "./project-target-state.mjs";
import {
  customizationId as id,
  customizationRoutes,
} from "./chat-customization-http-worker.mjs";
import { runBoundPermissionHttpCases } from "./chat-permission-bound-http-cases.mjs";
import { eventually } from "./full-worker.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import {
  runChatPlanHttpCases,
  runOfflineChatPlanHttpCases,
} from "./chat-plan-http-cases.mjs";

export async function runChatConfigurationHttpCases({
  h,
  result,
  profile,
  controller,
}) {
  const visit = h.visit,
    base = `/api/chats/${chat}`,
    permissions = base + "/permission-profiles",
    update = base + "/permission-profile",
    sql = (...statements) => h.fixture.sql(statements),
    choice = (name, value, status = 200) =>
      visit(name, "PATCH", update, { json: value, status });
  const initial = await visit(
    "initial permission capability",
    "GET",
    permissions,
  );
  assert.equal(initial.available, true);
  assert.ok(initial.profiles.some((p) => p.id === ":yolo"));
  for (const mode of ["error", "invalid", "unavailable", "denied"]) {
    controller.setProfileMode(mode);
    const value = await visit(
      `permission capability ${mode}`,
      "GET",
      permissions,
    );
    assert.equal(value.available, mode === "denied");
  }
  controller.setProfileMode("normal");
  await visit(
    "permission capability missing context",
    "GET",
    "/api/chats/missing/permission-profiles",
    { status: 404 },
  );
  await choice("invalid permission body", {}, 400);
  await choice(
    "invalid permission revision",
    { id: null, expectedRevision: "01" },
    400,
  );
  await choice("bound permission needs source", { id: ":workspace" }, 400);
  if (profile !== "none") {
    await visit("permission capability requires login", "GET", permissions, {
      client: "stranger",
      status: 401,
    });
    await visit("permission mutation requires CSRF", "PATCH", update, {
      csrf: false,
      json: { id: null },
      status: 403,
    });
  }
  if (profile === "accounts") {
    await visit("permission capability foreign context", "GET", permissions, {
      client: "other",
      status: 404,
    });
    await visit("permission mutation foreign context", "PATCH", update, {
      client: "other",
      json: { id: null },
      status: 404,
    });
  }
  await visit("reasoning state", "GET", base + "/reasoning");
  for (const query of [
    "modelId=inventory-provider-model-1",
    "modelId=%20inventory-provider-model-1%20",
    "modelId=",
    "extra=true",
  ])
    await visit(
      `reasoning query ${query}`,
      "GET",
      base + "/reasoning?" + query,
    );
  await visit(
    "reasoning duplicate model query",
    "GET",
    base + "/reasoning?modelId=a&modelId=b",
    { status: 409 },
  );
  await visit(
    "reasoning foreign model selection",
    "GET",
    base + "/reasoning?modelId=missing",
    { status: 409 },
  );
  await visit("invalid model body", "PATCH", base + "/model", {
    json: {},
    status: 400,
  });
  await visit("invalid reasoning body", "PATCH", base + "/reasoning", {
    json: {},
    status: 400,
  });
  await visit("unsupported reasoning effort", "PATCH", base + "/reasoning", {
    json: { reasoningEffort: "high" },
    status: 409,
  });
  const handoffSource = await visit(
    "model write fence source",
    "POST",
    base + "/native-settings/refresh",
  );
  await sql(
    `INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,phase,source,target_model_route_id) VALUES('configuration-handoff',${literal(h.owner)},${literal(chat)},${literal(worker)},'preparing',${json(handoffSource.binding)},'configuration-handoff-target')`,
  );
  for (const [path, body] of [
    ["model", { modelId: "inventory-provider-model-1" }],
    ["reasoning", { reasoningEffort: null }],
  ])
    await visit(
      `pending native handoff fences ${path} write`,
      "PATCH",
      base + "/" + path,
      { json: body, status: 409 },
    );
  await sql(
    "DELETE FROM native_runtime_handoffs WHERE operation_id='configuration-handoff'",
  );
  await sql(
    `UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id=${literal(chat)}`,
  );
  const durable = async (label) => {
    const [state] = await h.fixture.sql(
      [],
      [
        `SELECT jsonb_build_object('modelId',model_id,'reasoningEffort',reasoning_effort,'permissionProfileId',permission_profile_id,'status',status)::text result FROM chats WHERE id=${literal(chat)}`,
      ],
    );
    result.durable.push({ label, state });
    return state;
  };
  await visit("set legacy chat model", "PATCH", base + "/model", {
    json: { modelId: "inventory-provider-model-3", extra: true },
  });
  await durable("legacy model persisted");
  await visit("set default reasoning", "PATCH", base + "/reasoning", {
    json: { reasoningEffort: null },
  });
  await durable("reasoning persisted");
  await visit("missing model configuration", "PATCH", base + "/model", {
    json: { modelId: "missing" },
    status: 409,
  });
  await sql(`UPDATE chats SET model_id=NULL WHERE id=${literal(chat)}`);
  await visit("reasoning needs selected model", "GET", base + "/reasoning", {
    status: 409,
  });
  await sql(
    `UPDATE chats SET model_id='inventory-provider-model-1' WHERE id=${literal(chat)}`,
  );
  await choice(
    "unbound permission rejects stale source",
    { id: ":workspace", operationId: "stale" },
    409,
  );
  await choice("unadvertised permission profile", { id: "missing" }, 400);
  controller.setProfileMode("denied");
  await choice("advertised but denied permission", { id: ":yolo" }, 409);
  controller.setProfileMode("unavailable");
  await choice(
    "unavailable capability cannot authorize custom",
    { id: "custom" },
    400,
  );
  controller.setProfileMode("normal");
  let selected = await choice("unbound advertised custom permission", {
    id: "custom",
    extra: true,
  });
  assert.equal(selected.selectedId, "custom");
  assert.equal(selected.confirmed, false);
  assert.equal(selected.policyRevision, "0");
  await durable("custom permission persisted");
  await sql(
    `UPDATE projects SET worktree_policy='required-for-writes' WHERE id=${literal(project)}`,
  );
  selected = await choice("primary worktree policy forces readonly", {
    id: ":yolo",
  });
  assert.equal(selected.selectedId, ":yolo");
  assert.equal(selected.effectiveId, ":read-only");
  assert.equal(selected.forcedByWorktreePolicy, true);
  await sql(
    `UPDATE projects SET worktree_policy='agent-managed' WHERE id=${literal(project)}`,
  );
  await choice("unbound permission returns to default", { id: null });
  const capabilityGate = controller.holdProfiles(),
    replaced = choice(
      "native thread is created during capability read",
      { id: ":yolo" },
      409,
    );
  await eventually(
    () => capabilityGate.requested,
    (v) => assert.equal(v, true),
    15000,
  );
  await sql(
    `UPDATE chat_runtime_sessions SET codex_thread_id='thread' WHERE chat_id=${literal(chat)}`,
  );
  capabilityGate.release();
  assert.equal((await replaced).code, "permission-source-required");
  await sql(
    `UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id=${literal(chat)}`,
  );
  result.recovery.push({
    case: "native-source-created-during-capability-read",
    transactionRecheckedSource: true,
  });
  await sql(`UPDATE chats SET status='running' WHERE id=${literal(chat)}`);
  await choice(
    "unbound write rechecks actual execution",
    { id: ":workspace" },
    409,
  );
  await sql(`UPDATE chats SET status='idle' WHERE id=${literal(chat)}`);
  await sql(
    "CREATE FUNCTION fixture_permission_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled permission transaction failure'; END $$",
    `CREATE TRIGGER fixture_permission_failure BEFORE UPDATE OF permission_profile_id ON chats FOR EACH ROW WHEN (NEW.id=${literal(chat)}) EXECUTE FUNCTION fixture_permission_failure()`,
  );
  const before = await durable("before permission SQL failure");
  await choice("permission SQL failure is not committed", { id: ":yolo" }, 500);
  assert.deepEqual(await durable("after permission SQL failure"), before);
  await sql(
    "DROP TRIGGER fixture_permission_failure ON chats",
    "DROP FUNCTION fixture_permission_failure()",
  );
  await choice("permission SQL failure retry", { id: ":workspace" });
  result.recovery.push({
    case: "permission-sql-rollback",
    retainedBeforeRetry: true,
  });
  await sql(
    `UPDATE chat_runtime_sessions SET codex_thread_id='thread' WHERE chat_id=${literal(chat)}`,
  );
  await runBoundPermissionHttpCases({
    h,
    result,
    controller,
    base,
    permissions,
    choice,
    sql,
  });
  await runChatPlanHttpCases({ h, profile, controller });
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
    (v) => assert.equal(v, false),
    15000,
  );
  const offline = await visit(
    "permission capability offline",
    "GET",
    permissions,
  );
  await runOfflineChatPlanHttpCases({ h });
  assert.equal(offline.available, false);
  for (const [n, [method, path, operation]] of customizationRoutes.entries())
    await visit(
      `customization offline ${operation}`,
      method,
      base +
        "/" +
        path +
        (method === "GET" ? `?operationId=${id(200 + n)}` : ""),
      {
        ...(method === "GET"
          ? {}
          : {
              json: await controller.request(200 + n, operation, {
                workerId: worker,
                projectId: project,
                chatId: chat,
                providerId: "inventory-provider",
              }),
            }),
        status: 503,
      },
    );
  await visit(
    "customization target offline",
    "GET",
    base + "/customizations/target",
    { status: 503 },
  );
  await sql(
    `UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id=${literal(chat)}`,
  );
  await choice("offline unbound configurable permission", { id: ":read-only" });
  await choice("offline custom permission denied", { id: "custom" }, 400);
  await durable("retained permission before restart");
  const oldLive = h.live;
  await oldLive.close();
  await h.fixture.close();
  await h.fixture.start();
  h.live = await new LiveProbe(h.fixture).open();
  await h.live.initialized();
  h.live.history.unshift(...oldLive.history);
  await h.live.subscribed("configuration-after-restart", [
    { kind: "chat", chatId: chat },
  ]);
  const recovered = await visit(
    "retained permission after restart",
    "GET",
    permissions,
  );
  assert.equal(recovered.selectedId, ":read-only");
  await durable("retained permission after restart");
  result.recovery.push({
    case: "offline-permission-restart",
    retainedSelection: ":read-only",
  });
}
