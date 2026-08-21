import {
  clearSensitiveBytes,
  decryptWorkflowContent,
  encryptWorkflowContent,
} from "@cantrip/crypto";
import type { WorkerCommand } from "@cantrip/protocol";
import {
  protectedWorkflowNodeExecutionResultSchema,
  workflowAgentNodeConfigurationSchema,
  workflowJsonValueSchema,
  workflowNodeProtectedInputSchema,
  workflowNodeProtectedResultSchema,
  workflowProtectedErrorSchema,
  workflowRevisionProtectedDefinitionSchema,
  workflowRunProtectedInputSchema,
  workflowRunProtectedResultSchema,
  type WorkflowJsonValue,
  type WorkflowJsonObject,
  type WorkflowNodeExecutionResult,
} from "@cantrip/protocol/workflows";

import type { WorkerEncryptionService } from "./worker-encryption.js";

type ProtectedCommand = Extract<
  WorkerCommand,
  { type: "workflow.node.execute" }
>;

function pointerValue(value: WorkflowJsonValue, selector: string | null) {
  if (selector === null) return value;
  const pointer = selector.startsWith("/")
    ? selector
    : `/${selector.replaceAll("~", "~0").replaceAll("/", "~1")}`;
  let current: WorkflowJsonValue = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const position = Number(segment);
      if (
        !Number.isInteger(position) ||
        position < 0 ||
        position >= current.length
      ) {
        throw new Error(`Workflow result selector ${selector} did not match.`);
      }
      current = current[position]!;
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      throw new Error(`Workflow result selector ${selector} did not match.`);
    }
    current = (current as Record<string, WorkflowJsonValue>)[segment]!;
  }
  return workflowJsonValueSchema.parse(current);
}

function renderedPrompt(
  configuration: ReturnType<typeof workflowAgentNodeConfigurationSchema.parse>,
  input: WorkflowJsonValue,
) {
  const prompt = configuration.includeStructuredInput
    ? `${configuration.prompt}\n\nStructured workflow input (JSON):\n${JSON.stringify(input)}`
    : configuration.prompt;
  if (prompt.length > 100_000) {
    throw new Error("The rendered workflow prompt exceeds 100000 characters.");
  }
  return prompt;
}

async function protectError(input: {
  command: ProtectedCommand;
  componentKey: Uint8Array;
  ownerId: string;
  error: unknown;
}) {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  const content = {
    version: 1 as const,
    code: "protected-execution-failed",
    message: message.trim() || "Protected workflow execution failed.",
  };
  const protect = (
    recordKind: "workflow-attempt" | "workflow-run-node" | "workflow-run",
    recordId: string,
  ) =>
    encryptWorkflowContent({
      ownerId: input.ownerId,
      context: { recordKind, recordId, field: "error" },
      keyRevision: input.command.protectedDefinition.keyRevision,
      componentKey: input.componentKey,
      content,
      schema: workflowProtectedErrorSchema,
    });
  const [protectedAttemptError, protectedNodeError, protectedRunError] =
    await Promise.all([
      protect("workflow-attempt", input.command.attemptId),
      protect("workflow-run-node", input.command.runNodeId),
      protect("workflow-run", input.command.workflowRunId),
    ]);
  return { protectedAttemptError, protectedNodeError, protectedRunError };
}

export async function executeProtectedWorkflowNode(input: {
  command: ProtectedCommand;
  service: WorkerEncryptionService;
  execute(options: {
    prompt: string;
    developerInstructions: string | null;
    skillNames: string[];
    outputSchema: WorkflowJsonObject;
    networkAccess: "none" | "restricted" | "unrestricted";
    approvalMode: "interactive" | "preauthorized";
  }): Promise<WorkflowNodeExecutionResult>;
}) {
  const component = input.service.componentKey("workflow-content");
  const ownerId = input.service.ownerId();
  try {
    try {
      const [definition, runInput, ...predecessorResults] = await Promise.all([
        decryptWorkflowContent({
          ownerId,
          context: {
            recordKind: "workflow-revision",
            recordId: input.command.workflowRevisionId,
            field: "definition",
          },
          keyRevision: input.command.protectedDefinition.keyRevision,
          componentKey: component.key,
          encrypted: input.command.protectedDefinition,
          schema: workflowRevisionProtectedDefinitionSchema,
        }),
        decryptWorkflowContent({
          ownerId,
          context: {
            recordKind: "workflow-run",
            recordId: input.command.workflowRunId,
            field: "input",
          },
          keyRevision: input.command.protectedRunInput.keyRevision,
          componentKey: component.key,
          encrypted: input.command.protectedRunInput,
          schema: workflowRunProtectedInputSchema,
        }),
        ...input.command.predecessorResults.map((predecessor) =>
          decryptWorkflowContent({
            ownerId,
            context: {
              recordKind: "workflow-run-node" as const,
              recordId: predecessor.runNodeId,
              field: "result" as const,
            },
            keyRevision: predecessor.protectedResult.keyRevision,
            componentKey: component.key,
            encrypted: predecessor.protectedResult,
            schema: workflowNodeProtectedResultSchema,
          }),
        ),
      ]);
      if (
        definition.graph.nodes.some(({ type }) => type !== "agent") ||
        definition.graph.edges.some(({ condition }) => condition !== null)
      ) {
        throw new Error(
          "This protected runtime currently supports agent-only DAGs without conditional edges.",
        );
      }
      const node = definition.graph.nodes[input.command.nodePosition];
      if (!node || node.type !== "agent") {
        throw new Error(
          "The protected workflow node does not match its scheduling manifest.",
        );
      }
      if (
        node.mutationMode !== input.command.mutationMode ||
        node.permissionProfileId !== input.command.permissionProfileId
      ) {
        throw new Error(
          "The protected workflow node does not match its execution route.",
        );
      }
      const configuration = workflowAgentNodeConfigurationSchema.parse(
        node.configuration,
      );
      if (node.permissionRequirements.approvalMode !== "preauthorized") {
        throw new Error("Protected workflow nodes must be preauthorized.");
      }
      const incoming = definition.graph.edges.filter(
        ({ to }) => to === node.key,
      );
      if (incoming.length !== predecessorResults.length) {
        throw new Error(
          "The protected workflow predecessor set is incomplete.",
        );
      }
      let structuredInput: WorkflowJsonValue = runInput.input;
      if (incoming.length > 0) {
        const mapped = incoming.map((edge) => {
          const commandIndex = input.command.predecessorResults.findIndex(
            ({ nodePosition }) =>
              definition.graph.nodes[nodePosition]?.key === edge.from,
          );
          if (commandIndex < 0) {
            throw new Error(
              "The protected workflow predecessor mapping is invalid.",
            );
          }
          return {
            sourceNodeKey: edge.from,
            targetInput: edge.targetInput,
            value: pointerValue(
              predecessorResults[commandIndex]!.structuredResult,
              edge.sourceOutput,
            ),
          };
        });
        if (mapped.length === 1 && mapped[0]!.targetInput === null) {
          structuredInput = mapped[0]!.value;
        } else {
          const aggregate: Record<string, WorkflowJsonValue> = {};
          for (const item of mapped) {
            const key = item.targetInput ?? item.sourceNodeKey;
            if (Object.hasOwn(aggregate, key)) {
              throw new Error(
                `Workflow dependency mappings collide at ${key}.`,
              );
            }
            aggregate[key] = item.value;
          }
          structuredInput = aggregate;
        }
      }
      const result = await input.execute({
        prompt: renderedPrompt(configuration, structuredInput),
        developerInstructions: configuration.developerInstructions,
        skillNames: node.permissionRequirements.skills,
        outputSchema: node.outputSchema,
        networkAccess: node.permissionRequirements.network,
        approvalMode: node.permissionRequirements.approvalMode,
      });
      const nodeInput = { version: 1 as const, input: structuredInput };
      const nodeResult = {
        version: 1 as const,
        text: result.text,
        structuredResult: result.structuredResult,
      };
      const [
        protectedNodeInput,
        protectedNodeResult,
        protectedAttemptInput,
        protectedAttemptResult,
        protectedRunResult,
      ] = await Promise.all([
        encryptWorkflowContent({
          ownerId,
          context: {
            recordKind: "workflow-run-node",
            recordId: input.command.runNodeId,
            field: "input",
          },
          keyRevision: component.keyRevision,
          componentKey: component.key,
          content: nodeInput,
          schema: workflowNodeProtectedInputSchema,
        }),
        encryptWorkflowContent({
          ownerId,
          context: {
            recordKind: "workflow-run-node",
            recordId: input.command.runNodeId,
            field: "result",
          },
          keyRevision: component.keyRevision,
          componentKey: component.key,
          content: nodeResult,
          schema: workflowNodeProtectedResultSchema,
        }),
        encryptWorkflowContent({
          ownerId,
          context: {
            recordKind: "workflow-attempt",
            recordId: input.command.attemptId,
            field: "input",
          },
          keyRevision: component.keyRevision,
          componentKey: component.key,
          content: nodeInput,
          schema: workflowNodeProtectedInputSchema,
        }),
        encryptWorkflowContent({
          ownerId,
          context: {
            recordKind: "workflow-attempt",
            recordId: input.command.attemptId,
            field: "result",
          },
          keyRevision: component.keyRevision,
          componentKey: component.key,
          content: nodeResult,
          schema: workflowNodeProtectedResultSchema,
        }),
        encryptWorkflowContent({
          ownerId,
          context: {
            recordKind: "workflow-run",
            recordId: input.command.workflowRunId,
            field: "result",
          },
          keyRevision: component.keyRevision,
          componentKey: component.key,
          content: { version: 1, result: result.structuredResult },
          schema: workflowRunProtectedResultSchema,
        }),
      ]);
      return protectedWorkflowNodeExecutionResultSchema.parse({
        status: "completed",
        threadId: result.threadId,
        turnId: result.turnId,
        measuredUsage: result.measuredUsage,
        protectedNodeInput,
        protectedNodeResult,
        protectedAttemptInput,
        protectedAttemptResult,
        protectedRunResult,
      });
    } catch (error) {
      const protectedErrors = await protectError({
        command: input.command,
        componentKey: component.key,
        ownerId,
        error,
      });
      return protectedWorkflowNodeExecutionResultSchema.parse({
        status: "failed",
        ...protectedErrors,
      });
    }
  } finally {
    clearSensitiveBytes(component.key);
  }
}
