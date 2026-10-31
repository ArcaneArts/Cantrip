import { createRequire } from "node:module";
import { nativeCommandReceipt } from "../../cantrip_server/src/db/repository/native-command-receipt.ts";
import {
  samePlacement,
  sameRuntimeRoute,
} from "../../cantrip_server/src/db/repository/native-command-context.ts";
import * as schema from "../../cantrip_server/src/db/schema.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { getTableColumns } = require("drizzle-orm");
const base = {
  chat_id: "chat",
  operation_id: "operation",
  operation_generation: "generation",
  logical_operation_id: null,
  previous_operation_id: null,
  activation_generation: null,
  execution_lane_id: null,
  status: "accepted",
  method: "skills/list",
  payload_digest: "a".repeat(64),
  rejection_code: null,
  kind: "mutation",
  identity: { threadId: "thread" },
  created_at: "2026-10-25T00:00:00.123999Z",
  updated_at: "2026-10-25T01:00:00.123+01:00",
  settings_application: null,
};
function sourceRow(raw) {
  return Object.fromEntries(
    Object.entries(getTableColumns(schema.nativeCommands))
      .filter(([, column]) => Object.hasOwn(raw, column.name))
      .map(([key, column]) => [
        key,
        column.name.endsWith("_at") && raw[column.name] !== null
          ? new Date(raw[column.name])
          : raw[column.name],
      ]),
  );
}
const receipts = [];
function addReceipt(row) {
  let outcome;
  try {
    outcome = { ok: nativeCommandReceipt(sourceRow(row)) };
  } catch (error) {
    outcome = { error: error.message };
  }
  receipts.push({ row, outcome });
}
addReceipt(base);
for (const status of [
  "accepted",
  "dispatched",
  "applied",
  "rejected",
  "uncertain",
  "invalid",
])
  addReceipt({
    ...base,
    status,
    kind: "start",
    logical_operation_id: "logical",
    previous_operation_id: "previous",
  });
for (const value of [
  null,
  false,
  0,
  "",
  {},
  [],
  1,
  {
    nativeOperationId: "settings",
    submissionId: null,
    status: "pending",
    evidenceCount: 0,
  },
])
  addReceipt({ ...base, settings_application: value });
for (const identity of [
  {},
  { threadId: null },
  { threadId: "" },
  { threadId: "thread 🦀" },
  null,
  0,
  "thread",
  [],
])
  addReceipt({ ...base, identity });
for (const field of [
  "logical_operation_id",
  "previous_operation_id",
  "activation_generation",
  "settings_application",
]) {
  const row = { ...base };
  delete row[field];
  addReceipt(row);
}
for (const at of [
  "1970-01-01T00:00:00.000Z",
  "1969-12-31T23:59:59.999Z",
  "+010000-01-01T00:00:00.000Z",
  "infinity",
  "-infinity",
])
  for (const field of ["created_at", "updated_at"])
    addReceipt({ ...base, [field]: at });
const session = {
  chatId: "chat",
  threadId: "thread",
  contextKind: "project",
  projectId: "project",
  placementId: "tree",
  modelRouteId: null,
  providerAccountId: null,
};
const context = {
  chatId: "chat",
  workerId: "alpha",
  contextKind: "project",
  projectId: "project",
  worktreeId: "tree",
  scratchRootId: null,
  modelRouteId: null,
  providerAccountId: null,
};
const contexts = [
  context,
  null,
  {
    ...context,
    worktreeId: null,
    scratchRootId: "scratch",
    contextKind: "standalone",
    projectId: null,
  },
];
const sessions = [
  null,
  session,
  {
    ...session,
    placementId: "scratch",
    contextKind: "standalone",
    projectId: null,
  },
];
for (const field of [
  "workerId",
  "chatId",
  "contextKind",
  "projectId",
  "worktreeId",
  "scratchRootId",
  "modelRouteId",
  "providerAccountId",
]) {
  const missing = { ...context };
  delete missing[field];
  contexts.push(missing);
  for (const value of [null, "other", {}, []])
    contexts.push({ ...context, [field]: value });
}
for (const field of [
  "chatId",
  "contextKind",
  "projectId",
  "placementId",
  "modelRouteId",
  "providerAccountId",
]) {
  const missing = { ...session };
  delete missing[field];
  sessions.push(missing);
  for (const value of [null, "other", {}, []])
    sessions.push({ ...session, [field]: value });
}
const placements = [];
const attempt = (read) => {
  try {
    return { ok: read() };
  } catch (error) {
    return { error: error.message };
  }
};
for (const current of contexts)
  for (const selected of sessions)
    for (const worker of ["alpha", "beta"])
      placements.push({
        context: current,
        session: selected,
        worker,
        placement: attempt(() => samePlacement(current, worker, selected)),
        route: attempt(() => sameRuntimeRoute(current, selected)),
      });
const values = [
  null,
  true,
  false,
  0,
  "",
  "🦀0123456789",
  [],
  [null, 0, false, ["a", "b"]],
  { scope: "thread", settingKeys: [], expectedTurnId: null },
  { expectedTurnId: null, settingKeys: [], scope: "thread" },
  { scope: "thread", permissionTransition: { a: 1, b: 2 } },
  { permissionTransition: { b: 2, a: 1 }, scope: "thread" },
  { "a,b": "x", a: "b,x" },
  { a: "b,x", "a,b": "x" },
  { only: { toString: 0 } },
  { only: { toString: 0 }, other: 1 },
  JSON.parse('{"__proto__":"x","10":"a","2":"b","01":"c"}'),
];
const intents = values.map((input) => ({
  input,
  outcome: attempt(() => JSON.stringify(Object.entries(input).sort())),
}));
intents.push({
  outcome: attempt(() => JSON.stringify(Object.entries(undefined).sort())),
});
console.log(JSON.stringify({ receipts, placements, intents }));
