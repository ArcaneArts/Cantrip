// Expectations execute the current Source schemas, independently of Rust's graph.
import { vectorCases, outcome } from "./security-oracle.mjs";
import { sourceContractSchema } from "./contracts.mjs";
import { securityFixtures } from "./security-fixtures.mjs";
import { taskEnvelope, taskOperationId } from "./task-wire-fixtures.mjs";

export const gitStats = {
  kind: "git",
  commitCount: 17,
  trackedFileCount: 5,
  trackedByteCount: 101,
  textFileCount: 4,
  lineCount: 27,
  excludedFileCount: 1,
  truncated: false,
};
export const folderStats = {
  kind: "folder",
  fileCount: 5,
  byteCount: 101,
  textFileCount: 4,
  lineCount: 27,
  excludedFileCount: 1,
  truncated: false,
};
const totals = {
  inputTokens: 7,
  outputTokens: 3,
  totalTokens: 10,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 1,
  reasoningOutputTokens: 1,
};
const agentTime = {
  activeAgentCount: 0,
  agentTimeMs: 1000,
  wallTimeMs: 1000,
  averageConcurrency: 1,
};
const task = securityFixtures.taskOpaqueSummarySchema[0];
const plan = {
  kind: "chat-encrypted",
  chatId: task.chatId,
  mode: "default",
  hasQuestion: false,
  state: null,
};
const message = {
  id: "workload-message",
  chatId: task.chatId,
  worktreeId: "worktree",
  executionLaneId: null,
  sequence: 1,
  classification: { role: "user", mode: "default", attachmentIds: [] },
  protectedContent: taskEnvelope,
  modelId: null,
  modelRouteId: null,
  providerId: null,
  providerName: null,
  providerModelName: null,
  reasoningEffort: null,
  appliedReasoningEffort: null,
  reasoningAdjusted: false,
  idempotencyKey: null,
  createdAt: "2026-10-25T00:00:00.000Z",
};
// Task summaries put their public classification fields at the top level.
Object.assign(message, message.classification);
delete message.classification;
const workload = {
  projectId: "project",
  items: [{ task, plan, messages: [message] }],
};
const samples = {
  projectRepositoryStatsSchema: [
    gitStats,
    folderStats,
    { ...gitStats, kind: undefined },
  ],
  projectTokenUsageSchema: [
    {
      total: totals,
      agentTime,
      daily: [{ date: "2026-10-25", ...totals }],
      providers: [{ id: null, name: "Deleted provider", agentTime, ...totals }],
      models: [{ id: "model", name: "モデル", agentTime, ...totals }],
      range: { start: "2025-10-26", end: "2026-10-25" },
    },
  ],
  protectedScriptCommandListSchema: [
    {
      operationId: taskOperationId,
      projectId: "project",
      worktreeId: "worktree",
      protectedCommands: taskEnvelope,
    },
  ],
  projectTaskWorkloadOpaqueSchema: [
    workload,
    { projectId: "empty", items: [] },
  ],
  repositoryOperationOpaqueSchema: [taskEnvelope],
  scriptCommandOperationIdSchema: [
    taskOperationId,
    "00000000-0000-0000-0000-000000000000",
  ],
};
const schema = process.argv[2];
const extra = [];
if (schema === "projectTaskWorkloadOpaqueSchema") {
  for (const mismatch of ["plan", "messages"]) {
    const input = structuredClone(workload);
    if (mismatch === "plan") input.items[0].plan.chatId = "foreign";
    else input.items[0].messages[0].chatId = "foreign";
    extra.push({
      input,
      outcome: outcome(sourceContractSchema(schema), input),
    });
  }
}
if (schema)
  console.log(
    JSON.stringify({
      cases: [...vectorCases(schema, samples[schema]), ...extra],
    }),
  );
