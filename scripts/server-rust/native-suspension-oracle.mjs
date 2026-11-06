// Development oracle uses the actual protocol, including its semantic checks.
import * as protocol from "../../packages/protocol/dist/index.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const uuid = "f57d812b-37d4-4d1e-b87a-3503b0d89b23";
const active = { threadId: "native-thread", turnId: "original-turn" };
const actor = {
  workerGeneration: "worker",
  runtimeGeneration: "runtime",
  operationId: "operation",
  operationGeneration: "generation",
};
const evidence = {
  suspension: { ...active, checkpointId: "checkpoint", revision: 1 },
  storageId: uuid,
  runtimeVersion: "test/cantrip-suspension-v8",
  runtimeFingerprint: null,
};
export const record = {
  version: 1,
  controlId: uuid,
  action: "pause",
  phase: "paused",
  target: {
    workerId: "worker",
    contextKind: "project",
    projectId: "project",
    placementId: "tree",
    placementRevision: 1,
    cantripOsBindingId: null,
    executionLaneId: null,
    modelRouteId: null,
    providerAccountId: null,
    threadId: active.threadId,
    originalOperationId: null,
  },
  active,
  checkpoint: evidence,
  actor,
  actorControlId: uuid,
  error: null,
  requestedAt: "2026-11-05T12:00:00.000Z",
  updatedAt: "2026-11-05T12:00:01.000Z",
  pausedAt: "2026-11-05T12:00:01.000Z",
  pausedMilliseconds: 0,
};
export const cases = [];
function add(schema, input) {
  const parsed = protocol[schema].safeParse(input);
  cases.push({
    schema,
    input,
    outcome: parsed.success
      ? { ok: parsed.data }
      : { issues: parsed.error.issues },
    ...(!parsed.success ? { errorMessage: parsed.error.message } : {}),
  });
}
for (const [schema, value] of [
  ["nativeTurnSuspensionSchema", evidence.suspension],
  ["nativeSuspensionTargetSchema", record.target],
  ["nativeSuspensionActorSchema", actor],
  ["nativeSuspensionActiveTurnSchema", active],
  ["nativeSuspensionEvidenceSchema", evidence],
  [
    "nativeSuspensionErrorSchema",
    { code: "checkpoint-corrupt", protectedDetails: null },
  ],
  ["nativeSuspensionRecordSchema", record],
  ["chatNativeSuspensionSchema", protocol.storedChatNativeSuspension(record)],
]) {
  add(schema, value);
  add(schema, { ...value, executionGrant: "must-not-persist" });
  for (const key of Object.keys(value)) {
    const missing = { ...value };
    delete missing[key];
    add(schema, missing);
  }
}
add("nativeSuspensionRecordSchema", {
  ...record,
  executionOwner: { ...actor, operationId: "fresh-physical" },
});
add("nativeSuspensionRecordSchema", {
  ...record,
  executionOwner: { ...actor, grant: "must-not-persist" },
});
add("nativeSuspensionRecordSchema", {
  ...record,
  executionOwner: { ...actor, operationGeneration: "" },
});
for (const phase of protocol.nativeSuspensionPhaseSchema.options) {
  add("nativeSuspensionRecordSchema", { ...record, phase });
  add("nativeSuspensionRecordSchema", { ...record, phase, checkpoint: null });
}
for (const patch of [
  { action: "resume", phase: "resuming", checkpoint: null, pausedAt: null },
  { action: "resume", phase: "resuming", checkpoint: null, active: null },
  { action: "pause", phase: "resuming", checkpoint: null },
  {
    action: "resume",
    phase: "resuming",
    checkpoint: null,
    active: { ...active, threadId: "foreign" },
  },
])
  add("nativeSuspensionRecordSchema", { ...record, ...patch });

const taskRound = { operationId: uuid, inputOperationId: uuid, cycleId: uuid };
const taskTarget = {
  ...record.target,
  executionLaneId: "task-lane",
  originalOperationId: uuid,
  taskRound,
};
add("nativeSuspensionRecordSchema", { ...record, target: taskTarget });
for (const patch of [
  { contextKind: "standalone" },
  { projectId: null },
  { executionLaneId: null },
  { originalOperationId: "another-input" },
  { taskRound: { ...taskRound, cycleId: "invalid" } },
])
  add("nativeSuspensionRecordSchema", {
    ...record,
    target: { ...taskTarget, ...patch },
  });
const taskScope = {
  revision: 1,
  workerId: "worker",
  projectId: "project",
  worktreeId: "tree",
  threadId: active.threadId,
  modelRouteId: "route",
  providerAccountId: null,
  cycleId: uuid,
  orderEpoch: 1,
  taskRound,
};
for (const [schema, value] of [
  ["taskPauseScopeSchema", taskScope],
  ["taskPauseIntentSchema", { paused: true, scope: taskScope }],
  [
    "taskPauseRuntimeStateSchema",
    {
      paused: true,
      active,
      execution: {
        actor: { ...actor, operationId: uuid, operationGeneration: uuid },
        checkpoint: evidence,
      },
    },
  ],
  ["taskPauseRuntimeStateSchema", { paused: true, active: null }],
  [
    "taskPauseRuntimeStateSchema",
    { paused: false, active, execution: { actor, checkpoint: null } },
  ],
]) {
  add(schema, value);
  add(schema, { ...value, executionGrant: "must-not-persist" });
  for (const key of Object.keys(value)) {
    const missing = { ...value };
    delete missing[key];
    add(schema, missing);
  }
}
for (const patch of [
  { version: 99 },
  { actorControlId: "6f2b4be5-491a-4bea-b950-0b41ec38081e" },
  { actor: null },
  { active: null },
  { active: { ...active, turnId: "replacement" } },
  { active: { ...active, threadId: "foreign-thread" } },
  {
    phase: "error",
    error: { code: "checkpoint-corrupt", protectedDetails: null },
  },
  {
    error: {
      code: "checkpoint-corrupt",
      message: "/private/key",
      protectedDetails: null,
    },
  },
  {
    checkpoint: {
      ...evidence,
      suspension: { ...evidence.suspension, revision: 2 ** 53 },
    },
  },
  { pausedMilliseconds: 2 ** 53 },
])
  add("nativeSuspensionRecordSchema", { ...record, ...patch });

export const projections = [
  record,
  {
    ...record,
    action: "resume",
    phase: "resuming",
    checkpoint: null,
    pausedAt: null,
  },
  {
    ...record,
    action: "resume",
    phase: "error",
    checkpoint: null,
    pausedAt: null,
    error: { code: "restore-failed", protectedDetails: null },
  },
  {
    ...record,
    phase: "error",
    error: { code: "pause-failed", protectedDetails: null },
  },
  {
    ...record,
    action: "resume",
    phase: "error",
    error: { code: "restore-failed", protectedDetails: null },
  },
  null,
  { version: 99, phase: "running", secret: "private" },
  { ...record, phase: "completed" },
  { ...record, active: { ...active, turnId: "wrong" } },
].map((input) => ({
  input,
  output: protocol.storedChatNativeSuspension(input),
}));
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.stdout.write(JSON.stringify({ record, cases, projections }));
