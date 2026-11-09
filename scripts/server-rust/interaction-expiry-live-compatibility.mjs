// Real one-second expiry, durable rows and App Live; no request read expires rows.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { password } from "./security-fixtures.mjs";
import { eventually } from "./full-worker.mjs";
import { interactionOpaque } from "./agent-interaction-fixtures.mjs";
import {
  localOwner,
  literal,
  json,
  targetStateSql,
} from "./project-target-state.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    report: { type: "string" },
    shutdown: { type: "boolean", default: false },
    production: { type: "boolean", default: false },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-interaction-expiry-live-"),
);
console.error(JSON.stringify({ event: "interaction-expiry.created", root }));
const report = {
  root,
  database: values.database,
  production: values.production,
  profiles: [],
  completeReplacement: false,
};
const id = (n) => "77777777-7777-4777-8777-" + String(n).padStart(12, "0");
const payload = {
  kind: "fileChange",
  startedAtMs: 1,
  reason: "Visible fixture approval",
  grantRoot: null,
};
const chats = ["chat", "expiry-task", "expiry-standalone"];
const publication = (resource, scope, entityId) => ({
  resource,
  scope,
  entityId,
});
const expected = (selected) =>
  selected
    .flatMap((chat) => [
      publication("agent-interaction", { kind: "chat", chatId: chat }, null),
      publication(
        "chat",
        chat === "expiry-standalone"
          ? { kind: "current-user" }
          : { kind: "project", projectId: "github" },
        chat,
      ),
      ...(chat === "expiry-task"
        ? [
            publication(
              "agent-interaction",
              { kind: "project", projectId: "github" },
              chat,
            ),
          ]
        : []),
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const peers = [];
    report.profiles.push({ profile, peers });
    for (const kind of ["node", "rust"]) {
      const result = { kind, http: [], stages: [] };
      peers.push(result);
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      const f = new HttpFixture({
        kind,
        root,
        name: profile,
        databaseMode: values.database,
        executable,
        liveSqlFixture: !values.production,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_FIXTURE_LOGGING: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && values.database === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      let server, live, foreignLive, observer;
      if (values.production) {
        assert.ok(
          f.environment.DATABASE_URL,
          "Observe only the fixture-owned external PostgreSQL database",
        );
        const postgres = createRequire(
          new URL(
            "../../tests/reference-node-server/package.json",
            import.meta.url,
          ),
        )("postgres");
        observer = postgres(f.environment.DATABASE_URL, { max: 1 });
        f.sql = (statements, queries = []) =>
          observer.begin(async (sql) => {
            for (const statement of statements) await sql.unsafe(statement);
            const results = [];
            for (const query of queries) {
              const rows = await sql.unsafe(query);
              assert.equal(rows.length, 1);
              results.push(JSON.parse(rows[0].result));
            }
            return results;
          });
      }
      const visit = async (name, method, url, options = {}) => {
        result.http.push({
          name,
          ...(await f.observe(name, method, url, { csrf: true, ...options })),
        });
        return f.records.get(name);
      };
      const rows = async () =>
        (
          await f.sql(
            [],
            [
              "SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'status',status,'resolved',resolved_at IS NOT NULL,'payload',payload,'protected',protected_payload) ORDER BY id),'[]'::jsonb)::text result FROM agent_interaction_requests WHERE id::text LIKE '77777777-%'",
            ],
          )
        )[0];
      const events = (offset) =>
        live.history
          .slice(offset)
          .filter(
            (frame) =>
              frame.type === "event" &&
              ["agent-interaction", "chat"].includes(frame.resource) &&
              (chats.includes(frame.entityId) ||
                chats.includes(frame.scope.chatId)),
          )
          .map(({ resource, scope, entityId }) =>
            publication(resource, scope, entityId),
          )
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      try {
        await f.start();
        server = f.server;
        const auth =
          profile === "accounts"
            ? await visit("register", "POST", "/api/auth/register", {
                status: 201,
                json: {
                  email: "expiry@example.invalid",
                  displayName: "Expiry owner",
                  password,
                },
              })
            : profile === "password"
              ? await visit("login", "POST", "/api/auth/login", {
                  json: { password },
                })
              : await visit("session", "GET", "/api/auth/session");
        const owner = auth.currentUser?.id ?? localOwner;
        if (values.production) {
          const client = f.client();
          const control = await fetch(server.origin + "/__fixture/sql", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://127.0.0.1:5173",
              cookie: [...client.cookies]
                .map(([k, v]) => k + "=" + v)
                .join("; "),
              ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
            },
            body: JSON.stringify({ statements: [], queries: [] }),
          });
          result.productionSqlControlStatus = control.status;
          assert.equal(
            control.status,
            404,
            "Actual production server has no SQL control route",
          );
          await control.arrayBuffer();
        }
        const foreign =
          profile === "accounts"
            ? await visit(
                "register other owner",
                "POST",
                "/api/auth/register",
                {
                  client: "other",
                  status: 201,
                  json: {
                    email: "other-expiry@example.invalid",
                    displayName: "Other expiry owner",
                    password,
                  },
                },
              )
            : undefined;
        await f.sql([
          ...targetStateSql(owner, foreign?.currentUser.id),
          "UPDATE chats SET automation_paused=true",
          "INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,status,automation_paused) SELECT 'expiry-task',owner_id,project_id,active_worktree_id,active_worker_id,protected_label,'task','waiting-for-approval',true FROM chats WHERE id='chat'",
          `INSERT INTO chats(id,owner_id,context_kind,project_id,worktree_mode,active_worker_id,active_scratch_root_id,protected_label,status,automation_paused) SELECT 'expiry-standalone',owner_id,'standalone',NULL,NULL,'alpha',${literal(id(70))},protected_label,'waiting-for-approval',true FROM chats WHERE id='chat'`,
          `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES(${literal(id(70))},'expiry-standalone',${literal(owner)},'alpha',${literal("ctrr_" + Buffer.alloc(32, 39).toString("base64url"))},'ready')`,
          "UPDATE chats SET status='waiting-for-approval' WHERE id='chat'",
        ]);
        live = new LiveProbe(f);
        await live.open();
        await live.initialized();
        await live.subscribed("expiry scopes", [
          { kind: "current-user" },
          { kind: "project", projectId: "github" },
          ...chats.map((chatId) => ({ kind: "chat", chatId })),
        ]);
        if (foreign) {
          foreignLive = new LiveProbe(f, { client: "other" });
          await foreignLive.open();
          await foreignLive.initialized();
          await foreignLive.subscribed("other owner expiry scopes", [
            { kind: "current-user" },
            { kind: "project", projectId: "other" },
            { kind: "chat", chatId: "other-chat" },
          ]);
        }
        const deadline = new Date(Date.now() + 2000).toISOString();
        const insert = (n, chat, expires, status = "pending") =>
          `INSERT INTO agent_interaction_requests(id,request_key,interaction_owner,owner_id,project_id,chat_id,worker_id,thread_id,kind,status,payload,expires_at,resolved_at) VALUES(${literal(id(n))},${literal(id(n))},'codex',${literal(owner)},${literal(chat === "expiry-standalone" ? null : "github")},${literal(chat)},'alpha','thread','fileChange',${literal(status)},${json(payload)},${literal(expires)},${status === "pending" ? "NULL" : "now()"})`;
        let offset = live.history.length;
        await f.sql([
          insert(1, "chat", deadline),
          insert(2, "chat", deadline),
          insert(3, "expiry-task", deadline),
          insert(4, "expiry-task", deadline),
          insert(5, "expiry-standalone", deadline),
          insert(6, null, deadline),
          `INSERT INTO agent_interaction_requests(id,request_key,interaction_owner,owner_id,project_id,chat_id,worker_id,kind,status,payload,protected_payload,expires_at) VALUES(${literal(id(7))},${literal(id(7))},'computer-use',${literal(owner)},'github','chat','alpha','permissions','pending',NULL,${json(interactionOpaque)},${literal(deadline)})`,
          ...(foreign
            ? [
                `INSERT INTO agent_interaction_requests(id,request_key,interaction_owner,owner_id,project_id,chat_id,worker_id,thread_id,kind,status,payload,expires_at) VALUES(${literal(id(8))},${literal(id(8))},'codex',${literal(foreign.currentUser.id)},'other','other-chat','foreign','thread','fileChange','pending',${json(payload)},${literal(deadline)})`,
              ]
            : []),
          insert(20, "chat", "2099-01-01T00:00:00.000Z"),
          insert(21, "chat", "2000-01-01T00:00:00.000Z", "resolved"),
        ]);
        const before = await rows();
        assert.equal(
          before.filter((row) => row.status === "pending").length,
          foreign ? 9 : 8,
        );
        await eventually(
          rows,
          (actual) => {
            assert.equal(
              actual.filter((row) => row.status === "expired").length,
              foreign ? 8 : 7,
            );
            assert.equal(
              actual.find((row) => row.id === id(20)).status,
              "pending",
            );
            assert.equal(
              actual.find((row) => row.id === id(21)).status,
              "resolved",
            );
          },
          15000,
        );
        result.rowsAfterExpiry = await rows();
        await eventually(
          async () => events(offset),
          (actual) =>
            assert.deepEqual(
              actual,
              expected(chats),
              "Timer publishes one owner-scoped invalidation/summary per affected Chat, including Task fanout",
            ),
          15000,
        );
        result.stages.push({
          name: "global expiry deduplicates Chat/Task/standalone and ignores no-Chat rows",
          events: events(offset),
        });
        if (foreignLive) {
          const otherEvents = () =>
            foreignLive.history
              .filter(
                (frame) =>
                  frame.type === "event" &&
                  ["agent-interaction", "chat"].includes(frame.resource),
              )
              .map(({ resource, scope, entityId }) =>
                publication(resource, scope, entityId),
              )
              .sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b)),
              );
          await eventually(
            async () => otherEvents(),
            (actual) =>
              assert.deepEqual(
                actual,
                [
                  publication(
                    "agent-interaction",
                    { kind: "chat", chatId: "other-chat" },
                    null,
                  ),
                  publication(
                    "chat",
                    { kind: "project", projectId: "other" },
                    "other-chat",
                  ),
                ].sort((a, b) =>
                  JSON.stringify(a).localeCompare(JSON.stringify(b)),
                ),
                "Global expiry publishes only to each stored owner",
              ),
            15000,
          );
          result.stages.push({
            name: "simultaneous account expiry retains tenant isolation",
            events: otherEvents(),
          });
          assert.equal(
            live.history.some(
              (frame) =>
                frame.type === "event" &&
                (frame.entityId === "other-chat" ||
                  frame.scope.chatId === "other-chat"),
            ),
            false,
          );
        }
        for (const row of result.rowsAfterExpiry) {
          if (row.id === id(7)) {
            assert.equal(row.payload, null);
            assert.deepEqual(
              row.protected,
              interactionOpaque,
              "Expiry retains opaque computer-use content unchanged",
            );
          } else {
            assert.deepEqual(
              row.payload,
              payload,
              "Expiry preserves approval content",
            );
            assert.equal(row.protected, null);
          }
          assert.equal(row.resolved, row.id !== id(20));
        }
        await live.ping("first sweep events complete");
        offset = live.history.length;
        await f.sql([
          `UPDATE agent_interaction_requests SET expires_at=${literal(new Date(Date.now() + 2000).toISOString())} WHERE id=${literal(id(20))}`,
        ]);
        await eventually(
          rows,
          (actual) =>
            assert.equal(
              actual.find((row) => row.id === id(20)).status,
              "expired",
            ),
          15000,
        );
        await eventually(
          async () => events(offset),
          (actual) =>
            assert.deepEqual(
              actual,
              expected(["chat"]),
              "Later sweep publishes only newly expired Chat",
            ),
          15000,
        );
        result.stages.push({
          name: "later real sweep retains deduplication",
          events: events(offset),
        });
        await f.sql([
          "ALTER TABLE agent_interaction_requests RENAME TO owned_expiry_unavailable",
        ]);
        try {
          await eventually(
            async () => server.diagnostics(),
            (diagnostics) =>
              assert.ok(
                diagnostics.includes(
                  "Failed to expire pending agent interaction requests",
                ),
                "Observe the real timer's actual SQL failure",
              ),
            15000,
          );
        } finally {
          await f.sql([
            "ALTER TABLE owned_expiry_unavailable RENAME TO agent_interaction_requests",
          ]);
        }
        await live.ping("failed sweep observed and relation restored");
        offset = live.history.length;
        await f.sql([
          insert(30, "chat", new Date(Date.now() + 2000).toISOString()),
        ]);
        await eventually(
          rows,
          (actual) =>
            assert.equal(
              actual.find((row) => row.id === id(30)).status,
              "expired",
            ),
          15000,
        );
        await eventually(
          async () => events(offset),
          (actual) =>
            assert.deepEqual(
              actual,
              expected(["chat"]),
              "Timer resumes durable expiry and exact notification after actual SQL recovery",
            ),
          15000,
        );
        result.stages.push({
          name: "timer recovers after actual SQL failure",
          events: events(offset),
        });
        const publicRows = await visit(
          "expired public requests",
          "GET",
          "/api/agent-requests?chatId=chat&status=expired",
        );
        assert.ok(Array.isArray(publicRows));
        assert.equal(publicRows.length, 5);
        for (const row of publicRows)
          assert.equal(
            "ownerId" in row,
            false,
            "Internal ownership metadata never changes the public request contract",
          );
        [result.chatStates] = await f.sql(
          [],
          [
            "SELECT jsonb_agg(jsonb_build_object('id',id,'status',status) ORDER BY id)::text result FROM chats WHERE id IN ('chat','expiry-task','expiry-standalone')",
          ],
        );
        for (const chat of result.chatStates)
          assert.notEqual(
            chat.status,
            "waiting-for-approval",
            "Expiry restores the Chat after its last pending request",
          );
        if (values.shutdown) {
          result.rowsAtExit = await rows();
          await foreignLive?.close();
          await live.close();
          await (
            await import("./interaction-expiry-shutdown.mjs")
          ).interactionExpiryShutdown({
            f,
            server,
            result,
            requestId: id(40),
            insert: insert(
              40,
              "chat",
              new Date(Date.now() + 2000).toISOString(),
            ),
          });
        }
        result.passed = true;
      } finally {
        result.rowsAtExit =
          server && f.server
            ? await rows().catch((error) => ({ error: error.message }))
            : (result.rowsAtExit ?? []);
        result.liveHistory = live?.history;
        result.foreignLiveHistory = foreignLive?.history;
        result.diagnostics = server?.diagnostics();
        try {
          await foreignLive?.close();
          await live?.close();
        } finally {
          try {
            await f.close();
          } finally {
            await observer?.end();
            result.exit = {
              code: server?.child.exitCode,
              signal: server?.child.signalCode,
            };
          }
        }
      }
    }
    assert.deepEqual(
      peers[1].http,
      peers[0].http,
      "HTTP authentication contracts",
    );
    assert.deepEqual(peers[1].stages, peers[0].stages, "Timer publications");
    assert.deepEqual(
      peers[1].rowsAtExit,
      peers[0].rowsAtExit,
      "Final durable expiry state",
    );
    assert.deepEqual(
      peers[1].chatStates,
      peers[0].chatStates,
      "Restored Chat statuses",
    );
    if (values.shutdown)
      assert.deepEqual(
        peers[1].shutdown,
        peers[0].shutdown,
        "Started timer write and restoration survive shutdown",
      );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(
      path.resolve(values.report),
      JSON.stringify(report, null, 2) + "\n",
    );
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      peers: p.peers.map((r) => ({
        kind: r.kind,
        stages: r.stages.length,
        exit: r.exit,
      })),
    })),
  }),
);
