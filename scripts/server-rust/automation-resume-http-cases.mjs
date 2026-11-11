import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { ManagedNativeCommandSession } from "../../cantrip_worker/src/codex/managed-native-command-session.ts";
import { managedQueueNativeCommand } from "../../cantrip_worker/src/codex/managed-queue-command.ts";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.ts";
import {
  openEncryptedChatTurn,
  protectChatTurn,
} from "../../cantrip_worker/src/chat-message-encryption.ts";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../cantrip_worker/src/native-command-content.ts";
import { decryptQueuedPromptProtectedContent } from "../../packages/crypto/dist/index.js";
import { deadline } from "./live-sockets.mjs";
import { literal } from "./project-target-state.mjs";
import {
  settingsChat as chat,
  until,
} from "./native-settings-http-fixture.mjs";

const route = `/api/chats/${chat}`;
const promptId = "ef4e2a48-43b7-4f18-9897-000000000001";
const messageId = "ef4e2a48-43b7-4f18-9897-000000000002";
const objective = "private-queued-goal-𐐷";
const modelId = "resume-model";
const goalResult = {
  goal: { objective, status: "active" },
  goalEpoch: "resume-epoch",
};
const commandTypes = new Set([
  "chat.pause.set",
  "chat.automation.resume",
  "chat.queue.execute",
]);
const timestamps = new Set([
  "created_at",
  "updated_at",
  "execution_completed_at",
  "createdAt",
  "updatedAt",
]);
export const resumeSql = `SELECT jsonb_build_object(
 'paused',(SELECT automation_paused FROM chats WHERE id=${literal(chat)}),
 'stopped',(SELECT managed_autonomy_stopped FROM chats WHERE id=${literal(chat)}),
 'queue',(SELECT to_jsonb(s) FROM managed_queue_states s WHERE chat_id=${literal(chat)}),
 'prompt',(SELECT to_jsonb(q) FROM queued_prompts q WHERE id=${literal(promptId)}),
 'claims',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM managed_queue_claims c WHERE prompt_id=${literal(promptId)}),
 'messages',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') FROM chat_messages m WHERE chat_id=${literal(chat)}),
 'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.operation_id),'[]') FROM native_commands n WHERE chat_id=${literal(chat)})
 )::text result`;

export function automationResumeHttpCases(result, root) {
  let h,
    stage = "startup",
    reply,
    heldResume,
    heldNative,
    prompt;
  const aliases = new Map(),
    envelopes = new Map();
  const { commands, states, sdk } = result;

  function normalize(value, key) {
    if (Array.isArray(value)) return value.map((entry) => normalize(entry));
    if (value && typeof value === "object") {
      const envelope = envelopes.get(value.nonce);
      if (envelope) {
        assert.deepEqual(value, envelope.value);
        return envelope.label;
      }
      return Object.fromEntries(
        Object.entries(value).map(([field, entry]) => [
          field,
          normalize(entry, field),
        ]),
      );
    }
    if (aliases.has(value)) return aliases.get(value);
    if (typeof value === "string" && key === "notification_due_at") {
      const at = Date.parse(value);
      assert.ok(at >= result.startedAt - 1000 && at <= Date.now() + 5500);
      return "<queue notification clock>";
    }
    if (
      typeof value === "string" &&
      value !== "<timestamp>" &&
      timestamps.has(key)
    ) {
      const at = Date.parse(value);
      assert.ok(at >= result.startedAt - 1000 && at <= Date.now() + 1000);
      return "<database clock>";
    }
    return value;
  }

  function remember(value, label) {
    assert.match(value.nonce, /^[A-Za-z0-9_-]{16}$/);
    assert.ok(!envelopes.has(value.nonce));
    envelopes.set(value.nonce, { value, label });
  }

  const configure = (owner) => [
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('resume-provider',${literal(owner)},'Resume','openai-compatible','http://fixture.invalid')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('${modelId}',${literal(owner)},'Resume')`,
    `INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('resume-route','${modelId}','resume-provider','resume',0,true)`,
    `UPDATE chats SET status='idle',automation_paused=true,managed_autonomy_stopped=true,model_id='${modelId}',auto_title_pending=false WHERE id=${literal(chat)}`,
    "UPDATE chat_runtime_sessions SET model_route_id='resume-route',status='ready' WHERE id='settings-runtime'",
    `UPDATE user_settings SET default_model_id='${modelId}',auto_name_chats=false WHERE user_id=${literal(owner)}`,
  ];

  async function onCommand(command, _emit, { encryption }) {
    if (!commandTypes.has(command.type)) return undefined;
    commands.push({ stage, command: structuredClone(command) });
    assert.equal(command.chatId, chat);
    if (command.type === "chat.pause.set")
      return { paused: command.paused, active: null };
    assert.equal(command.threadId, "thread");
    assert.equal(command.session.projectId, h.scope.projectId);
    assert.equal(command.session.worktreeId, h.scope.placementId);
    assert.equal(command.model.routeId, "resume-route");
    assert.equal(command.permissionProfileId, ":workspace");
    if (command.type === "chat.automation.resume") {
      if (heldResume) {
        heldResume.arrived = true;
        await heldResume.promise;
      }
      return { resumed: reply };
    }
    assert.equal(command.queuedPromptId, promptId);
    assert.equal(command.executionMethod, "thread/goal/set");
    assert.deepEqual(command.protectedPrompt, prompt.pendingMessage);
    const text = await openEncryptedChatTurn({
      history: [],
      prompt: command.protectedPrompt,
      service: encryption,
      threadId: command.threadId,
    });
    assert.equal(text, objective);
    remember(
      command.protectedPrompt.protectedContent.envelope,
      "<verified queued message>",
    );
    const native = await managedQueueNativeCommand({
      opened: {
        version: 1,
        input: [{ type: "text", text, text_elements: [] }],
        action: "literal",
        executionMethod: command.executionMethod,
        displayText: text,
        attachmentMap: [],
        representedAttachmentIds: [],
      },
      threadId: command.threadId,
      promptId,
      codexHome: path.join(root, "controlled-codex-home"),
    });
    assert.equal(native.method, "thread/goal/set");
    assert.equal(native.params.objective, objective);
    const operationId = `queue:${command.queueClaim.id}`;
    const identity = {
      chatId: chat,
      contextKind: "project",
      projectId: command.session.projectId,
      placementId: command.session.worktreeId,
    };
    const runtimeGeneration = "resume-runtime";
    const session = {
      ...identity,
      threadId: command.threadId,
      modelRouteId: command.model.routeId,
      providerAccountId: null,
      runtimeGeneration,
      connectionId: "resume-gui",
    };
    const client = new NativeCommandClient({
      serverUrl: h.fixture.server.origin,
      workerId: h.scope.workerId,
      token: () => h.credential,
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        sdk.push({
          path: new URL(url).pathname,
          input: JSON.parse(options.body),
          status: response.status,
          body: await response.clone().json(),
        });
        return response;
      },
    });
    const adapter = new ManagedNativeCommandSession({
      identity: {
        ...identity,
        serverId: h.serverId,
        ownerId: h.owner,
        workerId: h.scope.workerId,
      },
      runtime: { transportGeneration: runtimeGeneration },
      client,
      encryption,
      policy: {
        cwd: command.cwd,
        codexHome: path.join(root, "controlled-codex-home"),
        permissionProfileId: command.permissionProfileId,
        security: {
          permissions: ":workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        },
      },
      beginExecution: async () => {
        throw new Error("The fixture controls the autonomous model boundary");
      },
      onError: (error) => result.workerErrors.push(error.message),
    });
    const accepted = await adapter.executeGuiCommand(session, {
      ...native,
      operationId,
      queueClaim: command.queueClaim,
      dispatch: async () => {
        heldNative.arrived = true;
        await heldNative.promise;
        return goalResult;
      },
    });
    const [admit, dispatch, receipt] = sdk;
    assert.deepEqual(
      sdk.map(({ path, status }) => [path.split("/").at(-1), status]),
      [
        ["admit", 200],
        ["dispatch", 200],
        ["receipt", 200],
      ],
    );
    assert.deepEqual(admit.input.queueClaim, command.queueClaim);
    const { operationGeneration } = admit.body.receipt;
    for (const record of sdk) {
      assert.equal(record.input.operationId, operationId);
      assert.equal(
        record.body.receipt.operationGeneration,
        operationGeneration,
      );
    }
    assert.equal(dispatch.input.operationGeneration, operationGeneration);
    assert.equal(receipt.input.operationGeneration, operationGeneration);
    assert.equal(receipt.input.goalEpoch, goalResult.goalEpoch);
    assert.equal(receipt.body.receipt.status, "applied");
    for (const [direction, envelope, digest, expected] of [
      [
        "request",
        admit.input.protectedPayload,
        admit.input.payloadDigest,
        { id: operationId, method: native.method, params: native.params },
      ],
      [
        "result",
        receipt.input.protectedResult,
        receipt.input.resultDigest,
        { result: goalResult },
      ],
    ]) {
      const context = { chatId: chat, operationId, direction };
      const opened = await openNativeCommandContent({
        service: encryption,
        context,
        envelope,
      });
      assert.deepEqual(opened, expected);
      assert.equal(
        (
          await protectNativeCommandContent({
            service: encryption,
            context,
            content: opened,
          })
        ).digest,
        digest,
      );
      remember(envelope, `<verified native ${direction}>`);
      aliases.set(digest, `<verified native ${direction} digest>`);
    }
    aliases.set(command.queueClaim.id, "<verified claim>");
    aliases.set(operationId, "<verified queue operation>");
    aliases.set(operationGeneration, "<verified queue operation generation>");
    return accepted;
  }

  async function capture(label) {
    const [value] = await h.fixture.sql([], [resumeSql]);
    states[label] = value;
    assert.equal(JSON.stringify(value).includes(objective), false);
    return value;
  }

  async function run(fixture, profile) {
    h = fixture;
    aliases.set(h.owner, "<verified owner>");
    const initialObservation = result.observations.length;
    const scopes = [
      { kind: "chat", chatId: chat },
      { kind: "project", projectId: h.scope.projectId },
      { kind: "current-user" },
    ];
    await h.live.subscribed("automation", scopes);
    const offset = h.live.history.length;
    const currentUserEvents = () =>
      h.live.history
        .slice(offset)
        .filter(
          (event) =>
            event.type === "event" &&
            event.scope.kind === "current-user" &&
            event.resource === "chat" &&
            event.entityId === chat,
        );
    const expectPublications = async (count) => {
      await until(currentUserEvents, (events) => events.length >= count);
      assert.equal(currentUserEvents().length, count);
    };
    const pause = (name, paused, options = {}) => {
      stage = name;
      return h.visit(name, "PATCH", route + "/pause", {
        json: { paused },
        ...options,
      });
    };
    const initial = await capture("initial");
    assert.equal(initial.paused, true);
    assert.equal(initial.stopped, true);
    await pause("invalid pause input", null, { status: 400 });
    if (profile !== "none")
      await pause("pause requires CSRF", false, { csrf: false, status: 403 });
    if (profile === "accounts")
      await pause("foreign chat is hidden", false, {
        client: "other",
        status: 404,
      });
    assert.equal(commands.length, 0);
    assert.deepEqual(await capture("denied"), initial);

    reply = "invalid";
    heldResume = Promise.withResolvers();
    const invalid = pause("invalid resume receipt", false, { status: 409 });
    const invalidSettled = invalid.then(
      () => true,
      () => true,
    );
    try {
      await until(() => heldResume.arrived, Boolean);
      const during = await capture("held malformed resume");
      assert.equal(during.paused, false);
      assert.equal(during.stopped, false);
      assert.deepEqual(during.claims, []);
      await h.live.ping("malformed reply still held");
      assert.deepEqual(currentUserEvents(), []);
    } finally {
      heldResume.resolve();
      await invalidSettled;
      heldResume = undefined;
    }
    assert.equal(
      (await invalid).error,
      "This chat remains paused because its next action could not start: The native automation resume receipt is invalid.",
    );
    assert.equal((await capture("compensated")).paused, true);
    assert.deepEqual(
      commands.map(({ command }) => command.type),
      ["chat.pause.set", "chat.automation.resume", "chat.pause.set"],
    );
    assert.equal(commands.at(-1).command.paused, true);
    await h.live.ping("invalid reply compensated");
    assert.deepEqual(currentUserEvents(), []);

    reply = true;
    assert.deepEqual(await pause("native resume succeeds", false), {
      paused: false,
    });
    await expectPublications(1);
    assert.equal((await capture("resumed")).paused, false);
    assert.deepEqual(
      commands.slice(-2).map(({ command }) => command.type),
      ["chat.pause.set", "chat.automation.resume"],
    );
    await pause("pause before adding goal", true);
    await expectPublications(2);
    ({ queuedPrompt: prompt } = await protectChatTurn({
      service: h.encryption,
      text: objective,
      mode: "goal",
      modelId,
      reasoningEffort: null,
      idempotencyKey: "queue-resume-goal",
      messageId,
      promptId,
    }));
    stage = "add queued goal";
    const created = await h.visit(stage, "POST", route + "/queue", {
      json: prompt,
      status: 201,
    });
    assert.equal(created.id, promptId);
    await expectPublications(3);
    const display = await decryptQueuedPromptProtectedContent({
      ownerId: h.owner,
      promptId,
      componentKey: h.encryption.componentKey().key,
      keyRevision: prompt.protectedContent.keyRevision,
      encrypted: prompt.protectedContent,
      publicClassification: prompt.classification,
    });
    assert.equal(display.text, objective);
    remember(prompt.protectedContent.envelope, "<verified queued display>");
    const queued = await capture("queued while paused");
    assert.equal(queued.paused, true);
    assert.equal(queued.prompt.state, "pending");
    assert.deepEqual(queued.prompt.opaque_content, prompt);
    assert.deepEqual(queued.claims, []);
    assert.deepEqual(queued.messages, []);

    reply = false;
    heldNative = Promise.withResolvers();
    const fallback = pause("resume delivers queued goal", false);
    const fallbackSettled = fallback.then(
      () => true,
      () => true,
    );
    try {
      await until(() => heldNative.arrived, Boolean);
      const held = await capture("held native mutation");
      assert.equal(held.paused, false);
      assert.equal(held.claims.length, 1);
      assert.equal(held.claims[0].status, "dispatched");
      assert.equal(held.claims[0].operation_id, sdk[0].input.operationId);
      assert.equal(
        held.claims[0].operation_generation,
        sdk[0].body.receipt.operationGeneration,
      );
      assert.equal(held.messages.length, 1);
      assert.equal(held.messages[0].content, null);
      await h.live.ping("native result still held");
      if (currentUserEvents().length === 4) {
        // A queue sweep can already own dispatch when resume joins it. In
        // that case the HTTP response completes while the mutation is held.
        assert.deepEqual(
          await deadline(fallback, "coalesced resume response"),
          {
            paused: false,
          },
        );
      } else {
        assert.equal(currentUserEvents().length, 3);
      }
      assert.deepEqual(
        held.messages[0].protected_content,
        prompt.pendingMessage.protectedContent,
      );
      assert.equal(
        held.receipts.find(
          (receipt) => receipt.operation_id === sdk[0].input.operationId,
        ).status,
        "dispatched",
      );
    } finally {
      heldNative.resolve();
      await fallbackSettled;
    }
    assert.deepEqual(await fallback, { paused: false });
    await expectPublications(4);
    assert.deepEqual(result.workerErrors, []);
    const delivered = await capture("settled native mutation");
    const claim = delivered.claims[0],
      settled = sdk[2].input;
    assert.equal(claim.status, "dispatched");
    assert.equal(claim.awaiting_goal, true);
    assert.equal(claim.goal_epoch, goalResult.goalEpoch);
    const retained = delivered.receipts.find(
      ({ operation_id }) => operation_id === settled.operationId,
    );
    assert.equal(retained.status, "applied");
    assert.equal(retained.result_digest, settled.resultDigest);
    assert.deepEqual(retained.protected_result, settled.protectedResult);
    assert.equal(retained.payload_digest, sdk[0].input.payloadDigest);
    assert.deepEqual(retained.protected_payload, sdk[0].input.protectedPayload);

    assert.deepEqual(
      await pause("repeat resume cannot claim the same goal", false),
      { paused: false },
    );
    assert.equal(
      commands.filter(({ command }) => command.type === "chat.queue.execute")
        .length,
      1,
    );
    await expectPublications(5);
    const final = await capture("final");
    assert.deepEqual(final, {
      ...delivered,
      queue: {
        ...delivered.queue,
        revision: delivered.queue.revision + 2,
        notification_due_at: final.queue.notification_due_at,
      },
    });
    await h.visit("final managed queue", "GET", route + "/queue");
    await h.visit("final protected history", "GET", route + "/messages");
    await h.live.ping("automation results published");
    result.rawLive = h.live.history.slice(offset);
    const relevant = result.rawLive.filter(
      (event) =>
        event.type === "event" &&
        ["chat", "chat-message"].includes(event.resource),
    );
    // Queue delivery has its own timer and coalesces revisions. Retain every
    // refresh and check its routing even when it overlaps this HTTP scenario.
    for (const event of result.rawLive.filter(
      (frame) => frame.type === "event" && frame.resource === "chat-queue",
    )) {
      assert.deepEqual(event.scope, { kind: "chat", chatId: chat });
      assert.equal(event.action, "invalidated");
      assert.equal(event.entityId, null);
      assert.equal(event.revision, null);
      assert.equal(event.payload, null);
    }
    assert.equal(final.queue.notified_revision, -1);
    const messages = relevant.filter(
      (event) => event.resource === "chat-message",
    );
    assert.equal(messages.length, 1);
    for (const event of messages) {
      assert.equal(event.entityId, messageId);
      assert.equal(event.revision, final.messages[0].sequence);
      assert.deepEqual(
        event.payload.protectedContent,
        prompt.pendingMessage.protectedContent,
      );
    }
    assert.equal(JSON.stringify(relevant).includes(objective), false);
    result.live = scopes.map((scope) =>
      relevant
        .filter(
          (event) => JSON.stringify(event.scope) === JSON.stringify(scope),
        )
        .map(({ type, resource, action, entityId, revision, payload }) => ({
          type,
          resource,
          action,
          entityId,
          revision,
          payload,
        })),
    );
    assert.deepEqual(
      result.live.map((events) => events.length),
      [1, 7, 5],
    );
    result.initialObservation = initialObservation;
  }

  function finish() {
    for (const receipt of states.final.receipts) {
      if (receipt.method !== "thread/queue/add") continue;
      aliases.set(
        receipt.operation_generation,
        "<verified add operation generation>",
      );
      assert.equal(receipt.operation_id, `gui-queue:add:${chat}:${promptId}`);
      const addDigest = createHash("sha256")
        .update(JSON.stringify({ kind: "add", prompt, attachments: [] }))
        .digest("hex");
      assert.equal(receipt.payload_digest, addDigest);
      aliases.set(addDigest, "<verified add payload digest>");
    }
    result.comparison = normalize({
      http: result.observations.slice(result.initialObservation),
      commands,
      states,
      sdk,
      live: result.live,
    });
  }

  return {
    configure,
    onCommand,
    run,
    finish,
    capture,
    release: () => {
      heldResume?.resolve();
      heldNative?.resolve();
    },
  };
}
