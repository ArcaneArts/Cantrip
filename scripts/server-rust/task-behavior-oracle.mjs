import {
  canTransitionTaskState,
  validateTaskOperationStart,
} from "../../cantrip_server/src/tasks/state.ts";
import {
  scheduleTaskRetry,
  taskRetrySummary,
} from "../../cantrip_server/src/tasks/automatic-retry.ts";
import {
  taskOperationRelayTurnFields,
  parseTaskOperationRelayResult,
} from "../../cantrip_server/src/tasks/encrypted-relay.ts";
import { taskStart, taskResult } from "./task-wire-fixtures.mjs";
const cases = [];
function add(kind, input, run) {
  let outcome;
  try {
    outcome = { ok: run() };
  } catch (error) {
    outcome = { error: error.message };
  }
  cases.push({ kind, input, outcome });
}
const states = [
  "draft",
  "planning",
  "review",
  "finalizing",
  "implementing",
  "paused",
  "blocked",
  "complete",
  "failed",
];
for (const from of states)
  for (const to of states)
    add("transition", { from, to }, () => canTransitionTaskState(from, to));
for (const state of states)
  for (const stable of [null, "draft", "review"])
    for (const kind of ["direct", "initial-plan", "continue-plan", "finalize"])
      add("start", { state, stable, kind }, () =>
        validateTaskOperationStart(state, stable, kind),
      );
const now = 60_000;
const records = [null];
for (const status of ["idle", "scheduled", "retrying", "latched", "manual"])
  for (const attempts of [
    [],
    [0, 1, 59_999, 60_000],
    [1, 2, 3, 4, 5],
    [0, 0, 0, 0, 0],
  ])
    for (const dueAt of [null, 65_000, 65_000.9, -65_000.9])
      records.push({
        status,
        failureKey: "previous",
        failureKind: "runtime",
        attempts,
        dueAt,
        claim: { id: "claim", expiresAt: 99_999 },
      });
for (const record of records) {
  add("retry-summary", { record, now }, () => taskRetrySummary(record, now));
  for (const key of ["previous", "new"])
    for (const failureKind of [
      "timeout",
      "capacity",
      "rate-limit",
      "connection",
      "runtime",
      "needs-input",
      "configuration",
      "usage-limit",
      "budget-limit",
    ])
      add("retry-schedule", { record, now, key, failureKind }, () =>
        scheduleTaskRetry(record, key, failureKind, now),
      );
}
for (const kind of ["direct", "initial-plan", "continue-plan", "finalize"]) {
  const request = taskStart(kind).operation,
    result = taskResult({ operation: request });
  add("relay-fields", { request }, () => taskOperationRelayTurnFields(request));
  add("relay-result", { request, result }, () =>
    parseTaskOperationRelayResult(result, request),
  );
  for (const field of [
    "chatId",
    "operationId",
    "fingerprint",
    "ordinal",
    "kind",
  ]) {
    const other = structuredClone(request);
    if (field === "chatId") other.chatId = "other-chat";
    else if (field === "operationId")
      other.operationId = "77777777-7777-4777-8777-000000000088";
    else if (field === "fingerprint")
      other.fingerprint = Buffer.alloc(32, 1).toString("base64url");
    else if (field === "ordinal") other.classification.ordinal++;
    else {
      other.classification.kind = kind === "direct" ? "initial-plan" : "direct";
      other.userMessage.classification.mode =
        other.classification.kind === "direct" ? "default" : "plan";
    }
    add("relay-result", { request: other, result }, () =>
      parseTaskOperationRelayResult(result, other),
    );
  }
}
console.log(JSON.stringify({ cases }));
