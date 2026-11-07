// Actual Source schemas, including canonical Task receipt/dispatch bindings.
import assert from "node:assert/strict";
import * as protocol from "../../packages/protocol/dist/index.js";
import alternatives from "./worker-command-alternatives.json" with { type: "json" };
import { outcome, vectorCases } from "./security-oracle.mjs";
import { record as suspension } from "./native-suspension-oracle.mjs";
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
  taskTurnStopSchema: [
    {
      controlId: "00000000-0000-4000-8000-000000000008",
      source: command.taskInferenceInput,
      active: suspension.active,
      checkpoint: suspension.checkpoint,
      scope: {
        revision: 1,
        workerId: command.taskInferenceInput.workerId,
        projectId: command.policyProjectId,
        worktreeId: command.worktreeId,
        threadId: suspension.active.threadId,
        modelRouteId: command.model.routeId,
        providerAccountId: command.provider.accountId,
        cycleId: command.taskDispatchLease.cycleId,
        orderEpoch: 0,
        taskRound: {
          operationId: operation.operationId,
          inputOperationId: command.taskInferenceInput.operationId,
          cycleId: command.taskDispatchLease.cycleId,
        },
      },
    },
  ],
  taskTurnStopResultSchema: [
    {
      controlId: "00000000-0000-4000-8000-000000000008",
      interrupted: true,
      active: suspension.active,
      outcome: "stopped",
      actor: {
        workerGeneration: dispatch.workerGeneration,
        runtimeGeneration: nativeBinding.nativeRuntimeGeneration,
        operationId: "00000000-0000-4000-8000-000000000008",
        operationGeneration: "00000000-0000-4000-8000-000000000008",
      },
    },
  ],
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
const cycleParent = {
  ...structuredClone(command.taskInferenceInput),
  kind: "goal",
};
const cycleSource = {
  kind: "goal-cycle",
  sourceKey: "f".repeat(64),
  operationId: `native-inference:${suspension.active.threadId}:${suspension.active.turnId}:cycle-scope:cycle-attempt`,
  workerGeneration: dispatch.workerGeneration,
  runtimeGeneration: nativeBinding.nativeRuntimeGeneration,
  ...suspension.active,
  cycle: {
    cycleId: cycleParent.dispatch.cycleId,
    goalEpoch: "epoch",
    scopeId: "cycle-scope",
    gateAttemptId: "cycle-attempt",
    runnerGeneration: "runner",
    modelRouteId: cycleParent.modelRouteId,
    providerAccountId: cycleParent.providerAccountId,
    orderEpoch: 0,
  },
  parent: cycleParent,
  publication: {
    id: "00000000-0000-4000-8000-000000000010",
    idempotencyKey: "assistant:goal-cycle:fixture",
  },
};
protocol.taskGoalCycleSuspensionSourceSchema.parse(cycleSource);
const cycleRestore = {
  controlId: "00000000-0000-4000-8000-000000000008",
  checkpoint: suspension.checkpoint,
  source: cycleParent,
  goalCycle: cycleSource,
};
const cycleDelivery = {
  version: 1,
  inputKind: "goal-cycle",
  deliveryId: cycleSource.publication.id,
  serverId: "fixture-server",
  ownerId: "fixture-owner",
  workerId: cycleParent.workerId,
  goalCycleSource: cycleSource,
  notification: {
    type: "chat.turn.outcome",
    chatId: cycleParent.chatId,
    clientMessageId: cycleParent.clientMessageId,
    executionLaneId: cycleParent.executionLaneId,
    contextKind: "project",
    scratchRootId: null,
    worktreeId: cycleParent.worktreeId,
    outcome: {
      ok: true,
      result: {
        ...suspension.active,
        text: "",
        status: "completed",
        structuredResult: {},
      },
    },
  },
};
Object.assign(samples, {
  taskGoalCycleSuspensionSourceSchema: [
    cycleSource,
    { ...cycleSource, parent: { ...cycleParent, kind: undefined } },
    { ...cycleSource, operationId: "another-native-operation" },
    {
      ...cycleSource,
      cycle: { ...cycleSource.cycle, cycleId: cycleSource.publication.id },
    },
  ],
  taskTurnResumptionSchema: [
    cycleRestore,
    {
      ...cycleRestore,
      source: { ...cycleParent, operationId: cycleSource.publication.id },
    },
    {
      ...cycleRestore,
      goalCycle: {
        ...cycleSource,
        turnId: "another-turn",
        operationId: `native-inference:${cycleSource.threadId}:another-turn:cycle-scope:cycle-attempt`,
      },
    },
  ],
  taskGoalOutcomeDeliverySchema: [
    cycleDelivery,
    { ...cycleDelivery, inputKind: "goal" },
    {
      ...cycleDelivery,
      notification: {
        ...cycleDelivery.notification,
        taskInferenceInputOperationId: cycleParent.operationId,
      },
    },
  ],
  taskGoalOutcomeCommitSchema: [
    {
      deliveryId: cycleSource.publication.id,
      goalCycleSourceKey: cycleSource.sourceKey,
      committed: true,
    },
    { deliveryId: cycleSource.publication.id, committed: true },
    {
      deliveryId: cycleSource.publication.id,
      goalCycleSourceKey: cycleSource.sourceKey,
      taskInferenceInputOperationId: cycleParent.operationId,
      committed: true,
    },
  ],
});
const cycleRefinementCases = [];
for (const schema of [
  "taskGoalCycleSuspensionSourceSchema",
  "taskTurnResumptionSchema",
  "taskGoalOutcomeDeliverySchema",
  "taskGoalOutcomeCommitSchema",
]) {
  const [valid, ...invalid] = samples[schema];
  samples[schema] = [valid];
  for (const input of invalid) {
    const expected = outcome(protocol[schema], input);
    assert.ok(
      expected.issues,
      `${schema} must reject a different physical source`,
    );
    cycleRefinementCases.push({ schema, input, outcome: expected });
  }
}
let count = 0;
function emit(schema, value) {
  console.log(JSON.stringify({ schema, ...value }));
  count++;
}
for (const [schema, values] of Object.entries(samples))
  for (const value of vectorCases(schema, values)) emit(schema, value);
for (const { schema, ...value } of cycleRefinementCases) emit(schema, value);
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
const stopEnvelope = structuredClone(envelope);
stopEnvelope.command = {
  type: "chat.interrupt",
  chatId: command.chatId,
  threadId: suspension.active.threadId,
  taskStop: {
    ...samples.taskTurnStopSchema[0],
    cwd: command.cwd,
    model: command.model,
    provider: command.provider,
    permissionProfileId: command.permissionProfileId,
  },
};
assert.ok(
  worker("scoped Task Stop without inference admission", stopEnvelope).ok,
);
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
const restored = structuredClone(envelope);
restored.command.threadId = suspension.active.threadId;
restored.command.taskResumption = {
  controlId: "00000000-0000-4000-8000-000000000008",
  checkpoint: suspension.checkpoint,
  source: structuredClone(command.taskInferenceInput),
};
restored.command.taskResumption.source.operationId =
  "00000000-0000-4000-8000-000000000009";
restored.command.taskDispatchLease.fencingToken = 2;
restored.command.taskInferenceInput.dispatch.fencingToken = 2;
assert.ok(worker("fresh physical Task restoration", restored).ok);
const goalRestored = structuredClone(restored);
goalRestored.command.taskInferenceInput.kind = "goal";
goalRestored.command.taskResumption.source.kind = "goal";
goalRestored.command.resultMode = {
  kind: "task-message-encrypted",
  messageId: "00000000-0000-4000-8000-000000000010",
  idempotencyKey: "assistant:fixture-goal",
};
delete goalRestored.command.prompt;
delete goalRestored.command.protectedPrompt;
goalRestored.command.protectedTaskPrompt = {
  ...operation.userMessage,
  classification: { role: "user", mode: "goal", attachmentIds: [] },
};
assert.ok(worker("fresh physical Goal restoration", goalRestored).ok);
const changedGoalSource = structuredClone(goalRestored);
delete changedGoalSource.command.taskResumption.source.kind;
assert.ok(
  worker("Goal restore cannot change source kind", changedGoalSource).issues,
);
for (const path of [
  ["source", "chatId"],
  ["source", "clientMessageId"],
  ["source", "executionLaneId"],
  ["source", "worktreeId"],
  ["source", "dispatch", "operationId"],
  ["source", "dispatch", "cycleId"],
  ["checkpoint", "suspension", "threadId"],
]) {
  const input = structuredClone(restored);
  let target = input.command.taskResumption;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = "00000000-0000-4000-8000-000000000099";
  assert.ok(worker("restore source mismatch " + path.join("."), input).issues);
}
for (const field of ["source", "physical", "missing"]) {
  const input = structuredClone(restored);
  if (field === "source") input.command.taskResumption.source.kind = "goal";
  else if (field === "physical") {
    input.command.taskInferenceInput.operationId =
      input.command.taskResumption.source.operationId;
  } else delete input.command.taskInferenceInput;
  assert.ok(
    worker("restore requires fresh Task authority " + field, input).issues,
  );
}
const bothIssues = structuredClone(restored);
bothIssues.command.taskInferenceInput.chatId = "wrong-task";
bothIssues.command.taskResumption.source.worktreeId = "wrong-tree";
worker("restore issue precedes physical binding issue", bothIssues);
console.log(JSON.stringify({ done: count }));
