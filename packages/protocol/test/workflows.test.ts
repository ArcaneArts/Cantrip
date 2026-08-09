import { describe, expect, it } from "vitest";

import {
  workflowApprovalGateSchema,
  workflowGateDecisionSchema,
  workflowAgentNodeConfigurationSchema,
  workflowDefinitionCreateSchema,
  workflowDefinitionQuerySchema,
  workflowConditionNodeConfigurationSchema,
  workflowGateNodeConfigurationSchema,
  workflowGraphSchema,
  workflowJsonPointerSchema,
  workflowJsonValueSchema,
  workflowMapNodeConfigurationSchema,
  workflowNodeExecutionRequestSchema,
  workflowNodeExecutionResultSchema,
  workflowNodeInterruptResultSchema,
  workflowNodeRetrySchema,
  workflowPermissionRequirementsSchema,
  workflowPipelineNodeConfigurationSchema,
  workflowPredicateSchema,
  workflowReduceNodeConfigurationSchema,
  workflowRepeatUntilNodeConfigurationSchema,
  workflowRevisionNodeSchema,
  workflowRunCreateSchema,
  workflowRunCancelSchema,
  workflowRunDetailSchema,
  workflowRunStatusUpdateSchema,
  workflowVerifyNodeConfigurationSchema,
} from "../src/workflows.js";

const timestamp = "2026-08-08T17:00:00.000Z";

function readNode(key: string) {
  return {
    key,
    type: "agent" as const,
    name: `Read ${key}`,
    configuration: { prompt: `Read ${key}.` },
  };
}

function writeNode(key: string) {
  return {
    key,
    type: "agent" as const,
    name: `Write ${key}`,
    configuration: { prompt: `Write ${key}.` },
    mutationMode: "write" as const,
    permissionRequirements: { filesystem: "workspace-write" as const },
  };
}

function validGraph() {
  return {
    version: 1 as const,
    nodes: [readNode("inspect"), writeNode("apply")],
    edges: [{ from: "inspect", to: "apply" }],
  };
}

function permissionManifest() {
  return workflowPermissionRequirementsSchema.parse({});
}

function budget() {
  return {
    maxNodes: 100,
    maxAttemptsPerNode: 3,
    maxParallelism: 4,
    maxTokens: null,
    maxDurationMs: 3_600_000,
    maxNodeDurationMs: 900_000,
    maxEstimatedCostUsd: null,
  };
}

function measuredUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    estimatedCostUsd: null,
    costAvailable: false,
  };
}

function trigger() {
  return {
    type: "manual" as const,
    sourceId: null,
    actorType: "user" as const,
    actorId: "user-1",
    deliveredAt: timestamp,
    metadata: {},
  };
}

describe("workflow protocol", () => {
  it("validates executable agent node configuration", () => {
    expect(
      workflowAgentNodeConfigurationSchema.parse({
        prompt: "Inspect the requested target.",
      }),
    ).toEqual({
      prompt: "Inspect the requested target.",
      developerInstructions: null,
      includeStructuredInput: true,
      automaticRetries: null,
    });
    expect(
      workflowAgentNodeConfigurationSchema.safeParse({ prompt: "" }).success,
    ).toBe(false);
  });

  it("normalizes constrained orchestration primitive configurations", () => {
    expect(
      workflowMapNodeConfigurationSchema.parse({
        prompt: "Inspect one item.",
        maxConcurrency: 4,
      }),
    ).toMatchObject({
      collectionPath: "",
      itemInputKey: "item",
      maxConcurrency: 4,
      failurePolicy: "fail-fast",
    });
    expect(
      workflowPipelineNodeConfigurationSchema
        .parse({
          maxConcurrency: 2,
          steps: [
            { key: "inspect", name: "Inspect", prompt: "Inspect the item." },
            { key: "verify", name: "Verify", prompt: "Verify the item." },
          ],
        })
        .steps.map(({ key }) => key),
    ).toEqual(["inspect", "verify"]);
    expect(
      workflowReduceNodeConfigurationSchema.parse({
        prompt: "Synthesize the findings.",
      }),
    ).toMatchObject({ collectionPath: "", emptyCollection: "fail" });
    expect(
      workflowVerifyNodeConfigurationSchema.parse({
        prompt: "Verify the finding.",
        passCondition: {
          path: "/passed",
          operator: "equals",
          value: true,
        },
      }),
    ).toMatchObject({ failurePolicy: "fail-run" });
    expect(workflowConditionNodeConfigurationSchema.parse({})).toEqual({
      requireMatch: true,
    });
    expect(
      workflowRepeatUntilNodeConfigurationSchema.parse({
        prompt: "Improve the candidate.",
        successCondition: {
          path: "/score",
          operator: "greater-than-or-equals",
          value: 0.9,
        },
        progressPath: "/score",
        maxUnchangedIterations: 2,
        maxIterations: 5,
        maxDurationMs: 60_000,
      }),
    ).toMatchObject({ maxIterations: 5, maxUnchangedIterations: 2 });
    expect(
      workflowGateNodeConfigurationSchema.parse({
        prompt: "Approve the next stage?",
      }),
    ).toEqual({
      prompt: "Approve the next stage?",
      expiresAfterMs: null,
      denialPolicy: "fail-run",
    });
  });

  it("rejects ambiguous predicates and unbounded collection or loop primitives", () => {
    expect(workflowJsonPointerSchema.parse("/results/0/score")).toBe(
      "/results/0/score",
    );
    expect(workflowJsonPointerSchema.safeParse("/bad~2escape").success).toBe(
      false,
    );
    expect(
      workflowPredicateSchema.safeParse({
        path: "/approved",
        operator: "equals",
      }).success,
    ).toBe(false);
    expect(
      workflowPredicateSchema.safeParse({
        path: "/approved",
        operator: "exists",
        value: true,
      }).success,
    ).toBe(false);
    expect(
      workflowMapNodeConfigurationSchema.safeParse({
        prompt: "Inspect one item.",
      }).success,
    ).toBe(false);
    expect(
      workflowPipelineNodeConfigurationSchema.safeParse({
        maxConcurrency: 2,
        steps: [
          { key: "same", name: "First", prompt: "First." },
          { key: "same", name: "Second", prompt: "Second." },
        ],
      }).success,
    ).toBe(false);
    expect(
      workflowRepeatUntilNodeConfigurationSchema.safeParse({
        prompt: "Improve the candidate.",
        successCondition: {
          path: "/done",
          operator: "equals",
          value: true,
        },
      }).success,
    ).toBe(false);
  });

  it("validates deterministic condition branches", () => {
    const conditional = workflowGraphSchema.parse({
      version: 1,
      nodes: [
        {
          key: "branch",
          type: "condition",
          name: "Branch",
          configuration: {},
        },
        readNode("approved"),
        readNode("fallback"),
      ],
      edges: [
        {
          from: "branch",
          to: "approved",
          condition: {
            path: "/approved",
            operator: "equals",
            value: true,
          },
        },
        { from: "branch", to: "fallback" },
      ],
    });
    expect(conditional.nodes[0]?.configuration).toEqual({
      requireMatch: true,
    });
    expect(
      workflowGraphSchema.safeParse({
        version: 1,
        nodes: [readNode("source"), readNode("target")],
        edges: [
          {
            from: "source",
            to: "target",
            condition: { path: "/ok", operator: "equals", value: true },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({
        version: 1,
        nodes: [
          {
            key: "branch",
            type: "condition",
            name: "Branch",
            configuration: {},
          },
          readNode("fallback"),
          readNode("matched"),
        ],
        edges: [
          { from: "branch", to: "fallback" },
          {
            from: "branch",
            to: "matched",
            condition: { path: "/ok", operator: "equals", value: true },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({
        version: 1,
        nodes: [readNode("first"), readNode("second"), readNode("target")],
        edges: [
          { from: "first", to: "target", targetInput: "result" },
          { from: "second", to: "target", targetInput: "result" },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded JSON and rejects unsafe or oversized values", () => {
    expect(
      workflowJsonValueSchema.parse({ nested: [true, 42, "safe", null] }),
    ).toEqual({ nested: [true, 42, "safe", null] });
    expect(workflowJsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(workflowJsonValueSchema.safeParse("x".repeat(100_001)).success).toBe(
      false,
    );

    let deeplyNested: Record<string, unknown> = {};
    for (let index = 0; index < 33; index += 1) {
      deeplyNested = { child: deeplyNested };
    }
    expect(workflowJsonValueSchema.safeParse(deeplyNested).success).toBe(false);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(workflowJsonValueSchema.safeParse(cyclic).success).toBe(false);

    const shared = {};
    expect(
      workflowJsonValueSchema.safeParse({ first: shared, second: shared })
        .success,
    ).toBe(false);
  });

  it("validates DAG structure, node identity, and dependency endpoints", () => {
    const parsed = workflowGraphSchema.parse(validGraph());
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0]?.mutationMode).toBe("read-only");
    expect(parsed.edges[0]).toMatchObject({ from: "inspect", to: "apply" });

    expect(
      workflowGraphSchema.safeParse({
        version: 1,
        nodes: [readNode("duplicate"), readNode("duplicate")],
      }).success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({
        version: 1,
        nodes: [readNode("known")],
        edges: [{ from: "known", to: "missing" }],
      }).success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({
        version: 1,
        nodes: [readNode("first"), readNode("second")],
        edges: [
          { from: "first", to: "second" },
          { from: "second", to: "first" },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires node mutation mode to match filesystem permissions", () => {
    expect(
      workflowGraphSchema.safeParse({
        version: 1,
        nodes: [
          {
            ...readNode("unsafe-read"),
            permissionRequirements: { filesystem: "workspace-write" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({
        version: 1,
        nodes: [{ ...writeNode("unsafe-write"), permissionRequirements: {} }],
      }).success,
    ).toBe(false);

    expect(
      workflowRevisionNodeSchema.safeParse({
        ...readNode("persisted"),
        mutationMode: "read-only",
        permissionRequirements: { filesystem: "workspace-write" },
        id: "node-1",
        revisionId: "revision-1",
        position: 0,
        createdAt: timestamp,
      }).success,
    ).toBe(false);
  });

  it("validates workflow scope and initial revision provenance", () => {
    expect(
      workflowDefinitionCreateSchema.parse({
        scope: "personal",
        slug: "local-check",
        name: "Local check",
        revision: { graph: { version: 1, nodes: [readNode("check")] } },
      }),
    ).toMatchObject({
      source: "cantrip",
      revision: { source: "cantrip" },
    });

    const provenance = {
      origin: "claude-code" as const,
      sourceId: "commands/review.md",
      metadata: { importedBy: "user-1" },
    };
    const valid = {
      scope: "project" as const,
      projectId: "project-1",
      slug: "review-change",
      name: "Review change",
      source: "imported" as const,
      provenance,
      revision: {
        graph: validGraph(),
        source: "imported" as const,
        provenance,
      },
    };
    expect(workflowDefinitionCreateSchema.parse(valid)).toMatchObject({
      scope: "project",
      projectId: "project-1",
      source: "imported",
    });
    expect(
      workflowDefinitionCreateSchema.safeParse({
        ...valid,
        provenance: {
          ...provenance,
          metadata: { importedBy: "user-1", path: "commands/review.md" },
        },
        revision: {
          ...valid.revision,
          provenance: {
            ...provenance,
            metadata: { path: "commands/review.md", importedBy: "user-1" },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      workflowDefinitionCreateSchema.safeParse({
        ...valid,
        projectId: null,
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionCreateSchema.safeParse({
        ...valid,
        scope: "personal",
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionCreateSchema.safeParse({
        ...valid,
        revision: { ...valid.revision, source: "manual" },
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionCreateSchema.safeParse({
        ...valid,
        revision: {
          ...valid.revision,
          provenance: { ...provenance, sourceId: "different.md" },
        },
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionCreateSchema.safeParse({
        ...valid,
        trustState: "trusted",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate skill and MCP requirements", () => {
    expect(
      workflowPermissionRequirementsSchema.safeParse({
        skills: ["review", "review"],
      }).success,
    ).toBe(false);
    expect(
      workflowPermissionRequirementsSchema.safeParse({
        mcpServers: ["github", "github"],
      }).success,
    ).toBe(false);
  });

  it("keeps approval gate status and decision data consistent", () => {
    const gate = {
      id: "gate-1",
      runId: "run-1",
      runNodeId: "run-node-1",
      gateKey: "approve-write",
      status: "pending" as const,
      prompt: "Approve workspace changes?",
      permissionManifest: permissionManifest(),
      interactionRequestId: null,
      requestedByType: "workflow",
      requestedById: "run-1",
      decision: null,
      decidedByUserId: null,
      decisionReason: null,
      expiresAt: null,
      decidedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(workflowApprovalGateSchema.parse(gate).status).toBe("pending");
    expect(
      workflowApprovalGateSchema.safeParse({
        ...gate,
        decision: "approved",
      }).success,
    ).toBe(false);
    expect(
      workflowApprovalGateSchema.safeParse({
        ...gate,
        status: "approved",
      }).success,
    ).toBe(false);
    expect(
      workflowApprovalGateSchema.parse({
        ...gate,
        status: "approved",
        decision: "approved",
        decidedByUserId: "user-1",
        decidedAt: timestamp,
      }).status,
    ).toBe("approved");
    expect(
      workflowGateDecisionSchema.parse({
        decision: "denied",
        idempotencyKey: "gate-decision-1",
      }),
    ).toEqual({
      decision: "denied",
      reason: null,
      idempotencyKey: "gate-decision-1",
    });
  });

  it("parses explicit false query parameters and rejects bad statuses", () => {
    expect(
      workflowDefinitionQuerySchema.parse({ includeArchived: "false" }),
    ).toMatchObject({ includeArchived: false });
    expect(
      workflowRunStatusUpdateSchema.safeParse({
        expectedStatus: "queued",
        status: "unknown",
        idempotencyKey: "update-1",
      }).success,
    ).toBe(false);
  });

  it("bounds durable cancellation and explicit retry controls", () => {
    expect(
      workflowRunCancelSchema.parse({
        reason: "No longer needed.",
        idempotencyKey: "cancel-1",
      }),
    ).toEqual({ reason: "No longer needed.", idempotencyKey: "cancel-1" });
    expect(
      workflowNodeRetrySchema.parse({ idempotencyKey: "retry-1" }),
    ).toEqual({ reason: null, idempotencyKey: "retry-1" });
    expect(
      workflowRunCancelSchema.safeParse({
        reason: "",
        idempotencyKey: "cancel-2",
      }).success,
    ).toBe(false);
  });

  it("bounds workflow node execution commands and structured results", () => {
    expect(
      workflowNodeExecutionRequestSchema.parse({
        workflowRunId: "run-1",
        runNodeId: "run-node-1",
        attemptId: "attempt-1",
        idempotencyKey: "execute-1",
        worktreeId: null,
        cwd: "/workspace",
        threadId: null,
        prompt: "Inspect the project.",
        developerInstructions: null,
        skillNames: ["review"],
        outputSchema: { type: "object" },
        mutationMode: "read-only",
        networkAccess: "none",
        approvalMode: "interactive",
        permissionProfileId: ":read-only",
        timeoutMs: 60_000,
      }),
    ).toMatchObject({
      attemptId: "attempt-1",
      mutationMode: "read-only",
      skillNames: ["review"],
    });
    expect(
      workflowNodeExecutionRequestSchema.safeParse({
        workflowRunId: "run-1",
        runNodeId: "run-node-1",
        attemptId: "attempt-1",
        idempotencyKey: "execute-1",
        cwd: "/workspace",
        prompt: "Inspect the project.",
        mutationMode: "read-only",
        networkAccess: "none",
        approvalMode: "interactive",
        timeoutMs: 999,
      }).success,
    ).toBe(false);

    expect(
      workflowNodeExecutionResultSchema.parse({
        threadId: "thread-1",
        turnId: "turn-1",
        text: '{"ok":true}',
        structuredResult: { ok: true },
        measuredUsage: {
          inputTokens: 12,
          outputTokens: 5,
          cachedInputTokens: 2,
          totalTokens: 17,
          durationMs: 250,
          estimatedCostUsd: null,
          costAvailable: false,
        },
        status: "completed",
      }).structuredResult,
    ).toEqual({ ok: true });
    expect(
      workflowNodeInterruptResultSchema.parse({ interrupted: true }),
    ).toEqual({ interrupted: true });
  });

  it("parses representative run creation and materialized run details", () => {
    expect(
      workflowRunCreateSchema.safeParse({
        trigger: trigger(),
        idempotencyKey: "missing-revision",
      }).success,
    ).toBe(false);

    expect(
      workflowRunCreateSchema.parse({
        workflowRevisionId: "revision-1",
        projectId: "project-1",
        structuredInput: { issue: 42 },
        trigger: trigger(),
        idempotencyKey: "launch-1",
      }),
    ).toMatchObject({
      workflowRevisionId: "revision-1",
      budget: { maxParallelism: 4 },
      permissionManifest: { filesystem: "read-only" },
    });

    const run = {
      id: "run-1",
      workflowId: "workflow-1",
      workflowRevisionId: "revision-1",
      ownerId: "user-1",
      projectId: "project-1",
      status: "queued" as const,
      trigger: trigger(),
      idempotencyKey: "launch-1",
      structuredInput: { issue: 42 },
      structuredResult: null,
      budget: budget(),
      measuredUsage: measuredUsage(),
      permissionManifest: permissionManifest(),
      selectedModelRouteId: "route-1",
      selectedPermissionProfileId: "profile-1",
      workerId: null,
      worktreeId: null,
      codexThreadId: null,
      errorCode: null,
      errorMessage: null,
      pauseReason: null,
      cancelReason: null,
      recoveryState: "stable" as const,
      queuedAt: timestamp,
      startedAt: null,
      pausedAt: null,
      cancelRequestedAt: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const node = {
      id: "run-node-1",
      runId: "run-1",
      revisionNodeId: "node-1",
      nodeKey: "inspect",
      nodeType: "agent" as const,
      status: "ready" as const,
      dependencyState: {},
      structuredInput: { issue: 42 },
      structuredResult: null,
      budget: budget(),
      measuredUsage: measuredUsage(),
      permissionManifest: permissionManifest(),
      workerId: null,
      worktreeId: null,
      modelRouteId: "route-1",
      permissionProfileId: "profile-1",
      codexThreadId: null,
      codexTurnId: null,
      writeCapable: false,
      executionLeaseKey: null,
      attemptCount: 0,
      notBefore: null,
      timeoutAt: null,
      readyAt: timestamp,
      startedAt: null,
      waitingAt: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const item = {
      id: "run-node-item-1",
      runNodeId: "run-node-1",
      itemKey: "alpha",
      position: 0,
      status: "ready" as const,
      structuredInput: { item: 42 },
      structuredResult: null,
      measuredUsage: measuredUsage(),
      errorCode: null,
      errorMessage: null,
      workerId: null,
      worktreeId: null,
      modelRouteId: "route-1",
      permissionProfileId: "profile-1",
      codexThreadId: null,
      codexTurnId: null,
      executionLeaseKey: null,
      attemptCount: 0,
      notBefore: null,
      timeoutAt: null,
      readyAt: timestamp,
      startedAt: null,
      waitingAt: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(
      workflowRunDetailSchema.parse({
        run,
        nodes: [node],
        items: [item],
        dependencies: [],
        attempts: [],
        gates: [],
      }),
    ).toMatchObject({
      run: { status: "queued", recoveryState: "stable" },
      nodes: [{ status: "ready", writeCapable: false }],
      items: [{ itemKey: "alpha", position: 0, status: "ready" }],
    });
  });
});
