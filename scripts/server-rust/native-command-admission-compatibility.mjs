import { backgroundObservation } from "./task-background-observation.mjs";
import { outcomeQueueAdmissions } from "./turn-outcome-queue-observation.mjs";
import { projectPauseDiagnostic } from "./project-task-pause-observation.mjs";
import { runTaskBackgroundCases } from "./task-background-cases.mjs";
import { runAutomationPauseCases } from "./automation-pause-cases.mjs";
import { runTaskClaimedCases } from "./task-claimed-cases.mjs";
import { runTaskAutomaticCases } from "./task-automatic-cases.mjs";
import { runTaskQueueCases } from "./task-queue-cases.mjs";
import { runTaskEligibilityCases } from "./task-eligibility-cases.mjs";
// Calls both actual repositories against isolated, migrated databases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { runAdmissionCases } from "./native-command-admission-cases.mjs";
import { runGuiAdmissionCases } from "./gui-admission-cases.mjs";
import { runTaskRepositoryCases } from "./task-repository-cases.mjs";
import { runTaskSchedulerCases } from "./task-scheduler-cases.mjs";
import { runTaskWorkerCases } from "./task-workers-cases.mjs";
import { runTaskRecoveryCases } from "./task-recovery-cases.mjs";
import { runTaskGoalCases } from "./task-goal-cases.mjs";
import { runTaskRetryCases } from "./task-retry-cases.mjs";
import { runAdmissionRaces } from "./native-command-admission-races.mjs";
import { runEvidenceRaces } from "./native-command-evidence-races.mjs";
import { runLogicalRaces } from "./native-logical-races.mjs";
import { runQueuedPromptRaces } from "./queued-prompt-races.mjs";
import { runQueuedPromptCases } from "./queued-prompt-cases.mjs";
import { runManagedQueueCases } from "./managed-queue-cases.mjs";
import { runManagedQueueRaces } from "./managed-queue-races.mjs";
import { runNativeEventContextCases } from "./native-event-context-cases.mjs";
import { runNativeEventRaces } from "./native-event-races.mjs";
import { runAgentInteractionRaces } from "./agent-interaction-races.mjs";
import { runAgentInteractionCases } from "./agent-interaction-cases.mjs";
import { runNativeModelInventoryCases } from "./native-model-inventory-cases.mjs";
import {
  targetStateSql,
  localOwner as owner,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-native-admission-")),
  standalone = "99999999-9999-4999-8999-000000000001",
  scratch = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()],
  counts = [{}, {}];
const startedAt = Date.now();
const claimedWindows = [null, null];
const fixedClocks = new Set([Date.parse(stamp)]);
function registerFixedClock(milliseconds) {
  assert.ok(Number.isSafeInteger(milliseconds));
  const iso = new Date(milliseconds).toISOString();
  fixedClocks.add(milliseconds);
  (report.fixtureClocks ??= []).push(iso);
}
let executable, pg, failure;
const report = {
  suite: "actual-native-command-admission-repositories",
  databaseMode,
  completeReplacement: false,
  lifecycleComplete: false,
  domain: option("--domain") ?? "all",
  projectControlsOnly: process.argv.includes("--project-controls-only"),
  turnOutcomesOnly: process.argv.includes("--turn-outcomes-only"),
  cases: [],
  snapshots: [],
};
function register(value, kind, i) {
  if (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    ) &&
    !aliases[i].has(value)
  ) {
    const n = counts[i][kind] ?? 0;
    counts[i][kind] = n + 1;
    aliases[i].set(value, `<${kind}-${n}>`);
  }
}
// Independent chats have no global event/worker ordering guarantee. Keep every
// field and per-chat order while comparing the independently scheduled streams.
function automaticOrder(value) {
  if (
    !["task-automatic", "task-background"].includes(report.domain) ||
    !value ||
    typeof value !== "object"
  )
    return value;
  const result = { ...value };
  if (report.domain === "task-background" && Array.isArray(result.logs))
    result.schedulerClaimOrder = result.logs
      .filter((v) => v.event === "task.scheduler.claimed")
      .map((v) => ({
        chat: v.chatId,
        cycle: v.cycleId,
        taskWorker: v.taskWorkerId,
      }));

  for (const field of [
    "commands",
    "events",
    "logs",
    "trace",
    ...(report.domain === "task-background" ? ["publications"] : []),
  ]) {
    if (!Array.isArray(result[field])) continue;
    const key = (v) =>
      v.__comparisonChat ??
      v.command?.chatId ??
      v.chatId ??
      v.scope?.chatId ??
      (typeof v.entityId === "string" ? v.entityId : undefined) ??
      v.scope?.chatId ??
      v.scope?.projectId ??
      v.chat ??
      v.context?.chatId ??
      v.ownerId ??
      "";
    result[field] = result[field].toSorted((a, b) =>
      key(a).localeCompare(key(b)),
    );
  }
  return result;
}
function normalized(value, i, key = "") {
  if (
    ["projectPauseError", "recoveryError"].includes(key) &&
    typeof value === "string" &&
    value.includes("Failed query: update ")
  ) {
    // These raw error reports retain the complete ORM query and every scalar
    // parameter. Only live Date parameters vary between isolated peer runs.
    return projectPauseDiagnostic(value, (at, context) =>
      normalized(
        at,
        i,
        context.kind === "heartbeat" && context.parameterIndex === 0
          ? "leaseExpiresAt"
          : "updatedAt",
      ),
    );
  }
  if (
    ["task-claimed", "task-background"].includes(report.domain) &&
    key === "dueAt" &&
    typeof value === "number"
  ) {
    const window = claimedWindows[i];
    assert.ok(
      window &&
        Number.isSafeInteger(value) &&
        value >= window[0] + 4990 &&
        value <= window[1] + 5010,
      "actual five-second Task retry deadline",
    );
    return "<claimed-retry-deadline>";
  }
  if (
    report.domain === "task-background" &&
    key === "attempts" &&
    Array.isArray(value) &&
    value.every((v) => typeof v === "number")
  ) {
    return value.map((at) => {
      assert.ok(
        Number.isSafeInteger(at) &&
          at >= startedAt - 1000 &&
          at <= Date.now() + 1000,
        "actual automatic retry attempt clock",
      );
      return "<retry-attempt-clock>";
    });
  }
  if (Array.isArray(value))
    return value.map((v) =>
      normalized(v, i, key === "recoveryErrors" ? "recoveryError" : ""),
    );
  if (
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "next_attempt_milliseconds")
  ) {
    const { next_attempt_milliseconds: milliseconds, ...row } = value;
    const time = Number(milliseconds);
    assert.ok(
      Number.isSafeInteger(time),
      "database completion due milliseconds",
    );
    value = { ...row, next_attempt_at: new Date(time).toISOString() };
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalized(v, i, k)]),
    );
  if (typeof value === "string") {
    if (
      ["task-claimed", "task-background"].includes(report.domain) &&
      ["lease_expires_at", "leaseExpiresAt"].includes(key)
    ) {
      const at = Date.parse(value);
      assert.ok(Number.isFinite(at), "actual Task lease deadline");
      if (!fixedClocks.has(at)) {
        assert.ok(
          at >= startedAt + 119000 && at <= Date.now() + 121000,
          "renewed Task lease deadline",
        );
        return "<claimed-lease-deadline>";
      }
      return new Date(at).toISOString();
    }
    if (
      ["task-claimed", "task-background"].includes(report.domain) &&
      [
        "last_heartbeat_at",
        "claimed_at",
        "lastHeartbeatAt",
        "claimedAt",
      ].includes(key)
    ) {
      const at = Date.parse(value);
      assert.ok(Number.isFinite(at), "actual Task claim/heartbeat clock");
      if (fixedClocks.has(at)) return new Date(at).toISOString();
      assert.ok(
        at >= startedAt - 1000 && at <= Date.now() + 1000,
        "live Task claim/heartbeat clock",
      );
      return "<clock>";
    }
    if (aliases[i].has(value)) return aliases[i].get(value);
    if (key === "next_attempt_at") {
      const time = Date.parse(value);
      assert.ok(Number.isFinite(time), "valid completion due clock");
      return time >= startedAt - 1000 && time <= Date.now() + 1000
        ? "<clock>"
        : new Date(time).toISOString();
    }
    if (
      [
        "resolvedAt",
        "resolved_at",
        "createdAt",
        "updatedAt",
        "created_at",
        "updated_at",
        "activated_at",
        "released_at",
        "last_scanned_at",
        "started_at",
        "completed_at",
        "finalized_at",
        "first_activity_at",
        "first_visible_response_at",
        "logical_completed_at",
        "execution_completed_at",
        "notification_due_at",
        "executionLaneActivatedAt",
        "implementationStartedAt",
        "implementation_started_at",
        "startedAt",
        "completedAt",
        "queuedAt",
        "queued_at",
        "deleted_at",
        "pausedAt",
        "paused_at",
        "task_scheduling_paused_at",
      ].includes(key)
    ) {
      assert.ok(
        Number.isFinite(Date.parse(value)),
        `valid clock: ${key}=${value}`,
      );
      if (Date.parse(value) === Date.parse(stamp)) return "<seed-clock>";
      if (fixedClocks.has(Date.parse(value)))
        return new Date(value).toISOString();
      assert.ok(
        Date.parse(value) >= startedAt - 1000 &&
          Date.parse(value) <=
            Date.now() + (key === "notification_due_at" ? 6000 : 1000),
        `live database clock: ${key}=${value}`,
      );
      return "<clock>";
    }
  }
  return value;
}
async function seed(statements) {
  for (const [i, r] of pair.entries()) {
    const items = typeof statements === "function" ? statements(i) : statements;
    for (const sql of Array.isArray(items) ? items : [items]) await r.seed(sql);
  }
}
async function snapshot(name) {
  const values = [];
  for (const [i, r] of pair.entries()) {
    const result = await r.request({
      op: "query-json",
      sql: "SELECT jsonb_build_object('commands',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_commands n),'activations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY chat_id) FROM native_command_activations a),'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY chat_id,created_at) FROM chat_execution_lanes l),'runtimes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id,worktree_id,scratch_root_id) FROM chat_runtime_sessions r),'leases',(SELECT jsonb_agg(to_jsonb(b) ORDER BY project_id,branch_name,created_at) FROM project_branch_leases b),'queues',(SELECT jsonb_agg(to_jsonb(q) ORDER BY chat_id) FROM managed_queue_states q),'claims',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM managed_queue_claims q),'interactions',(SELECT jsonb_agg(to_jsonb(i) ORDER BY request_key) FROM agent_interaction_requests i),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'queueInputs',(SELECT jsonb_agg(to_jsonb(q) ORDER BY claim_id) FROM managed_queue_input_snapshots q),'queueImports',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM managed_queue_imports q),'prompts',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM queued_prompts q),'pending',(SELECT jsonb_agg(to_jsonb(n) ORDER BY chat_id,runtime_generation,native_request_id) FROM native_pending_requests n),'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY chat_id) FROM native_settings_states s),'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM native_settings_evidence e),'turns',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_id) FROM native_command_turns t),'completions',(SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('next_attempt_milliseconds',floor(extract(epoch FROM c.next_attempt_at)*1000)::text) ORDER BY root_operation_id) FROM native_logical_completions c)) result",
    });
    assert.equal(result.rejected, false, result.diagnostic);
    const value = result.value;
    for (const [key, kind] of [
      ["lanes", "lane"],
      ["runtimes", "runtime"],
      ["leases", "lease"],
    ])
      for (const row of value[key] ?? []) register(row.id, kind, i);
    for (const row of value.interactions ?? [])
      register(row.id, "interaction", i);
    for (const row of value.commands ?? [])
      register(row.operation_generation, "operation", i);
    for (const row of value.activations ?? [])
      register(row.generation, "activation", i);
    for (const row of value.claims ?? []) register(row.id, "claim", i);
    const handoffs = await r.request({
      op: "query-json",
      sql: "SELECT jsonb_build_object('handoffs',(SELECT jsonb_agg(to_jsonb(h) ORDER BY operation_id) FROM native_runtime_handoffs h)) result",
    });
    assert.equal(handoffs.rejected, false, handoffs.diagnostic);
    value.handoffs = handoffs.value.handoffs;
    for (const row of value.handoffs ?? []) {
      register(row.binding?.bindingId, "binding", i);
      register(row.source?.bindingId, "binding", i);
    }
    values.push(value);
  }
  report.snapshots.push({ name, values });
  const canonical = (value, i) => {
    const result = normalized(value, i);
    // These raw relational tables are queried by random UUID. Compare every
    // row/field using the already-established identity aliases, then sort by
    // that canonical identity. Public repository/API list order is untouched.
    for (const [table, key] of [
      ["claims", "id"],
      ["queueInputs", "claim_id"],
    ]) {
      result[table]?.sort((a, b) =>
        a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0,
      );
    }
    return result;
  };
  assert.deepEqual(canonical(values[1], 1), canonical(values[0], 0), name);
  return values;
}
async function observe(
  name,
  input,
  {
    options = {},
    op = "native-command-admit",
    shape = "admission",
    requestOwner = owner,
    error = false,
    code,
    sqlstate,
    status = "accepted",
    rejection,
  } = {},
) {
  report.lastOperation = { name };
  const outcomes = [],
    requests = [];
  for (const [i, r] of pair.entries()) {
    const actual = typeof input === "function" ? input(i) : input;
    const request =
      shape === "raw" || shape === "gui"
        ? { op, owner: requestOwner, ...actual }
        : {
            op,
            owner: requestOwner,
            input: actual,
            options: typeof options === "function" ? options(i) : options,
          };
    requests.push(request);
    const from = Date.now(),
      result = await r.request(request);
    outcomes.push(result);
    report.inFlightComparison = { name, requests, outcomes };
    if (op === "native-command-turn-outcome" && actual.queueAdmission) {
      for (const binding of outcomeQueueAdmissions(
        result.value,
        actual.queueAdmission,
      )) {
        register(binding.claimId, "outcome-queue-claim", i);
        aliases[i].set(
          binding.operationId,
          `<outcome-queue:${aliases[i].get(binding.claimId)}>`,
        );
      }
    }
    if (
      [
        "native-command-task-claimed",
        "native-command-task-background",
        "native-command-turn-outcome",
      ].includes(op)
    )
      claimedWindows[i] = [from, Date.now()];
    if (report.domain === "task-background") {
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (
          value.id &&
          value.chatId &&
          value.operationId &&
          Object.hasOwn(value, "fencingToken")
        ) {
          register(value.id, "background-cycle-" + value.chatId, i);
          register(
            value.operationId,
            "background-operation-" + value.chatId,
            i,
          );
          for (const prefix of ["dispatch", "goal-launch"])
            aliases[i].set(
              `${prefix}:${value.id}:${value.fencingToken}`,
              `${prefix}:${aliases[i].get(value.id)}:${value.fencingToken}`,
            );
        }
        if (
          value.chat_id &&
          value.operation_id &&
          Object.hasOwn(value, "fencing_token")
        ) {
          register(value.id, "background-cycle-" + value.chat_id, i);
          register(
            value.operation_id,
            "background-operation-" + value.chat_id,
            i,
          );
          for (const prefix of ["dispatch", "goal-launch"])
            aliases[i].set(
              `${prefix}:${value.id}:${value.fencing_token}`,
              `${prefix}:${aliases[i].get(value.id)}:${value.fencing_token}`,
            );
        }
        if (value.chat_id && value.automatic_retry) {
          const r = value.automatic_retry;
          const id =
            r.claim?.id ??
            (r.failureKey?.startsWith("retry:") ? r.failureKey.slice(6) : null);
          register(id, "background-attempt-" + value.chat_id, i);
          if (id) aliases[i].set("retry:" + id, "retry:" + aliases[i].get(id));
        }
        for (const child of Object.values(value))
          if (child && typeof child === "object") visit(child);
      };
      visit(result.value);
    }
    if (
      ["task-claimed", "task-background"].includes(report.domain) &&
      op === "query-json"
    ) {
      for (const cycle of result.value?.cycles ?? []) {
        const alias = aliases[i].get(cycle.id);
        assert.ok(
          alias,
          "actual claimed cycle registered before observing failure keys",
        );
        for (const prefix of ["dispatch", "goal-launch"])
          aliases[i].set(
            `${prefix}:${cycle.id}:${cycle.fencing_token}`,
            `${prefix}:${alias}:${cycle.fencing_token}`,
          );
      }
    }
    if (op === "native-command-task-workers" && actual.action === "create")
      register(result.value?.value?.id, "task-worker", i);
    if (op === "query-json" && report.domain === "task-workers")
      for (const row of result.value?.workers ?? [])
        register(row.id, "task-worker", i);
    if (report.domain === "task-automatic") {
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (value.chat_id && value.automatic_retry) {
          const record = value.automatic_retry;
          const id =
            record.claim?.id ??
            (record.failureKey?.startsWith("retry:")
              ? record.failureKey.slice(6)
              : null);
          register(id, `automatic-attempt-${value.chat_id}`, i);
          if (id) aliases[i].set(`retry:${id}`, `retry:${aliases[i].get(id)}`);
        }
        if (
          value.chat_id &&
          value.operation_id &&
          Object.hasOwn(value, "fencing_token")
        ) {
          register(value.operation_id, `automatic-attempt-${value.chat_id}`, i);
          register(value.id, `automatic-cycle-${value.chat_id}`, i);
        }
        for (const child of Object.values(value))
          if (child && typeof child === "object") visit(child);
      };
      visit(result.value);
    }
    if (op === "native-command-task-retry" && actual.action === "claim") {
      const id = result.value?.value?.id;
      register(id, "task-retry-claim", i);
      if (id) aliases[i].set(`retry:${id}`, `retry:${aliases[i].get(id)}`);
    }
    if (
      [
        "native-command-task-goal",
        "native-command-task-automatic",
        "native-command-automation-pause",
        "native-command-turn-outcome",
      ].includes(op) ||
      (op === "native-command-task-claimed" && actual.action === "resume") ||
      op === "native-command-task-background"
    ) {
      if (op === "native-command-turn-outcome") {
        for (const step of actual.steps ?? [])
          for (const notification of step.notifications ?? [
            step.notification,
          ]) {
            const message =
              notification?.outcome?.result?.structuredResult?.goal
                ?.startMessage;
            if (message)
              register(message.id, "goal-start-" + notification.chatId, i);
          }
      }
      for (const item of result.value?.commands ?? []) {
        const message = item.command?.taskContext?.message;
        if (message && message.id !== actual.message?.id) {
          register(
            message.id,
            report.domain === "task-background"
              ? "goal-control-" + item.command?.chatId
              : "goal-control",
            i,
          );
          assert.equal(
            message.idempotencyKey,
            `task-goal-resume:${message.id}`,
          );
          aliases[i].set(
            message.idempotencyKey,
            `task-goal-resume:${aliases[i].get(message.id)}`,
          );
        }
        const response = item.command?.resultMode;
        if (response?.kind === "task-message-encrypted") {
          const user = response.idempotencyKey.slice("assistant:".length);
          assert.equal(response.idempotencyKey, "assistant:" + user);
          assert.ok(
            aliases[i].has(user),
            "Task Goal assistant belongs to admitted control input",
          );
          register(response.messageId, "goal-assistant", i);
          aliases[i].set(
            response.idempotencyKey,
            "assistant:" + aliases[i].get(user),
          );
        }
        if (item.command?.type === "chat.message.protect") {
          const id = item.command.message.id;
          register(id, "goal-protected", i);
          aliases[i].set(`gui-goal:${id}`, `gui-goal:${aliases[i].get(id)}`);
        }
      }
      for (const call of result.value?.trace ?? [])
        if (call.kind === "begin") {
          if (call.options?.purpose === "Resume paused Codex goal") {
            const prefix = `chat-resume:${actual.goalReply.goal.updatedAt}:`,
              key = call.input.idempotencyKey;
            assert.ok(key.startsWith(prefix));
            const id = key.slice(prefix.length);
            register(id, "goal-resume", i);
            assert.ok(aliases[i].has(id));
            aliases[i].set(key, prefix + aliases[i].get(id));
          }
          const lease = call.options?.taskDispatchLease;
          if (lease?.leaseOwner?.startsWith("task-goal-continuation:")) {
            const id = lease.leaseOwner.slice("task-goal-continuation:".length);
            register(id, "goal-continuation-owner", i);
            assert.ok(aliases[i].has(id));
            aliases[i].set(
              lease.leaseOwner,
              `task-goal-continuation:${aliases[i].get(id)}`,
            );
          }
          if (lease && !lease.leaseExpiresAt.startsWith("2099-")) {
            const time = Date.parse(lease.leaseExpiresAt);
            assert.ok(
              time >= from + 119000 && time <= Date.now() + 121000,
              "actual recovered lease expiry",
            );
            aliases[i].set(lease.leaseExpiresAt, "<recovery-lease-clock>");
          }
          const pair = call.options?.encryptedTaskMessages;
          if (pair) {
            register(pair.response.id, "goal-response", i);
            assert.equal(
              pair.response.idempotencyKey,
              `assistant:${pair.userMessage.id}`,
            );
            if (aliases[i].has(pair.userMessage.id))
              aliases[i].set(
                pair.response.idempotencyKey,
                `assistant:${aliases[i].get(pair.userMessage.id)}`,
              );
          }
        }
    }
    if (
      op === "native-command-task-scheduler" ||
      op === "native-command-task-queue"
    ) {
      function cycles(value) {
        if (!value || typeof value !== "object") return;
        if (
          value.chatId &&
          value.operationId &&
          Object.hasOwn(value, "fencingToken")
        )
          register(value.id, "task-cycle", i);
        for (const child of Object.values(value))
          if (child && typeof child === "object") cycles(child);
      }
      cycles(result.value);
      if (
        op === "native-command-task-queue" &&
        actual.action === "retry" &&
        actual.operationId === undefined
      )
        register(
          result.value?.value?.dispatch?.operationId,
          "task-retry-operation",
          i,
        );
    }

    if (op === "query-json" && actual.taskQueueSnapshot)
      for (const c of result.value?.cycles ?? [])
        register(c.id, "task-cycle", i);
    if (op === "query-json" && actual.goalSnapshot)
      for (const row of result.value?.sessions ?? [])
        register(row.id, "goal-session", i);
    if (op === "query-json" && actual.recoverySnapshot) {
      const owner = result.value?.dispatch?.owner;
      if (owner?.startsWith("task-goal-continuation:")) {
        const id = owner.slice("task-goal-continuation:".length);
        register(id, "goal-continuation-owner", i);
        assert.ok(aliases[i].has(id));
        aliases[i].set(owner, `task-goal-continuation:${aliases[i].get(id)}`);
      }
    }
    if (op === "native-command-account-prepare") {
      for (const item of result.value?.commands ?? [])
        register(item.command?.operationId, "account-transfer", i);
    }
    if (op === "native-command-runtime-handoff") {
      const entries = Array.isArray(result.value)
        ? result.value
        : [result.value];
      for (const value of entries) {
        register(value?.binding?.bindingId, "binding", i);
        register(value?.source?.bindingId, "binding", i);
        register(value?.latest?.binding?.bindingId, "binding", i);
      }
    }
    if (op === "query-json" && actual.telemetrySnapshot)
      for (const [key, kind] of [
        ["behaviorRecords", "behavior"],
        ["usageRecords", "usage"],
      ])
        for (const row of result.value?.[key] ?? []) register(row.id, kind, i);
    if (op === "native-command-interaction" && result.value?.id)
      register(result.value.id, "interaction", i);
    if (op === "native-command-turn-live") {
      for (const value of result.value?.results ?? [])
        if (value?.id) register(value.id, "turn-live-result", i);
      for (const item of result.value?.commands ?? [])
        if (item.command?.message?.id)
          register(item.command.message.id, "turn-live-result", i);
    }
    if (op === "native-command-turn-bootstrap") {
      register(result.value?.userMessage?.id, "bootstrap-message", i);
      for (const item of result.value?.commands ?? [])
        register(item.command?.message?.id, "bootstrap-message", i);
    }
    if (op === "native-command-recovery") {
      for (const call of result.value?.trace ?? []) {
        if (call.kind === "begin") {
          register(
            call.options?.encryptedChatMessages?.response?.id,
            "recovery-response",
            i,
          );
          register(
            call.options?.encryptedChatMessages?.userMessage?.id,
            "recovery-protected",
            i,
          );
          register(call.options?.managedQueueClaim?.id, "claim", i);
          const pair = call.options?.encryptedChatMessages;
          if (
            pair?.response &&
            pair.userMessage.id !== actual.protectedMessage?.id
          ) {
            assert.equal(
              pair.response.idempotencyKey,
              `assistant:${pair.userMessage.id}`,
              "continuation response retains its protected input identity",
            );
            aliases[i].set(
              pair.response.idempotencyKey,
              `assistant:${aliases[i].get(pair.userMessage.id)}`,
            );
          }
        }
      }
      for (const item of result.value?.commands ?? []) {
        register(item.command?.message?.id, "recovery-protected", i);
        register(item.command?.queueClaim?.id, "claim", i);
      }
    }
    if (
      [
        "native-command-turn-execution",
        "native-command-task-claimed",
        "native-command-task-background",
        "native-command-turn-outcome",
      ].includes(op)
    ) {
      register(result.value?.result?.executionLaneId, "lane", i);
      for (const event of result.value?.events ?? [])
        if (event.resource === "agent-interaction")
          register(event.entityId, "interaction", i);
      for (const item of result.value?.commands ?? []) {
        if (
          op === "native-command-turn-outcome" &&
          item.command?.resultMode?.kind === "chat-message-encrypted"
        )
          register(
            item.command.resultMode.messageId,
            "outcome-queue-response",
            i,
          );
        register(
          item.command?.executionLaneId,
          report.domain === "task-background"
            ? "lane-" + item.command?.chatId
            : "lane",
          i,
        );
        register(item.command?.message?.id, "stream-protected", i);
        const receipt = item.command?.nativeCommandReceipt;
        if (receipt) {
          register(receipt.executionLaneId, "lane", i);
          register(receipt.operationGeneration, "operation", i);
          register(receipt.activationGeneration, "activation", i);
        }
      }
    }
    if (op === "native-command-automatic-title" && actual.action === "claim")
      register(result.value, "title-claim", i);
    if (
      op.startsWith("native-command-prompt-") &&
      request.action === "create-visible"
    )
      register(result.value?.id, "prompt", i);
    if (
      op.startsWith("native-command-managed-queue-") &&
      request.action === "claim-next"
    )
      register(result.value?.id, "claim", i);
    if (
      op === "native-command-event-context" &&
      request.action?.startsWith("interaction") &&
      result.value?.saved?.id
    )
      register(result.value.saved.id, "interaction", i);
    if (result.value?.state?.binding?.bindingId)
      register(result.value.state.binding.bindingId, "binding", i);
    if (op === "native-command-gui-protect")
      register(result.value?.command?.message?.id, "protected-message", i);
    register(result.value?.execution?.executionLaneId, "lane", i);
    const receipt =
      shape === "gui"
        ? result.value?.nativeCommandReceipt
        : shape === "receipt"
          ? result.value
          : result.value?.receipt;
    if (receipt) {
      register(receipt.operationGeneration, "operation", i);
      register(receipt.activationGeneration, "activation", i);
      register(receipt.executionLaneId, "lane", i);
      if (!result.value.replayed)
        for (const key of ["createdAt", "updatedAt"]) {
          assert.equal(
            new Date(receipt[key]).toISOString(),
            receipt[key],
            name,
          );
          if (
            op === "native-command-admit" ||
            (op === "native-command-dispatch" && key === "updatedAt")
          )
            assert.ok(
              Date.parse(receipt[key]) >= from - 1000 &&
                Date.parse(receipt[key]) <= Date.now() + 1000,
              name + " admission clock",
            );
        }
    }
  }
  report.cases.push({ name, requests, outcomes });
  delete report.inFlightComparison;
  for (const result of outcomes) {
    assert.equal(result.rejected, error, name + ": " + result.diagnostic);
    if (code) assert.equal(result.commandError, code, name);
    if (sqlstate) assert.equal(result.databaseCode, sqlstate, name);
    if (!error && shape !== "raw" && shape !== "gui") {
      const receipt = shape === "receipt" ? result.value : result.value.receipt;
      assert.equal(receipt.status, status, name);
      if (rejection) assert.equal(receipt.rejectionCode, rejection, name);
    }
  }
  if (!error)
    assert.deepEqual(
      automaticOrder(
        normalized(
          report.domain === "task-background"
            ? backgroundObservation(outcomes[1].value)
            : outcomes[1].value,
          1,
        ),
      ),
      automaticOrder(
        normalized(
          report.domain === "task-background"
            ? backgroundObservation(outcomes[0].value)
            : outcomes[0].value,
          0,
        ),
      ),
      name,
    );
  else if (!sqlstate)
    assert.deepEqual(
      {
        code: outcomes[1].commandError,
        status: outcomes[1].commandStatus,
        message: outcomes[1].diagnostic,
        interactionError: outcomes[1].interactionError,
        laneError: outcomes[1].laneError,
      },
      {
        code: outcomes[0].commandError,
        status: outcomes[0].commandStatus,
        message: outcomes[0].diagnostic,
        interactionError: outcomes[0].interactionError,
        laneError: outcomes[0].laneError,
      },
      name,
    );
  return outcomes.map((r) => r.value);
}
async function reset() {
  await seed([
    "DELETE FROM native_pending_requests",
    "DELETE FROM native_command_activations",
    "DELETE FROM managed_queue_claims",
    "DELETE FROM native_runtime_handoffs",
    "DELETE FROM native_commands",
    "DELETE FROM chat_execution_lanes",
    "DELETE FROM chat_runtime_sessions",
    "DELETE FROM native_settings_states",
    "DELETE FROM queued_prompts",
    "DELETE FROM chat_relocation_jobs",
    "DELETE FROM chat_import_jobs",
    `UPDATE chats SET status='idle',automation_paused=false,managed_autonomy_stopped=false,has_unread_completion=false,managed_input_revision=0,archived_at=NULL,reasoning_effort=NULL,permission_profile_id=NULL,updated_at=${literal(stamp)},last_used_at=${literal(stamp)}`,
    "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-main' WHERE id='chat'",
    "UPDATE project_worktrees SET branch='main',detached=false,lifecycle_state='ready'",
    "UPDATE project_sources SET removed_at=NULL",
    "UPDATE projects SET worktree_policy='agent-managed' WHERE id='github'",
    "UPDATE managed_queue_states SET revision=0",
    "UPDATE user_settings SET default_chat_permission_profile_id=':workspace'",
  ]);
}
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
async function reopen(name) {
  const before = await snapshot("before " + name);
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  const after = await snapshot(name);
  assert.deepEqual(after, before, name);
  (report.reopens ??= []).push({ name, passed: true });
}
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || databaseMode === "postgres")
        ? await pg.database()
        : undefined;
    pair.push(await open(kind, i));
  }
  await seed(targetStateSql());
  await seed([
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label,created_at,updated_at,last_used_at) VALUES('task',${literal(owner)},'github','alpha','github-alpha-main','task',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO managed_queue_states(chat_id,notification_due_at) VALUES('chat',${literal(stamp)})`,
  ]);
  for (const r of pair) {
    const result = await r.request({
      op: "transaction",
      statements: [
        `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(standalone)},${literal(owner)},'standalone','alpha',${literal(scratch)},NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
        `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES(${literal(scratch)},${literal(standalone)},${literal(owner)},'alpha','ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',${literal(stamp)},${literal(stamp)})`,
      ],
    });
    assert.equal(result.rejected, false, result.diagnostic);
  }
  await reset();
  const runCases =
    report.domain === "task-background"
      ? runTaskBackgroundCases
      : report.domain === "automation-pause"
        ? runAutomationPauseCases
        : report.domain === "task-claimed"
          ? runTaskClaimedCases
          : report.domain === "task-automatic"
            ? runTaskAutomaticCases
            : report.domain === "task-queue"
              ? runTaskQueueCases
              : report.domain === "task-eligibility"
                ? runTaskEligibilityCases
                : report.domain === "task-workers"
                  ? runTaskWorkerCases
                  : report.domain === "task-recovery"
                    ? runTaskRecoveryCases
                    : report.domain === "task-goal"
                      ? runTaskGoalCases
                      : report.domain === "task-retry"
                        ? runTaskRetryCases
                        : report.domain === "task-dispatch"
                          ? runTaskSchedulerCases
                          : report.domain === "tasks"
                            ? runTaskRepositoryCases
                            : report.domain === "gui"
                              ? runGuiAdmissionCases
                              : report.domain === "prompts"
                                ? runQueuedPromptCases
                                : report.domain === "managed-queue"
                                  ? runManagedQueueCases
                                  : report.domain === "events"
                                    ? runNativeEventContextCases
                                    : report.domain === "models"
                                      ? runNativeModelInventoryCases
                                      : report.domain === "interactions"
                                        ? runAgentInteractionCases
                                        : runAdmissionCases;
  await runCases({
    pair,
    urls,
    databaseMode,
    root,
    executable,
    seed,
    snapshot,
    observe,
    reset,
    owner,
    standalone,
    scratch,
    report,
    register,
    reopen,
    registerFixedClock,
  });
  if (
    databaseMode === "postgres" &&
    report.domain !== "prompts" &&
    report.domain !== "managed-queue" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions" &&
    ![
      "gui",
      "tasks",
      "task-dispatch",
      "task-retry",
      "task-goal",
      "task-recovery",
      "task-workers",
      "task-eligibility",
      "task-queue",
      "task-automatic",
      "task-claimed",
      "automation-pause",
      "task-background",
    ].includes(report.domain)
  )
    await runAdmissionRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      snapshot,
      report,
      register,
      normalized,
    });
  if (
    databaseMode === "postgres" &&
    report.domain !== "prompts" &&
    report.domain !== "managed-queue" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions" &&
    ![
      "gui",
      "tasks",
      "task-dispatch",
      "task-retry",
      "task-goal",
      "task-recovery",
      "task-workers",
      "task-eligibility",
      "task-queue",
      "task-automatic",
      "task-claimed",
      "automation-pause",
      "task-background",
    ].includes(report.domain)
  )
    await runEvidenceRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      seed,
      observe,
      snapshot,
      report,
      normalized,
    });
  await reopen("actual admission backend reopen");
  if (
    databaseMode === "postgres" &&
    report.domain !== "prompts" &&
    report.domain !== "managed-queue" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions" &&
    ![
      "gui",
      "tasks",
      "task-dispatch",
      "task-retry",
      "task-goal",
      "task-recovery",
      "task-workers",
      "task-eligibility",
      "task-queue",
      "task-automatic",
      "task-claimed",
      "automation-pause",
      "task-background",
    ].includes(report.domain)
  )
    await runLogicalRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      seed,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
  if (
    databaseMode === "postgres" &&
    report.domain !== "managed-queue" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions" &&
    ![
      "gui",
      "tasks",
      "task-dispatch",
      "task-retry",
      "task-goal",
      "task-recovery",
      "task-workers",
      "task-eligibility",
      "task-queue",
      "task-automatic",
      "task-claimed",
      "automation-pause",
      "task-background",
    ].includes(report.domain)
  )
    await runQueuedPromptRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
  if (
    databaseMode === "postgres" &&
    report.domain !== "prompts" &&
    report.domain !== "events" &&
    report.domain !== "models" &&
    report.domain !== "interactions" &&
    ![
      "gui",
      "tasks",
      "task-dispatch",
      "task-retry",
      "task-goal",
      "task-recovery",
      "task-workers",
      "task-eligibility",
      "task-queue",
      "task-automatic",
      "task-claimed",
      "automation-pause",
      "task-background",
    ].includes(report.domain)
  )
    await runManagedQueueRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      seed,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
  if (
    databaseMode === "postgres" &&
    ["all", "interactions"].includes(report.domain)
  )
    await runAgentInteractionRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      seed,
      observe,
      snapshot,
      report,
      normalized,
    });
  report.passed = true;
  if (databaseMode === "postgres" && ["all", "events"].includes(report.domain))
    await runNativeEventRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      seed,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = pair.map((r) => r.diagnostics());
} finally {
  for (const r of pair)
    try {
      await r.close();
    } catch (error) {
      failure ??= error;
      (report.cleanupFailures ??= []).push(String(error));
    }
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    (report.cleanupFailures ??= []).push(String(error));
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
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    passed: true,
    lifecycleComplete: false,
  }),
);
