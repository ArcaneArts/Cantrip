// Drive the actual Source executor; capture its repository settlement boundary.
import assert from "node:assert/strict";
import { ChatImportJobExecutor } from "../../cantrip_server/src/chat-imports/executor.ts";
import { CanonicalChatHydrationError } from "../../cantrip_server/src/chats/hydration.ts";
import { WorkerUnavailableError } from "../../cantrip_server/src/workers/bridge.ts";
import { externalChatReadWorkerResultSchema } from "../../packages/protocol/dist/index.js";

const inputs = [];
const phrases = [
  "outside Cantrip's tested range",
  "not supported",
  "no selected model",
  "no default model",
  "no target model route",
  "model profile was not found",
  "permission profile",
  "required skills",
  "cannot inject",
  "no longer belongs",
  "project match",
  "destination worktree",
  "identity changed",
  "invalid thread/read",
  "safe to import",
  "not found",
  "timed out",
  "timeout",
];
for (const phrase of phrases) {
  for (const message of [
    phrase,
    phrase.toUpperCase(),
    phrase.replaceAll("s", "ſ").replaceAll("k", "K"),
  ]) {
    for (const [prefix, suffix] of [
      ["", ""],
      ["😀\ud800 ", " \udfff\u2028"],
      ["x".repeat(2100), ""],
    ])
      inputs.push({ kind: "worker", message: prefix + message + suffix });
  }
}
// Overlapping classes verify the executor's priority, not just keyword presence.
for (const left of phrases)
  for (const right of phrases)
    inputs.push({ kind: "worker", message: right + " / " + left });
for (const message of [
  "",
  "unclassified failure",
  "😀".repeat(1100),
  "x".repeat(1999) + "😀tail",
  "\ud800".repeat(2100),
  "x".repeat(2000) + "timeout",
  "TİMEOUT",
  "tımeout",
  "tİmed out",
])
  inputs.push({ kind: "worker", message });
inputs.push(
  { kind: "offline", message: "not supported" },
  { kind: "validation", message: "" },
  { kind: "encoding-validation", message: "" },
);
for (const [kind, message] of [
  [
    "digest-mismatch",
    "The immutable canonical transcript failed server-side digest verification.",
  ],
  [
    "target-mismatch",
    "The target worker returned hydration state for a different snapshot.",
  ],
  [
    "too-many-skills",
    "The canonical transcript references more than 64 skills and cannot be hydrated safely.",
  ],
])
  inputs.push({ kind, message });

const cases = [];
for (const input of inputs) {
  let error;
  if (input.kind === "offline")
    error = new WorkerUnavailableError(input.message);
  else if (input.kind.includes("validation")) {
    try {
      externalChatReadWorkerResultSchema.parse({});
    } catch (value) {
      error = value;
    }
  } else if (input.kind === "worker") error = new Error(input.message);
  else error = new CanonicalChatHydrationError(input.kind, input.message);
  assert.ok(error);
  const job = {
    id: "job",
    projectId: "project",
    chatId: null,
    sourceWorkerId: "source",
    targetPlacement: { workerId: "target" },
    attempt: 1,
  };
  let claimed = false,
    outcome;
  const settle = (state, failure) => {
    assert.equal(outcome, undefined);
    outcome = { state, error: failure };
    return { ...job, state, error: failure };
  };
  const repository = {
    getWorker: async () => ({ externalCodexHistory: true }),
    chatImportJobs: {
      claimNext: async () => {
        if (claimed) return null;
        claimed = true;
        return { ownerId: "owner", commandId: "command", job };
      },
      readContext: async () => ({ targets: [] }),
      block: async (_id, _command, failure) => settle("blocked", failure),
      fail: async (_id, _command, failure) => settle("failed", failure),
    },
  };
  const executor = new ChatImportJobExecutor(
    repository,
    {
      isConnected: () => true,
      request: async () => {
        throw error;
      },
    },
    {
      warn() {},
      info() {},
      error(context) {
        throw context.err;
      },
    },
  );
  executor.queueAvailable();
  await executor.drain();
  executor.stop();
  await executor.drain();
  assert.ok(outcome);
  cases.push({ input, outcome });
}
process.stdout.write(JSON.stringify({ cases }) + "\n");
