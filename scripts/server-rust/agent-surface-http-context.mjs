import assert from "node:assert/strict";
import { verifiedSurfaceQueryFailure } from "./agent-surface-http-text.mjs";
import { literal } from "./project-target-state.mjs";
import {
  operations,
  readOperations,
  lane,
  interaction,
} from "./agent-surface-http-fixtures.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const eventResources = new Set([
  "explorer",
  "terminal",
  "browser",
  "agent-interaction",
]);
export async function surfaceContext(h, state, result) {
  await h.live.subscribed("mcp-surfaces", [
    { kind: "project", projectId: project },
  ]);
  const began = Date.now(),
    aliases = new Map([
      [h.owner, "<owner>"],
      [h.serverId, "<server>"],
    ]);
  const verifiedCiphertexts = new Set();
  const binding = {
    bindingId: "eeeeeeee-eeee-4eee-8eee-000000000800",
    ownerId: h.owner,
    contextKind: "project",
    projectId: project,
    chatId: chat,
    executionLaneId: lane,
    workerId: worker,
    worktreeId: tree,
    rootKind: "git-worktree",
    scratchRootId: null,
    permissionProfileId: ":workspace",
    allowedOperations: operations,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  const normalize = (value, key) => {
    if (
      key === "protectedContent" &&
      verifiedCiphertexts.has(JSON.stringify(value))
    )
      return "<endpoint-verified notification ciphertext>";
    if (typeof value === "string") {
      if (aliases.has(value)) return aliases.get(value);
      if (
        [
          "createdAt",
          "updatedAt",
          "occurredAt",
          "created_at",
          "updated_at",
          "occurred_at",
          "resolved_at",
          "resolvedAt",
        ].includes(key) &&
        Number.isFinite(Date.parse(value))
      ) {
        if (Date.parse(value) < began - 1000) return value;
        assert.ok(
          Date.parse(value) <= Date.now() + 1000,
          "generated clock bounded by actual request",
        );
        return "<verified generated clock>";
      }
    }
    if (Array.isArray(value)) return value.map((v) => normalize(v, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
      );
    return value;
  };
  const audits = async () =>
    (
      await h.fixture.sql(
        [],
        [
          "SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb)::text AS result FROM audit_events a WHERE a.action LIKE 'mcp.%'",
        ],
      )
    )[0];
  const durable = async () =>
    (
      await h.fixture.sql(
        [],
        [
          `SELECT jsonb_build_object('terminal',(SELECT jsonb_build_object('status',status,'enabled',service_enabled,'kind',kind) FROM terminals WHERE id='mcp-terminal'),'browser',(SELECT jsonb_build_object('state',protected_state,'revision',state_revision) FROM browsers WHERE id='mcp-browser'),'remote',(SELECT jsonb_build_object('state',protected_state,'revision',state_revision,'worker',worker_id,'configuration',configuration) FROM remote_surfaces WHERE id='mcp-browser'),'interaction',(SELECT jsonb_build_object('status',status,'protected',protected_payload,'response',response,'protectedResponse',protected_response,'resolvedAt',resolved_at) FROM agent_interaction_requests WHERE id=${literal(interaction)}))::text AS result`,
        ],
      )
    )[0];
  let sequence = 0;
  const id = () =>
    `dddddddd-dddd-4ddd-8ddd-${String(++sequence).padStart(12, "0")}`;
  async function call(
    name,
    operation,
    args = {},
    status = 200,
    claims = binding,
  ) {
    await h.live.ping("before " + name);
    const before = await audits(),
      commandStart = state.commands.length,
      liveStart = h.live.history.length;
    const requestId = id();
    const response = await fetch(
      h.fixture.server.origin + "/api/internal/agent-operations",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + h.credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId,
          binding: claims,
          request: { operation, arguments: args },
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    const body = await response.json(),
      httpRequestId = response.headers.get("x-request-id");
    assert.match(httpRequestId, uuid);
    aliases.set(httpRequestId, "<http:" + name + ">");
    if (body.data?.correlationId) {
      assert.match(body.data.correlationId, uuid);
      aliases.set(body.data.correlationId, "<control:" + name + ">");
    }
    const after = await audits(),
      fresh = after.filter((row) => !before.some((old) => old.id === row.id));
    assert.equal(fresh.length, 1, JSON.stringify({ name, fresh }));
    const audit = fresh[0];
    assert.ok(Number.isSafeInteger(audit.id) && audit.id > 0);
    assert.equal(audit.owner_id, h.owner);
    assert.equal(audit.actor_user_id, null);
    assert.equal(audit.actor_session_id, null);
    assert.equal(audit.request_id, httpRequestId);
    assert.equal(audit.resource_type, "mcp-binding");
    assert.equal(audit.resource_id, claims.bindingId);
    assert.equal(
      audit.action,
      status === 200
        ? readOperations.has(operation)
          ? "mcp.operation.executed"
          : "mcp.operation.mutated"
        : "mcp.operation.rejected",
    );
    assert.equal(
      audit.result,
      status === 200
        ? "succeeded"
        : ["forbidden", "stale-binding", "expired"].includes(body.code)
          ? "denied"
          : "failed",
    );
    await h.live.ping("after " + name);
    const events = h.live.history
      .slice(liveStart)
      .filter(
        (frame) => frame.type === "event" && eventResources.has(frame.resource),
      );
    let cursor = -1;
    for (const event of events) {
      assert.ok(event.cursor > cursor);
      cursor = event.cursor;
      assert.deepEqual(event.scope, { kind: "project", projectId: project });
    }
    const headers = Object.fromEntries(
      [
        "content-type",
        "cache-control",
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "vary",
        "x-content-type-options",
        "referrer-policy",
        "content-security-policy",
        "cross-origin-resource-policy",
        "cross-origin-opener-policy",
        "x-frame-options",
      ].map((k) => [k, response.headers.get(k)]),
    );
    const record = {
      name,
      operation,
      args,
      status: response.status,
      body,
      commands: state.commands.slice(commandStart),
      audit,
      headers,
      events,
      durable: await durable(),
    };
    result.calls.push(record);
    result.normalizedCalls.push(
      normalize({
        ...record,
        body: verifiedSurfaceQueryFailure(body, operation, args, h.owner),
        audit: { ...audit, id: "<audit:" + name + ">" },
        events: events.map(({ cursor, ...event }) => event),
      }),
    );
    assert.equal(response.status, status, JSON.stringify({ name, body }));
    console.log(
      JSON.stringify({ kind: h.fixture.kind, name, status: response.status }),
    );
    return body;
  }
  return {
    h,
    state,
    result,
    binding,
    call,
    normalize,
    verifiedCiphertexts,
    id,
    began,
  };
}
