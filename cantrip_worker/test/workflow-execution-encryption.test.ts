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
      nodeType: "agent",
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
      outgoingDependencies: [],
      mutationMode: "read-only",
      permissionProfileId: null,
      maxNodeExecutions: 100,
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

  it("keeps map collection values worker-local and returns one sealed aggregate", async () => {
    const key = randomBytes(32);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
    } as unknown as WorkerEncryptionService;
    const permissionRequirements = {
      filesystem: "read-only" as const,
      network: "none" as const,
      approvalMode: "preauthorized" as const,
      skills: [],
      mcpServers: [],
      nativeSubagents: false,
    };
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
              key: "map-items",
              type: "map",
              name: "Private map",
              configuration: {
                prompt: "Process this item",
                developerInstructions: null,
                includeStructuredInput: true,
                automaticRetries: null,
                collectionPath: "/items",
                itemInputKey: "item",
                maxConcurrency: 2,
                failurePolicy: "fail-fast",
              },
              inputSchema: {},
              outputSchema: {},
              permissionRequirements,
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
        permissionRequirements,
      },
      schema: workflowRevisionProtectedDefinitionSchema,
    });
    const protectedRunInput = await encryptWorkflowContent({
      ownerId,
      context: { recordKind: "workflow-run", recordId: runId, field: "input" },
      keyRevision: 1,
      componentKey: key,
      content: { version: 1, input: { items: ["alpha", "beta"] } },
      schema: workflowRunProtectedInputSchema,
    });
    const observedPrompts: string[] = [];
    const result = await executeProtectedWorkflowNode({
      command: {
        type: "workflow.node.execute",
        workflowRunId: runId,
        workflowRevisionId: revisionId,
        revisionNodeId: "revision-node-1",
        nodePosition: 0,
        nodeType: "map",
        runNodeId,
        attemptId,
        idempotencyKey: "map-once",
        worktreeId: null,
        rootKind: "git-worktree",
        cwd: "/tmp/project",
        threadId: null,
        protectedDefinition,
        protectedRunInput,
        predecessorResults: [],
        outgoingDependencies: [],
        mutationMode: "read-only",
        permissionProfileId: null,
        maxNodeExecutions: 2,
        timeoutMs: 30_000,
        model: {},
        provider: {},
        mcpServers: [],
      } as unknown as Extract<WorkerCommand, { type: "workflow.node.execute" }>,
      service,
      execute: async ({ prompt }) => {
        const position = observedPrompts.length;
        observedPrompts.push(prompt);
        return {
          status: "completed",
          threadId: `thread-${position}`,
          turnId: `turn-${position}`,
          text: "done",
          structuredResult: { position },
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
    expect(observedPrompts).toHaveLength(2);
    expect(observedPrompts.join("\n")).toContain("alpha");
    expect(observedPrompts.join("\n")).toContain("beta");
    if (result.status !== "completed") throw new Error("execution failed");
    expect(result.logicalExecutionCount).toBe(2);
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
      structuredResult: [{ position: 0 }, { position: 1 }],
    });
  });

  it("evaluates condition predicates on the worker and returns only the selected dependency ID", async () => {
    const key = randomBytes(32);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
    } as unknown as WorkerEncryptionService;
    const permissionRequirements = {
      filesystem: "read-only" as const,
      network: "none" as const,
      approvalMode: "preauthorized" as const,
      skills: [],
      mcpServers: [],
      nativeSubagents: false,
    };
    const agentNode = (keyValue: string) => ({
      key: keyValue,
      type: "agent" as const,
      name: keyValue,
      configuration: {
        prompt: "unused",
        developerInstructions: null,
        includeStructuredInput: false,
        automaticRetries: null,
      },
      inputSchema: {},
      outputSchema: {},
      permissionRequirements,
      mutationMode: "read-only" as const,
      modelRouteId: null,
      permissionProfileId: null,
    });
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
              key: "choose",
              type: "condition",
              name: "Private condition",
              configuration: { requireMatch: true },
              inputSchema: {},
              outputSchema: {},
              permissionRequirements,
              mutationMode: "read-only",
              modelRouteId: null,
              permissionProfileId: null,
            },
            agentNode("yes"),
            agentNode("no"),
          ],
          edges: [
            {
              from: "choose",
              to: "yes",
              sourceOutput: null,
              targetInput: null,
              condition: {
                path: "/approved",
                operator: "equals",
                value: true,
              },
            },
            {
              from: "choose",
              to: "no",
              sourceOutput: null,
              targetInput: null,
              condition: null,
            },
          ],
        },
        declaredInputs: {},
        declaredOutputs: {},
        defaults: {},
        permissionRequirements,
      },
      schema: workflowRevisionProtectedDefinitionSchema,
    });
    const protectedRunInput = await encryptWorkflowContent({
      ownerId,
      context: { recordKind: "workflow-run", recordId: runId, field: "input" },
      keyRevision: 1,
      componentKey: key,
      content: { version: 1, input: { approved: true } },
      schema: workflowRunProtectedInputSchema,
    });
    const result = await executeProtectedWorkflowNode({
      command: {
        type: "workflow.node.execute",
        workflowRunId: runId,
        workflowRevisionId: revisionId,
        revisionNodeId: "revision-node-1",
        nodePosition: 0,
        nodeType: "condition",
        runNodeId,
        attemptId,
        idempotencyKey: "condition-once",
        worktreeId: null,
        rootKind: "git-worktree",
        cwd: "/tmp/project",
        threadId: null,
        protectedDefinition,
        protectedRunInput,
        predecessorResults: [],
        outgoingDependencies: [
          { edgePosition: 0, dependencyId: "dependency-yes" },
          { edgePosition: 1, dependencyId: "dependency-no" },
        ],
        mutationMode: "read-only",
        permissionProfileId: null,
        maxNodeExecutions: 1,
        timeoutMs: 30_000,
        model: {},
        provider: {},
        mcpServers: [],
      } as unknown as Extract<WorkerCommand, { type: "workflow.node.execute" }>,
      service,
      execute: async () => {
        throw new Error("condition nodes must not invoke a model");
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      threadId: null,
      turnId: null,
      logicalExecutionCount: 1,
      selectedDependencyIds: ["dependency-yes"],
    });
    expect(JSON.stringify(result)).not.toContain("approved");
  });
});
