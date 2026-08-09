import { describe, expect, it } from "vitest";

import {
  parseWorkflowDefinitionCreate,
  parseWorkflowAuthoringRevision,
  starterWorkflowGraph,
  valuesFromGeneratedWorkflow,
  type WorkflowAuthoringValues,
} from "./workflow-author-dialog";

function values(): WorkflowAuthoringValues {
  return {
    scope: "project",
    slug: "inspect-project",
    name: "Inspect project",
    description: "Read-only inspection.",
    trustState: "untrusted",
    graphText: JSON.stringify(starterWorkflowGraph),
    declaredInputsText: "{}",
    declaredOutputsText: "{}",
    defaultsText: "{}",
    permissionsText: "{}",
    source: "manual",
    provenance: {
      origin: "cantrip",
      sourceId: null,
      sourceRevision: null,
      reference: null,
      importedAt: null,
      metadata: { authoredIn: "cantrip" },
    },
  };
}

describe("workflow authoring", () => {
  it("builds a schema-validated project workflow", () => {
    const workflow = parseWorkflowDefinitionCreate(values(), "project-1");
    expect(workflow).toMatchObject({
      scope: "project",
      projectId: "project-1",
      slug: "inspect-project",
      source: "manual",
      trustState: "untrusted",
    });
    expect(workflow.revision.graph.nodes[0]).toMatchObject({
      key: "step",
      mutationMode: "read-only",
    });
  });

  it("removes project attribution from personal workflows", () => {
    const input = values();
    input.scope = "personal";
    expect(parseWorkflowDefinitionCreate(input, "project-1").projectId).toBe(
      null,
    );
  });

  it("rejects executable-looking extras and graph cycles", () => {
    const input = values();
    const graph = structuredClone(starterWorkflowGraph) as unknown as {
      nodes: Array<{ configuration: Record<string, unknown> }>;
    };
    graph.nodes[0]!.configuration = {
      ...graph.nodes[0]!.configuration,
      script: "process.exit(1)",
    };
    input.graphText = JSON.stringify(graph);
    expect(() => parseWorkflowAuthoringRevision(input, null)).toThrow();

    const cyclic = structuredClone(starterWorkflowGraph);
    cyclic.nodes.push({
      ...cyclic.nodes[0]!,
      key: "second",
      name: "Second",
    });
    cyclic.edges = [
      {
        from: "step",
        to: "second",
        sourceOutput: null,
        targetInput: null,
        condition: null,
      },
      {
        from: "second",
        to: "step",
        sourceOutput: null,
        targetInput: null,
        condition: null,
      },
    ];
    input.graphText = JSON.stringify(cyclic);
    expect(() => parseWorkflowAuthoringRevision(input, null)).toThrow(
      "Workflow dependency edges must form an acyclic graph.",
    );
  });

  it("loads an untrusted generated preview without silently saving it", () => {
    const input = values();
    const preview = valuesFromGeneratedWorkflow(
      input,
      {
        generationId: "generation-1",
        definition: {
          scope: "project",
          projectId: "project-1",
          slug: "generated-review",
          name: "Generated review",
          description: "Review a change.",
          source: "generated",
          provenance: {
            origin: "generated",
            sourceId: "generation-1",
            sourceRevision: null,
            reference: "chat:chat-1",
            importedAt: null,
            metadata: {},
          },
          trustState: "untrusted",
          revision: {
            graph: starterWorkflowGraph,
            declaredInputs: {},
            declaredOutputs: {},
            defaults: {},
            permissionRequirements: {
              filesystem: "read-only",
              network: "none",
              approvalMode: "interactive",
              skills: [],
              mcpServers: [],
              nativeSubagents: false,
            },
            source: "generated",
            provenance: {
              origin: "generated",
              sourceId: "generation-1",
              sourceRevision: null,
              reference: "chat:chat-1",
              importedAt: null,
              metadata: {},
            },
            trustState: "untrusted",
          },
        },
        codexThreadId: "thread-1",
        codexTurnId: "turn-1",
        measuredUsage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedInputTokens: 0,
          totalTokens: 30,
          durationMs: 100,
          estimatedCostUsd: null,
          costAvailable: false,
        },
      },
      false,
    );

    expect(preview).toMatchObject({
      slug: "generated-review",
      source: "generated",
      trustState: "untrusted",
    });
    expect(parseWorkflowDefinitionCreate(preview, "project-1")).toMatchObject({
      source: "generated",
      trustState: "untrusted",
      provenance: { sourceId: "generation-1" },
    });
  });
});
