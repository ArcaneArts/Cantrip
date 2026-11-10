import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  decryptTaskMessageProtectedContent,
  decryptTaskProtectedContent,
  encryptTaskProtectedContent,
  generateHpkeKeyPair,
  openTaskOperationRelayRequest,
  openTaskOperationRelayResult,
  publicKeyForPair,
  unwrapComponentKeyForWorker,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import {
  encryptTaskTurnResult,
  executeEncryptedTaskOperation,
  openTaskConversationPrompt,
  prepareEncryptedTaskOperation,
  protectTaskConversationMessage,
} from "../../cantrip_worker/src/task-operation.ts";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.ts";
import {
  seedEventChats,
  task,
  taskProject,
  taskTree,
} from "./native-event-http-setup.mjs";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";
import { json, literal, stamp } from "./project-target-state.mjs";
import { heartbeat, initialization } from "./security-fixtures.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";

const id = (suffix) => "66666666-6666-4666-8666-666666666" + suffix;
const principal = id("694");
const plan = id("698");
const cases = [
  {
    chat: task,
    operation: id("695"),
    kind: "direct",
    endpoint: "start",
    thread: "task-thread",
    state: "complete",
    mode: "default",
  },
  {
    chat: plan,
    operation: id("699"),
    kind: "initial-plan",
    endpoint: "plan",
    thread: "task-plan-thread",
    state: "review",
    mode: "plan",
  },
];
const route = "task-prepare-route";
const model = "task-prepare-model";
const provider = "task-prepare-provider";
const brief = "private-task-preparation-brief — 𝒯";
const planText = "# private-task-planner-output — 測試";
const follow = "private-task-follow-up — 測試";
const answer = "private-task-preparation-answer";
const taskKey = new Uint8Array(32).fill(73);
const configuration = {
  modelId: model,
  reasoningEffort: null,
  customSubagentModel: false,
  subagentModelId: null,
  subagentReasoningEffort: null,
};

function taskRows(chat) {
  const value = literal(chat);
  return `SELECT jsonb_build_object(
    'chat',(SELECT to_jsonb(ch) FROM chats ch WHERE id=${value}),
    'task',(SELECT to_jsonb(t) FROM tasks t WHERE chat_id=${value}),
    'cycles',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM task_dispatch_cycles c WHERE chat_id=${value}),
    'rounds',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.ordinal),'[]') FROM task_planning_rounds r WHERE chat_id=${value}),
    'messages',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.sequence),'[]') FROM chat_messages m WHERE chat_id=${value}),
    'lanes',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]') FROM chat_execution_lanes l WHERE chat_id=${value})) result`;
}

function seed(owner) {
  return [
    ...seedEventChats(owner),
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(provider)},${literal(owner)},'Task prepare','openai-compatible','http://fixture.invalid')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES(${literal(model)},${literal(owner)},'Task prepare')`,
    `INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES(${literal(route)},${literal(model)},${literal(provider)},'task-prepare-native',0)`,
    `UPDATE user_settings SET auto_name_tasks=false,auto_name_chats=false,computer_use_enabled=false WHERE user_id=${literal(owner)}`,
    `UPDATE chats SET model_id=${literal(model)} WHERE id=${literal(task)}`,
    `UPDATE chat_runtime_sessions SET model_route_id=${literal(route)} WHERE chat_id=${literal(task)}`,
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,model_id) SELECT ${literal(plan)},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,'task',model_id FROM chats WHERE id=${literal(task)}`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id) VALUES('task-plan-runtime',${literal(plan)},${literal(worker)},${literal(taskTree)},'task-plan-thread',${literal(route)})`,
  ];
}

const keyOf = (envelope) =>
  JSON.stringify([envelope.keyRevision, envelope.nonce, envelope.ciphertext]);

function held() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release, requested: false };
}

async function wait(read, predicate, label) {
  const deadline = Date.now() + 15_000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await delay(75);
  } while (Date.now() < deadline);
  assert.fail(label);
}

export function taskExecutionHttpCases(result) {
  let h, grantedKey, sdk, preparing, converting, followInput;
  const drafts = new Map();
  const envelopes = new Map();
  const prepared = new Map();
  const leaseDeadlines = new Set();
  const leaseOwners = new Set();
  Object.assign(result, {
    rawCommands: [],
    preparations: [],
    turns: [],
    conversions: [],
    inputDispatches: [],
    rawStages: [],
    cryptoProofs: 0,
  });

  const key = () => ({ key: new Uint8Array(grantedKey), keyRevision: 1 });
  const material = () => ({
    ownerId: h.owner,
    componentKey: grantedKey,
    keyRevision: 1,
  });
  const crypto = (wrapped, label) => {
    assert.equal(wrapped.envelope.algorithm, "AES-256-GCM");
    envelopes.set(keyOf(wrapped.envelope), label);
  };
  const read = async (chat) =>
    (
      await h.fixture.sql(
        [],
        [taskRows(chat).replace(" result", "::text result")],
      )
    )[0];
  const visit = (...args) => h.visit(...args);
  const keep = (label, state) => result.rawStages.push({ label, state });

  async function prepare({ owner, fixture }) {
    for (const spec of cases) {
      const content = {
        version: 1,
        classification: taskContent("draft").classification,
        briefMarkdown: brief,
        planMarkdown: null,
        currentQuestions: [],
        currentAnswers: [],
        additionalDirection: "",
        finalPlanMarkdown: null,
        goalPrompt: null,
        lastError: null,
      };
      const encrypted = await encryptTaskProtectedContent({
        ownerId: owner,
        chatId: spec.chat,
        keyRevision: 1,
        componentKey: taskKey,
        content,
      });
      drafts.set(spec.chat, { content, encrypted });
      await fixture.sql([
        `INSERT INTO tasks(chat_id,state,plan_goal_enabled,protected_content,model_configuration,created_at,updated_at) VALUES(${literal(spec.chat)},'draft',${spec.kind !== "direct"},${json(encrypted)},${json(configuration)},${literal(stamp)},${literal(stamp)})`,
      ]);
    }
  }

  async function grant() {
    await visit(
      "initialize encryption",
      "POST",
      "/api/encryption/profile/initialize",
      { status: 201, json: initialization() },
    );
    const workerKeyPair = await generateHpkeKeyPair();
    const publicKey = await publicKeyForPair(workerKeyPair);
    const endpoint = "/api/internal/workers/encryption/bootstrap";
    const options = {
      client: "worker",
      headers: {
        authorization: "Bearer " + h.credential,
        "x-cantrip-worker-id": worker,
      },
      json: { principalId: principal, publicKey },
    };
    const pending = await visit(
      "pending worker key",
      "POST",
      endpoint,
      options,
    );
    assert.equal(pending.principal.state, "pending");
    assert.equal(pending.principal.id, principal);
    assert.deepEqual(pending.grants, []);
    const authority = `/api/encryption/principals/${principal}`;
    const approved = await visit(
      "approve worker key",
      "POST",
      authority + "/approve",
      { json: { expectedRevision: 1 } },
    );
    assert.equal(approved.state, "approved");
    const wrappedKey = await wrapComponentKeyForWorker({
      ownerId: h.owner,
      workerId: worker,
      component: "task-content",
      componentKey: taskKey,
      keyRevision: 1,
      workerPublicKey: publicKey,
    });
    const created = await visit(
      "grant worker Task component key",
      "POST",
      authority + "/grants",
      {
        status: 201,
        json: { component: "task-content", keyRevision: 1, wrappedKey },
      },
    );
    assert.deepEqual(created.wrappedKey, wrappedKey);
    const ready = await visit(
      "read approved Task component key",
      "POST",
      endpoint,
      options,
    );
    assert.equal(ready.principal.state, "approved");
    assert.deepEqual(ready.principal.publicKey, publicKey);
    assert.deepEqual(ready.grants, [created]);
    grantedKey = await unwrapComponentKeyForWorker({
      ownerId: h.owner,
      grant: ready.grants[0].wrappedKey,
      workerKeyPair,
    });
    assert.deepEqual(grantedKey, taskKey);
    result.cryptoProofs++;
    for (const { chat } of cases) {
      const { content, encrypted } = drafts.get(chat);
      assert.deepEqual(
        await decryptTaskProtectedContent({
          ...material(),
          chatId: chat,
          encrypted,
          publicClassification: content.classification,
        }),
        content,
      );
      crypto(encrypted, "draft:" + chat);
      result.cryptoProofs++;
    }
    return ready.grants.map(({ component, keyRevision }) => ({
      component,
      keyRevision,
    }));
  }

  async function reportGrant(grants) {
    const encryption = {
      supported: true,
      state: "ready",
      principalId: principal,
      grants,
      lastSyncedAt: null,
      error: null,
    };
    const actual = await visit(
      "worker reports opened Task key",
      "POST",
      "/api/internal/workers/heartbeat",
      {
        client: "worker",
        headers: { authorization: "Bearer " + h.credential },
        status: 202,
        json: { ...heartbeat, workerId: worker, encryption },
      },
    );
    assert.deepEqual(actual.encryption, encryption);
  }

  async function onCommand(command, _emit, scope) {
    result.rawCommands.push(structuredClone(command));
    if (command.type === "chat.queue.changed") return null;
    if (command.type === "chat.thread.ensure") {
      const spec = cases.find((entry) => entry.chat === command.chatId);
      if (spec) return { threadId: spec.thread };
    }
    if (command.type === "task.operation.prepare") {
      const spec = preparing.spec;
      assert.equal(command.operationId, spec.operation);
      assert.equal(command.operationKind, spec.kind);
      assert.equal(command.task.chatId, spec.chat);
      assert.equal(command.task.rowVersion, 1);
      assert.deepEqual(
        command.task.protectedContent,
        drafts.get(spec.chat).encrypted,
      );
      const value = await prepareEncryptedTaskOperation({
        getComponentKey: key,
        ownerId: scope.owner,
        request: {
          operationId: command.operationId,
          operationKind: command.operationKind,
          task: command.task,
        },
      });
      const opened = await openTaskOperationRelayRequest({
        ...material(),
        request: value.operation,
      });
      assert.equal(opened.round.inputBriefMarkdown, brief);
      assert.equal(opened.task.classification.activeOperationKind, spec.kind);
      assert.equal(opened.userMessage.classification.mode, spec.mode);
      crypto(
        value.operation.task.protectedContent,
        "running Task:" + spec.chat,
      );
      crypto(
        value.operation.userMessage.protectedContent,
        "scheduled input:" + spec.chat,
      );
      result.cryptoProofs += 3;
      prepared.set(spec.chat, value);
      result.preparations.push({ command, value });
      preparing.requested = true;
      await preparing.promise;
      return value;
    }
    if (command.type === "task.message.protect") {
      assert.deepEqual(command.message, followInput.message);
      converting.requested = true;
      const service = {
        ...scope.encryption,
        componentKey: (component) =>
          component === "task-content"
            ? key()
            : scope.encryption.componentKey(component),
      };
      try {
        const value = await protectTaskConversationMessage({
          message: command.message,
          service,
        });
        assert.equal(
          await openTaskConversationPrompt({ message: value, service }),
          follow,
        );
        crypto(value.protectedContent, "follow-up input");
        result.cryptoProofs++;
        result.conversions.push({ command, value });
        await converting.promise;
        return value;
      } catch (error) {
        result.conversions.push({ command, error: error.message });
        throw error;
      }
    }
    if (command.type !== "chat.turn") return undefined;
    const spec = cases.find((entry) => entry.chat === command.chatId);
    assert.ok(spec);
    assert.equal(command.worktreeId, taskTree);
    assert.equal(command.model.routeId, route);
    assert.equal(command.provider.id, provider);
    const raw = {
      status: "completed",
      threadId: spec.thread,
      turnId: "fixture-task-turn-" + (result.turns.length + 1),
      text: answer,
    };
    let value;
    if (command.resultMode.kind === "task-encrypted") {
      const request = prepared.get(spec.chat).operation;
      assert.deepEqual(command.resultMode.operation, request);
      assert.equal(command.taskDispatchLease.operationId, spec.operation);
      const binding = {
        serverId: scope.serverId,
        workerGeneration: h.worker.connectionGeneration(),
        receipt: command.taskInferenceInput,
      };
      assert.equal(binding.receipt.clientMessageId, request.userMessage.id);
      value = await executeEncryptedTaskOperation({
        getComponentKey: key,
        ownerId: scope.owner,
        request,
        run: async ({ prompt, outputSchema }) => {
          assert.ok(prompt.includes(brief));
          assert.equal(Boolean(outputSchema), spec.mode === "plan");
          for (const phase of ["claim", "dispatch", "native"]) {
            const input = {
              ...binding,
              phase,
              ...(phase === "native"
                ? {
                    nativeExecution: {
                      threadId: raw.threadId,
                      turnId: raw.turnId,
                      scopeId: "controlled-task-native-" + spec.kind,
                    },
                    nativeRuntimeGeneration:
                      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
                  }
                : {}),
            };
            result.inputDispatches.push({
              input,
              response: await sdk.dispatchTaskInput(input),
            });
          }
          return spec.mode === "plan"
            ? {
                ...raw,
                structuredResult: { planMarkdown: planText, questions: [] },
              }
            : raw;
        },
      });
      const relay = value.structuredResult;
      const opened = await openTaskOperationRelayResult({
        ...material(),
        request,
        result: relay,
      });
      assert.equal(opened.task.classification.state, spec.state);
      assert.equal(opened.task.briefMarkdown, brief);
      assert.equal(
        opened.round.outputPlanMarkdown,
        spec.mode === "plan" ? planText : null,
      );
      assert.ok(
        opened.assistantMessage.content.some(
          (item) => item.text === (spec.mode === "plan" ? planText : answer),
        ),
      );
      crypto(relay.task.protectedContent, "settled Task:" + spec.chat);
      crypto(
        relay.assistantMessage.protectedContent,
        "scheduled reply:" + spec.chat,
      );
      result.cryptoProofs += 3;
    } else {
      assert.equal(command.resultMode.kind, "task-message-encrypted");
      assert.equal(command.taskInferenceInput, undefined);
      assert.deepEqual(
        command.protectedTaskPrompt,
        result.conversions.at(-1).value,
      );
      value = await encryptTaskTurnResult({
        getComponentKey: key,
        ownerId: scope.owner,
        result: raw,
        messageId: command.resultMode.messageId,
        idempotencyKey: command.resultMode.idempotencyKey,
        mode: "default",
      });
      crypto(
        value.structuredResult.message.protectedContent,
        "follow-up reply",
      );
    }
    assert.equal(value.text, "");
    result.turns.push({ command, value });
    return value;
  }

  function admission(name, response, spec) {
    assert.equal(response.dispatch.state, "queued");
    assert.equal(response.dispatch.operationId, spec.operation);
    assert.equal(response.dispatch.operationKind, spec.kind);
    assert.equal(response.rowVersion, 1);
    assert.deepEqual(
      response.protectedContent,
      drafts.get(spec.chat).encrypted,
    );
    const code = response.dispatch.eligibilityCode;
    assert.ok(
      code === null ||
        (spec.kind === "direct" && code === "encryption-grant-unavailable"),
    );
    result.observations.find(
      (entry) => entry.name === name,
    ).body.dispatch.eligibilityCode = "<scheduler observation>";
  }

  async function schedule(spec, grants) {
    preparing = { ...held(), spec };
    const name = "admit scheduled " + spec.kind;
    const endpoint = `/api/tasks/${spec.chat}/${spec.endpoint}`;
    const input = { operationId: spec.operation, rowVersion: 1 };
    const response = await visit(name, "POST", endpoint, {
      status: 202,
      json: input,
    });
    admission(name, response, spec);
    if (grants) {
      const unready = await wait(
        () => read(spec.chat),
        (row) =>
          row.cycles[0]?.eligibility_code === "encryption-grant-unavailable",
        "queued Task waits for reported worker grant",
      );
      assert.equal(unready.cycles[0].state, "queued");
      assert.equal(unready.cycles[0].fencing_token, 0);
      assert.equal(preparing.requested, false);
      keep("queued without reported grant", unready);
      await reportGrant(grants);
    }
    await wait(
      () => preparing.requested,
      Boolean,
      "actual scheduler asks worker to prepare Task",
    );
    const claimed = await read(spec.chat);
    keep("held " + spec.kind + " preparation", claimed);
    const [cycle] = claimed.cycles;
    assert.equal(cycle.id, response.dispatch.id);
    assert.equal(cycle.state, "claimed");
    assert.equal(cycle.fencing_token, 1);
    assert.equal(claimed.rounds.length, 0);
    assert.equal(claimed.messages.length, 0);
    assert.equal(claimed.lanes.length, 0);
    assert.deepEqual(
      claimed.task.protected_content,
      drafts.get(spec.chat).encrypted,
    );
    preparing.release();
    const completed = await wait(
      () => read(spec.chat),
      (row) =>
        row.cycles[0]?.state === "succeeded" &&
        row.chat.status === "idle" &&
        row.messages.length === 2,
      "scheduled Task completes in original cycle",
    );
    keep("settled " + spec.kind, completed);
    assert.equal(completed.task.state, spec.state);
    assert.equal(completed.cycles.length, 1);
    assert.equal(completed.cycles[0].id, cycle.id);
    assert.equal(completed.cycles[0].fencing_token, cycle.fencing_token);
    const [round] = completed.rounds;
    const turn = result.turns.at(-1);
    const relay = turn.value.structuredResult;
    const native = result.inputDispatches.at(-1);
    assert.deepEqual(round.relay_request, prepared.get(spec.chat).operation);
    assert.deepEqual(round.relay_result, relay);
    assert.deepEqual(round.inference_input.receipt, native.response.receipt);
    assert.deepEqual(
      round.inference_input.nativeExecution,
      native.response.nativeExecution,
    );
    assert.deepEqual(round.inference_input.nativeOwner, {
      workerGeneration: native.input.workerGeneration,
      runtimeGeneration: native.response.nativeRuntimeGeneration,
    });
    assert.equal(round.inference_input.terminal.ok, true);
    assert.equal(round.inference_input.terminal.turnId, turn.value.turnId);
    assert.equal(round.inference_input.terminal.threadId, spec.thread);
    assert.ok(round.inference_input.terminal.projectedAt);
    assert.equal(round.status, "completed");
    assert.equal(round.assistant_message_id, relay.assistantMessage.id);
    assert.deepEqual(
      completed.task.protected_content,
      relay.task.protectedContent,
    );
    assert.deepEqual(
      completed.messages.map((message) => message.id),
      [round.relay_request.userMessage.id, relay.assistantMessage.id],
    );
    const retainedCycle = completed.cycles[0];
    assert.equal(cycle.lease_owner, h.serverId + ":local-single-instance");
    assert.equal(retainedCycle.lease_owner, cycle.lease_owner);
    leaseOwners.add(retainedCycle.lease_owner);
    const expires = Date.parse(cycle.lease_expires_at);
    assert.equal(expires - Date.parse(cycle.last_heartbeat_at), 120_000);
    assert.equal(retainedCycle.lease_expires_at, cycle.lease_expires_at);
    assert.ok(Date.parse(retainedCycle.completed_at) <= expires);
    const deadline = new Date(expires).toISOString();
    leaseDeadlines.add(deadline);
    const summary = await visit(
      "settled Task " + spec.kind,
      "GET",
      `/api/tasks/${spec.chat}`,
    );
    assert.equal(summary.dispatch.leaseExpiresAt, deadline);
    assert.equal(summary.dispatch.id, retainedCycle.id);
    assert.equal(summary.dispatch.leaseOwner, retainedCycle.lease_owner);
    return completed;
  }

  async function followUp(profile, scheduled) {
    const endpoint = `/api/chats/${task}/turns`;
    const protect = (suffix) =>
      protectChatTurn({
        text: follow,
        idempotencyKey: "task-follow-up-" + suffix,
        messageId: id(suffix ? "689" : "696"),
        promptId: id(suffix ? "688" : "697"),
        mode: "default",
        modelId: model,
        reasoningEffort: null,
        service: h.encryption,
      });
    followInput = await protect("tampered");
    for (const message of [
      followInput.message,
      followInput.queuedPrompt.pendingMessage,
    ]) {
      const envelope = message.protectedContent.envelope;
      const cipher = Buffer.from(envelope.ciphertext, "base64url");
      cipher[0] ^= 1;
      envelope.ciphertext = cipher.toString("base64url");
    }
    converting = held();
    await visit(
      "tampered Task message rejected by worker codec",
      "POST",
      endpoint,
      { status: 400, json: followInput },
    );
    assert.equal(converting.requested, true);
    assert.equal(
      result.conversions.at(-1).error,
      "Encrypted material could not be authenticated.",
    );
    assert.deepEqual(await read(task), scheduled);

    followInput = await protect("");
    if (profile !== "none") {
      await visit("Task follow-up requires session", "POST", endpoint, {
        status: 401,
        client: "stranger",
        json: followInput,
      });
      await visit("Task follow-up requires CSRF", "POST", endpoint, {
        status: 403,
        csrf: false,
        json: followInput,
      });
    }
    if (profile === "accounts")
      await visit("foreign Task follow-up hidden", "POST", endpoint, {
        status: 404,
        client: "other",
        json: followInput,
      });
    assert.equal(result.conversions.length, 1);
    converting = held();
    const pending = visit("protected Task follow-up", "POST", endpoint, {
      status: 202,
      json: followInput,
    });
    let started;
    try {
      await wait(
        () => converting.requested,
        Boolean,
        "worker receives protected message",
      );
      assert.deepEqual(await read(task), scheduled);
      converting.release();
      started = await pending;
    } finally {
      converting.release();
      await pending.catch(() => {});
    }
    assert.equal(started.kind, "task-encrypted");
    assert.equal(started.message.id, followInput.message.id);
    const { value } = result.conversions.at(-1);
    assert.deepEqual(started.message.protectedContent, value.protectedContent);
    assert.notDeepEqual(
      value.protectedContent,
      followInput.message.protectedContent,
    );
    const replay = await visit(
      "Task follow-up replay uses saved message",
      "POST",
      endpoint,
      { json: followInput },
    );
    assert.deepEqual(replay, started);
    const completed = await wait(
      () => read(task),
      (row) => row.chat.status === "idle" && row.messages.length === 4,
      "Task conversation result persisted",
    );
    assert.equal(result.conversions.length, 2);
    assert.equal(result.turns.length, 2);
    assert.deepEqual(completed.cycles, scheduled.cycles);
    assert.deepEqual(completed.rounds, scheduled.rounds);
    assert.deepEqual(completed.task, scheduled.task);
    return completed;
  }

  async function history(spec, state) {
    const value = await visit(
      "encrypted Task history " + spec.kind,
      "GET",
      `/api/chats/${spec.chat}/messages`,
    );
    assert.equal(value.kind, "task-encrypted");
    assert.equal(value.messages.length, state.messages.length);
    const expected =
      spec.kind === "direct"
        ? [brief, answer, follow, answer]
        : [null, planText];
    for (const [i, row] of state.messages.entries()) {
      const message = value.messages[i];
      assert.equal(row.content, null);
      assert.equal(row.protected_content, null);
      assert.equal(row.id, message.id);
      assert.equal(row.sequence, message.sequence);
      assert.equal(row.role, i % 2 ? "assistant" : "user");
      assert.deepEqual(row.task_protected_content, message.protectedContent);
      const opened = await decryptTaskMessageProtectedContent({
        ...material(),
        messageId: message.id,
        encrypted: message.protectedContent,
        publicClassification: {
          role: message.role,
          mode: message.mode,
          attachmentIds: message.attachmentIds,
        },
      });
      assert.equal(opened.classification.mode, spec.mode);
      const text = opened.content.map((item) => item.text).join("\n");
      if (expected[i] === null) assert.ok(text.includes(brief));
      else assert.equal(text, expected[i]);
      assert.ok(envelopes.has(keyOf(message.protectedContent.envelope)));
      result.cryptoProofs++;
    }
  }

  const bootstrapLabels = new Set([
    "pending worker key",
    "approve worker key",
    "grant worker Task component key",
    "read approved Task component key",
  ]);
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    if (
      value.algorithm === "AES-256-GCM" &&
      typeof value.nonce === "string" &&
      typeof value.ciphertext === "string"
    ) {
      const label = envelopes.get(keyOf(value));
      if (label)
        return { ...value, nonce: "<authenticated nonce>", ciphertext: label };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalize(child)]),
    );
  }

  async function run(fixture, profile) {
    h = fixture;
    const normalizeHttp = h.fixture.normalize.bind(h.fixture);
    h.fixture.normalize = (value, key) => {
      if (key === "leaseExpiresAt" && leaseDeadlines.has(value))
        return "<observed dispatch lease deadline>";
      if (key === "leaseOwner" && leaseOwners.has(value))
        return "<server identity>:local-single-instance";
      return normalizeHttp(value, key);
    };
    sdk = new NativeCommandClient({
      serverUrl: h.fixture.server.origin,
      workerId: worker,
      token: () => h.credential,
    });
    await h.live.subscribed("scheduled and protected Task operations", [
      ...cases.map(({ chat }) => ({ kind: "chat", chatId: chat })),
      { kind: "project", projectId: taskProject },
    ]);
    const grants = await grant();
    const scheduled = await schedule(cases[0], grants);
    const continued = await followUp(profile, scheduled);
    const planned = await schedule(cases[1]);
    assert.equal(result.turns.length, 3);
    await history(cases[0], continued);
    await history(cases[1], planned);
    await h.live.ping("complete Task publication");
    result.rawRetained = await Promise.all(cases.map(({ chat }) => read(chat)));
    assert.deepEqual(result.rawRetained, [continued, planned]);
    result.productObservations = result.observations
      .filter(({ name }) => !bootstrapLabels.has(name))
      .map(normalize);
    result.rawLive = h.live.history;
    const privateMarkers = [brief, follow, planText, answer];
    for (const text of privateMarkers)
      assert.equal(
        JSON.stringify([
          result.rawRetained,
          result.rawStages,
          result.rawCommands,
          result.inputDispatches,
          result.rawLive,
          [...h.fixture.records],
          h.diagnostics(),
        ]).includes(text),
        false,
      );
    result.effects = result.rawRetained.map(
      ({ task, cycles, messages, rounds, lanes }) => ({
        state: task.state,
        version: task.row_version,
        kind: cycles[0].operation_kind,
        cycle: cycles[0].state,
        fence: cycles[0].fencing_token,
        round: rounds[0].status,
        lane: lanes[0].state,
        history: messages.map(({ role, mode, sequence, idempotency_key }) => ({
          role,
          mode,
          sequence,
          idempotencyKey: idempotency_key.startsWith("assistant:")
            ? "follow-up-reply"
            : idempotency_key,
        })),
      }),
    );
    const selected = result.rawLive.filter(
      (frame) => frame.type === "event" && frame.resource === "chat-message",
    );
    let lastCursor = 0;
    result.messageEvents = selected.map(({ cursor, occurredAt, ...frame }) => {
      assert.ok(Number.isSafeInteger(cursor) && cursor > lastCursor);
      lastCursor = cursor;
      assert.ok(Number.isFinite(Date.parse(occurredAt)));
      const saved = result.rawRetained
        .flatMap(({ messages }) => messages)
        .find(({ id }) => id === frame.entityId);
      assert.ok(saved);
      assert.equal(frame.payload.id, saved.id);
      assert.deepEqual(
        frame.payload.protectedContent,
        saved.task_protected_content,
      );
      return normalize(h.fixture.normalize(frame));
    });
    assert.equal(new Set(selected.map((frame) => frame.entityId)).size, 6);
  }

  return {
    configure: seed,
    prepare,
    onCommand,
    run,
    queries: cases.map(({ chat }) => taskRows(chat)),
    release() {
      preparing?.release();
      converting?.release();
    },
  };
}
