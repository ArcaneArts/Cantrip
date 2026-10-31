// Real HTTP, Live and unchanged worker transport, using the production worker's
// message encryption/reprotection functions with a test-owned endpoint key.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { label, json, literal } from "./project-target-state.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import {
  protectChatMessage,
  reprotectChatMessages,
} from "../../cantrip_worker/src/chat-message-encryption.ts";
import { decryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-fork-http-"));
const uuid = (g, n = 0) =>
  `${g.repeat(8)}-${g.repeat(4)}-4${g.repeat(3)}-8${g.repeat(3)}-${String(n).padStart(12, "0")}`;
const project = uuid("1"),
  source = uuid("2"),
  standalone = uuid("3"),
  scratch = uuid("4"),
  tree = uuid("5"),
  fork = (n) => uuid("6", n),
  messageId = (n) => uuid("7", n),
  task = uuid("8"),
  plain = uuid("9");
const workerId = "fork-worker",
  titleProtection = label("chat"),
  componentKey = new Uint8Array(32).fill(19);
const capabilities = {
  protocolVersion: 1,
  scratch: Object.fromEntries(
    [
      "provision",
      "resolve",
      "archive",
      "restore",
      "remove",
      "reconcile",
      "routingHandles",
    ].map((k) => [k, true]),
  ),
  files: heartbeat.standaloneChat.files,
};
const report = {
  suite: "actual-encrypted-chat-fork-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, failure;
async function until(read, check, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    try {
      check(v);
      return v;
    } catch (e) {
      if (Date.now() >= end) throw e;
    }
    await delay(20);
  }
}
const digest = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const date = (n) => new Date(Date.UTC(2026, 9, 25, 0, 0, n, 123)).toISOString();
try {
  const passwordHash = await hashPassword(password),
    executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"]) {
    const outputs = [];
    report.profiles.push({ profile, runtimes: outputs });
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = {
        kind,
        observations: [],
        rawCommands: [],
        commands: [],
        cryptoProofs: [],
        rootCommands: [],
        events: [],
      };
      outputs.push(result);
      let repository,
        worker,
        live,
        foreign,
        mode = "success",
        hold,
        connections = 0,
        runtimeFailure,
        owner;
      const provisionGates = new Map(),
        expected = new Map(),
        usedIds = new Set();
      const visit = async (name, method, route, options = {}) => {
        result.observations.push({
          label: name,
          ...(await fixture.observe(name, method, route, {
            csrf:
              !["GET", "HEAD"].includes(method) &&
              !!fixture.client(options.client).csrf,
            ...options,
          })),
        });
        return fixture.records.get(name);
      };
      const repoOpen = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl: url,
        });
      const chatEvents = () =>
        live.history.filter((e) => e.type === "event" && e.resource === "chat");
      const forEntity = (id) => chatEvents().filter((e) => e.entityId === id);
      try {
        await fixture.start();
        if (profile === "accounts")
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `fork-${client}@example.invalid`,
                displayName: "Fork " + client,
                password,
              },
            });
        else {
          await visit("session", "GET", "/api/auth/session");
          if (profile === "password")
            await visit("login", "POST", "/api/auth/login", {
              json: { password },
            });
        }
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 201, json: { label: "Fork worker" } },
        );
        await visit("enrollment", "POST", "/api/internal/workers/enroll", {
          client: "worker",
          status: 201,
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: { ...heartbeat, workerId, standaloneChat: capabilities },
          },
        });
        await fixture.close();
        repository = await repoOpen();
        const owned = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('owner',owner_id) result FROM workers WHERE id=${literal(workerId)}`,
        });
        assert.equal(owned.rejected, false, owned.diagnostic);
        owner = owned.value.owner;
        assert.equal(typeof owner, "string");
        const encryption = {
          ownerId: () => owner,
          componentKey: () => ({
            key: new Uint8Array(componentKey),
            keyRevision: 2,
          }),
        };
        const statements = [
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) VALUES(${literal(project)},${literal(owner)},${json(label("project"))},'github',true,true,'agent-managed',${literal(workerId)},'fork-project')`,
          `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('fork-source',${literal(project)},${literal(workerId)},'git','/worker-owned/fork','/worker-owned/fork')`,
          `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(tree)},'fork-source',${literal(workerId)},'main','/worker-owned/fork','/worker-owned/fork',true,'cantrip','ready')`,
          ...[
            [source, "agent"],
            [task, "task"],
            [plain, "agent"],
          ].map(
            ([id, experience]) =>
              `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience) VALUES(${literal(id)},${literal(owner)},${literal(project)},${literal(tree)},${literal(workerId)},${json(titleProtection)},${literal(experience)})`,
          ),
          `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label) VALUES(${literal(standalone)},${literal(owner)},'standalone',${literal(workerId)},${literal(scratch)},NULL,${json(titleProtection)})`,
          `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle) VALUES(${literal(scratch)},${literal(standalone)},${literal(owner)},${literal(workerId)},'ready',${literal("ctrr_" + "a".repeat(43))})`,
        ];
        const tx = await repository.request({ op: "transaction", statements });
        assert.equal(tx.rejected, false, tx.diagnostic);
        for (const [chat, count, offset] of [
          [source, 205, 0],
          [standalone, 3, 205],
        ]) {
          const rows = [];
          for (let n = 0; n < count; n++) {
            const id = messageId(offset + n),
              content = [
                { type: "text", text: `SENTINEL fork body ${offset + n} 🦀` },
              ],
              role = n % 2 ? "assistant" : "user";
            const protectedMessage = await protectChatMessage({
              id,
              message: {
                role,
                mode: "default",
                content,
                reasoningEffort: "high",
                idempotencyKey: "original:" + (offset + n),
              },
              service: encryption,
            });
            expected.set(id, {
              content,
              role,
              createdAt: date(offset + n),
              reasoningEffort: "high",
              idempotencyKey: protectedMessage.idempotencyKey,
            });
            rows.push(
              `(${literal(id)},${literal(chat)},${chat === source ? literal(tree) : "NULL"},${chat === standalone ? literal(scratch) : "NULL"},${literal(role)},'default',${json(protectedMessage.protectedContent)},'[]','high',${literal(protectedMessage.idempotencyKey)},${literal(date(offset + n))})`,
            );
          }
          await repository.seed(
            "INSERT INTO chat_messages(id,chat_id,worktree_id,scratch_root_id,role,mode,protected_content,attachment_ids,reasoning_effort,idempotency_key,created_at) VALUES" +
              rows.join(","),
          );
        }
        await repository.seed(
          `INSERT INTO chat_messages(id,chat_id,worktree_id,role,content) VALUES('visible-source',${literal(plain)},${literal(tree)},'user','[]')`,
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("forks", [
          { kind: "current-user" },
          { kind: "project", projectId: project },
        ]);
        if (profile === "accounts") {
          foreign = await new LiveProbe(fixture, { client: "other" }).open();
          await foreign.initialized();
          await foreign.subscribed();
        }
        const config = {
          dataDirectory: path.join(root, profile, kind, "controlled-worker"),
          name: "Fork transport",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("enrollment").credential,
          tokenSource: "persisted",
          workerId,
        };
        saveWorkerCredential({
          credential: config.token,
          dataDirectory: config.dataDirectory,
          serverUrl: config.serverUrl,
          workerId,
        });
        const reconciliations = [];
        worker = new WorkerConnection(
          config,
          async (command) => {
            if (command.type === "chat.scratch.reconcile") {
              reconciliations.push(command);
              return {
                retainedRootIds: command.roots.map((r) => r.rootId),
                missingRootIds: [],
                orphanedRootIds: [],
                dueRootIds: [],
              };
            }
            if (command.type === "chat.scratch.provision") {
              result.rootCommands.push(command);
              await new Promise((resolve) =>
                provisionGates.set(command.chatId, resolve),
              );
              return {
                status: "ready",
                jobId: command.jobId,
                attempt: command.attempt,
                rootId: command.rootId,
                chatId: command.chatId,
                path:
                  "ctrr_" +
                  createHash("sha256")
                    .update(command.chatId)
                    .digest("base64url"),
                displayPath:
                  "ctrr_" +
                  createHash("sha256")
                    .update(command.chatId)
                    .digest("base64url"),
                reused: false,
              };
            }
            if (command.type !== "chat.messages.reprotect")
              throw new Error("Controlled fork command is unsupported");
            result.rawCommands.push(command);
            const normalized = fixture.normalize({
              ...command,
              messages: command.messages.map((entry) => ({
                ...entry,
                source: {
                  ...entry.source,
                  protectedContent: "<verified encrypted source>",
                },
              })),
            });
            result.commands.push(normalized);
            for (const entry of command.messages) {
              assert.equal(
                usedIds.has(entry.id),
                false,
                "new message identities are unique",
              );
              usedIds.add(entry.id);
              assert.notEqual(entry.id, entry.source.id);
              assert.equal(entry.idempotencyKey, "fork:" + entry.source.id);
              const metadata = expected.get(entry.source.id);
              assert.equal(entry.source.createdAt, metadata.createdAt);
              assert.equal(
                entry.source.reasoningEffort,
                metadata.reasoningEffort,
              );
              assert.equal(
                entry.source.idempotencyKey,
                metadata.idempotencyKey,
              );
            }
            if (hold && !hold.requested) {
              hold.requested = true;
              await new Promise((resolve) => {
                hold.release = resolve;
              });
            }
            if (mode === "worker-error")
              throw new Error("Controlled fork worker failure");
            if (mode === "duplicate-error")
              throw new Error("Controlled duplicate fork failure");
            if (mode === "invalid") return { invalid: true };
            const copies = await reprotectChatMessages({
              messages: command.messages,
              service: encryption,
            });
            for (let n = 0; n < copies.length; n++) {
              const copy = copies[n],
                sourceMessage = command.messages[n].source;
              const opened = await decryptChatMessageProtectedContent({
                ownerId: owner,
                messageId: copy.id,
                keyRevision: 2,
                componentKey,
                encrypted: copy.protectedContent,
                publicClassification: copy.classification,
              });
              assert.deepEqual(
                opened.content,
                expected.get(sourceMessage.id).content,
              );
              await assert.rejects(() =>
                decryptChatMessageProtectedContent({
                  ownerId: owner,
                  messageId: sourceMessage.id,
                  keyRevision: 2,
                  componentKey,
                  encrypted: copy.protectedContent,
                  publicClassification: copy.classification,
                }),
              );
              assert.notDeepEqual(
                copy.protectedContent,
                sourceMessage.protectedContent,
              );
              result.cryptoProofs.push({
                id: fixture.normalize(copy.id),
                sourceId: sourceMessage.id,
                contentSha256: digest(opened.content),
                oldBindingRejected: true,
              });
            }
            if (mode === "classification")
              copies[0].classification.role =
                copies[0].classification.role === "user" ? "assistant" : "user";
            return copies;
          },
          undefined,
          undefined,
          undefined,
          1000,
          () => connections++,
        );
        worker.start();
        await until(
          () => connections,
          (n) => assert.equal(n, 1),
        );
        await until(
          () => reconciliations.length,
          (n) => assert.equal(n, 1),
        );
        assert.deepEqual(
          reconciliations[0].roots.map((r) => r.rootId),
          [scratch],
        );
        for (const input of [
          undefined,
          null,
          {},
          [],
          { id: fork(0), titleProtection: label("project") },
          { id: fork(0), titleProtection, extra: 1 },
        ])
          await visit(
            "invalid fork " + JSON.stringify(input),
            "POST",
            "/api/chats/" + source + "/fork",
            { status: 400, ...(input === undefined ? {} : { json: input }) },
          );
        const body = (id) => ({
          id,
          titleProtection,
          attachToTabLayout: false,
        });
        await visit("missing source", "POST", "/api/chats/missing/fork", {
          status: 404,
          json: body(fork(0)),
        });
        await visit(
          "Task relocation required",
          "POST",
          "/api/chats/" + task + "/fork",
          { status: 409, json: body(fork(0)) },
        );
        await visit(
          "visible source refused",
          "POST",
          "/api/chats/" + plain + "/fork",
          { status: 404, json: body(fork(0)) },
        );
        await visit(
          "missing selected message",
          "POST",
          "/api/chats/" + source + "/fork",
          { status: 404, json: { ...body(fork(0)), messageId: "missing" } },
        );
        await visit(
          "standalone worktree settings refused",
          "POST",
          "/api/chats/" + standalone + "/fork",
          { status: 409, json: { ...body(fork(0)), worktreeMode: "pinned" } },
        );
        if (profile === "accounts")
          await visit(
            "foreign source",
            "POST",
            "/api/chats/" + source + "/fork",
            { client: "other", status: 404, json: body(fork(0)) },
          );
        assert.equal(
          result.commands.length,
          0,
          "admission failures do not dispatch protected history",
        );
        let before = result.commands.length;
        await visit(
          "project full history",
          "POST",
          "/api/chats/" + source + "/fork",
          { status: 201, json: body(fork(1)) },
        );
        assert.deepEqual(
          result.commands.slice(before).map((c) => c.messages.length),
          [100, 100, 5],
        );
        await visit(
          "duplicate project fork uses source statement-message matching",
          "POST",
          "/api/chats/" + source + "/fork",
          { status: 500, json: body(fork(1)) },
        );
        before = result.commands.length;
        await visit(
          "project history prefix",
          "POST",
          "/api/chats/" + source + "/fork",
          {
            status: 201,
            json: {
              ...body(fork(2)),
              messageId: messageId(100),
              attachToTabLayout: true,
            },
          },
        );
        assert.deepEqual(
          result.commands.slice(before).map((c) => c.messages.length),
          [100, 1],
        );
        before = result.commands.length;
        await visit(
          "standalone encrypted history",
          "POST",
          "/api/chats/" + standalone + "/fork",
          { status: 202, json: body(fork(3)) },
        );
        assert.deepEqual(
          result.commands.slice(before).map((c) => c.messages.length),
          [3],
        );
        await until(
          () => provisionGates.has(fork(3)),
          (v) => assert.equal(v, true),
        );
        await live.ping("held fork provisioning");
        assert.equal(forEntity(fork(3)).length, 1);
        provisionGates.get(fork(3))();
        provisionGates.delete(fork(3));
        await until(
          () => forEntity(fork(3)).length,
          (n) => assert.equal(n, 2),
        );
        for (const fault of [
          "worker-error",
          "duplicate-error",
          "invalid",
          "classification",
        ]) {
          mode = fault;
          await visit(
            "worker reprotection " + fault,
            "POST",
            "/api/chats/" + source + "/fork",
            {
              status: fault === "duplicate-error" ? 409 : 500,
              json: { ...body(fork(4)), messageId: messageId(0) },
            },
          );
        }
        mode = "success";
        hold = { requested: false };
        let callerError, unexpectedResponse;
        const caller = httpRequest(
          fixture.server.origin + "/api/chats/" + source + "/fork",
          {
            method: "POST",
            agent: false,
            headers: {
              origin: "http://127.0.0.1:5173",
              "content-type": "application/json",
              cookie: [...fixture.client().cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
              ...(fixture.client().csrf
                ? { "x-cantrip-csrf": fixture.client().csrf }
                : {}),
            },
          },
          (response) => {
            unexpectedResponse = response.statusCode;
            response.resume();
          },
        );
        caller.on("error", (e) => {
          callerError = e.message;
        });
        const closed = new Promise((resolve) => caller.once("close", resolve));
        caller.end(
          JSON.stringify({ ...body(fork(5)), messageId: messageId(0) }),
        );
        await until(
          () => !!hold.release,
          (v) => assert.equal(v, true),
        );
        caller.destroy(new Error("Controlled fork caller disconnect"));
        await closed;
        assert.equal(callerError, "Controlled fork caller disconnect");
        assert.equal(unexpectedResponse, undefined);
        hold.release();
        await until(
          () => forEntity(fork(5)).length,
          (n) => assert.equal(n, 1),
        );
        hold = undefined;
        result.disconnected = { callerError, protectedCopyCommitted: true };
        worker.close();
        worker = undefined;
        await until(
          async () => {
            const response = await fetch(
              fixture.server.origin + "/api/workers",
              {
                headers: {
                  cookie: [...fixture.client().cookies]
                    .map(([k, v]) => `${k}=${v}`)
                    .join("; "),
                },
              },
            );
            assert.equal(response.status, 200);
            return response.json();
          },
          (workers) =>
            assert.equal(
              workers.find((w) => w.workerId === workerId).online,
              false,
            ),
        );
        await visit(
          "offline project source",
          "POST",
          "/api/chats/" + source + "/fork",
          { status: 503, json: body(fork(6)) },
        );
        await visit(
          "offline standalone source",
          "POST",
          "/api/chats/" + standalone + "/fork",
          { status: 503, json: body(fork(6)) },
        );
        await visit(
          "Task rejected before offline check",
          "POST",
          "/api/chats/" + task + "/fork",
          { status: 409, json: body(fork(6)) },
        );
        await live.ping("fork events complete");
        result.rawEvents = chatEvents();
        result.events = result.rawEvents.map(
          ({ scope, resource, action, entityId, revision, payload }) =>
            fixture.normalize({
              scope,
              resource,
              action,
              entityId,
              revision,
              payload,
            }),
        );
        assert.equal(result.events.length, 8);
        if (foreign) {
          await foreign.ping("fork owner isolation");
          assert.equal(
            foreign.history.filter(
              (e) => e.type === "event" && e.resource === "chat",
            ).length,
            0,
          );
        }
        await live.close();
        live = undefined;
        await foreign?.close();
        foreign = undefined;
        result.diagnostics = fixture.server.diagnostics();
        assert.equal(result.diagnostics.includes("SENTINEL fork body"), false);
        await fixture.close();
        repository = await repoOpen();
        const state = await repository.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'roots',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id) FROM standalone_chat_roots r),'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY chat_id,kind) FROM standalone_chat_root_jobs j),'runtimes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id) FROM chat_runtime_sessions r),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY chat_id) FROM chat_execution_lanes l),'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY region,position) FROM tab_groups g),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY tab_key) FROM tab_group_members m)) result",
        });
        assert.equal(state.rejected, false, state.diagnostic);
        result.rawState = state.value;
        for (const [id, count] of [
          [fork(1), 205],
          [fork(2), 101],
          [fork(3), 3],
          [fork(5), 1],
        ]) {
          const rows = state.value.messages.filter((m) => m.chat_id === id);
          assert.equal(rows.length, count);
          for (const row of rows) {
            assert.equal(row.content, null);
            assert.equal(row.task_protected_content, null);
            assert.equal(row.reasoning_effort, "high");
            const sourceId = row.idempotency_key.slice("fork:".length);
            const opened = await decryptChatMessageProtectedContent({
              ownerId: owner,
              messageId: row.id,
              keyRevision: 2,
              componentKey,
              encrypted: row.protected_content,
              publicClassification: {
                role: row.role,
                mode: row.mode,
                attachmentIds: row.attachment_ids,
              },
            });
            assert.deepEqual(opened.content, expected.get(sourceId).content);
            assert.equal(row.scratch_root_id !== null, id === fork(3));
          }
        }
        assert.equal(
          state.value.chats.some((c) => c.id === fork(4) || c.id === fork(6)),
          false,
        );
        const normalize = (v, key = "") =>
          Array.isArray(v)
            ? v.map((x) => normalize(x))
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v).map(([k, x]) => [
                    k,
                    k === "protected_content" && x !== null
                      ? "<verified encrypted content>"
                      : normalize(x, k),
                  ]),
                )
              : typeof v === "string" && key.endsWith("_at")
                ? (assert.ok(Number.isFinite(Date.parse(v))), "<timestamp>")
                : fixture.normalize(v, key);
        result.state = normalize(state.value);
        result.rawRootCommands = result.rootCommands;
        result.rootCommands = result.rootCommands.map((c) =>
          fixture.normalize(c),
        );
        result.reconciliation = fixture.normalize(reconciliations);
      } catch (error) {
        runtimeFailure = error;
        result.failure = { message: error.message, stack: error.stack };
        result.diagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        hold?.release?.();
        for (const release of provisionGates.values()) release();
        for (const cleanup of [
          () => worker?.close(),
          () => live?.close(),
          () => foreign?.close(),
          () => fixture.close(),
          () => repository?.close(),
        ])
          try {
            await cleanup();
          } catch (error) {
            runtimeFailure ??= error;
            (result.cleanupFailures ??= []).push(String(error));
          }
        if (runtimeFailure && !result.failure) throw runtimeFailure;
      }
    }
    for (const key of [
      "observations",
      "commands",
      "cryptoProofs",
      "rootCommands",
      "events",
      "state",
      "disconnected",
      "reconciliation",
    ])
      assert.deepEqual(outputs[1][key], outputs[0][key], profile + ": " + key);
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.databaseCleanupFailure = String(error);
  }
  if (failure) report.passed = false;
  if (option("--report")) {
    const p = path.resolve(option("--report"));
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.length,
    passed: true,
  }),
);
