import { taskFailureKindForError } from "../../packages/protocol/src/task-retry.ts";
const cases = [];
function add(input) {
  cases.push({ input, kind: taskFailureKindForError(input) });
}
const messages = [
  "",
  "hello",
  "task-timeout",
  "implementation-capacity",
  "task-goal-start-rate-limit",
  "task-connection!",
  "task-runtime timeout",
  "task-needs-input",
  "task-configuration",
  "task-usage-limit",
  "task-budget-limit",
  "TASK-TIMEOUT",
  "task-timeout_",
  "task-timeouts",
  "task-timeouté",
  "task-timeout\ud800",
  "budget limit",
  "token budget",
  "usage limit",
  "insufficient_quota",
  "quota.exceeded",
  "goal-blocked",
  "needs input",
  "user_input_required",
  "unauthorized",
  "forbidden",
  "permission denied",
  "invalid_api_key",
  "model X not found",
  "no models configured",
  "route is no longer available",
  "timed out",
  "deadline",
  "server overloaded",
  "at capacity",
  "over-capacity",
  "503",
  "5030",
  "overloaded",
  "task-capacity",
  "rate limit",
  "too many requests",
  "429",
  "4290",
  "offline",
  "disconnect",
  "connection",
  "econnreset",
  "socket",
  "network",
  "fetch failed",
  "budget\nlimit",
  "BUDGETKLIMIT",
  "taſk-timeout",
  "\ud800",
  "\udc00",
];
for (const input of [null, false, true, 0, 123, [], {}, ["timeout"]])
  add(input);
for (const input of messages) {
  add(input);
  for (const key of ["code", "reasonCode", "name", "message"])
    add({ [key]: input });
}
for (const a of messages)
  for (const b of [
    "task-runtime",
    "task-configuration",
    "token budget",
    "timeout",
    "network",
    "",
  ])
    add({ code: a, message: b });
for (const code of [undefined, null, "worker-offline", "other"])
  for (const retryable of [undefined, null, false, true, 0, 1, "true"])
    add({
      name: "ModelConfigurationResolutionError",
      failure: { code, retryable },
      message: "timeout",
    });
for (const name of ["ModelConfigurationResolutionError", "Other"])
  for (const failure of [undefined, null, {}, false])
    add({ name, failure, message: "capacity" });
process.stdout.write(JSON.stringify({ cases }));
