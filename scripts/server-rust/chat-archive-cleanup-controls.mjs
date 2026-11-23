import assert from "node:assert/strict";
import { heartbeat } from "./security-fixtures.mjs";
import { LiveProbe } from "./live-sockets.mjs";

const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
const list = (values) => values.map(literal).join(",");
const json = async (h, query) => (await h.fixture.sql([], [query]))[0];

export async function retentionControls(h, id, projectSeed, scratchSeed) {
  const chats = [7, 8, 9, 11, 13].map(id),
    roots = [10, 12, 14].map(id);
  await h.fixture.sql([
    projectSeed(id(7), new Date().toISOString()),
    projectSeed(id(8), null),
    ...scratchSeed(
      id(9),
      id(10),
      "2000-01-01T00:00:00Z",
      "2999-01-01T00:00:00Z",
    ),
    ...scratchSeed(id(11), id(12), null, null),
    ...scratchSeed(id(13), id(14), "2000-01-01T00:00:00Z", null),
  ]);
  const snapshot = () =>
    json(
      h,
      `SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c WHERE id IN (${list(chats)})),'roots',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM standalone_chat_roots r WHERE id IN (${list(roots)})),'jobs',(SELECT count(*)::int FROM standalone_chat_root_jobs WHERE chat_id IN (${list(chats)})))::text result`,
    );
  const before = await snapshot();
  assert.equal(before.chats.length, 5);
  assert.equal(before.roots.length, 3);
  assert.equal(before.jobs, 0);
  return {
    chats,
    roots,
    async unchanged() {
      // Compare every stored field, including ciphertext, within its producer.
      assert.deepEqual(await snapshot(), before);
      return {
        retainedChats: chats.length,
        retainedRoots: roots.length,
        jobs: 0,
      };
    },
  };
}

export async function foreignOwnerControl(h, id, scratchSeed) {
  const foreignProject = id(20),
    foreignChat = id(21),
    foreignScratchChat = id(22),
    foreignRoot = id(23);
  const foreignWorker = "foreign-archive-cleanup-worker";
  const owner = (
    await json(
      h,
      "SELECT jsonb_build_object('id',id)::text result FROM users WHERE email='other-settings@example.invalid'",
    )
  ).id;
  assert.notEqual(owner, h.owner);
  const code = await h.visit(
    "foreign cleanup worker enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { client: "other", status: 201, json: { label: "Foreign cleanup worker" } },
  );
  await h.visit(
    "foreign cleanup worker enrollment",
    "POST",
    "/api/internal/workers/enroll",
    {
      client: "worker",
      status: 201,
      json: {
        code: code.code,
        heartbeat: { ...heartbeat, workerId: foreignWorker },
      },
    },
  );
  await h.fixture.sql([
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) SELECT ${literal(foreignProject)},${literal(owner)},protected_label,origin_kind,git_capability,github_capability,worktree_policy,${literal(foreignWorker)},'foreign-cleanup-project' FROM projects WHERE id=${literal(h.scope.projectId)}`,
    `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('foreign-cleanup-source',${literal(foreignProject)},${literal(foreignWorker)},'git','/worker-owned/foreign-cleanup','/worker-owned/foreign-cleanup')`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(id(24))},'foreign-cleanup-source',${literal(foreignWorker)},'main','/worker-owned/foreign-cleanup','/worker-owned/foreign-cleanup',true,'cantrip','ready')`,
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,worktree_mode,protected_label,experience,archived_at) SELECT ${literal(foreignChat)},${literal(owner)},${literal(foreignProject)},${literal(id(24))},${literal(foreignWorker)},worktree_mode,protected_label,'agent','2000-01-01T00:00:00Z' FROM chats WHERE id=${literal(h.scope.chatId)}`,
    ...scratchSeed(
      foreignScratchChat,
      foreignRoot,
      "2000-01-01T00:00:00Z",
      "2001-01-01T00:00:00Z",
      owner,
      foreignWorker,
    ),
  ]);
  const snapshot = () =>
    json(
      h,
      `SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c WHERE id IN (${list([foreignChat, foreignScratchChat])})),'roots',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM standalone_chat_roots r WHERE id=${literal(foreignRoot)}),'jobs',(SELECT count(*)::int FROM standalone_chat_root_jobs WHERE chat_id=${literal(foreignScratchChat)}))::text result`,
    );
  const before = await snapshot();
  assert.equal(before.chats.length, 2);
  assert.equal(before.roots.length, 1);
  assert.equal(before.jobs, 0);
  return {
    owner,
    async unchanged() {
      assert.deepEqual(await snapshot(), before);
    },
    async clean(until) {
      const live = await new LiveProbe(h.fixture, { client: "other" }).open();
      try {
        await live.initialized();
        await live.subscribed("foreign-archive-owner", [
          { kind: "current-user" },
        ]);
        const offset = h.live.history.length;
        assert.deepEqual(
          await h.visit(
            "foreign owner cleans only its own archives",
            "POST",
            "/api/chats/archives/cleanup",
            { client: "other", json: { ownerId: h.owner } },
          ),
          { deleted: 2 },
        );
        const state = await until(
          () =>
            json(
              h,
              `SELECT jsonb_build_object('chats',(SELECT count(*)::int FROM chats WHERE id IN (${list([foreignChat, foreignScratchChat])})),'jobs',(SELECT jsonb_agg(jsonb_build_object('ownerId',owner_id,'state',state,'lastErrorCode',last_error_code,'errorRetryable',error_retryable)) FROM standalone_chat_root_jobs WHERE chat_id=${literal(foreignScratchChat)}))::text result`,
            ),
          (v) => v.jobs?.[0]?.state === "blocked",
        );
        assert.deepEqual(state, {
          chats: 0,
          jobs: [
            {
              ownerId: owner,
              state: "blocked",
              lastErrorCode: "worker-offline",
              errorRetryable: true,
            },
          ],
        });
        const events = await until(
          () =>
            live.history.filter(
              (e) =>
                e.type === "event" &&
                e.resource === "chat" &&
                e.entityId === foreignScratchChat,
            ),
          (v) => v.length >= 2,
        );
        assert.equal(events.length, 2);
        for (const [i, event] of events.entries()) {
          if (i) assert.ok(event.cursor > events[i - 1].cursor);
          assert.ok(Date.parse(event.occurredAt) <= Date.now());
        }
        assert.deepEqual(
          events.map(({ cursor, occurredAt, ...event }) => event),
          Array.from({ length: 2 }, () => ({
            type: "event",
            scope: { kind: "current-user" },
            resource: "chat",
            action: "invalidated",
            entityId: foreignScratchChat,
            revision: null,
            payload: null,
          })),
        );
        await h.live.subscribed("foreign-archive-isolation-barrier", [
          { kind: "current-user" },
        ]);
        assert.equal(
          h.live.history
            .slice(offset)
            .filter(
              (e) =>
                e.type === "event" &&
                [foreignChat, foreignScratchChat].includes(e.entityId),
            ).length,
          0,
        );
        return {
          deleted: 2,
          foreignJobBlockedOffline: true,
          foreignEvents: 2,
          leakedEvents: 0,
        };
      } finally {
        await live.close();
      }
    },
  };
}

export async function durabilitySnapshot(h, retained, jobChats) {
  // Worker disconnection can change operational status. Retained content and
  // archive deadlines must survive unchanged; completed job rows stay exact.
  return json(
    h,
    `SELECT jsonb_build_object('chats',(SELECT jsonb_agg(jsonb_build_object('id',id,'owner',owner_id,'project',project_id,'label',protected_label,'archived',archived_at,'scratch',active_scratch_root_id) ORDER BY id) FROM chats WHERE id IN (${list(retained.chats)})),'roots',(SELECT jsonb_agg(jsonb_build_object('id',id,'chat',chat_id,'owner',owner_id,'worker',worker_id,'handle',protected_path_handle,'archived',archived_at,'expires',archive_expires_at) ORDER BY id) FROM standalone_chat_roots WHERE id IN (${list(retained.roots)})),'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY chat_id) FROM standalone_chat_root_jobs j WHERE chat_id IN (${list(jobChats)})))::text result`,
  );
}

export async function productionBodyChecks(h, server, profile) {
  const port = Number(new URL(h.fixture.server.origin).port);
  await h.fixture.close();
  h.fixture.executable = server;
  h.fixture.liveSqlFixture = false;
  await h.fixture.start({ port });
  const route = "/api/chats/archives/cleanup";
  for (const [name, method, target, options] of [
    ["cleanup no body", "POST", route, {}],
    ["cleanup scalar body", "POST", route, { json: 17 }],
    ["cleanup array body", "POST", route, { json: [] }],
    [
      "cleanup text body",
      "POST",
      route,
      { raw: "ignored text", headers: { "content-type": "text/plain" } },
    ],
    [
      "cleanup binary body",
      "POST",
      route,
      {
        raw: "ignored binary",
        headers: { "content-type": "application/octet-stream" },
      },
    ],
    [
      "cleanup malformed JSON",
      "POST",
      route,
      {
        raw: "{",
        headers: { "content-type": "application/json" },
        status: 400,
      },
    ],
    [
      "cleanup empty JSON",
      "POST",
      route,
      { raw: "", headers: { "content-type": "application/json" }, status: 400 },
    ],
    ["cleanup GET unsupported", "GET", route, { status: 404 }],
    ["cleanup DELETE unsupported", "DELETE", route, { status: 404 }],
    [
      "production SQL control excluded",
      "POST",
      "/__fixture/sql",
      { json: { statements: ["SELECT 1"] }, status: 404 },
    ],
  ]) {
    const value = await h.visit(name, method, target, options);
    if ((options.status ?? 200) === 200)
      assert.deepEqual(value, { deleted: 0 });
  }
  if (profile !== "none") {
    await h.visit("cleanup requires browser authentication", "POST", route, {
      client: "guest",
      status: 401,
      json: {},
    });
    await h.visit("cleanup requires matching CSRF", "POST", route, {
      csrf: false,
      headers: { "x-cantrip-csrf": "wrong-token" },
      status: 403,
      json: {},
    });
  }
}
