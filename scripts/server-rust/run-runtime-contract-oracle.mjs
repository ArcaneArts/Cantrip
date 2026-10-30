import { runConfigurationRuntimeWorkerOperationResultSchema as schema } from "../../packages/protocol/dist/run-configuration-runtime.js";
import { outcome } from "./security-oracle.mjs";
const identity = {
  runtimeId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  configurationId: "33333333-3333-4333-8333-333333333333",
  worktreeId: "44444444-4444-4444-8444-444444444444",
  workerId: "worker",
  definitionRevision: "a".repeat(64),
  codexEnvironmentRevision: null,
  generation: 1,
  operationId: "55555555-5555-4555-8555-555555555555",
  terminalId: "66666666-6666-4666-8666-666666666666",
};
const cases = [];
for (const result of ["accepted", "replayed", "stale", "not-found"]) {
  cases.push({ outcome: result, observation: null });
  for (const state of [
    "idle",
    "starting",
    "running",
    "restarting",
    "stopping",
    "exited",
    "failed",
    "lost",
  ])
    for (const endedAt of [null, "2026-10-25T00:00:00.123Z"])
      cases.push({
        outcome: result,
        observation: {
          ...identity,
          state,
          startedAt: null,
          endedAt,
          exitCode: null,
          signal: null,
          failure: null,
        },
      });
}
console.log(
  JSON.stringify({
    cases: cases.map((input) => ({ input, outcome: outcome(schema, input) })),
  }),
);
