// Real paired HTTP reads preserve MCP context, discovery, opaque history and audit contracts.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";
import { literal, json, label } from "./project-target-state.mjs";
import { securityFixtures } from "./security-fixtures.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
import { createHash } from "node:crypto";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-read-before-"));
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const readQueries = JSON.parse(
  await readFile(
    new URL(
      "../../cantrip_server_rs/contracts/mcp-read-queries.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ??
  (await buildRustExample("http-sql-fixture"));
const reportPath =
  option("--report") ?? `.qa/rust-server/mcp-read-http-${databaseMode}.json`;
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  root,
  executable,
  actualHttp: true,
  actualWorkerConnection: true,
  fullWorkerProcess: false,
  databaseMode,
  investigationOnly: false,
  completeReplacement: false,
  profiles: [],
};
let h, pg, failure;
try {
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const p = { profile, peers: [], differences: [], auditDifferences: [] };
    report.profiles.push(p);
    const issuedAt = new Date().toISOString(),
      expiresAt = new Date(Date.now() + 120000).toISOString();
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], commands: [], calls: [] };
      p.peers.push(result);
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        onCommand: async (command) => {
          result.commands.push({ type: command.type });
        },
      });
      try {
        await h.fixture.sql([
          `UPDATE chats SET status='running',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-read-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Qualification','active',now(),'settings-runtime')`,
        ]);
        const binding = {
          bindingId: "eeeeeeee-eeee-4eee-8eee-000000000001",
          ownerId: h.owner,
          contextKind: "project",
          projectId: project,
          chatId: chat,
          executionLaneId: "mcp-read-lane",
          workerId: worker,
          worktreeId: tree,
          rootKind: "git-worktree",
          scratchRootId: null,
          permissionProfileId: ":workspace",
          allowedOperations: [
            "context.get",
            "task.create",
            "chat.list",
            "chat.read",
            "chat.wait",
          ],
          issuedAt,
          expiresAt,
        };
        async function call(
          name,
          operation,
          args,
          status = 200,
          claims = binding,
        ) {
          const response = await fetch(
            h.fixture.server.origin + "/api/internal/agent-operations",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + h.credential,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                requestId: randomUUID(),
                binding: claims,
                request: { operation, arguments: args },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.json();
          result.calls.push({
            name,
            operation,
            args,
            status: response.status,
            body,
            httpRequestId: response.headers.get("x-request-id"),
          });
          if (kind === "node")
            assert.equal(
              response.status,
              status,
              JSON.stringify({ name, body }),
            );
          return body;
        }
        await call("context with Task mutation grant", "context.get", {});
        await call("context ignores operation arguments", "context.get", {
          unknown: "Source ignores context arguments",
        });
        await call(
          "context after safe lane transition",
          "context.get",
          {},
          200,
          { ...binding, executionLaneId: "prior-lane" },
        );
        await call("context read-only attachment", "context.get", {}, 200, {
          ...binding,
          allowedOperations: ["context.get"],
        });
        await h.fixture.sql([
          `UPDATE chats SET status='idle' WHERE id=${literal(chat)}`,
        ]);
        await call("context between turns", "context.get", {});
        await h.fixture.sql([
          `UPDATE chats SET status='running',permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
        ]);
        await call(
          "context current read-only permission",
          "context.get",
          {},
          200,
          { ...binding, permissionProfileId: ":read-only" },
        );
        await call(
          "context permits read-only Alert reporting",
          "context.get",
          {},
          200,
          {
            ...binding,
            permissionProfileId: ":read-only",
            allowedOperations: ["context.get", "alert.raise"],
          },
        );
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
        ]);
        await call("project Agent chats", "chat.list", {});
        await call("Agent list tail page", "chat.list", {
          cursor: 10,
          limit: 1,
        });
        await call(
          "invalid Agent list arguments",
          "chat.list",
          { unknown: true },
          400,
        );
        await call("read current Agent transcript", "chat.read", {
          chatId: chat,
        });
        await call("wait reads the current Agent transcript", "chat.wait", {
          chatId: chat,
        });
        await call(
          "read missing Agent",
          "chat.read",
          { chatId: "missing" },
          404,
        );
        await call(
          "read missing target precedes argument validation",
          "chat.read",
          { unknown: true },
          404,
        );
        await call(
          "invalid Agent read arguments",
          "chat.read",
          { chatId: chat, unknown: true },
          400,
        );
        await call(
          "Agent read follows safe lane transition",
          "chat.read",
          { chatId: chat },
          200,
          { ...binding, executionLaneId: "prior-lane" },
        );
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
        ]);
        await call("read-only Agent discovery", "chat.list", {}, 200, {
          ...binding,
          permissionProfileId: ":read-only",
        });
        await call(
          "read-only Agent transcript",
          "chat.read",
          { chatId: chat },
          200,
          { ...binding, permissionProfileId: ":read-only" },
        );
        await h.fixture.sql([
          `UPDATE chats SET permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('mcp-default',${literal(h.owner)},'MCP default'),('mcp-selected',${literal(h.owner)},'MCP selected'),('mcp-subagent',${literal(h.owner)},'MCP subagent')`,
          `UPDATE user_settings SET default_model_id='mcp-default' WHERE user_id=${literal(h.owner)}`,
        ]);
        const recipient = "eeeeeeee-eeee-4eee-8eee-000000000300";
        const largeRecipient = "eeeeeeee-eeee-4eee-8eee-000000000301";
        const taskChat = "eeeeeeee-eeee-4eee-8eee-000000000302";
        const archivedChat = "eeeeeeee-eeee-4eee-8eee-000000000303";
        for (const [id, experience, position] of [
          [recipient, "agent", 10],
          [largeRecipient, "agent", 20],
          [taskChat, "task", 5],
          [archivedChat, "agent", 30],
        ]) {
          await h.fixture.sql([
            `INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id,active_worker_id,experience,position,created_at,updated_at) VALUES(${literal(id)},${literal(h.owner)},${literal(project)},${json(label("chat"))},${literal(tree)},${literal(worker)},${literal(experience)},${position},'2026-10-25','2026-10-25')`,
          ]);
        }
        await h.fixture.sql([
          `UPDATE chats SET model_id='mcp-selected',reasoning_effort='medium',custom_subagent_model=true,subagent_model_id='mcp-subagent',subagent_reasoning_effort='low' WHERE id=${literal(recipient)}`,
          `UPDATE chats SET archived_at='2026-10-25' WHERE id=${literal(archivedChat)}`,
          `INSERT INTO tasks(chat_id,state,plan_goal_enabled,protected_content) VALUES(${literal(taskChat)},'draft',false,${json(taskContent().protectedContent)})`,
        ]);
        const listed = await call(
          "Agent discovery excludes Tasks and archives",
          "chat.list",
          {},
        );
        assert.deepEqual(
          listed.data.chats.map((chat) => chat.id),
          [chat, recipient, largeRecipient],
        );
        assert.equal(listed.data.chats[0].configuration.modelId, "mcp-default");
        assert.deepEqual(listed.data.chats[1].configuration, {
          modelId: "mcp-selected",
          reasoningEffort: "medium",
          customSubagentModel: true,
          subagentModelId: "mcp-subagent",
          subagentReasoningEffort: "low",
        });
        const second = await call(
          "Agent discovery page uses stable order",
          "chat.list",
          { cursor: 1, limit: 1 },
        );
        assert.deepEqual(
          second.data.chats.map((chat) => chat.id),
          [recipient],
        );
        assert.equal(second.data.nextCursor, 2);
        await call(
          "Task transcript is outside Agent reads",
          "chat.read",
          { chatId: taskChat },
          404,
        );
        await call(
          "archived Agent transcript is excluded",
          "chat.read",
          { chatId: archivedChat },
          404,
        );
        const foreignProject = "eeeeeeee-eeee-4eee-8eee-000000000304",
          foreignChat = "eeeeeeee-eeee-4eee-8eee-000000000305",
          foreignTree = "eeeeeeee-eeee-4eee-8eee-000000000306";
        await h.fixture.sql([
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) VALUES(${literal(foreignProject)},${literal(h.owner)},${json(label("project"))},'github',true,true,'agent-managed',${literal(worker)},'mcp-foreign-project')`,
          `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('mcp-foreign-source',${literal(foreignProject)},${literal(worker)},'git','/worker-owned/mcp-foreign','/worker-owned/mcp-foreign')`,
          `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(foreignTree)},'mcp-foreign-source',${literal(worker)},'main','/worker-owned/mcp-foreign','/worker-owned/mcp-foreign',true,'cantrip','ready')`,
          `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience) VALUES(${literal(foreignChat)},${literal(h.owner)},${literal(foreignProject)},${literal(foreignTree)},${literal(worker)},${json(label("chat"))},'agent')`,
        ]);
        await call(
          "same-owner foreign project transcript is excluded",
          "chat.read",
          { chatId: foreignChat },
          404,
        );
        const protectedContent =
          securityFixtures.chatMessageOpaqueSummarySchema[0].protectedContent;
        for (let sequence = 1; sequence <= 7; sequence++) {
          const role = sequence === 1 || sequence === 4 ? "user" : "assistant";
          await h.fixture.sql([
            `INSERT INTO chat_messages(id,chat_id,worktree_id,sequence,role,mode,protected_content,created_at) VALUES(${literal("mcp-read-" + sequence)},${literal(recipient)},${literal(tree)},${sequence},${literal(role)},'default',${json(protectedContent)},'2026-10-25')`,
          ]);
        }
        const transcript = await call("opaque Agent transcript", "chat.read", {
          chatId: recipient,
        });
        assert.deepEqual(
          transcript.data.messages.map((message) => message.sequence),
          [1, 2, 3, 4, 5, 6, 7],
        );
        const exactCursor = (value) =>
          createHash("sha256")
            .update(
              JSON.stringify({
                chatId: value.chat.id,
                status: value.chat.status,
                paused: value.chat.automationPaused,
                messages: value.messages.map((message) => [
                  message.id,
                  message.sequence,
                  message.protectedContent,
                ]),
              }),
            )
            .digest("hex");
        assert.equal(transcript.data.cursor, exactCursor(transcript.data));
        const recent = await call(
          "Agent page retains complete latest user turn",
          "chat.read",
          { chatId: recipient, limit: 1 },
        );
        assert.deepEqual(
          recent.data.messages.map((message) => message.sequence),
          [4, 5, 6, 7],
        );
        assert.equal(recent.data.page.nextBeforeSequence, 4);
        assert.equal(recent.data.page.startsAtUserTurn, true);
        assert.equal(recent.data.cursor, transcript.data.cursor);
        const older = await call(
          "older Agent page retains complete user turn",
          "chat.read",
          { chatId: recipient, beforeSequence: 4, limit: 1 },
        );
        assert.deepEqual(
          older.data.messages.map((message) => message.sequence),
          [1, 2, 3],
        );
        assert.equal(older.data.page.hasMore, false);
        assert.equal(older.data.cursor, transcript.data.cursor);
        const empty = await call(
          "empty older page retains latest transcript cursor",
          "chat.read",
          { chatId: recipient, beforeSequence: 1, limit: 1 },
        );
        assert.deepEqual(empty.data.messages, []);
        assert.equal(empty.data.cursor, transcript.data.cursor);
        const chars = await call(
          "maxChars does not clip opaque server data",
          "chat.read",
          { chatId: recipient, maxChars: 1 },
        );
        assert.deepEqual(chars.data, transcript.data);
        await call(
          "invalid Agent history boundary",
          "chat.read",
          { chatId: recipient, beforeSequence: 0 },
          400,
        );
        const changed = structuredClone(protectedContent);
        changed.envelope.ciphertext = Buffer.alloc(
          Buffer.from(changed.envelope.ciphertext, "base64url").length,
          1,
        ).toString("base64url");
        await h.fixture.sql([
          `UPDATE chat_messages SET protected_content=${json(changed)} WHERE id='mcp-read-7'`,
        ]);
        const updated = await call(
          "opaque payload changes the Agent cursor",
          "chat.read",
          { chatId: recipient },
        );
        assert.notEqual(updated.data.cursor, transcript.data.cursor);
        assert.equal(updated.data.cursor, exactCursor(updated.data));
        await h.fixture.sql([
          `UPDATE chats SET automation_paused=true WHERE id=${literal(recipient)}`,
        ]);
        const paused = await call(
          "autonomy pause changes the Agent cursor",
          "chat.wait",
          { chatId: recipient },
        );
        assert.notEqual(paused.data.cursor, updated.data.cursor);
        assert.equal(paused.data.cursor, exactCursor(paused.data));
        await h.fixture.sql([
          `INSERT INTO chat_messages(id,chat_id,worktree_id,sequence,role,mode,protected_content,created_at) SELECT 'mcp-large-'||lpad(n::text,3,'0'),${literal(largeRecipient)},${literal(tree)},n,CASE WHEN n=1 THEN 'user' ELSE 'assistant' END,'default',jsonb_set(${json(protectedContent)},'{envelope,ciphertext}',to_jsonb(repeat('A',70000))),'2026-10-25' FROM generate_series(1,100) n`,
        ]);
        const capped = await call(
          "six MiB Agent relay retains maximal message suffix",
          "chat.read",
          { chatId: largeRecipient },
        );
        const messages = capped.data.messages;
        assert.ok(messages.length > 0 && messages.length < 100);
        const bytes = messages.reduce(
          (sum, message) => sum + Buffer.byteLength(JSON.stringify(message)),
          0,
        );
        assert.ok(bytes <= 6 * 1024 * 1024);
        assert.equal(messages.at(-1).sequence, 100);
        assert.equal(capped.data.page.hasMore, true);
        assert.equal(capped.data.page.oldestSequence, messages[0].sequence);
        assert.equal(capped.data.page.nextBeforeSequence, messages[0].sequence);
        assert.equal(capped.data.page.startsAtUserTurn, false);
        const previous = structuredClone(messages[0]);
        previous.sequence--;
        previous.id = "mcp-large-" + String(previous.sequence).padStart(3, "0");
        previous.role = previous.sequence === 1 ? "user" : "assistant";
        assert.ok(
          bytes + Buffer.byteLength(JSON.stringify(previous)) > 6 * 1024 * 1024,
          "The previous actual-shaped stored message cannot fit in the Source relay budget",
        );
        result.relayBudgetProof = {
          storedMessages: 100,
          retainedMessages: messages.length,
          bytes,
          firstSequence: messages[0].sequence,
        };
        h.worker.close();
        await h.live.close();
        const port = Number(new URL(h.fixture.server.origin).port);
        await h.fixture.close();
        await h.fixture.start({ port });
        await h.reconnectWorker();
        await call(
          "recovered caller requires an active turn before Agent reads",
          "chat.read",
          { chatId: recipient },
          409,
        );
        // Recovery ends the old controlled turn. Establish the next owned turn
        // without changing the receiving transcript or its model/pause state.
        await h.fixture.sql([
          `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
        ]);
        binding.issuedAt = new Date().toISOString();
        binding.expiresAt = new Date(Date.now() + 120000).toISOString();
        const retained = await call(
          "Agent opaque transcript and cursor survive server restart",
          "chat.read",
          { chatId: recipient },
        );
        assert.deepEqual(retained.data, paused.data);
        result.actualServerRestartVerified = true;
        await h.fixture.sql([
          `UPDATE chats SET position=-1 WHERE id=${literal(taskChat)}`,
        ]);
        await call(
          "invalid hidden Task descriptor fails before filtering",
          "chat.list",
          {},
          400,
        );
        await call(
          "invalid hidden descriptor precedes missing target lookup",
          "chat.read",
          { chatId: "missing" },
          400,
        );
        await h.fixture.sql([
          `UPDATE chats SET position=5 WHERE id=${literal(taskChat)}`,
        ]);

        async function queryFailure(name, operation, args, key, params) {
          const body = await call(name, operation, args, 400);
          const sql =
            key === "rows"
              ? readQueries.rows.replace(
                  "__mcp_sequence_parameters__",
                  params
                    .slice(3)
                    .map((_, i) => "$" + (i + 4))
                    .join(", "),
                )
              : readQueries[key];
          assert.deepEqual(
            body,
            {
              code: "invalid",
              error: (
                "Failed query: " +
                sql +
                "\nparams: " +
                params.join(",")
              ).slice(0, 2000),
            },
            "The actual failure retains exact Source query, parameters and UTF-16 truncation",
          );
          const observed = result.calls.at(-1);
          observed.verifiedQueryFailure = { key, sql, params };
          observed.comparisonBody = {
            code: "invalid",
            error:
              "<verified exact Source " +
              key +
              " query failure with actual peer parameters>",
          };
        }
        await h.fixture.sql([
          "ALTER TABLE chats RENAME TO mcp_chat_storage",
          `CREATE FUNCTION mcp_catalog_fault(selected_chat text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$ BEGIN IF selected_chat=${literal(recipient)} THEN RAISE EXCEPTION 'owned MCP catalog read failure'; END IF; RETURN true; END $$`,
          "CREATE VIEW chats AS SELECT c.* FROM mcp_chat_storage c WHERE mcp_catalog_fault(c.id)",
        ]);
        await queryFailure(
          "actual Agent catalog query failure",
          "chat.list",
          {},
          "list",
          [h.owner, project],
        );
        await queryFailure(
          "catalog query failure precedes list argument parsing",
          "chat.list",
          { unknown: true },
          "list",
          [h.owner, project],
        );
        await h.fixture.sql([
          "DROP VIEW chats",
          "ALTER TABLE mcp_chat_storage RENAME TO chats",
          "DROP FUNCTION mcp_catalog_fault(text)",
        ]);
        await h.fixture.sql([
          "ALTER TABLE chat_messages RENAME TO mcp_message_storage",
          `CREATE FUNCTION mcp_header_fault(selected_chat text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$ BEGIN IF selected_chat=${literal(recipient)} THEN RAISE EXCEPTION 'owned MCP header read failure'; END IF; RETURN true; END $$`,
          "CREATE VIEW chat_messages AS SELECT m.* FROM mcp_message_storage m WHERE mcp_header_fault(m.chat_id)",
        ]);
        await queryFailure(
          "actual Agent header query failure",
          "chat.read",
          { chatId: recipient },
          "headers",
          ["agent", h.owner, recipient, 501],
        );
        await queryFailure(
          "actual older Agent header query failure",
          "chat.read",
          { chatId: recipient, beforeSequence: 4, limit: 1 },
          "headersBefore",
          ["agent", h.owner, recipient, 4, 501],
        );
        await h.fixture.sql([
          "DROP VIEW chat_messages",
          "DROP FUNCTION mcp_header_fault(text)",
        ]);
        const [columns] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('columns',jsonb_agg(column_name ORDER BY ordinal_position))::text result FROM information_schema.columns WHERE table_schema='public' AND table_name='mcp_message_storage'",
          ],
        );
        await h.fixture.sql([
          "CREATE FUNCTION mcp_row_fault(payload jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'owned MCP opaque row read failure'; END $$",
          "CREATE VIEW chat_messages AS SELECT " +
            columns.columns
              .map((name) =>
                name === "content"
                  ? 'mcp_row_fault(m."content") AS "content"'
                  : 'm."' + name.replaceAll('"', '""') + '"',
              )
              .join(",") +
            " FROM mcp_message_storage m",
        ]);
        await queryFailure(
          "actual Agent opaque row query failure",
          "chat.read",
          { chatId: recipient },
          "rows",
          ["agent", h.owner, recipient, 7, 6, 5, 4, 3, 2, 1],
        );
        await queryFailure(
          "actual older Agent opaque row query failure",
          "chat.read",
          { chatId: recipient, beforeSequence: 4, limit: 1 },
          "rows",
          ["agent", h.owner, recipient, 3, 2, 1],
        );
        await h.fixture.sql([
          "DROP VIEW chat_messages",
          "ALTER TABLE mcp_message_storage RENAME TO chat_messages",
          "DROP FUNCTION mcp_row_fault(jsonb)",
        ]);
        const [audit] = await h.fixture.sql(
          [],
          [
            "SELECT jsonb_build_object('events',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_events a WHERE a.action LIKE 'mcp.operation.%'),'[]'::jsonb))::text result",
          ],
        );
        const calls = new Map(result.calls.map((c) => [c.httpRequestId, c]));
        assert.equal(audit.events.length, result.calls.length);
        result.auditEvents = audit.events.map((event) => {
          const call = calls.get(event.request_id);
          assert.ok(
            call,
            "Actual audit request identity names an observed call",
          );
          assert.equal(event.owner_id, h.owner);
          assert.equal(event.actor_user_id, null);
          assert.equal(event.actor_session_id, null);
          assert.equal(event.resource_type, "mcp-binding");
          assert.equal(event.resource_id, binding.bindingId);
          assert.equal(
            event.action,
            call.status === 200
              ? "mcp.operation.executed"
              : "mcp.operation.rejected",
          );
          const outcome =
            call.status === 200
              ? "succeeded"
              : ["forbidden", "stale-binding", "expired"].includes(
                    call.body.code,
                  )
                ? "denied"
                : "failed";
          assert.equal(event.result, outcome);
          assert.ok(
            Number.isFinite(Date.parse(event.occurred_at)) &&
              Date.parse(event.occurred_at) <= Date.now() + 1000,
          );
          return {
            case: call.name,
            action: event.action,
            result: event.result,
            resourceType: event.resource_type,
            resourceId: event.resource_id,
          };
        });
      } finally {
        result.serverDiagnostics = h.diagnostics();
        await h.close();
        h = undefined;
      }
    }
    const [node, rust] = p.peers;
    assert.equal(node.calls.length, rust.calls.length);
    for (let i = 0; i < node.calls.length; i++) {
      const a = node.calls[i],
        b = rust.calls[i];
      assert.equal(a.name, b.name);
      if (
        !isDeepStrictEqual(
          [a.status, a.comparisonBody ?? a.body],
          [b.status, b.comparisonBody ?? b.body],
        )
      )
        p.differences.push({ name: a.name, node: a, rust: b });
    }
    if (!isDeepStrictEqual(node.auditEvents, rust.auditEvents))
      p.auditDifferences.push({
        node: node.auditEvents,
        rust: rust.auditEvents,
      });
  }
  report.compatibilityPassed = report.profiles.every(
    (p) => p.differences.length === 0 && p.auditDifferences.length === 0,
  );
  report.investigationCompleted = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await h?.close();
  await pg?.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: reportPath,
      compatibilityPassed: report.compatibilityPassed,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        callsPerPeer: p.peers.map((v) => v.calls.length),
        differences: p.differences.length,
      })),
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;

assert.equal(
  report.compatibilityPassed,
  true,
  "All MCP context/chat response and audit observations must match Source",
);
