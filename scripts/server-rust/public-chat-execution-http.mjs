// Public routes over actual Node/Rust HTTP and worker WebSocket connections.
// Existing worker crypto, native admission/receipt client and session adapter;
// model execution and rollback are explicit controlled fixture boundaries.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsWorker as worker,
  settingsProject as project,
  componentKey,
  until,
} from "./native-settings-http-fixture.mjs";
import {
  seedEventChats,
  standalone,
  task,
  taskProject,
} from "./native-event-http-setup.mjs";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";
import {
  decryptChatMessageProtectedContent,
  decryptQueuedPromptProtectedContent,
  encryptTaskProtectedContent,
  decryptTaskProtectedContent,
} from "../../packages/crypto/dist/index.js";
import { queuedPromptOpaqueContentSchema } from "../../packages/protocol/dist/index.js";
import { publicExecutionWorker } from "./public-chat-execution-worker.mjs";
import { additionalPublicChatCases } from "./public-chat-additional-cases.mjs";
import { publicPauseCases } from "./public-pause-cases.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-public-chat-execution-"),
);
const report = {
  suite: "public-chat-execution-http-live-native-receipts",
  databaseMode,
  completeReplacement: false,
  fullWorkerProcess: false,
  profiles: [],
};
const id = (n) => `e1e1e1e1-1111-4111-8111-${String(n).padStart(12, "0")}`;
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
let pg, active, activeWorker, failure;
try {
  const executable = await buildRustServer();
  const repositoryExecutable = await buildRustExample(
    "project-repository-fixture",
  );
  const passwordHash = await hashPassword(password);
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
        notificationProofs: [],
        nativeReceiptProofs: 0,
      };
      outputs.push(result);
      const modelWorker = (activeWorker = publicExecutionWorker());
      const pauseTaskContent = {
        version: 1,
        classification: taskContent("implementing").classification,
        briefMarkdown: "private-public-chat-task-between-turns",
        planMarkdown: null,
        currentQuestions: [],
        currentAnswers: [],
        additionalDirection: "",
        finalPlanMarkdown: null,
        goalPrompt: null,
        lastError: null,
      };
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        url,
        passwordHash,
        result,
        onCommand: (...args) => modelWorker.handle(...args),
        configure: (owner) => [
          ...seedEventChats(owner),
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('public-provider',${literal(owner)},'Public fixture','openai-compatible','http://fixture.invalid')`,
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('public-model',${literal(owner)},'Public fixture')`,
          "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('public-route','public-model','public-provider','public-fixture',0,true)",
          `UPDATE chats SET model_id='public-model',custom_subagent_model=false,subagent_model_id=NULL,auto_title_pending=false WHERE owner_id=${literal(owner)}`,
          `UPDATE user_settings SET auto_name_chats=false,auto_name_tasks=false,default_model_id='public-model' WHERE user_id=${literal(owner)}`,
          "UPDATE chat_runtime_sessions SET model_route_id='public-route'",
        ],
        prepare: async ({ owner, repository }) => {
          const protectedContent = await encryptTaskProtectedContent({
            ownerId: owner,
            chatId: task,
            keyRevision: 1,
            componentKey,
            content: pauseTaskContent,
          });
          const seeded = await repository.request({
            op: "transaction",
            statements: [
              `INSERT INTO tasks(chat_id,state,protected_content) VALUES(${literal(task)},'implementing',${json(protectedContent)})`,
              `UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id=${literal(task)}`,
            ],
          });
          assert.equal(seeded.rejected, false, seeded.diagnostic);
        },
      }));
      modelWorker.attach(h);
      const processHandle = h.fixture.server;
      const expectedMessages = new Map(),
        verifiedContent = new Set(),
        digests = new Map();
      let cryptographicChecks = 0;
      async function prove(value) {
        if (Array.isArray(value)) {
          for (const entry of value) await prove(entry);
          return;
        }
        if (!value || typeof value !== "object") return;
        if (value.id && value.protectedContent) {
          const classification = value.classification?.role
            ? value.classification
            : value.role
              ? {
                  role: value.role,
                  mode: value.mode,
                  attachmentIds: value.attachmentIds,
                }
              : null;
          if (classification) {
            const content = await decryptChatMessageProtectedContent({
              ownerId: h.owner,
              messageId: value.id,
              keyRevision: 1,
              componentKey: new Uint8Array(componentKey),
              encrypted: value.protectedContent,
              publicClassification: classification,
            });
            const text =
              classification.role === "assistant"
                ? "private-public-chat-answer"
                : expectedMessages.get(value.id);
            assert.ok(text, "server returns only known encrypted messages");
            assert.equal(content.content[0].text, text);
          } else {
            assert.ok(
              value.classification,
              "known queued prompt classification",
            );
            const content = await decryptQueuedPromptProtectedContent({
              ownerId: h.owner,
              promptId: value.id,
              keyRevision: 1,
              componentKey: new Uint8Array(componentKey),
              encrypted: value.protectedContent,
              publicClassification: value.classification,
            });
            assert.ok(content.text.startsWith("private-public-chat-"));
          }
          verifiedContent.add(stable(value.protectedContent));
          cryptographicChecks++;
        }
        for (const entry of Object.values(value)) await prove(entry);
      }
      function normalized(value, key = "") {
        if (key === "protectedContent" && value) {
          assert.ok(
            verifiedContent.has(stable(value)),
            "only decrypted endpoint ciphertext can be compared by identity",
          );
          return "<verified encrypted content>";
        }
        if (key === "payloadDigest" && value) {
          assert.ok(
            digests.has(value),
            "queue digest binds to the exact submitted encrypted mutation",
          );
          return digests.get(value);
        }
        if (key === "executionLaneId" && value)
          return "<verified execution lane>";
        if (
          ["createdAt", "updatedAt", "pausedAt"].includes(key) &&
          typeof value === "string" &&
          Number.isFinite(Date.parse(value))
        ) {
          assert.ok(
            Date.parse(value) >= Date.now() - 300000 &&
              Date.parse(value) <= Date.now() + 1000,
          );
          return "<verified database clock>";
        }
        if (Array.isArray(value)) return value.map((v) => normalized(v));
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, normalized(v, k)]),
          );
        return value;
      }
      function mutation(operation, value) {
        const digest = createHash("sha256")
          .update(JSON.stringify(value))
          .digest("hex");
        digests.set(digest, "<verified mutation:" + operation + ">");
      }
      async function visit(name, method, route, options = {}) {
        report.currentOperation = { profile, kind, name, method, route };
        const value = await h.visit(name, method, route, options);
        await prove(value);
        return value;
      }
      async function make(n, frozen = false, overrides = {}) {
        const text = "private-public-chat-" + n;
        const value = await protectChatTurn({
          service: h.encryption,
          text,
          mode: "default",
          modelId: "public-model",
          reasoningEffort: null,
          idempotencyKey: "public-message-" + n,
          messageId: id(n),
          promptId: id(n + 1000),
          ...overrides,
        });
        expectedMessages.set(value.message.id, text);
        value.queuedPrompt = queuedPromptOpaqueContentSchema.parse({
          ...value.queuedPrompt,
          frozen,
        });
        return value;
      }
      const queueRoute = `/api/chats/${chat}/queue`;
      const messagesRoute = `/api/chats/${chat}/messages`;
      async function messages(count) {
        const deadline = Date.now() + 15000;
        let body;
        do {
          await delay(30);
          await h.fixture.observe(
            "message boundary poll",
            "GET",
            messagesRoute,
          );
          body = h.fixture.records.get("message boundary poll");
          await prove(body);
          if (body.messages.length === count) return body;
        } while (Date.now() < deadline);
        assert.equal(
          body.messages.length,
          count,
          "actual public execution reaches its durable encrypted message boundary",
        );
      }
      async function notified(name, state) {
        await until(
          () =>
            modelWorker.queueChanges.some(
              (c) => c.chatId === chat && c.revision >= state.revision,
            ),
          Boolean,
        );
        await h.live.ping(name);
        const events = h.live.history.filter(
          (e) => e.type === "event" && e.resource === "chat-queue",
        );
        assert.ok(
          events.length > 0,
          "queue notice publishes owner-scoped Live invalidation",
        );
        assert.ok(
          events.every(
            (e) =>
              e.scope.kind === "chat" &&
              e.scope.chatId === chat &&
              e.action === "invalidated",
          ),
        );
        result.notificationProofs.push({
          name,
          revision: state.revision,
          latestRevision: Math.max(
            ...modelWorker.queueChanges
              .filter((c) => c.chatId === chat)
              .map((c) => c.revision),
          ),
        });
      }
      let scenarioFailure;
      try {
        const first = await make(1);
        for (const [name, method, route] of [
          ["turn", "POST", `/api/chats/${id(999)}/turns`],
          ["retry", "POST", `/api/chats/${id(999)}/turns/${id(1)}/retry`],
          ["queue add", "POST", queueRoute],
          ["queue order", "PATCH", queueRoute + "/order"],
          ["queue edit", "PATCH", `/api/queued-prompts/${id(1001)}`],
          ["queue edit named steer", "PATCH", "/api/queued-prompts/steer"],
        ])
          await visit("invalid " + name, method, route, {
            json: {},
            status: 400,
          });
        await visit("turn absent chat", "POST", `/api/chats/${id(999)}/turns`, {
          json: first,
          status: 404,
        });
        await visit(
          "retry absent chat",
          "POST",
          `/api/chats/${id(999)}/turns/${id(1)}/retry`,
          { json: first, status: 404 },
        );
        await visit(
          "Task retry unavailable",
          "POST",
          `/api/chats/${task}/turns/${id(1)}/retry`,
          { json: first, status: 409 },
        );
        await visit(
          "absent queue lists empty",
          "GET",
          `/api/chats/${id(999)}/queue`,
        );
        await visit(
          "absent prompt deletion",
          "DELETE",
          `/api/queued-prompts/${id(999)}`,
          { status: 404 },
        );
        if (profile === "accounts") {
          await visit(
            "foreign turn is absent",
            "POST",
            `/api/chats/${chat}/turns`,
            { client: "other", json: first, status: 404 },
          );
          await visit("foreign queue is empty", "GET", queueRoute, {
            client: "other",
          });
        }
        const frozen = await make(10, true),
          another = await make(11, true);
        for (const value of [frozen, another]) {
          mutation("gui-queue:add:" + chat + ":" + value.queuedPrompt.id, {
            kind: "add",
            prompt: value.queuedPrompt,
            attachments: [],
          });
          await visit("add frozen " + value.message.id, "POST", queueRoute, {
            json: value.queuedPrompt,
            status: 201,
          });
        }
        let state = await visit("managed queue snapshot", "GET", queueRoute);
        assert.equal(state.items.length, 2);
        await notified("frozen additions delivered", state);
        const operation =
          "gui-queue:add:" + chat + ":" + frozen.queuedPrompt.id;
        assert.equal(
          (
            await visit(
              "canonical add receipt",
              "GET",
              queueRoute + "/operations/" + encodeURIComponent(operation),
            )
          ).found,
          true,
        );
        await visit(
          "unknown queue receipt",
          "GET",
          queueRoute + "/operations/unknown",
        );
        await visit(
          "managed reorder needs revision",
          "PATCH",
          queueRoute + "/order",
          { json: { ids: state.items.map((p) => p.id) }, status: 409 },
        );
        const order = [another.queuedPrompt.id, frozen.queuedPrompt.id];
        mutation("public-order", { kind: "reorder", ids: order });
        await visit("managed reorder", "PATCH", queueRoute + "/order", {
          json: {
            ids: order,
            expectedRevision: state.revision,
            operationId: "public-order",
          },
          status: 204,
        });
        state = await visit("reordered queue", "GET", queueRoute);
        assert.deepEqual(
          state.items.map((p) => p.id),
          order,
        );
        const current = state.items.find(
          (p) => p.id === frozen.queuedPrompt.id,
        );
        const replacement = await make(12, true);
        const edited = queuedPromptOpaqueContentSchema.parse({
          ...replacement.queuedPrompt,
          id: current.id,
        });
        // Re-encrypt with the retained prompt identity before submitting an edit.
        const revised = await protectChatTurn({
          service: h.encryption,
          text: "private-public-chat-12",
          mode: "default",
          modelId: "public-model",
          reasoningEffort: null,
          idempotencyKey: "public-message-12",
          messageId: replacement.message.id,
          promptId: current.id,
        });
        const prompt = queuedPromptOpaqueContentSchema.parse({
          ...edited,
          protectedContent: revised.queuedPrompt.protectedContent,
          pendingMessage: revised.message,
        });
        await visit(
          "managed edit needs revision",
          "PATCH",
          `/api/queued-prompts/${current.id}`,
          { json: { prompt }, status: 409 },
        );
        const update = {
          prompt,
          expectedItemRevision: current.revision,
          operationId: "public-edit",
        };
        mutation("public-edit", {
          kind: "update",
          id: current.id,
          expectedItemRevision: current.revision,
          prompt,
          attachments: [],
        });
        const changed = await visit(
          "managed prompt edit",
          "PATCH",
          `/api/queued-prompts/${current.id}`,
          { json: update },
        );
        assert.equal(changed.id, current.id);
        const replay = await visit(
          "managed edit receipt replay",
          "PATCH",
          `/api/queued-prompts/${current.id}`,
          { json: update },
        );
        assert.deepEqual(replay, changed);
        await visit(
          "managed delete needs revision",
          "DELETE",
          `/api/queued-prompts/${current.id}`,
          { status: 409 },
        );
        await visit(
          "unsafe delete revision",
          "DELETE",
          `/api/queued-prompts/${current.id}?expectedItemRevision=9007199254740992&operationId=unsafe`,
          { status: 409 },
        );
        for (const item of [
          changed,
          state.items.find((p) => p.id === another.queuedPrompt.id),
        ]) {
          const operationId = "delete-" + item.id;
          mutation(operationId, {
            kind: "delete",
            id: item.id,
            expectedItemRevision: item.revision,
          });
          await visit(
            "managed delete " + item.id,
            "DELETE",
            `/api/queued-prompts/${item.id}?expectedItemRevision=0x${item.revision.toString(16)}&operationId=${operationId}`,
            { status: 204 },
          );
        }
        state = await visit("empty managed queue", "GET", queueRoute);
        assert.equal(state.items.length, 0);
        await notified("mutations delivered", state);
        const gate = modelWorker.holdNext();
        const started = await visit(
          "public turn starts",
          "POST",
          `/api/chats/${chat}/turns`,
          { json: first, status: 202 },
        );
        assert.equal(started.status, "started");
        await until(() => gate.dispatched, Boolean);
        await visit("public turn replay", "POST", `/api/chats/${chat}/turns`, {
          json: first,
        });
        const editedTurn = await make(2);
        await visit(
          "active message cannot be edited",
          "POST",
          `/api/chats/${chat}/turns/${first.message.id}/retry`,
          { json: editedTurn, status: 409 },
        );
        const steer = await make(3);
        mutation("gui-queue:add:" + chat + ":" + steer.queuedPrompt.id, {
          kind: "add",
          prompt: steer.queuedPrompt,
          attachments: [],
        });
        const queued = await visit(
          "submit queues behind active turn",
          "POST",
          `/api/chats/${chat}/turns`,
          { json: steer, status: 202 },
        );
        assert.equal(queued.status, "queued");
        await visit(
          "managed steer needs revision",
          "POST",
          `/api/queued-prompts/${steer.queuedPrompt.id}/steer`,
          { json: {}, status: 409 },
        );
        const steered = await visit(
          "steer queued encrypted input",
          "POST",
          `/api/queued-prompts/${steer.queuedPrompt.id}/steer`,
          {
            json: {
              expectedItemRevision: queued.prompt.revision,
              operationId: "public-steer",
            },
          },
        );
        assert.equal(steered.steered, true);
        assert.equal(modelWorker.controls.length, 1);
        const consumed = await visit(
          "steered queue is consumed",
          "GET",
          queueRoute,
        );
        assert.equal(consumed.items.length, 0);
        assert.equal(
          consumed.claims.length,
          0,
          "consumed claims leave the active queue snapshot",
        );
        gate.release();
        await messages(3);
        await until(() => modelWorker.acknowledgments.length >= 1, Boolean);
        await visit("completed messages", "GET", messagesRoute);
        await visit(
          "only latest user can retry",
          "POST",
          `/api/chats/${chat}/turns/${first.message.id}/retry`,
          { json: editedTurn, status: 409 },
        );
        await visit(
          "steered message retains its original model metadata",
          "POST",
          `/api/chats/${chat}/turns/${steer.message.id}/retry`,
          { json: editedTurn, status: 409 },
        );
        const latestTurn = await make(4);
        await visit(
          "next public turn starts",
          "POST",
          `/api/chats/${chat}/turns`,
          { json: latestTurn, status: 202 },
        );
        await messages(5);
        await until(() => modelWorker.acknowledgments.length >= 2, Boolean);
        for (const [name, overrides] of [
          ["mode", { mode: "plan" }],
          ["reasoning", { reasoningEffort: "high" }],
          ["model", { modelId: "different-model" }],
        ]) {
          const changed = await make(20 + name.length, false, overrides);
          await visit(
            "retry preserves " + name,
            "POST",
            `/api/chats/${chat}/turns/${latestTurn.message.id}/retry`,
            { json: changed, status: 409 },
          );
        }
        const latest = latestTurn.message;
        await visit(
          "edit latest user and rollback",
          "POST",
          `/api/chats/${chat}/turns/${latest.id}/retry`,
          { json: editedTurn, status: 202 },
        );
        await messages(5);
        await until(() => modelWorker.acknowledgments.length >= 2, Boolean);
        await visit("retried durable transcript", "GET", messagesRoute);
        await until(() => modelWorker.acknowledgments.length >= 3, Boolean);
        assert.equal(modelWorker.turns.length, 3);
        result.expandedScope = await additionalPublicChatCases({
          h,
          modelWorker,
          visit,
          make,
          messages,
          mutation,
          prove,
        });
        result.pauseProofs = await publicPauseCases({
          h,
          modelWorker,
          visit,
          profile,
        });
        assert.equal(modelWorker.failures.length, 0);
        assert.ok(
          modelWorker.requests.some(
            (r) => r.path.endsWith("/receipt") && r.status === 200,
          ),
        );
        result.nativeReceiptProofs = modelWorker.requests.filter(
          (r) => r.path.endsWith("/receipt") && r.status === 200,
        ).length;
        result.workerQueueChanges = modelWorker.queueChanges;
        result.nativeRequests = modelWorker.requests;
        result.cryptoChecks = cryptographicChecks;
        assert.ok(cryptographicChecks > 20);
      } catch (error) {
        scenarioFailure = error;
        result.scenarioFailure = { message: error.message, stack: error.stack };
        throw error;
      } finally {
        modelWorker.releaseAll();
        try {
          await modelWorker.drained();
          await h.close();
        } catch (error) {
          result.cleanupFailure = {
            message: error.message,
            stack: error.stack,
          };
          throw scenarioFailure
            ? new AggregateError(
                [scenarioFailure, error],
                "Public execution scenario and cleanup failed",
              )
            : error;
        }
        active = null;
        activeWorker = null;
      }
      const repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, profile),
        databaseMode,
        databaseUrl: url,
      });
      try {
        const stored = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('messages',(SELECT count(*) FROM chat_messages WHERE chat_id=${literal(chat)}),'plaintext',(SELECT count(*) FROM chat_messages WHERE chat_id IN (${literal(chat)},${literal(standalone)}) AND content IS NOT NULL),'activeLanes',(SELECT count(*) FROM chat_execution_lanes WHERE chat_id IN (${literal(chat)},${literal(standalone)}) AND state='active'),'pendingPrompts',(SELECT count(*) FROM queued_prompts WHERE chat_id IN (${literal(chat)},${literal(standalone)}) AND state IN ('pending','claimed')),'consumedClaims',(SELECT count(*) FROM managed_queue_claims WHERE chat_id=${literal(chat)} AND status='consumed'),'standaloneMessages',(SELECT count(*) FROM chat_messages WHERE chat_id=${literal(standalone)}),'standaloneStatus',(SELECT status FROM chats WHERE id=${literal(standalone)}),'status',(SELECT status FROM chats WHERE id=${literal(chat)})) result`,
        });
        assert.equal(stored.rejected, false, stored.diagnostic);
        result.durableState = stored.value;
        assert.deepEqual(stored.value, {
          messages: 9,
          plaintext: 0,
          activeLanes: 0,
          pendingPrompts: 0,
          consumedClaims: 2,
          standaloneMessages: 3,
          standaloneStatus: "idle",
          status: "idle",
        });
        const claims = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('claims',jsonb_agg(jsonb_build_object('id',c.id,'promptId',c.prompt_id,'status',c.status,'operationId',c.operation_id,'operationGeneration',c.operation_generation,'messageId',s.protected_input->'pendingMessage'->>'id','messageKey',s.protected_input->'pendingMessage'->>'idempotencyKey','owner',n.owner_id,'chat',n.chat_id,'worker',n.worker_id,'method',n.method) ORDER BY c.prompt_id)) result FROM managed_queue_claims c INNER JOIN managed_queue_input_snapshots s ON s.claim_id=c.id INNER JOIN native_commands n ON n.operation_id=c.operation_id AND n.operation_generation=c.operation_generation WHERE c.chat_id=${literal(chat)}`,
        });
        assert.equal(claims.rejected, false, claims.diagnostic);
        result.rawClaims = claims.value.claims;
        assert.equal(result.rawClaims.length, 2);
        for (const claim of result.rawClaims) {
          assert.equal(claim.owner, h.owner);
          assert.equal(claim.chat, chat);
          assert.equal(claim.worker, worker);
          assert.equal(claim.status, "consumed");
        }
        const followed = result.rawClaims.find((c) => c.promptId === id(1006));
        assert.ok(followed);
        assert.equal(followed.messageId, id(6));
        assert.equal(followed.messageKey, "public-message-6");
        assert.equal(
          followed.operationId,
          "gui:" +
            createHash("sha256")
              .update(
                JSON.stringify([
                  h.owner,
                  chat,
                  followed.messageKey,
                  followed.id,
                ]),
              )
              .digest("hex"),
        );
        const actual = modelWorker.turns.find(
          (t) => t.command.clientMessageId === id(6),
        ).command.nativeCommandReceipt;
        assert.equal(actual.operationId, followed.operationId);
        assert.equal(actual.operationGeneration, followed.operationGeneration);
        result.queueInputBindingProof = {
          consumedClaims: 2,
          ownerChatWorkerVerified: true,
          immutableMessageVerified: true,
          actualClaimOperationHashVerified: true,
          workerReceiptGenerationVerified: true,
        };
        const pauseState = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('taskState',t.state,'taskPaused',c.automation_paused,'taskThread',s.codex_thread_id,'projectPaused',p.task_scheduling_paused,'projectRevision',p.task_scheduling_revision,'standalonePaused',(SELECT automation_paused FROM chats WHERE id=${literal(standalone)}),'protectedTask',t.protected_content) result FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id JOIN chat_runtime_sessions s ON s.chat_id=c.id WHERE c.id=${literal(task)} AND p.id=${literal(taskProject)}`,
        });
        assert.equal(pauseState.rejected, false, pauseState.diagnostic);
        const { protectedTask, ...paused } = pauseState.value;
        assert.deepEqual(paused, {
          taskState: "implementing",
          taskPaused: false,
          taskThread: null,
          projectPaused: false,
          projectRevision: 5,
          standalonePaused: true,
        });
        assert.deepEqual(
          await decryptTaskProtectedContent({
            ownerId: h.owner,
            chatId: task,
            keyRevision: 1,
            componentKey,
            encrypted: protectedTask,
            publicClassification: pauseTaskContent.classification,
          }),
          pauseTaskContent,
        );
        result.pauseDurableState = { ...paused, protectedTaskUnchanged: true };
      } finally {
        await repository.close();
      }
      result.observations = normalized(result.observations);
      result.diagnostics = processHandle.diagnostics();
      assert.equal(result.diagnostics.includes("private-public-chat-"), false);
    }
    for (const field of [
      "observations",
      "durableState",
      "nativeReceiptProofs",
      "queueInputBindingProof",
      "pauseProofs",
      "pauseDurableState",
    ])
      assert.deepEqual(
        outputs[1][field],
        outputs[0][field],
        profile + " " + field,
      );
  }
  report.passed = true;
  delete report.currentOperation;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = active?.diagnostics();
} finally {
  activeWorker?.releaseAll();
  await active?.close().catch(() => {});
  await pg?.close();
  if (option("--report")) {
    const file = path.resolve(option("--report"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    databaseMode,
    profiles: report.profiles.length,
  }),
);
