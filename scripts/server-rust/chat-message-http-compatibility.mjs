// Real HTTP and Live, with production endpoint encryption and no server keys.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { label, json, literal, stamp } from "./project-target-state.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
import { decryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
import { chatMessageHttpRaces } from "./chat-message-http-races.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-message-http-"));
const uuid = (group, n = 0) =>
  `${group.repeat(8)}-${group.repeat(4)}-4${group.repeat(3)}-8${group.repeat(3)}-${String(n).padStart(12, "0")}`;
const project = uuid("1"),
  agent = uuid("2"),
  standalone = uuid("3"),
  scratch = uuid("4"),
  tree = uuid("5"),
  messageId = (n) => uuid("6", n),
  task = uuid("8"),
  archived = uuid("9"),
  workerId = "message-worker",
  componentKey = new Uint8Array(32).fill(23);
const report = {
  suite: "actual-encrypted-chat-message-http-live",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, failure;
try {
  const passwordHash = await hashPassword(password),
    executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
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
      const result = { kind, observations: [], cryptoProofs: [], events: [] };
      runtimes.push(result);
      let repository, live, owner;
      const expected = new Map(),
        proven = new Set();
      const repoOpen = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl: url,
        });
      async function protect(n, chat, content, extra = {}) {
        const id = messageId(n),
          message = {
            role: "user",
            mode: "default",
            content,
            reasoningEffort: null,
            idempotencyKey: "message:" + n,
            ...extra,
          };
        const input = await protectChatMessage({
          id,
          message,
          service: {
            ownerId: () => owner,
            componentKey: () => ({
              key: new Uint8Array(componentKey),
              keyRevision: 2,
            }),
          },
        });
        expected.set(id, {
          chat,
          content: message.content,
          role: message.role,
          mode: message.mode,
          attachmentIds: input.classification.attachmentIds,
        });
        return input;
      }
      async function prove(message) {
        const e = expected.get(message.id);
        assert.ok(e, "known endpoint message identity");
        assert.equal(message.chatId, e.chat);
        const opened = await decryptChatMessageProtectedContent({
          ownerId: owner,
          messageId: message.id,
          keyRevision: 2,
          componentKey,
          encrypted: message.protectedContent,
          publicClassification: {
            role: message.role,
            mode: message.mode,
            attachmentIds: message.attachmentIds,
          },
        });
        assert.deepEqual(opened.content, e.content);
        assert.equal(message.role, e.role);
        assert.equal(message.mode, e.mode);
        await assert.rejects(() =>
          decryptChatMessageProtectedContent({
            ownerId: owner,
            messageId: messageId(9999),
            keyRevision: 2,
            componentKey,
            encrypted: message.protectedContent,
            publicClassification: {
              role: message.role,
              mode: message.mode,
              attachmentIds: message.attachmentIds,
            },
          }),
        );
        result.cryptoProofs.push({
          id: message.id,
          chatId: message.chatId,
          newBindingOpened: true,
          wrongBindingRejected: true,
        });
        proven.add(message.id);
      }
      async function proveBody(value) {
        if (Array.isArray(value)) {
          for (const v of value) await proveBody(v);
        } else if (value && typeof value === "object") {
          if (
            value.id &&
            value.chatId &&
            value.protectedContent &&
            value.role &&
            value.contextKind
          ) {
            await prove(value);
            return;
          }
          if (value.id === "task-message" && value.chatId === task) {
            assert.deepEqual(
              value.protectedContent,
              label("chat").protectedLabel,
            );
            return;
          }
          for (const v of Object.values(value)) await proveBody(v);
        }
      }
      function normalized(value) {
        if (Array.isArray(value)) return value.map(normalized);
        if (value && typeof value === "object") {
          if (
            value.id &&
            value.chatId &&
            value.protectedContent &&
            value.role &&
            value.contextKind
          ) {
            assert.ok(proven.has(value.id));
            return fixture.normalize({
              ...value,
              protectedContent: {
                ...value.protectedContent,
                envelope: {
                  ...value.protectedContent.envelope,
                  nonce: "<verified-nonce>",
                  ciphertext: "<verified-ciphertext>",
                },
              },
            });
          }
          return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, normalized(v)]),
          );
        }
        return value;
      }
      async function visit(name, method, route, options = {}) {
        const observation = await fixture.observe(name, method, route, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        const body = fixture.records.get(name);
        await proveBody(body);
        // Normalize ciphertext only after opening each actual endpoint binding.
        observation.body = normalized(observation.body);
        result.observations.push({ label: name, ...observation });
        return body;
      }
      try {
        await fixture.start();
        if (profile === "accounts")
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `message-${client}@example.invalid`,
                displayName: "Message " + client,
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
          { status: 201, json: { label: "Message worker" } },
        );
        await visit("enrollment", "POST", "/api/internal/workers/enroll", {
          client: "worker",
          status: 201,
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: { ...heartbeat, workerId },
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
        const statements = [
          `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,worktree_policy,preferred_worker_id,github_repository_blind_index) VALUES(${literal(project)},${literal(owner)},${json(label("project"))},'github',true,true,'agent-managed',${literal(workerId)},'message-project')`,
          `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('message-source',${literal(project)},${literal(workerId)},'git','/worker-owned/messages','/worker-owned/messages')`,
          `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(tree)},'message-source',${literal(workerId)},'main','/worker-owned/messages','/worker-owned/messages',true,'cantrip','ready')`,
          ...[
            [agent, "agent"],
            [task, "task"],
            [archived, "agent"],
          ].map(
            ([id, experience]) =>
              `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,archived_at) VALUES(${literal(id)},${literal(owner)},${literal(project)},${literal(tree)},${literal(workerId)},${json(label("chat"))},${literal(experience)},${id === archived ? literal(stamp) : "NULL"})`,
          ),
          `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label) VALUES(${literal(standalone)},${literal(owner)},'standalone',${literal(workerId)},${literal(scratch)},NULL,${json(label("chat"))})`,
          `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle) VALUES(${literal(scratch)},${literal(standalone)},${literal(owner)},${literal(workerId)},'ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
        ];
        const tx = await repository.request({ op: "transaction", statements });
        assert.equal(tx.rejected, false, tx.diagnostic);
        for (let i = 0; i < 20; i++) {
          const p = await protect(
            i,
            agent,
            [{ type: "text", text: "SENTINEL message body " + i }],
            { role: i === 0 || i === 10 ? "user" : "assistant" },
          );
          await repository.seed(
            `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,protected_content,attachment_ids,idempotency_key,created_at) VALUES(${literal(p.id)},${literal(agent)},${literal(tree)},${literal(p.classification.role)},'default',${json(p.protectedContent)},'[]',${literal(p.idempotencyKey)},${literal(stamp)})`,
          );
        }
        const p = await protect(30, standalone, [
          { type: "text", text: "SENTINEL standalone body" },
        ]);
        await repository.seed(
          `INSERT INTO chat_messages(id,chat_id,scratch_root_id,role,protected_content,idempotency_key,created_at) VALUES(${literal(p.id)},${literal(standalone)},${literal(scratch)},'user',${json(p.protectedContent)},${literal(p.idempotencyKey)},${literal(stamp)})`,
        );
        await repository.seed(
          `INSERT INTO chat_messages(id,chat_id,worktree_id,role,task_protected_content,created_at) VALUES('task-message',${literal(task)},${literal(tree)},'user',${json(label("chat").protectedLabel)},${literal(stamp)})`,
        );
        for (const chat of [agent, archived, standalone]) {
          const binding = "binding-" + chat;
          await repository.seed(
            `INSERT INTO native_history_bindings(id,owner_id,worker_id,chat_id,thread_id,project_id,worktree_id) VALUES(${literal(binding)},${literal(owner)},${literal(workerId)},${literal(chat)},'thread',${literal(project)},${literal(tree)})`,
          );
          await repository.seed(
            `INSERT INTO native_history_turns(binding_id,turn_id,revision,ordinal,status,started_at_ms,metadata,payload_digest) VALUES(${literal(binding)},'turn',1,0,'completed',1.125,${json(label("chat").protectedLabel.envelope)},repeat('a',64))`,
          );
        }
        await repository.seed(
          `INSERT INTO native_history_items(key,chat_id,thread_id,turn_id,item_id,component,identity_kind,message_id,idempotency_key,revision,payload_digest,turn_ordinal,item_ordinal,component_ordinal) VALUES('canonical',${literal(agent)},'thread','turn','item','assistant','canonical',${literal(messageId(0))},'message:0',1,repeat('a',64),0,0,0)`,
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("messages", [
          currentUser,
          { kind: "chat", chatId: agent },
          { kind: "chat", chatId: standalone },
        ]);
        assert.equal(
          (
            await visit(
              "complete Agent history",
              "GET",
              `/api/chats/${agent}/messages`,
            )
          ).messages.length,
          20,
        );
        assert.equal(
          (
            await visit(
              "turn-aware page",
              "GET",
              `/api/chats/${agent}/messages?limit=1`,
            )
          ).messages.length,
          10,
        );
        await visit(
          "cursor page",
          "GET",
          `/api/chats/${agent}/messages?beforeSequence=11&limit=1`,
        );
        await visit(
          "empty page",
          "GET",
          `/api/chats/${agent}/messages?beforeSequence=1&limit=1`,
        );
        await visit(
          "standalone history",
          "GET",
          `/api/chats/${standalone}/messages`,
        );
        await visit("Task history", "GET", `/api/chats/${task}/messages`);
        await visit("Task page", "GET", `/api/chats/${task}/messages?limit=1`);
        await visit("missing history", "GET", "/api/chats/missing/messages", {
          status: 404,
        });
        await visit(
          "ownership before query parsing",
          "GET",
          "/api/chats/missing/messages?limit=bad",
          { status: 404 },
        );
        await visit(
          "archived messages hidden",
          "GET",
          `/api/chats/${archived}/messages`,
          { status: 404 },
        );
        for (const query of [
          "limit=bad",
          "limit=",
          "limit=1&limit=2",
          "limit=1&unknown=true",
        ])
          await visit(
            "invalid page " + query,
            "GET",
            `/api/chats/${agent}/messages?${query}`,
            { status: 500 },
          );
        const created = await protect(50, agent, [
          { type: "text", text: "SENTINEL appended message" },
        ]);
        await visit("append message", "POST", `/api/chats/${agent}/messages`, {
          status: 201,
          json: created,
        });
        await live.ping("append complete");
        await visit(
          "unchanged Source duplicate response",
          "POST",
          `/api/chats/${agent}/messages`,
          { status: 500, json: created },
        );
        const stand = await protect(51, standalone, [
          { type: "text", text: "SENTINEL appended standalone" },
        ]);
        await visit(
          "append standalone",
          "POST",
          `/api/chats/${standalone}/messages`,
          { status: 201, json: stand },
        );
        await visit(
          "Task refuses Agent write",
          "POST",
          `/api/chats/${task}/messages`,
          { status: 409, json: created },
        );
        await visit(
          "invalid body before missing Chat",
          "POST",
          "/api/chats/missing/messages",
          { status: 400, json: {} },
        );
        await visit("malformed JSON", "POST", `/api/chats/${agent}/messages`, {
          status: 400,
          raw: "{",
          headers: { "content-type": "application/json" },
        });
        await visit("missing write", "POST", "/api/chats/missing/messages", {
          status: 404,
          json: created,
        });
        const stale = await protect(0, agent, [
          { type: "text", text: "SENTINEL stale canonical body" },
        ]);
        expected.set(messageId(0), {
          ...expected.get(messageId(0)),
          content: [{ type: "text", text: "SENTINEL message body 0" }],
        });
        await visit(
          "canonical stale body returns current row",
          "POST",
          `/api/chats/${agent}/messages`,
          { status: 201, json: stale },
        );
        await visit(
          "canonical identity conflict",
          "POST",
          `/api/chats/${agent}/messages`,
          { status: 409, json: { ...stale, idempotencyKey: "wrong-key" } },
        );
        const archive = { turns: [{ threadId: "thread", turnId: "turn" }] };
        await live.ping("before archive reads");
        const eventsBefore = live.history.filter(
          (e) =>
            e.type === "event" && ["chat", "chat-message"].includes(e.resource),
        ).length;
        for (const chat of [agent, standalone, archived])
          await visit(
            "archive read " + chat,
            "POST",
            `/api/chats/${chat}/native-history/turns/read`,
            { json: archive },
          );
        await visit(
          "empty archive",
          "POST",
          `/api/chats/${agent}/native-history/turns/read`,
          { json: { turns: [] } },
        );
        await visit(
          "missing archive",
          "POST",
          "/api/chats/missing/native-history/turns/read",
          { status: 404, json: archive },
        );
        await visit(
          "invalid archive body",
          "POST",
          "/api/chats/missing/native-history/turns/read",
          { status: 400, json: {} },
        );
        await live.ping("after archive reads");
        assert.equal(
          live.history.filter(
            (e) =>
              e.type === "event" &&
              ["chat", "chat-message"].includes(e.resource),
          ).length,
          eventsBefore,
        );
        if (profile === "accounts") {
          await visit(
            "foreign read hidden",
            "GET",
            `/api/chats/${agent}/messages`,
            { client: "other", status: 404 },
          );
          await visit(
            "foreign write hidden",
            "POST",
            `/api/chats/${agent}/messages`,
            { client: "other", status: 404, json: created },
          );
          await visit(
            "foreign archive hidden",
            "POST",
            `/api/chats/${agent}/native-history/turns/read`,
            { client: "other", status: 404, json: archive },
          );
        }
        await live.ping("all messages completed");
        result.rawEvents = live.history.filter(
          (e) =>
            e.type === "event" && ["chat", "chat-message"].includes(e.resource),
        );
        for (const event of result.rawEvents)
          if (event.resource === "chat-message") await prove(event.payload);
        result.events = normalized(
          fixture.normalize(
            result.rawEvents.map(
              ({ scope, resource, action, entityId, revision, payload }) => ({
                scope,
                resource,
                action,
                entityId,
                revision,
                payload,
              }),
            ),
          ),
        );
        assert.equal(
          result.events.filter((e) => e.resource === "chat-message").length,
          3,
        );
        assert.equal(
          result.events.filter((e) => e.resource === "chat").length,
          3,
        );
        if (databaseMode === "postgres") {
          result.races = await chatMessageHttpRaces({
            fixture,
            databaseUrl: url,
            project,
            agent,
            standalone,
            protect,
            prove,
            live,
          });
          const extra = live.history
            .filter(
              (e) =>
                e.type === "event" &&
                ["chat", "chat-message"].includes(e.resource),
            )
            .slice(result.rawEvents.length);
          for (const event of extra)
            if (event.resource === "chat-message") await prove(event.payload);
          result.rawRaceEvents = extra;
          result.raceEvents = normalized(
            fixture.normalize(
              extra.map(
                ({ scope, resource, action, entityId, revision, payload }) => ({
                  scope,
                  resource,
                  action,
                  entityId,
                  revision,
                  payload,
                }),
              ),
            ),
          );
        }
        assert.equal(fixture.server.diagnostics().includes("SENTINEL"), false);
        await live.close();
        live = undefined;
        await fixture.close();
        repository = await repoOpen();
        const state = await repository.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'turns',(SELECT jsonb_agg(to_jsonb(t) ORDER BY binding_id,turn_id) FROM native_history_turns t)) result",
        });
        assert.equal(state.rejected, false, state.diagnostic);
        result.rawState = state.value;
        for (const m of state.value.messages) {
          assert.equal(m.content, null);
          if (m.protected_content) {
            await prove({
              id: m.id,
              chatId: m.chat_id,
              role: m.role,
              mode: m.mode,
              attachmentIds: m.attachment_ids,
              protectedContent: m.protected_content,
            });
          }
        }
        const scrub = (v) =>
          Array.isArray(v)
            ? v.map(scrub)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v).map(([k, x]) => [
                    k,
                    k === "protected_content"
                      ? "<verified-ciphertext>"
                      : k.endsWith("_at")
                        ? "<clock>"
                        : scrub(x),
                  ]),
                )
              : v;
        result.state = fixture.normalize(scrub(state.value));
      } catch (error) {
        result.diagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        if (fixture.messageRaceEvidence)
          result.raceEvidence = fixture.messageRaceEvidence;
        await live?.close();
        await fixture.close();
        await repository?.close();
      }
    }
    assert.deepEqual(
      runtimes[1].observations,
      runtimes[0].observations,
      profile + " HTTP",
    );
    assert.deepEqual(
      runtimes[1].events,
      runtimes[0].events,
      profile + " ordered Live",
    );
    assert.deepEqual(
      runtimes[1].state,
      runtimes[0].state,
      profile + " persisted messages/archive",
    );
    assert.deepEqual(
      runtimes[1].races,
      runtimes[0].races,
      profile + " admitted races",
    );
    assert.deepEqual(
      runtimes[1].raceEvents,
      runtimes[0].raceEvents,
      profile + " race Live",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
} finally {
  await pg?.close();
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
    databaseMode,
    passed: true,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      runtimes: p.runtimes.map((r) => ({
        kind: r.kind,
        http: r.observations.length,
        cryptoProofs: r.cryptoProofs.length,
        events: r.events.length,
      })),
    })),
  }),
);
