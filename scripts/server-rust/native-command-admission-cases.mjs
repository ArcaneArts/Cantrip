import assert from "node:assert/strict";
import { nativeCommandAdmissionSchema } from "../../packages/protocol/dist/index.js";
import { runDispatchCases } from "./native-command-dispatch-cases.mjs";
import { runControlCases } from "./native-command-control-cases.mjs";
import { runEvidenceCases } from "./native-command-evidence-cases.mjs";
import { runLogicalCases } from "./native-logical-cases.mjs";
import { runQueuedPromptCases } from "./queued-prompt-cases.mjs";
import { runManagedQueueCases } from "./managed-queue-cases.mjs";
import { runNativeEventContextCases } from "./native-event-context-cases.mjs";
import { runAgentInteractionCases } from "./agent-interaction-cases.mjs";
import { runNativeModelInventoryCases } from "./native-model-inventory-cases.mjs";
import { runSettlementCases } from "./native-command-settlement-cases.mjs";
import { literal, label, stamp, otherOwner } from "./project-target-state.mjs";
import { runAdmissionQueueCases } from "./native-command-admission-queue-cases.mjs";
import { runAdmissionSettingsCases } from "./native-command-admission-settings-cases.mjs";

export function command(overrides = {}) {
  const base = {
    workerId: "alpha",
    operationId: "request",
    origin: "gui",
    session: {
      chatId: "chat",
      threadId: null,
      contextKind: "project",
      projectId: "github",
      placementId: "github-alpha-main",
      modelRouteId: null,
      providerAccountId: null,
      runtimeGeneration: null,
      connectionId: null,
    },
    method: "turn/start",
    payloadDigest: "a".repeat(64),
    protectedPayload: label("chat").protectedLabel.envelope,
    expectedActivationGeneration: null,
    intent: { scope: "thread" },
  };
  return nativeCommandAdmissionSchema.parse({
    ...base,
    ...overrides,
    session: { ...base.session, ...overrides.session },
    intent: { ...base.intent, ...overrides.intent },
  });
}
export async function runAdmissionCases(h) {
  const { seed, snapshot, observe, reset, owner, standalone, scratch } = h;
  async function noWrite(name, input, expected) {
    const before = await snapshot("before " + name);
    await observe(name, input, { error: true, ...expected });
    assert.deepEqual(await snapshot("rollback " + name), before, name);
  }
  async function rejected(name, input, code, options = {}) {
    await reset();
    const before = await snapshot("before " + name);
    const result = await observe(name, input, {
      status: "rejected",
      rejection: code,
      options,
    });
    const after = await snapshot("durable rejection " + name);
    for (const [i, value] of after.entries()) {
      assert.equal(value.commands.length, 1, name);
      const row = value.commands[0];
      assert.equal(row.operation_id, "request");
      assert.equal(
        row.protected_payload.ciphertext,
        command().protectedPayload.ciphertext,
      );
      const unchanged = structuredClone(value);
      unchanged.commands = before[i].commands;
      assert.deepEqual(
        unchanged,
        before[i],
        name + " changes only rejection journal",
      );
      assert.equal(Object.hasOwn(result[i], "replayed"), false, name);
    }
    return result;
  }
  await snapshot("initial admission state");
  const start = await observe("fresh GUI start", command(), {
    options: { clientMessageId: "client-message" },
  });
  for (const value of start) {
    assert.equal(Object.hasOwn(value, "replayed"), false);
    assert.equal(value.receipt.logicalOperationId, "request");
    assert.equal(value.receipt.startsExecution, true);
    assert.equal(
      value.receipt.executionLaneId,
      value.execution.executionLaneId,
    );
    assert.equal(value.execution.status, "running");
  }
  const admitted = await snapshot("atomic start lane receipt activation");
  for (const value of admitted) {
    assert.equal(value.commands[0].logical_client_message_id, "client-message");
    assert.equal(value.commands[0].identity.runtimeGeneration, null);
    assert.equal(
      value.activations[0].generation,
      value.commands[0].activation_generation,
    );
    assert.equal(value.activations[0].operation_id, "request");
    assert.equal(value.lanes.length, 1);
    assert.equal(value.runtimes.length, 1);
    assert.equal(value.leases.length, 1);
  }
  for (const input of [
    command(),
    command({
      session: {
        threadId: "ignored-new-thread",
        runtimeGeneration: "ignored-generation",
        connectionId: "ignored-connection",
        placementId: "ignored-placement",
      },
    }),
  ]) {
    const replay = await observe(
      "stored identity replay " + input.session.placementId,
      input,
      { options: { clientMessageId: "ignored-new-client" } },
    );
    for (const [i, value] of replay.entries()) {
      assert.equal(value.replayed, true);
      assert.deepEqual(value.receipt, start[i].receipt);
    }
    assert.deepEqual(
      await snapshot("replay changes no durable state"),
      admitted,
    );
  }
  await noWrite(
    "operation id conflict",
    command({ payloadDigest: "b".repeat(64) }),
    { code: "operation-id-conflict" },
  );
  await reset();
  for (const changes of [
    { workerId: "beta" },
    { session: { placementId: "missing" } },
    { session: { projectId: "folder" } },
    { session: { chatId: "missing" } },
  ])
    await noWrite(
      "stale or missing placement " + JSON.stringify(changes),
      command(changes),
      { code: changes.session?.chatId ? "chat-not-found" : "stale-placement" },
    );
  await noWrite("foreign owner lock", command(), {
    requestOwner: otherOwner,
    code: "chat-not-found",
  });
  for (const [name, input, code, options] of [
    [
      "Task session",
      command({ session: { chatId: "task" } }),
      "managed-session-ineligible",
    ],
    [
      "standalone session",
      command({
        session: {
          chatId: standalone,
          contextKind: "standalone",
          projectId: null,
          placementId: scratch,
        },
      }),
      "managed-session-ineligible",
    ],
    [
      "input revision",
      command(),
      "cancelled-before-admission",
      { expectedInputRevision: 1 },
    ],
    [
      "explicit null input revision",
      command(),
      "cancelled-before-admission",
      { expectedInputRevision: null },
    ],
    [
      "pause lacks boolean",
      command({ method: "turn/pause" }),
      "invalid-pause-intent",
    ],
    [
      "pause resume disagreement",
      command({
        method: "turn/pause",
        intent: { paused: true, resumeAutonomy: true },
      }),
      "invalid-pause-intent",
    ],
    [
      "pause on another method",
      command({ intent: { paused: false } }),
      "invalid-pause-intent",
    ],
    [
      "resume on start",
      command({ intent: { resumeAutonomy: true } }),
      "invalid-autonomy-resume",
    ],
    [
      "goal status on start",
      command({ intent: { goalStatus: "paused" } }),
      "invalid-goal-status",
    ],
    ["read method", command({ method: "thread/read" }), "unsupported-mutation"],
    [
      "unknown method",
      command({ method: "unknown/mutate" }),
      "unsupported-mutation",
    ],
    [
      "target scope",
      command({ intent: { scope: "account-defaults" } }),
      "invalid-target-scope",
    ],
    [
      "managed config",
      command({ method: "thread/managedConfig/update" }),
      "unsupported-settings",
    ],
    [
      "unsupported setting key",
      command({
        method: "thread/settings/update",
        intent: { settingKeys: ["unknown"] },
      }),
      "unsupported-settings",
    ],
    [
      "binding wrong method",
      command({ intent: { settingsBindingId: "binding" } }),
      "invalid-settings-binding-scope",
    ],
    [
      "native settings wrong method",
      command({ intent: { nativeSettingsOperationId: "settings" } }),
      "invalid-settings-operation-scope",
    ],
    [
      "security profile",
      command({ intent: { settingKeys: ["approvalPolicy"] } }),
      "permission-profile-mismatch",
    ],
    [
      "cwd outside placement",
      command({ intent: { settingKeys: ["cwd"] } }),
      "path-scope-mismatch",
    ],
    [
      "thread identity",
      command({ session: { threadId: "different" } }),
      "thread-identity-mismatch",
    ],
    [
      "runtime route",
      command({ session: { modelRouteId: "different" } }),
      "runtime-route-mismatch",
    ],
    [
      "start activation",
      command({ expectedActivationGeneration: "old" }),
      "stale-activation",
    ],
    [
      "unbound queue mutation",
      command({ method: "thread/queue/add" }),
      "thread-identity-mismatch",
    ],
    [
      "unbound active control",
      command({ method: "turn/interrupt" }),
      "thread-identity-mismatch",
    ],
  ])
    await rejected(name, input, code, options);
  await reset();
  await observe(
    "canonical queue mutation admits unbound GUI",
    command({ method: "thread/queue/add" }),
    { options: { canonicalQueueMutation: true, clientMessageId: "" } },
  );
  const canonical = await snapshot(
    "canonical queue mutation no execution lane",
  );
  for (const value of canonical) {
    assert.equal(value.lanes, null);
    assert.equal(value.activations, null);
    assert.equal(value.commands[0].logical_client_message_id, "");
  }

  await reset();
  await seed(
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
  );
  const bound = {
    threadId: "thread",
    runtimeGeneration: "native-generation",
    connectionId: "connection",
  };
  const active = await observe("bound GUI start", command({ session: bound }));
  const control = (i, extra = {}) =>
    command({
      operationId: "control",
      method: "turn/interrupt",
      session: bound,
      expectedActivationGeneration: active[i].receipt.activationGeneration,
      ...extra,
    });
  await observe("active control", (i) => control(i));
  await snapshot("active control retains activation");
  await observe(
    "stale native turn",
    (i) =>
      control(i, {
        operationId: "stale-turn",
        intent: { expectedTurnId: "wrong" },
      }),
    { status: "rejected", rejection: "stale-native-turn" },
  );
  await observe(
    "stale activation",
    (i) =>
      control(i, {
        operationId: "stale-activation",
        expectedActivationGeneration: "wrong",
      }),
    { status: "rejected", rejection: "stale-activation" },
  );
  const pendingMethod = "item/commandExecution/requestApproval";
  await seed(
    (i) =>
      `INSERT INTO native_pending_requests(chat_id,runtime_generation,native_request_id,activation_generation,request_method,turn_id) VALUES('chat','native-generation','approval',${literal(active[i].receipt.activationGeneration)},${literal(pendingMethod)},'turn')`,
  );
  const reply = (i) =>
    command({
      operationId: "reply",
      method: "serverRequest/reply",
      session: bound,
      expectedActivationGeneration: active[i].receipt.activationGeneration,
      reply: {
        nativeRequestId: "approval",
        requestMethod: pendingMethod,
        turnId: "turn",
      },
    });
  await observe("consume approval", reply);
  const consumed = await snapshot("approval consumed with receipt");
  for (const value of consumed)
    assert.equal(value.pending[0].resolution_operation_id, "reply");
  await observe("approval replay", reply);
  assert.deepEqual(await snapshot("approval replay unchanged"), consumed);
  await observe(
    "approval single consumption",
    (i) => ({ ...reply(i), operationId: "reply-again" }),
    { status: "rejected", rejection: "stale-native-reply" },
  );

  // Failure after lane acquisition must roll back lane, lease, chat and journal together.
  for (const [name, table, sqlstate] of [
    ["receipt", "native_commands", "P0001"],
    ["activation", "native_command_activations", "P0001"],
  ]) {
    await reset();
    await seed(
      `CREATE FUNCTION fail_admission() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'admission failure'; END$$`,
    );
    await seed(
      `CREATE TRIGGER fail_admission BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_admission()`,
    );
    await noWrite(name + " failure rolls back execution", command(), {
      sqlstate,
    });
    await seed(`DROP TRIGGER fail_admission ON ${table}`);
    await seed("DROP FUNCTION fail_admission()");
  }
  await reset();
  await seed(
    "CREATE FUNCTION fail_admission_lane() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'lane fixture failure' USING ERRCODE='23505'; END$$",
  );
  await seed(
    "CREATE TRIGGER fail_admission_lane BEFORE INSERT ON chat_execution_lanes FOR EACH ROW EXECUTE FUNCTION fail_admission_lane()",
  );
  await noWrite("untyped lane failure rolls back admission", command(), {
    sqlstate: "23505",
  });
  const beforeTyped = await snapshot("before typed inner lane failure");
  await observe("typed lane failure persists rejection", command(), {
    options: { purpose: "unique lane purpose" },
    status: "rejected",
    rejection: "execution-conflict",
  });
  const afterTyped = await snapshot(
    "typed lane savepoint restores inner writes",
  );
  for (const [i, value] of afterTyped.entries()) {
    assert.equal(value.commands[0].logical_operation_id, "request");
    assert.equal(value.commands[0].kind, "start");
    const unchanged = structuredClone(value);
    unchanged.commands = beforeTyped[i].commands;
    assert.deepEqual(unchanged, beforeTyped[i]);
  }
  await seed("DROP TRIGGER fail_admission_lane ON chat_execution_lanes");
  await seed("DROP FUNCTION fail_admission_lane()");
  await runAdmissionQueueCases({ ...h, command });
  await runAdmissionSettingsCases({ ...h, command });
  await runDispatchCases({ ...h, command });
  await runControlCases({ ...h, command });
  await runEvidenceCases({ ...h, command });
  await runSettlementCases({ ...h, command });
  await runLogicalCases({ ...h, command });
  await runQueuedPromptCases({ ...h, command });
  await runManagedQueueCases({ ...h, command });
  await runNativeEventContextCases({ ...h, command });
  await runNativeModelInventoryCases({ ...h, command });
  await runAgentInteractionCases({ ...h, command });
}
