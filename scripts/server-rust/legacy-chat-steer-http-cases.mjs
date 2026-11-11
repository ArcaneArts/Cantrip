import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexAppServer } from "../../cantrip_worker/src/codex/app-server.ts";
import { AttachmentStore } from "../../cantrip_worker/src/attachment-store.ts";
import {
  openWorkerAttachments,
  protectWorkerAttachmentMetadata,
} from "../../cantrip_worker/src/attachment-encryption.ts";
import {
  openEncryptedChatTurn,
  protectChatTurn,
} from "../../cantrip_worker/src/chat-message-encryption.ts";
import { unprobedCodexRuntimeReport } from "../../packages/protocol/dist/index.js";
import {
  settingsChat,
  settingsTree,
  settingsWorker,
  until,
} from "./native-settings-http-fixture.mjs";
import {
  scratch,
  seedEventChats,
  standalone,
} from "./native-event-http-setup.mjs";
import { json, literal } from "./project-target-state.mjs";

const model = {
  id: "steer-model",
  routeId: "steer-route",
  name: "Steer",
  reasoningEffort: null,
};
const provider = {
  id: "steer-provider",
  name: "Steer",
  kind: "openai-compatible",
  baseUrl: "http://fixture.invalid",
  apiKey: null,
};
const contexts = [
  {
    chat: settingsChat,
    kind: "project",
    profile: "ide",
    threadId: "thread",
    lane: "steer-project-lane",
    session: "settings-runtime",
    worktree: settingsTree,
    root: null,
    status: "running",
  },
  {
    chat: standalone,
    kind: "standalone",
    profile: "standalone-chat",
    threadId: "standalone-thread",
    lane: "steer-standalone-lane",
    session: "event-standalone-runtime",
    worktree: null,
    root: scratch,
    status: "waiting-for-approval",
  },
];
const id = (n) => `e7e7e7e7-1111-4111-8111-${String(n).padStart(12, "0")}`;
const marker = "private-steer-𐐷";
const fileName = marker + ".txt";
const bytes = Buffer.from("fixture bytes for " + marker);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const rpcRejection = "Controlled turn/steer rejection";
const queue = (c) => `/api/chats/${c.chat}/queue`;
const history = (c) => `/api/chats/${c.chat}/messages`;
const persisted = (c) => `SELECT jsonb_build_object(
 'messages',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') FROM chat_messages m WHERE m.chat_id=c.id),
 'prompts',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM queued_prompts p WHERE p.chat_id=c.id),
 'claims',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.id),'[]') FROM managed_queue_claims q WHERE q.chat_id=c.id)
 )::text result FROM chats c WHERE c.id=${literal(c.chat)}`;

export function configureSteer(owner) {
  return [
    ...seedEventChats(owner),
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(provider.id)},${literal(owner)},${literal(provider.name)},${literal(provider.kind)},${literal(provider.baseUrl)})`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES(${literal(model.id)},${literal(owner)},${literal(model.name)})`,
    `INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES(${literal(model.routeId)},${literal(model.id)},${literal(provider.id)},${literal(model.name)},0,true)`,
    `UPDATE chats SET model_id=${literal(model.id)},auto_title_pending=false WHERE owner_id=${literal(owner)}`,
    `UPDATE chat_runtime_sessions SET model_route_id=${literal(model.routeId)},status='ready'`,
  ];
}

export function legacySteerCases(result, cwd) {
  let current, runtime, execution, gate, workerError;
  const envelopes = new Map();
  const store = new AttachmentStore(cwd);

  function remember(content, label) {
    const envelope = content.envelope;
    assert.match(envelope.nonce, /^[A-Za-z0-9_-]{16}$/);
    assert.ok(!envelopes.has(envelope.nonce));
    envelopes.set(envelope.nonce, { envelope, label });
  }

  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    const match = envelopes.get(value.nonce);
    if (match) {
      assert.deepEqual(value, match.envelope);
      return match.label;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
    );
  }

  async function handle(command, _emit, { encryption }) {
    if (command.type === "chat.queue.changed") return null;
    if (!["chat.steer", "chat.native-control"].includes(command.type))
      return undefined;
    try {
      assert.equal(command.type, "chat.steer");
      const { context, prompt, attachment, opaque, text, expected } = current;
      assert.equal(command.chatId, context.chat);
      assert.equal(command.threadId, context.threadId);
      assert.equal(command.executionProfile, context.profile);
      assert.equal(command.operationId, expected.operationId);
      assert.deepEqual(command.queueClaim, {
        id: "steer:" + expected.operationId,
        promptRevision: expected.expectedItemRevision,
      });
      const nativeId = `cantrip:${prompt.pendingMessage.id}`;
      assert.equal(command.nativeClientUserMessageId, nativeId);
      assert.equal(command.prompt, undefined);
      assert.deepEqual(command.protectedPrompt, prompt.pendingMessage);
      assert.deepEqual(command.model, { ...model, catalog: null });
      assert.equal(command.provider.id, provider.id);
      assert.equal(command.provider.baseUrl, provider.baseUrl);
      assert.equal(JSON.stringify(command).includes(marker), false);
      const opened = await openEncryptedChatTurn({
        history: [],
        prompt: command.protectedPrompt,
        service: encryption,
        threadId: command.threadId,
      });
      assert.equal(opened, text);
      assert.deepEqual(
        command.attachments.map((a) => a.protectedMetadata),
        [opaque],
      );
      const [openedAttachment] = await openWorkerAttachments(
        command.attachments,
        encryption,
      );
      assert.deepEqual(openedAttachment, { ...attachment, sha256 });
      const localPath = store.resolve(
        context.chat,
        attachment.id,
        openedAttachment.fileName,
      );
      assert.deepEqual(await readFile(localPath), bytes);
      result.commands.push(structuredClone(command));
      return runtime.steerThread(
        command.chatId,
        command.threadId,
        opened,
        [{ ...openedAttachment, path: localPath }],
        command.model,
        { ...command.provider, apiKey: null },
        {
          operationId: command.operationId,
          queueClaim: command.queueClaim,
          clientUserMessageId: nativeId,
        },
      );
    } catch (error) {
      workerError = error;
      throw error;
    }
  }

  function closeRuntime() {
    gate?.release();
    execution?.fail(new Error("Controlled steer fixture ended"));
    runtime?.close();
  }

  async function run(h, profile) {
    const inputs = [];
    for (const [index, context] of contexts.entries()) {
      const number = 10 * index;
      const attachment = {
        id: id(number + 1),
        chatId: context.chat,
        fileName,
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        kind: "file",
        source: "file",
        status: "ready",
        previewText: null,
        createdAt: "2026-10-25T00:00:00.000Z",
      };
      const opaque = await protectWorkerAttachmentMetadata({
        chatId: context.chat,
        attachmentId: attachment.id,
        content: {
          version: 1,
          fileName,
          mimeType: attachment.mimeType,
          kind: attachment.kind,
          source: attachment.source,
          previewText: null,
          sha256,
          error: null,
        },
        service: h.encryption,
      });
      remember(opaque, `attachment ${context.kind}`);
      const localPath = store.resolve(context.chat, attachment.id, fileName);
      await mkdir(path.dirname(localPath), { recursive: true });
      await writeFile(localPath, bytes);
      await h.fixture.sql([
        `INSERT INTO chat_attachments(id,chat_id,worker_id,size_bytes,status,protected_metadata,created_at) VALUES(${literal(attachment.id)},${literal(context.chat)},${literal(settingsWorker)},${bytes.length},'ready',${json(opaque)},${literal(attachment.createdAt)})`,
        `INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status,verified_at) VALUES(${literal(attachment.id)},${literal(settingsWorker)},'ready',now())`,
      ]);
      const text = marker + " " + context.kind;
      const { queuedPrompt: prompt } = await protectChatTurn({
        service: h.encryption,
        text,
        attachments: [attachment],
        mode: "default",
        modelId: model.id,
        reasoningEffort: null,
        idempotencyKey: "legacy-steer-" + context.kind,
        messageId: id(number + 2),
        promptId: id(number + 3),
      });
      remember(prompt.protectedContent, `queue input ${context.kind}`);
      remember(
        prompt.pendingMessage.protectedContent,
        `message ${context.kind}`,
      );
      const visit = (name, method, route, options) =>
        h.visit(context.kind + " " + name, method, route, options);
      const added = await visit(
        "queue before active turn",
        "POST",
        queue(context),
        {
          json: { ...prompt, frozen: true },
          status: 201,
        },
      );
      assert.equal(added.id, prompt.id);
      assert.equal(added.frozen, true);
      assert.deepEqual(added.pendingMessage, prompt.pendingMessage);
      inputs.push({ context, prompt, attachment, opaque, text, added, visit });
    }
    for (const input of inputs) {
      current = input;
      const { context, prompt, attachment, text, added, visit } = input;
      await h.fixture.sql([
        `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id,codex_thread_id) VALUES(${literal(context.lane)},${literal(context.chat)},${literal(context.worktree)},${literal(context.root)},${literal(settingsWorker)},'agent',false,'Steer parity','active',now(),${literal(context.session)},${literal(context.threadId)})`,
        `UPDATE chats SET status=${literal(context.status)},automation_paused=true WHERE id=${literal(context.chat)}`,
      ]);
      const [state] = await h.fixture.sql(
        [],
        [
          `SELECT jsonb_build_object('status',c.status,'activations',(SELECT count(*) FROM native_command_activations a WHERE a.chat_id=c.id AND a.active))::text result FROM chats c WHERE c.id=${literal(context.chat)}`,
        ],
      );
      assert.deepEqual(state, { status: context.status, activations: 0 });
      const nativeTurn = `turn-${context.kind}`;
      runtime = new CodexAppServer(
        "/controlled/codex",
        cwd,
        cwd,
        unprobedCodexRuntimeReport,
      );
      runtime.request = async (method, params) => {
        assert.equal(method, "turn/steer");
        assert.deepEqual(params, {
          threadId: context.threadId,
          expectedTurnId: nativeTurn,
          clientUserMessageId: `cantrip:${prompt.pendingMessage.id}`,
          input: [
            {
              type: "text",
              text: `${text}\n\nAttachments are stored outside the repository on this worker. Read them from these paths as needed:\n- ${fileName} (text/plain, ${bytes.length} bytes): ${store.resolve(context.chat, attachment.id, fileName)}`,
              text_elements: [],
            },
          ],
        });
        result.nativeCalls.push({ method, params });
        if (gate) {
          const held = gate;
          held.entered = true;
          await held.promise;
          throw new Error(rpcRejection);
        }
        return { turnId: nativeTurn };
      };
      execution = await runtime.prepareAdmittedNativeExecution({
        operationGeneration: "controlled-existing-turn",
        chatId: context.chat,
        threadId: context.threadId,
        cwd,
        model,
        provider,
        captureProtectedDiagnostics: false,
      });
      runtime.handleMessage(
        Buffer.from(
          JSON.stringify({
            method: "turn/started",
            params: {
              threadId: context.threadId,
              turn: { id: nativeTurn, startedAt: 1 },
            },
          }),
        ),
      );
      const route = `/api/queued-prompts/${prompt.id}/steer`;
      const expected = {
        expectedItemRevision: added.revision,
        operationId: context.kind + "-rejected",
      };
      current.expected = expected;
      assert.deepEqual(
        await visit("revision required", "POST", route, {
          json: {},
          status: 409,
        }),
        { code: "queue-revision-required" },
      );
      assert.deepEqual(
        await visit("stale revision", "POST", route, {
          json: { ...expected, expectedItemRevision: added.revision + 1 },
          status: 409,
        }),
        { error: "queue-item-revision-conflict" },
      );
      if (profile === "accounts") {
        assert.deepEqual(
          await visit("foreign steer", "POST", route, {
            client: "other",
            json: expected,
            status: 404,
          }),
          { error: "Queued prompt not found." },
        );
      }
      let release;
      const promise = new Promise((resolve) => (release = resolve));
      gate = { promise, release, entered: false };
      const rejected = visit("worker rejects", "POST", route, {
        json: expected,
        status: 409,
      });
      void rejected.catch(() => {});
      try {
        await until(() => gate.entered || workerError, Boolean);
        if (workerError) throw workerError;
        const held = await visit(
          "queue while steer is in flight",
          "GET",
          queue(context),
        );
        assert.equal(held.items[0].state, "claimed");
        assert.equal(held.claims[0].id, "steer:" + expected.operationId);
        assert.equal(held.claims[0].status, "claimed");
        assert.deepEqual(
          (
            await visit(
              "history before acknowledgement",
              "GET",
              history(context),
            )
          ).messages,
          [],
        );
      } finally {
        gate.release();
      }
      assert.deepEqual(await rejected, { error: rpcRejection });
      gate = undefined;
      const pending = await visit(
        "queue after rejection",
        "GET",
        queue(context),
      );
      assert.deepEqual(pending.items, [added]);
      assert.equal(pending.claims[0].status, "rejected");
      assert.deepEqual(
        (await visit("history after rejection", "GET", history(context)))
          .messages,
        [],
      );

      current.expected = {
        ...expected,
        operationId: context.kind + "-accepted",
      };
      const steered = await visit("worker accepts retry", "POST", route, {
        json: current.expected,
      });
      if (workerError) throw workerError;
      assert.equal(steered.steered, true);
      assert.equal(steered.message.id, prompt.pendingMessage.id);
      assert.equal(steered.message.executionLaneId, context.lane);
      assert.equal(steered.message.contextKind, context.kind);
      assert.equal(steered.message.worktreeId, context.worktree);
      assert.equal(steered.message.scratchRootId, context.root);
      assert.deepEqual(
        steered.message.protectedContent,
        prompt.pendingMessage.protectedContent,
      );
      assert.deepEqual(steered.message.attachmentIds, [attachment.id]);
      const retained = await visit(
        "queue after accepted retry",
        "GET",
        queue(context),
      );
      assert.deepEqual(retained.items, [{ ...added, state: "claimed" }]);
      assert.deepEqual(
        retained.claims.map(({ id, status }) => [id, status]),
        [["steer:" + current.expected.operationId, "claimed"]],
      );
      const messages = await visit(
        "history after accepted retry",
        "GET",
        history(context),
      );
      assert.deepEqual(messages.messages, [steered.message]);
      const [saved] = await h.fixture.sql([], [persisted(context)]);
      assert.deepEqual(
        saved.claims.map(({ id, status }) => [id, status]),
        [
          ["steer:" + current.expected.operationId, "claimed"],
          ["steer:" + expected.operationId, "rejected"],
        ],
      );
      assert.equal(saved.messages.length, 1);
      assert.equal(saved.messages[0].content, null);
      assert.deepEqual(
        saved.messages[0].protected_content,
        steered.message.protectedContent,
      );
      assert.equal(JSON.stringify(saved).includes(marker), false);
      result.retained[context.kind] = { saved, messages, retained };
      closeRuntime();
    }
    assert.equal(result.commands.length, 4);
    assert.equal(result.nativeCalls.length, 4);
  }

  async function reopened(h) {
    for (const context of contexts) {
      const { saved, messages, retained } = result.retained[context.kind];
      assert.deepEqual(
        (await h.fixture.sql([], [persisted(context)]))[0],
        saved,
      );
      assert.deepEqual(
        await h.visit(context.kind + " reopened queue", "GET", queue(context)),
        retained,
      );
      assert.deepEqual(
        await h.visit(
          context.kind + " reopened history",
          "GET",
          history(context),
        ),
        messages,
      );
    }
    assert.equal(
      result.observations.some((entry) =>
        JSON.stringify(entry).includes(marker),
      ),
      false,
    );
    return normalize({
      http: result.observations,
      commands: result.commands.map((command) => h.fixture.normalize(command)),
      nativeCalls: result.nativeCalls.map(({ method, params }) => ({
        method,
        params: {
          ...params,
          input: params.input.map((item) => ({
            ...item,
            text: item.text.replaceAll(cwd, "<worker data>"),
          })),
        },
      })),
    });
  }
  return { handle, run, closeRuntime, reopened };
}
