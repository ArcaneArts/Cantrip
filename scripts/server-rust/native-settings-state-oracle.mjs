// Expectations invoke the actual pure state machines and policy fences.
import {
  emptyNativeSettingsState,
  requestNativeSettings,
  bindNativeSettingsRead,
  observeNativeSettings,
  settleNativeSettingsIntent,
} from "../../cantrip_server/src/db/repository/native-settings-state.ts";
import {
  resolvePermissionTransition,
  assertPermissionTransition,
} from "../../cantrip_server/src/db/repository/native-permission-transitions.ts";
import { NativeCommandError } from "../../cantrip_server/src/db/repository/native-command-errors.ts";
import {
  settingsBinding as binding,
  settingsSnapshot as snapshot,
  settingsIntent as intent,
  resolvedAttribution,
} from "./native-settings-fixtures.mjs";
const cases = [],
  states = [],
  seen = new Set();
function run(kind, input, remember = false) {
  let outcome;
  try {
    let ok;
    switch (kind) {
      case "empty":
        ok = emptyNativeSettingsState(input.chat);
        break;
      case "request":
        ok = requestNativeSettings(input.value, input.intent);
        break;
      case "bind":
        ok = bindNativeSettingsRead(
          input.value,
          input.expected,
          input.binding,
          input.snapshot,
        );
        break;
      case "observe":
        ok = observeNativeSettings(
          input.value,
          input.bindingId,
          input.snapshot,
        );
        break;
      case "settle":
        ok = settleNativeSettingsIntent(
          input.value,
          input.operation,
          input.outcome,
        );
        break;
      case "resolve-permission":
        ok = resolvePermissionTransition(
          input.context,
          input.selectedId,
          input.revision,
        );
        break;
      case "assert-permission":
        assertPermissionTransition(input.context, input.value, input.input);
        ok = null;
        break;
      default:
        throw new Error("Unknown oracle kind");
    }
    outcome = { ok };
  } catch (error) {
    outcome = {
      error: error.message,
      ...(error instanceof NativeCommandError
        ? { code: error.code, status: error.statusCode }
        : {}),
    };
  }
  cases.push({ kind, ...structuredClone(input), result: outcome });
  if (remember && outcome.ok) {
    const key = JSON.stringify(outcome.ok);
    if (!seen.has(key)) {
      seen.add(key);
      states.push(outcome.ok);
    }
  }
  return outcome.ok;
}
const initial = run("empty", { chat: "chat" }, true);
const first = run("request", { value: initial, intent }, true);
const secondIntent = {
  ...intent,
  operationId: "second",
  operationGeneration: "second-generation",
};
run("request", { value: first, intent: secondIntent }, true);
run(
  "request",
  {
    value: initial,
    intent: {
      ...intent,
      source: { ...intent.source, runtimeGeneration: null, threadId: null },
    },
  },
  true,
);
const bound = run(
  "bind",
  { value: initial, expected: null, binding, snapshot },
  true,
);
const requested = run("request", { value: bound, intent }, true);
run("bind", { value: first, expected: null, binding, snapshot }, true);
run("request", { value: requested, intent: secondIntent }, true);
for (const outcome of ["dispatched", "applied", "rejected", "uncertain"])
  run("settle", { value: requested, operation: intent, outcome }, true);
run(
  "observe",
  {
    value: requested,
    bindingId: "binding",
    snapshot: {
      ...snapshot,
      context: {
        ...snapshot.context,
        settingsVersion: { epoch: "epoch", revision: "5" },
      },
    },
  },
  true,
);
run(
  "observe",
  {
    value: requested,
    bindingId: "binding",
    snapshot: { ...snapshot, modelAttribution: resolvedAttribution },
  },
  true,
);
run(
  "bind",
  {
    value: requested,
    expected: "binding",
    binding: {
      ...binding,
      bindingId: "replacement",
      runtimeGeneration: "new-runtime",
    },
    snapshot: {
      ...snapshot,
      context: { ...snapshot.context, runtimeGeneration: "new-runtime" },
    },
  },
  true,
);
const snapshots = [
  snapshot,
  ...["0", "3", "5", "18446744073709551615", "18446744073709551616"].map(
    (revision) => ({
      ...snapshot,
      context: {
        ...snapshot.context,
        settingsVersion: { epoch: "epoch", revision },
      },
    }),
  ),
  ...["chatId", "workerId", "threadId", "runtimeGeneration"].map((key) => ({
    ...snapshot,
    context: { ...snapshot.context, [key]: "replaced" },
  })),
  {
    ...snapshot,
    context: {
      ...snapshot.context,
      settingsVersion: { epoch: "new-epoch", revision: "4" },
    },
  },
  { ...snapshot, contentFingerprint: "f".repeat(64) },
  {
    ...snapshot,
    protectedContent: {
      ...snapshot.protectedContent,
      ciphertext: Buffer.alloc(32, 7).toString("base64url"),
    },
  },
  {
    ...snapshot,
    protectedContent: {
      ...snapshot.protectedContent,
      keyRevision: snapshot.protectedContent.keyRevision + 1,
    },
  },
  { ...snapshot, modelAttribution: resolvedAttribution },
  {
    ...snapshot,
    modelAttribution: { ...resolvedAttribution, fingerprint: "e".repeat(64) },
  },
  {
    ...snapshot,
    modelAttribution: {
      ...resolvedAttribution,
      selection: {
        ...resolvedAttribution.selection,
        modelId: "different-model",
      },
    },
  },
  {
    ...snapshot,
    modelAttribution: {
      selection: { status: "unmapped" },
      fingerprint: "d".repeat(64),
    },
  },
];
for (const value of [
  ...states,
  {
    ...requested,
    revision: "999999999999999999999999999999",
    desiredRevision: "1844674407370955161599999999",
  },
]) {
  for (const changed of [
    {},
    { operationGeneration: "replaced" },
    { origin: "terminal" },
    { payloadDigest: "f".repeat(64) },
    { source: { ...intent.source, workerId: "beta" } },
    {
      protectedContent: {
        ...intent.protectedContent,
        ciphertext: Buffer.alloc(32, 8).toString("base64url"),
      },
    },
    { operationId: "third" },
    {
      permissionTransition: {
        selectedId: null,
        resolvedSelectedId: ":workspace",
        effectiveId: ":workspace",
        expectedRevision: "0",
      },
    },
  ])
    run("request", { value, intent: { ...intent, ...changed } });
  for (const operation of [
    intent,
    secondIntent,
    { operationId: "missing", operationGeneration: "missing" },
    { ...intent, operationGeneration: "replaced" },
  ])
    for (const outcome of ["dispatched", "applied", "rejected", "uncertain"])
      run("settle", { value, operation, outcome });
  for (const next of snapshots) {
    run("observe", { value, bindingId: "binding", snapshot: next });
    run("bind", {
      value,
      expected: value.binding?.bindingId ?? null,
      binding: { ...binding, bindingId: "new-binding" },
      snapshot: next,
    });
  }
  for (const expected of [null, "binding", "stale"])
    for (const next of [
      binding,
      { ...binding, modelRouteId: "new-route" },
      { ...binding, chatId: "other" },
    ])
      run("bind", { value, expected, binding: next, snapshot });
}
for (const selectedId of [
  null,
  ":workspace",
  ":read-only",
  ":full-access",
  "custom-policy",
])
  for (const defaultPermissionProfileId of [
    null,
    ":workspace",
    ":read-only",
    "custom-default",
  ])
    for (const isPrimary of [false, true])
      for (const worktreePolicy of ["shared", "required-for-writes"]) {
        const context = {
          defaultPermissionProfileId,
          isPrimary,
          worktreePolicy,
        };
        for (const revision of ["0", "999999999999999999999999"])
          run("resolve-permission", { context, selectedId, revision });
        const transition = resolvePermissionTransition(
          context,
          selectedId,
          "0",
        );
        const input = {
          method: "thread/settings/update",
          operationId: "operation",
          intent: {
            scope: "thread",
            settingKeys: ["permissions"],
            settingsBindingId: "binding",
            nativeSettingsOperationId: "settings",
            permissionTransition: transition,
          },
        };
        const pendingIntent = { ...intent, permissionTransition: transition };
        for (const value of [
          bound,
          { ...bound, binding: null },
          { ...bound, binding: { ...binding, bindingId: "other" } },
          { ...bound, permissionPolicy: { revision: "1" } },
          {
            ...bound,
            pending: [{ intent: pendingIntent, status: "accepted" }],
          },
          {
            ...bound,
            pending: [
              {
                intent: { ...pendingIntent, operationId: "other" },
                status: "dispatched",
              },
            ],
          },
          {
            ...bound,
            desired: { ...pendingIntent, operationId: "other" },
            desiredStatus: "uncertain",
          },
          {
            ...bound,
            desired: { ...pendingIntent, operationId: "other" },
            desiredStatus: "applied",
          },
        ])
          for (const changed of [
            {},
            { method: "turn/settings/update" },
            { intent: { ...input.intent, permissionTransition: undefined } },
            { intent: { ...input.intent, settingKeys: [] } },
            { intent: { ...input.intent, nativeSettingsOperationId: null } },
            {
              intent: {
                ...input.intent,
                permissionTransition: {
                  ...transition,
                  resolvedSelectedId: "wrong",
                },
              },
            },
            {
              intent: {
                ...input.intent,
                permissionTransition: { ...transition, expectedRevision: "1" },
              },
            },
          ])
            run("assert-permission", {
              context,
              value,
              input: { ...input, ...changed },
            });
      }
console.log(JSON.stringify({ cases }));
