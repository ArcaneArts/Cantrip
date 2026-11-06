// Actual Source schemas, including canonical Task receipt/dispatch bindings.
import assert from "node:assert/strict";
import * as protocol from "../../packages/protocol/dist/index.js";
import alternatives from "./worker-command-alternatives.json" with { type: "json" };
import { outcome, vectorCases } from "./security-oracle.mjs";
const envelope = structuredClone(
  alternatives.cases.find(
    ({ input }) =>
      input.command.type === "chat.turn" &&
      input.command.resultMode?.kind === "task-encrypted",
  ).input,
);
const command = envelope.command;
const operation = command.resultMode.operation;
command.clientMessageId = operation.userMessage.id;
command.taskDispatchLease = {
  cycleId: "00000000-0000-4000-8000-000000000002",
  operationId: operation.operationId,
  leaseOwner: "fixture-task-owner",
  fencingToken: 1,
  leaseExpiresAt: "2026-11-05T00:00:00.000Z",
};
command.taskInferenceInput = {
  operationId: "00000000-0000-4000-8000-000000000003",
  chatId: command.chatId,
  clientMessageId: command.clientMessageId,
  workerId: "fixture-task-worker",
  worktreeId: command.worktreeId,
  executionLaneId: command.executionLaneId,
  executionLaneActivatedAt: "2026-11-05T00:00:00.000Z",
  providerId: command.provider.id,
  modelRouteId: command.model.routeId,
  providerAccountId: command.provider.accountId,
  dispatch: Object.fromEntries(
    ["cycleId", "operationId", "leaseOwner", "fencingToken"].map((key) => [
      key,
      command.taskDispatchLease[key],
    ]),
  ),
};
protocol.workerRequestEnvelopeSchema.parse(envelope);
const dispatch = {
  serverId: "fixture-server",
  workerId: command.taskInferenceInput.workerId,
  workerGeneration: "00000000-0000-4000-8000-000000000004",
  receipt: command.taskInferenceInput,
};
const nativeBinding = {
  ...dispatch,
  phase: "native",
  nativeExecution: {
    threadId: "native-thread",
    turnId: "native-turn",
    scopeId: "native-scope",
  },
  nativeRuntimeGeneration: "00000000-0000-4000-8000-000000000005",
};
const samples = {
  taskInferenceInputReceiptSchema: [command.taskInferenceInput],
  taskInferenceInputDispatchSchema: [
    dispatch,
    { ...dispatch, phase: "accepted" },
    { ...dispatch, phase: "claim" },
    nativeBinding,
  ],
  taskInferenceInputDispatchResultSchema: [
    { receipt: command.taskInferenceInput },
    {
      receipt: nativeBinding.receipt,
      nativeExecution: nativeBinding.nativeExecution,
      nativeRuntimeGeneration: nativeBinding.nativeRuntimeGeneration,
    },
  ],
};
let count = 0;
function emit(schema, value) {
  console.log(JSON.stringify({ schema, ...value }));
  count++;
}
for (const [schema, values] of Object.entries(samples))
  for (const value of vectorCases(schema, values)) emit(schema, value);
for (const [index, input] of [
  { ...nativeBinding, phase: "dispatch" },
  { ...nativeBinding, nativeExecution: undefined },
  { ...nativeBinding, nativeRuntimeGeneration: undefined },
  { ...dispatch, phase: "native" },
].entries()) {
  emit("taskInferenceInputDispatchSchema", {
    name: "native binding field requirement " + index,
    input,
    outcome: outcome(protocol.taskInferenceInputDispatchSchema, input),
  });
}
function worker(name, input) {
  const expected = outcome(protocol.workerRequestEnvelopeSchema, input);
  emit("workerRequestEnvelopeSchema", {
    name,
    input,
    outcome: expected,
    ...(expected.issues
      ? {
          errorMessage:
            protocol.workerRequestEnvelopeSchema.safeParse(input).error.message,
        }
      : {}),
  });
  return expected;
}
worker("canonical Task receipt", envelope);
for (const key of [
  "chatId",
  "clientMessageId",
  "worktreeId",
  "executionLaneId",
  "providerId",
  "modelRouteId",
  "providerAccountId",
]) {
  const input = structuredClone(envelope);
  input.command.taskInferenceInput[key] = "different";
  assert.ok(
    worker("receipt mismatch " + key, input).issues.some(
      (issue) =>
        issue.message ===
        "Task input receipt must match its canonical round, dispatch, and placement.",
    ),
  );
}
for (const key of ["cycleId", "operationId", "leaseOwner", "fencingToken"]) {
  const input = structuredClone(envelope);
  input.command.taskInferenceInput.dispatch[key] =
    key === "fencingToken"
      ? 2
      : key === "cycleId"
        ? "00000000-0000-4000-8000-000000000099"
        : "different";
  assert.ok(
    worker("dispatch mismatch " + key, input).issues.some(
      (issue) =>
        issue.message ===
        "Task input receipt must match its canonical round, dispatch, and placement.",
    ),
  );
}
for (const path of [
  ["chatId"],
  ["clientMessageId"],
  ["worktreeId"],
  ["executionLaneId"],
  ["provider", "id"],
  ["provider", "accountId"],
  ["model", "routeId"],
  ["resultMode", "operation", "chatId"],
  ["resultMode", "operation", "operationId"],
  ["resultMode", "operation", "userMessage", "id"],
]) {
  const input = structuredClone(envelope);
  let current = input.command;
  for (const key of path.slice(0, -1)) current = current[key];
  current[path.at(-1)] =
    path.at(-1) === "id" && path.includes("userMessage")
      ? "00000000-0000-4000-8000-000000000099"
      : "different";
  worker("command mismatch " + path.join("."), input);
}
for (const field of ["taskInferenceInput", "taskDispatchLease"]) {
  const input = structuredClone(envelope);
  delete input.command[field];
  worker("missing " + field, input);
}
const visible = structuredClone(envelope);
visible.command.resultMode = { kind: "visible" };
worker("Task input requires encrypted Task result", visible);
visible.command.executionProfile = "cantrip-os";
worker("Task binding issue precedes OS issue", visible);
const native = alternatives.cases.find(
  ({ input }) =>
    input.command.type === "chat.turn" && input.command.nativeCommandReceipt,
);
assert.ok(native);
const mixed = structuredClone(envelope);
mixed.command.nativeCommandReceipt = structuredClone(
  native.input.command.nativeCommandReceipt,
);
worker("Task input excludes native command receipt", mixed);
console.log(JSON.stringify({ done: count }));
