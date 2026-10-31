import { nativeCommandPolicy } from "../../cantrip_server/src/db/repository/native-commands.ts";
import {
  managedNativeMethods,
  managedNativeServerRequests,
} from "../../packages/protocol/dist/index.js";
import { label } from "./project-target-state.mjs";

const base = {
  workerId: "worker",
  operationId: "operation",
  origin: "gui",
  session: {
    chatId: "chat",
    threadId: null,
    contextKind: "project",
    projectId: "project",
    placementId: "worktree",
    modelRouteId: null,
    providerAccountId: null,
    runtimeGeneration: null,
    connectionId: null,
  },
  payloadDigest: "a".repeat(64),
  protectedPayload: label("chat").protectedLabel.envelope,
  expectedActivationGeneration: null,
};
const intents = [
  {},
  { scope: "account-defaults" },
  { scope: "account-defaults", configTarget: "account-defaults" },
  {
    scope: "account-defaults",
    configTarget: "account-defaults",
    settingKeys: ["model_reasoning_effort"],
  },
  {
    scope: "account-defaults",
    configTarget: "account-defaults",
    settingKeys: ["unsupported"],
  },
  { settingKeys: ["model", "permissionProfileId"] },
  { settingKeys: ["unsupported"] },
  { settingsBindingId: "binding" },
  { nativeSettingsOperationId: "settings" },
  { nativeSettingsOperationId: "settings", settingsBindingId: "binding" },
  {
    scope: "account-defaults",
    configTarget: "account-defaults",
    settingsBindingId: "binding",
  },
  { settingsBindingId: "", nativeSettingsOperationId: "" },
];
const methods = new Set([
  ...managedNativeMethods.keys(),
  "serverRequest/reply",
  "thread/rollback",
  "unknown/native",
  "TURN/START",
  " turn/start",
  "turn/start ",
  "thread/settings/update\0",
  "\ud800",
  "\ufffd",
  "",
]);
const cases = [];
function add(input) {
  let outcome;
  try {
    outcome = { ok: nativeCommandPolicy({ ...base, ...input }) };
  } catch (error) {
    outcome = {
      error: {
        code: error.code,
        status: error.statusCode,
        message: error.message,
      },
    };
  }
  cases.push({ input, outcome });
}
for (const method of methods)
  for (const variant of intents) {
    const input = {
      method,
      intent: {
        scope: "thread",
        settingKeys: [],
        expectedTurnId: null,
        ...variant,
      },
    };
    add(input);
    add({ ...input, reply: null });
    add({
      ...input,
      reply: {
        nativeRequestId: "request",
        requestMethod: "item/tool/requestUserInput",
        turnId: null,
      },
    });
    add({
      ...input,
      reply: {
        nativeRequestId: "request",
        requestMethod: "unsupported",
        turnId: null,
      },
    });
  }
for (const requestMethod of managedNativeServerRequests)
  add({
    method: "serverRequest/reply",
    intent: { scope: "thread", settingKeys: [], expectedTurnId: null },
    reply: { nativeRequestId: "request", requestMethod, turnId: null },
  });
console.log(JSON.stringify({ nodeVersion: process.version, base, cases }));
