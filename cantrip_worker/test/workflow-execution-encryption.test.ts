import {
  decryptWorkflowContent,
  encryptWorkflowContent,
  randomBytes,
} from "@cantrip/crypto";
import type { WorkerCommand } from "@cantrip/protocol";
import {
  workflowNodeProtectedResultSchema,
  workflowRevisionProtectedDefinitionSchema,
  workflowRunProtectedInputSchema,
} from "@cantrip/protocol/workflows";
import { describe, expect, it } from "vitest";

import { executeProtectedWorkflowNode } from "../src/workflow-execution-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const ownerId = "owner-workflow-runtime";
const revisionId = "revision-1";
const runId = "run-1";
const runNodeId = "run-node-1";
const attemptId = "attempt-1";

describe("protected workflow execution", () => {
  it("opens prompts only on the worker and seals run, node, and attempt results", async () => {
    const key = randomBytes(32);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
    } as unknown as WorkerEncryptionService;
    const protectedDefinition = await encryptWorkflowContent({
      ownerId,
      context: {
        recordKind: "workflow-revision",
        recordId: revisionId,
        field: "definition",
      },
      keyRevision: 1,
      componentKey: key,
      content: {
        version: 1,
        graph: {
          version: 1,
          nodes: [
            {
              key: "summarize",
              type: "agent",
              name: "Private node name",
              configuration: {
                prompt: "PRIVATE_PROMPT_SENTINEL",
                developerInstructions: null,
                includeStructuredInput: true,
                automaticRetries: null,
              },
              inputSchema: {},
              outputSchema: {},
              permissionRequirements: {
                filesystem: "read-only",
                network: "none",
                approvalMode: "preauthorized",
                skills: [],
                mcpServers: [],
                nativeSubagents: false,
              },
              mutationMode: "read-only",
              modelRouteId: null,
              permissionProfileId: null,
            },
          ],
          edges: [],
        },
        declaredInputs: {},
        declaredOutputs: {},
        defaults: {},
        permissionRequirements: {
          filesystem: "read-only",
          network: "none",
          approvalMode: "preauthorized",
          skills: [],
          mcpServers: [],
          nativeSubagents: false,
        },
      },
      schema: workflowRevisionProtectedDefinitionSchema,
    });
    const protectedRunInput = await encryptWorkflowContent({
      ownerId,
      context: { recordKind: "workflow-run", recordId: runId, field: "input" },
      keyRevision: 1,
      componentKey: key,
      content: { version: 1, input: { request: "PRIVATE_INPUT_SENTINEL" } },
      schema: workflowRunProtectedInputSchema,
    });
    const command = {
      type: "workflow.node.execute",
      workflowRunId: runId,
      workflowRevisionId: revisionId,
      revisionNodeId: "revision-node-1",
      nodePosition: 0,
      runNodeId,
      attemptId,
      idempotencyKey: "attempt-once",
      worktreeId: null,
      rootKind: "git-worktree",
      cwd: "/tmp/project",
      threadId: null,
      protectedDefinition,
      protectedRunInput,
      predecessorResults: [],
      mutationMode: "read-only",
      permissionProfileId: null,
      timeoutMs: 30_000,
      model: {},
      provider: {},
      mcpServers: [],
    } as unknown as Extract<WorkerCommand, { type: "workflow.node.execute" }>;
    let observedPrompt = "";
    const result = await executeProtectedWorkflowNode({
      command,
      service,
      execute: async ({ prompt }) => {
        observedPrompt = prompt;
        return {
          status: "completed",
          threadId: "thread-1",
          turnId: "turn-1",
          text: "PRIVATE_RESULT_TEXT_SENTINEL",
          structuredResult: { answer: "PRIVATE_RESULT_SENTINEL" },
          measuredUsage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            totalTokens: 2,
            durationMs: 10,
            estimatedCostUsd: null,
            costAvailable: false,
          },
        };
      },
    });
    expect(result.status).toBe("completed");
    expect(observedPrompt).toContain("PRIVATE_PROMPT_SENTINEL");
    expect(observedPrompt).toContain("PRIVATE_INPUT_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RESULT_SENTINEL");
    if (result.status !== "completed") throw new Error("execution failed");
    await expect(
      decryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "workflow-run-node",
          recordId: runNodeId,
          field: "result",
        },
        keyRevision: 1,
        componentKey: key,
        encrypted: result.protectedNodeResult,
        schema: workflowNodeProtectedResultSchema,
      }),
    ).resolves.toMatchObject({
      text: "PRIVATE_RESULT_TEXT_SENTINEL",
      structuredResult: { answer: "PRIVATE_RESULT_SENTINEL" },
    });
  });
});
