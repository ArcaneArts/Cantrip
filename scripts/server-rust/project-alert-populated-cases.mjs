import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { heartbeat, password } from "./security-fixtures.mjs";
import { LiveProbe } from "./live-sockets.mjs";

const uuid = (n) =>
  `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`;
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const opaque = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(22),
  },
};

export async function populatedAlertCases(fixture, result, profile) {
  let ownerId;
  const alertIds = new Map(),
    identities = new Map();
  const registerAlerts = (value) => {
    if (!value || typeof value !== "object") return;
    if (
      typeof value.id === "string" &&
      value.id.startsWith("alert_") &&
      value.episodeId
    ) {
      const fields = [
        ownerId,
        value.projectId,
        value.source,
        value.sourceId,
        value.episodeId,
      ];
      // These fixture identities are ASCII. PostgreSQL's jsonb array text uses
      // comma-space separators; assert the actual owner-bound public digest
      // independently before relating identities between isolated accounts.
      for (const field of fields) assert.match(field, /^[\x20-\x7e]+$/);
      const serialized =
        "[" + fields.map((s) => JSON.stringify(s)).join(", ") + "]";
      assert.equal(
        value.id,
        "alert_" + createHash("sha256").update(serialized).digest("hex"),
      );
      const logical = JSON.stringify(fields.slice(1));
      if (identities.has(logical))
        assert.equal(identities.get(logical), value.id);
      if (alertIds.has(value.id)) assert.equal(alertIds.get(value.id), logical);
      identities.set(logical, value.id);
      alertIds.set(value.id, logical);
    }
    for (const child of Object.values(value)) registerAlerts(child);
  };
  const canonical = (value, key = "") => {
    if (Array.isArray(value)) return value.map((v) => canonical(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, canonical(v, k)]),
      );
    if (typeof value !== "string") return value;
    if (alertIds.has(value)) return "<alert:" + alertIds.get(value) + ">";
    if (key === "url" || key === "label") {
      for (const [id, logical] of alertIds)
        value = value.replaceAll(id, "<alert:" + logical + ">");
      // Paths use the actual credential ID returned by enrollment. Its UUID
      // format and identity were already checked by the shared HTTP fixture.
      for (const [id, alias] of fixture.ids)
        value = value.replaceAll(id, alias);
    }
    return value;
  };
  const visit = async (label, method, url, options = {}) => {
    const observed = await fixture.observe(label, method, url, {
      csrf: true,
      ...options,
    });
    registerAlerts(fixture.records.get(label));
    result.http.push({
      label,
      method,
      url,
      ...observed,
    });
    return fixture.records.get(label);
  };
  const session = await visit(
    "owner session",
    profile === "none" ? "GET" : "POST",
    profile === "none"
      ? "/api/auth/session"
      : profile === "accounts"
        ? "/api/auth/register"
        : "/api/auth/login",
    profile === "none"
      ? {}
      : {
          status: profile === "accounts" ? 201 : 200,
          json:
            profile === "accounts"
              ? {
                  email: "alert-owner@example.invalid",
                  displayName: "Alert owner",
                  password,
                }
              : { password },
        },
  );
  if (profile === "none") {
    assert.equal(session.currentUser, null);
    ownerId = "00000000-0000-0000-0000-000000000001";
  } else ownerId = session.currentUser.id;
  const identity = await visit("server identity", "GET", "/api/bootstrap");
  const serverId = identity.server.id;
  let otherId = uuid(500);
  if (profile === "accounts") {
    const other = await visit(
      "other owner session",
      "POST",
      "/api/auth/register",
      {
        client: "other",
        status: 201,
        json: {
          email: "alert-other@example.invalid",
          displayName: "Other alert owner",
          password,
        },
      },
    );
    otherId = other.currentUser.id;
  } else {
    await fixture.sql([
      `INSERT INTO users(id,kind,display_name) VALUES(${literal(otherId)},'anonymous','Other fixture')`,
    ]);
  }
  const code = await visit(
    "worker enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    {
      status: 201,
      json: { label: "Alert source worker" },
    },
  );
  const enrollment = await visit(
    "worker enrollment",
    "POST",
    "/api/internal/workers/enroll",
    {
      client: "worker",
      status: 201,
      json: {
        code: code.code,
        heartbeat: { ...heartbeat, workerId: "worker" },
      },
    },
  );
  const headers = { authorization: "Bearer " + enrollment.credential };
  const generation = uuid(100);
  const label = (kind) =>
    literal(
      JSON.stringify({
        classification: { recordKind: kind },
        protectedLabel: opaque,
      }),
    );
  await fixture.sql([
    `INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES('project',${literal(ownerId)},${label("project")},'A'),('empty',${literal(ownerId)},${label("project")},'B'),('foreign',${literal(otherId)},${label("project")},'A')`,
    "INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES('source','project','worker','/qa','/qa')",
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,origin,is_primary) VALUES('tree','source','worker','Primary','/qa','/qa','cantrip',true)",
    ...["chat", "chat-two"].map(
      (id) =>
        `INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id,status,permission_profile_id) VALUES(${literal(id)},${literal(ownerId)},'project',${label("chat")},'tree','running',':workspace')`,
    ),
    "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('runtime','chat','worker','tree','thread'),('runtime-two','chat-two','worker','tree','thread-two')",
    "INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('lane','chat','tree','worker','agent',false,'Qualification','active',now(),'runtime')",
    `UPDATE workers SET project_goal_generation=${literal(generation)} WHERE id='worker'`,
  ]);

  const live = new LiveProbe(fixture);
  let otherLive;
  try {
    await live.open();
    await live.initialized();
    await live.subscribed();
    if (profile === "accounts") {
      otherLive = new LiveProbe(fixture, { client: "other" });
      await otherLive.open();
      await otherLive.initialized();
      await otherLive.subscribed();
    }
    const post = (name, url, json, status = 200, authenticated = true) =>
      visit(name, "POST", url, {
        client: "worker",
        json,
        status,
        headers: authenticated ? headers : {},
      });
    const counts = async (name, expected) => {
      const actual = await visit(name, "GET", "/api/project-alerts/counts");
      assert.deepEqual(
        actual,
        expected ? [{ projectId: "project", count: expected }] : [],
      );
    };
    const fact = (revision, status, second = false) => ({
      chatId: second ? "chat-two" : "chat",
      workerId: "worker",
      threadId: second ? "thread-two" : "thread",
      generation,
      revision,
      snapshot: {
        kind: "chat-encrypted",
        goal: status
          ? {
              threadId: second ? "thread-two" : "thread",
              status,
              tokenBudget: null,
              tokensUsed: 1,
              timeUsedSeconds: 1,
              createdAt: 1,
              updatedAt: second ? 3 : 2,
              protectedObjective: {
                id: uuid(second ? 102 : 101),
                classification: {
                  role: "user",
                  mode: "goal",
                  attachmentIds: [],
                },
                protectedContent: opaque,
                idempotencyKey: second ? "goal-two" : "goal",
              },
            }
          : null,
      },
    });
    const goalUrl = "/api/internal/project-alerts/goals";
    await post("unauthorized fact", goalUrl, fact(1, "blocked"), 401, false);
    const blocked = fact(1, "blocked");
    await post("blocked fact", goalUrl, blocked);
    await live.message(
      (f) => f.type === "event" && f.resource === "project-alert",
    );
    await counts("one blocked Goal", 1);
    const page = await visit(
      "populated Goal inbox",
      "GET",
      "/api/projects/project/alerts",
    );
    assert.equal(page.items.length, 1);
    const goalAlert = page.items[0];
    assert.equal(goalAlert.source, "goal");
    assert.equal(goalAlert.chatId, "chat");
    assert.equal(goalAlert.kind, "goal-stalled");
    const sourceUrl = `/api/projects/project/alerts/${goalAlert.id}/goal`;
    const snapshot = await visit("stored opaque Goal source", "GET", sourceUrl);
    assert.deepEqual(snapshot, {
      ...blocked.snapshot,
      goal: {
        ...blocked.snapshot.goal,
        protectedObjective: {
          ...blocked.snapshot.goal.protectedObjective,
          reasoningEffort: null,
        },
      },
    });
    result.opaqueGoal = snapshot;
    await visit(
      "foreign Goal project",
      "GET",
      `/api/projects/foreign/alerts/${goalAlert.id}/goal`,
      { status: 404 },
    );
    if (profile === "accounts") {
      await visit("other owner cannot read Goal", "GET", sourceUrl, {
        client: "other",
        status: 404,
      });
      await visit(
        "other owner cannot read inbox",
        "GET",
        "/api/projects/project/alerts",
        { client: "other", status: 404 },
      );
      assert.deepEqual(
        await visit("other owner counts", "GET", "/api/project-alerts/counts", {
          client: "other",
        }),
        [],
      );
    }
    await post("second stalled Goal", goalUrl, fact(1, "usageLimited", true));
    await counts("two stalled Goals", 2);
    const all = await visit(
      "two Goal inbox",
      "GET",
      "/api/projects/project/alerts",
    );
    assert.equal(all.items.length, 2);
    const first = await visit(
      "first inbox page",
      "GET",
      "/api/projects/project/alerts?limit=1",
    );
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].chatId, "chat-two");
    assert.equal(first.nextCursor, first.items[0].id);
    const second = await visit(
      "second inbox page",
      "GET",
      `/api/projects/project/alerts?limit=1&after=${first.nextCursor}`,
    );
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].chatId, "chat");
    assert.equal(second.nextCursor, null);
    assert.notEqual(second.items[0].id, first.items[0].id);
    assert.deepEqual(
      new Set([...first.items, ...second.items].map((v) => v.id)),
      new Set(all.items.map((v) => v.id)),
    );
    await visit(
      "cursor is project bound",
      "GET",
      `/api/projects/empty/alerts?after=${first.nextCursor}`,
      { status: 404 },
    );
    for (const query of [
      "limit=1&limit=2",
      "limit=1&limit=1",
      "%6cimit=1&limit=2",
      `after=${first.nextCursor}&after=${first.nextCursor}`,
    ])
      await visit(
        "repeated query " + query,
        "GET",
        "/api/projects/project/alerts?" + query,
        { status: 400 },
      );
    await post("resumed fact", goalUrl, fact(2, "active"));
    await post("stale fact", goalUrl, blocked);
    await counts("stale report cannot reopen Goal", 1);
    await post("clear second Goal", goalUrl, fact(2, null, true));
    await post("clear first Goal", goalUrl, fact(3, null));
    await counts("cleared Goals", 0);
    const retired = await post("retired process", goalUrl, {
      ...fact(4, "blocked"),
      generation: uuid(200),
    });
    assert.equal(retired.reason, "retired-worker");
    await counts("retired process cannot reopen Goal", 0);

    const binding = {
      bindingId: uuid(300),
      ownerId,
      contextKind: "project",
      projectId: "project",
      chatId: "chat",
      executionLaneId: "lane",
      workerId: "worker",
      worktreeId: "tree",
      rootKind: "git-worktree",
      scratchRootId: null,
      permissionProfileId: ":workspace",
      allowedOperations: ["context.get", "alert.raise", "alert.resolve"],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    let requestId = 400;
    const call = (operation, args) => ({
      requestId: uuid(requestId++),
      binding,
      request: { operation, arguments: args },
    });
    const tools = "/api/internal/agent-operations";
    await post("context", tools, call("context.get", {}));
    const key = uuid(350);
    const mutation = (revision, status, scopeId = "chat") => ({
      key,
      revision,
      status,
      kind: "blocked",
      protectedDetail: {
        context: {
          domain: "alert-content",
          serverId,
          workerId: "worker",
          scopeId,
          operationId: key,
          operation: "agent-alert",
          direction: "stored",
          sequence: revision,
        },
        protectedContent: { ...opaque, domain: "alert-content" },
      },
    });
    await post(
      "unauthorized tool",
      tools,
      call("alert.raise", mutation(1, "open")),
      401,
      false,
    );
    const raised = mutation(1, "open");
    await post("raise", tools, call("alert.raise", raised));
    await post("duplicate raise", tools, call("alert.raise", raised));
    await counts("one AI Alert after replay", 1);
    const agentPage = await visit(
      "populated AI Alert inbox",
      "GET",
      "/api/projects/project/alerts",
    );
    assert.equal(agentPage.items.length, 1);
    assert.equal(agentPage.items[0].source, "agent");
    assert.deepEqual(
      agentPage.items[0].protectedDetail,
      raised.protectedDetail,
    );
    await post(
      "foreign aad",
      tools,
      call("alert.resolve", mutation(2, "resolved", "foreign")),
      403,
    );
    await counts("foreign context cannot resolve Alert", 1);
    await post(
      "resolve",
      tools,
      call("alert.resolve", mutation(2, "resolved")),
    );
    await post("late raise", tools, call("alert.raise", mutation(3, "open")));
    await counts("terminal AI Alert cannot reopen", 0);
    await visit(
      "revoke worker credential",
      "DELETE",
      `/api/workers/worker/credentials/${enrollment.credentialSummary.id}`,
      { status: 204 },
    );
    await post(
      "revoked credential cannot report Goal",
      goalUrl,
      fact(4, "blocked"),
      401,
    );
    await counts("revocation retains resolved state", 0);
    await live.ping("source transitions settled");
    await otherLive?.ping("other owner settled");
  } finally {
    await otherLive?.close();
    await live.close();
    result.liveHistory = live.history;
    result.otherLiveHistory = otherLive?.history;
  }
  const alerts = (history) =>
    history.filter((f) => f.type === "event" && f.resource === "project-alert");
  result.publications = alerts(live.history).map(({ cursor, ...event }) =>
    fixture.normalize(event),
  );
  assert.ok(
    result.publications.length > 0,
    "Actual source write publishes Alert invalidation",
  );
  for (const event of result.publications) {
    assert.deepEqual(event.scope, { kind: "current-user" });
    assert.equal(event.action, "invalidated");
    assert.equal(event.entityId, "project");
    assert.equal(event.payload, null);
  }
  if (otherLive)
    assert.deepEqual(
      alerts(otherLive.history),
      [],
      "Other owner receives no Alert publication",
    );

  const query =
    "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text AS result FROM project_alerts t";
  const [before] = await fixture.sql([], [query]);
  result.beforeRestart = before;
  const firstServer = result.server;
  await fixture.close();
  result.exits.push({
    code: firstServer.child.exitCode,
    signal: firstServer.child.signalCode,
  });
  result.firstGenerationDiagnostics = firstServer.diagnostics();
  await fixture.start();
  result.server = fixture.server;
  await visit("retained resolved counts", "GET", "/api/project-alerts/counts");
  assert.deepEqual(fixture.records.get("retained resolved counts"), []);
  const [after] = await fixture.sql([], [query]);
  result.afterRestart = after;
  assert.deepEqual(
    after,
    before,
    "Retained source revisions, opaque bytes and resolved tombstones",
  );
  result.http = canonical(result.http);
  result.alertIdentities = Object.fromEntries(identities);
}
