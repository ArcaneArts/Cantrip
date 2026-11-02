// Existing HTTP/worker protocol, passive lane ownership and protected history.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
  settingsTree as tree,
  componentKey,
} from "./native-settings-http-fixture.mjs";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import {
  seedEventChats,
  task,
  standalone,
} from "./native-event-http-setup.mjs";
import {
  threadSync,
  syncTurn,
  usageActivity,
} from "./chat-thread-sync-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
import { decryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-thread-sync-"));
const id = (n) => `f7f7f7f7-7777-4777-8777-${String(n).padStart(12, "0")}`;
const notificationChat = id(7),
  notificationThread = "notification-thread";
const report = {
  suite: "chat-thread-sync-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, h, repository, failure;
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || option("--profile") === p,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        commands: [],
        openedMessages: 0,
      };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      let response = threadSync(),
        mode = "normal";
      const expected = new Map();
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        passwordHash,
        databaseMode,
        url,
        result,
        configure: (owner, scope) => {
          scope.modelRouteId = "inventory-provider-route-1";
          return [
            ...inventorySeed(owner, { kind: "openai-compatible", worker }),
            ...seedEventChats(owner),
            "UPDATE user_settings SET default_model_id=NULL,auto_name_chats=false,auto_name_tasks=false",
            `UPDATE chats SET model_id='inventory-provider-model-1' WHERE id IN (${literal(chat)},${literal(task)},${literal(standalone)})`,
            "UPDATE chat_runtime_sessions SET model_route_id='inventory-provider-route-1' WHERE id='settings-runtime'",
            ...[1, 2, 3, 4, 5, 6].flatMap((n) => [
              `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,model_id,archived_at) SELECT ${literal(id(n))},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,'agent',${n >= 4 ? literal("inventory-provider-model-1") : "NULL"},${n === 3 ? "now()" : "NULL"} FROM chats WHERE id=${literal(chat)}`,
              `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES(${literal("sync-runtime-" + n)},${literal(id(n))},${literal(worker)},${literal(n === 6 ? "77777777-7777-4777-8777-777777777777" : tree)},${n === 1 ? "NULL" : literal(n >= 4 ? (n === 6 ? "stale-placement-thread" : "ambiguous-thread") : "missing-model-thread")})`,
            ]),
            // A separate paused Chat isolates this notification's wire effects
            // from asynchronous queue dispatch after the earlier history reads.
            `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,model_id,automation_paused) SELECT ${literal(notificationChat)},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,'agent','inventory-provider-model-1',true FROM chats WHERE id=${literal(chat)}`,
            `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id) VALUES('notification-runtime',${literal(notificationChat)},${literal(worker)},${literal(tree)},${literal(notificationThread)},'inventory-provider-route-1')`,
          ];
        },
        onCommand: async (command, _emit, { encryption }) => {
          if (command.type === "chat.sync") {
            result.commands.push(command);
            assert.equal(command.executionProfile, "ide");
            assert.ok([chat, notificationChat].includes(command.chatId));
            assert.equal(
              command.threadId,
              command.chatId === notificationChat
                ? notificationThread
                : "thread",
            );
            assert.equal(command.model.id, "inventory-provider-model-1");
            if (mode === "worker-error")
              throw new Error("Controlled thread synchronization failure.");
            if (mode === "invalid")
              return { threadId: "thread", status: "invalid", turns: [] };
            return command.chatId === notificationChat
              ? { ...response, threadId: notificationThread }
              : response;
          }
          if (command.type === "chat.message.protect") {
            expected.set(command.message.id, command.message);
            return protectChatMessage({
              id: command.message.id,
              message: command.message,
              service: encryption,
            });
          }
        },
      });
      await h.live.subscribed("sync-project", [
        { kind: "project", projectId: project },
      ]);
      await h.live.subscribed("sync-observed-chat", [
        { kind: "chat", chatId: notificationChat },
      ]);
      const visit = h.visit,
        sync = (name, options = {}) =>
          visit(name, "POST", `/api/chats/${chat}/sync`, options);
      const status = async (name) => {
        const chats = await visit(
          name,
          "GET",
          `/api/projects/${project}/chats`,
        );
        return chats.find((c) => c.id === chat).status;
      };
      await visit(
        "missing Chat synchronization",
        "POST",
        `/api/chats/${id(99)}/sync`,
        { json: {}, status: 404 },
      );
      await visit(
        "archived Chat synchronization",
        "POST",
        `/api/chats/${id(3)}/sync`,
        { status: 404 },
      );
      await visit(
        "Task synchronization uses its reconstruction conflict",
        "POST",
        `/api/chats/${task}/sync`,
        { json: {}, status: 409 },
      );
      await visit(
        "threadless Chat needs no selected model",
        "POST",
        `/api/chats/${id(1)}/sync`,
        { json: { ignored: true } },
      );
      await visit(
        "linked Chat without any selected model retains reference failure",
        "POST",
        `/api/chats/${id(2)}/sync`,
        { status: 500 },
      );
      await visit(
        "standalone Chat cannot use console synchronization",
        "POST",
        `/api/chats/${standalone}/sync`,
        { status: 409 },
      );
      if (profile === "accounts")
        await sync("foreign owner cannot synchronize", {
          client: "other",
          status: 404,
        });
      const cold = await sync("empty cold history");
      assert.equal(cold.status, "idle");
      assert.equal(await status("cold history keeps idle"), "idle");
      response = threadSync([], {
        status: "running",
        statusSource: "native-thread",
      });
      await sync("native running console acquires its linked lane");
      assert.equal(await status("linked console running"), "running");
      response = threadSync();
      await sync("empty history is not terminal lifecycle evidence");
      assert.equal(await status("empty history preserves running"), "running");
      response = threadSync([], {
        status: "failed",
        statusSource: "native-thread",
      });
      await sync("native console failure finishes its lane");
      assert.equal(await status("linked console failed"), "failed");
      response = threadSync([], { statusSource: "native-thread" });
      await sync("native idle console updates retained status");
      assert.equal(await status("linked console idle"), "idle");
      mode = "worker-error";
      await sync("worker synchronization failure", { status: 500 });
      mode = "invalid";
      await sync("invalid native synchronization response", { status: 500 });
      mode = "normal";
      const inputs = [
        { type: "userMessage", id: "legacy-user", text: "Legacy sync user 🌲" },
        {
          type: "agentMessage",
          id: "legacy-answer",
          text: "Legacy sync answer 🌙",
          phase: null,
        },
        { type: "activity", activity: usageActivity },
      ];
      response = threadSync([syncTurn(inputs)]);
      await sync("legacy console history is protected by the bound worker");
      const messages = async (name) => {
        const raw = await visit(name, "GET", `/api/chats/${chat}/messages`);
        assert.equal(raw.kind, "chat-encrypted");
        assert.equal(raw.messages.length, 3);
        const opened = [];
        for (const message of raw.messages) {
          const content = await decryptChatMessageProtectedContent({
            ownerId: h.owner,
            messageId: message.id,
            keyRevision: 1,
            componentKey: new Uint8Array(componentKey),
            encrypted: message.protectedContent,
            publicClassification: {
              role: message.role,
              mode: message.mode,
              attachmentIds: message.attachmentIds,
            },
          });
          assert.deepEqual(content.content, expected.get(message.id).content);
          result.openedMessages++;
          const normalized = result.observations
            .at(-1)
            .body.messages.find((m) => m.sequence === message.sequence);
          normalized.protectedContent = {
            verifiedContent: content.content,
            classification: content.classification,
          };
          opened.push({
            id: message.id,
            sequence: message.sequence,
            content: content.content,
          });
        }
        return opened;
      };
      const original = await messages("read encrypted synchronized messages");
      await sync("idempotent console synchronization");
      assert.deepEqual(
        await messages("replayed history preserves message identity and order"),
        original,
      );
      response = threadSync([
        syncTurn(
          inputs.map((i) =>
            i.type === "agentMessage"
              ? { ...i, text: "Legacy sync updated answer 🌙" }
              : i,
          ),
        ),
      ]);
      await sync("canonical console revision updates its protected row");
      const changed = await messages("read updated synchronized messages");
      assert.deepEqual(
        changed.map((m) => [m.id, m.sequence]),
        original.map((m) => [m.id, m.sequence]),
      );
      assert.ok(
        JSON.stringify(changed).includes("Legacy sync updated answer 🌙"),
      );
      response = threadSync([], { statusSource: "native-thread" });
      const before = result.commands.length,
        eventOffset = h.live.history.length;
      for (const threadId of [
        "unknown-thread",
        "task-thread",
        "standalone-thread",
        "ambiguous-thread",
        "stale-placement-thread",
      ])
        assert.equal(
          h.worker.sendNotification({
            type: "chat.thread.changed",
            threadId,
            revision: 1,
            changes: ["turn", "goal", "queue", "plan"],
          }),
          true,
        );
      assert.equal(
        h.worker.sendNotification({
          type: "chat.thread.changed",
          threadId: notificationThread,
          revision: 1,
          changes: ["goal", "queue", "plan"],
        }),
        true,
      );
      await eventually(
        () => result.commands.length,
        (n) => assert.equal(n, before + 1),
        15000,
      );
      await eventually(
        () =>
          h.live.history
            .slice(eventOffset)
            .filter(
              (e) =>
                e.type === "event" &&
                e.scope.kind === "chat" &&
                e.scope.chatId === notificationChat,
            )
            .map((e) => e.resource),
        (resources) => {
          for (const resource of ["chat-goal", "chat-queue", "chat-plan"])
            assert.ok(resources.includes(resource));
        },
        15000,
      );
      const invalidations = h.live.history
        .slice(eventOffset)
        .filter(
          (e) =>
            e.type === "event" &&
            e.scope.kind === "chat" &&
            e.scope.chatId === notificationChat &&
            ["chat-goal", "chat-queue", "chat-plan"].includes(e.resource),
        );
      assert.deepEqual(
        invalidations.map((e) => e.resource),
        ["chat-goal", "chat-queue", "chat-plan"],
      );
      for (const [i, event] of invalidations.entries()) {
        assert.deepEqual(event.scope, {
          kind: "chat",
          chatId: notificationChat,
        });
        if (i)
          assert.ok(
            event.cursor > invalidations[i - 1].cursor,
            "notification invalidations keep their committed Live order",
          );
        assert.ok(Date.parse(event.occurredAt) <= Date.now());
      }
      result.notificationInvalidations = invalidations.map(
        ({ cursor, occurredAt, ...event }) => event,
      );
      assert.deepEqual(
        result.notificationInvalidations,
        ["chat-goal", "chat-queue", "chat-plan"].map((resource) => ({
          type: "event",
          scope: { kind: "chat", chatId: notificationChat },
          resource,
          action: "invalidated",
          entityId: null,
          revision: null,
          payload: null,
        })),
      );
      result.observedThreadChange = true;
      const port = Number(new URL(h.fixture.server.origin).port);
      await h.fixture.close();
      await h.fixture.start({ port });
      assert.deepEqual(
        await messages("retained synchronized history after server restart"),
        changed,
      );
      h.worker.close();
      await eventually(
        async () => {
          await h.fixture.observe(
            "offline worker state",
            "GET",
            "/api/workers",
          );
          return h.fixture.records
            .get("offline worker state")
            .find((w) => w.workerId === worker)?.online;
        },
        (online) => assert.equal(online, false),
        15000,
      );
      await sync("linked synchronization reports offline worker", {
        status: 503,
      });
      await visit(
        "threadless synchronization still works offline",
        "POST",
        `/api/chats/${id(1)}/sync`,
      );
      await h.close();
      assert.equal(
        result.commands.length,
        before + 1,
        "non-unique, stale, unknown and non-Agent thread notifications dispatch no history command",
      );
      result.rejectedNotificationBindings = 5;
      repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      const saved = await repository.request({
        op: "query-json",
        sql: `SELECT jsonb_build_object('messages',(SELECT count(*)::int FROM chat_messages WHERE chat_id=${literal(chat)}),'plaintext',(SELECT count(*)::int FROM chat_messages WHERE chat_id=${literal(chat)} AND content IS NOT NULL),'lanes',(SELECT count(*)::int FROM chat_execution_lanes WHERE chat_id=${literal(chat)} AND state='active'),'usage',(SELECT jsonb_agg(to_jsonb(u)-'id'-'owner_id'-'started_at'-'completed_at'-'finalized_at'-'created_at'-'updated_at') FROM token_usage_records u WHERE chat_id=${literal(chat)}),'usageOwned',(SELECT bool_and(owner_id=${literal(h.owner)}) FROM token_usage_records WHERE chat_id=${literal(chat)})) AS result`,
      });
      assert.equal(saved.rejected, false, saved.diagnostic);
      assert.deepEqual(
        {
          messages: saved.value.messages,
          plaintext: saved.value.plaintext,
          lanes: saved.value.lanes,
        },
        { messages: 3, plaintext: 0, lanes: 0 },
      );
      assert.equal(saved.value.usageOwned, true);
      assert.equal(
        saved.value.usage.length,
        1,
        "replayed console usage is recorded once",
      );
      assert.equal(saved.value.usage[0].source_key, `chat:${chat}:sync-turn`);
      assert.equal(
        saved.value.usage[0].execution_attempt_id,
        `console-sync:${chat}:sync-turn`,
      );
      assert.equal(saved.value.usage[0].attempt_kind, "console-sync");
      assert.equal(saved.value.usage[0].attempt_status, "completed");
      assert.equal(saved.value.usage[0].input_tokens, 3);
      assert.equal(saved.value.usage[0].output_tokens, 2);
      result.state = saved.value;
      await repository.close();
      repository = null;
      h = null;
    }
    for (const field of [
      "observations",
      "state",
      "openedMessages",
      "observedThreadChange",
      "rejectedNotificationBindings",
      "notificationInvalidations",
    ])
      assert.deepEqual(
        outputs[1][field],
        outputs[0][field],
        profile + " " + field,
      );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = h?.diagnostics();
} finally {
  await repository?.close();
  await h?.close();
  await pg?.close();
  if (option("--report")) {
    await mkdir(path.dirname(path.resolve(option("--report"))), {
      recursive: true,
    });
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
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
      http: p.outputs.map((o) => o.observations.length),
    })),
  }),
);
