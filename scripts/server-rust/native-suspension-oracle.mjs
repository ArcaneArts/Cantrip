// Development oracle uses the actual protocol, including its semantic checks.
import * as protocol from "../../packages/protocol/dist/index.js";

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
const record = {
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
const cases = [];
function add(schema, input) {
  const parsed = protocol[schema].safeParse(input);
  cases.push({
    schema,
    input,
    outcome: parsed.success
      ? { ok: parsed.data }
      : { issues: parsed.error.issues },
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
for (const phase of protocol.nativeSuspensionPhaseSchema.options) {
  add("nativeSuspensionRecordSchema", { ...record, phase });
  add("nativeSuspensionRecordSchema", { ...record, phase, checkpoint: null });
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

const projections = [
  record,
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
process.stdout.write(JSON.stringify({ record, cases, projections }));
