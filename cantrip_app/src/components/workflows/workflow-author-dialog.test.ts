import { describe, expect, it } from "vitest";

import {
  parseWorkflowDefinitionCreate,
  parseWorkflowAuthoringRevision,
  starterWorkflowGraph,
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
});
