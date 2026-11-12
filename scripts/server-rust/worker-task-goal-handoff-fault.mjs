// Keep the real server response from reaching the worker at a durable boundary.
import { existsSync, renameSync, writeFileSync } from "node:fs";

const {
  CANTRIP_TEST_TASK_GOAL_HANDOFF_FILE: file,
  CANTRIP_TEST_TASK_GOAL_HANDOFF_ACTION: action,
  CANTRIP_TEST_TASK_GOAL_HANDOFF_WORKER_ENTRY: entry,
} = process.env;
if (file && process.argv[1] === entry && !existsSync(file)) {
  const fetch = globalThis.fetch;
  let intercepted = false;
  globalThis.fetch = async (input, options) => {
    const response = await fetch(input, options);
    const url = typeof input === "string" ? input : (input?.url ?? input?.href);
    if (
      intercepted ||
      !response.ok ||
      !url?.endsWith("/api/internal/native-runtime-handoffs") ||
      typeof options?.body !== "string" ||
      JSON.parse(options.body).action !== action
    )
      return response;
    const state = await response.clone().json();
    if (intercepted || !state.queuedSource?.taskGoalInput) return response;
    intercepted = true;
    const { signal } = options;
    if (!signal) throw new Error("Handoff request has no cancellation signal.");
    const temporary = file + ".tmp";
    writeFileSync(
      temporary,
      JSON.stringify({
        action,
        status: response.status,
        phase: state.phase,
        operationId: state.operationId,
        chatId: state.chatId,
        binding: state.binding,
        preparedRuntimeGeneration: state.prepared?.runtimeGeneration,
        sourceWithdrawn: state.queuedSource.withdrawn,
        pid: process.pid,
      }) + "\n",
      { mode: 0o600 },
    );
    renameSync(temporary, file);
    signal.throwIfAborted();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
}
