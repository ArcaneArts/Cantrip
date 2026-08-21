import { isDeepStrictEqual } from "node:util";

import {
  clearSensitiveBytes,
  decryptWorkflowContent,
  encryptWorkflowContent,
} from "@cantrip/crypto";
import type { WorkerCommand } from "@cantrip/protocol";
import {
  protectedWorkflowNodeExecutionResultSchema,
  workflowAgentNodeConfigurationSchema,
  workflowConditionNodeConfigurationSchema,
  workflowJsonValueSchema,
  workflowMapNodeConfigurationSchema,
  workflowMeasuredUsageSchema,
  workflowNodeProtectedInputSchema,
  workflowNodeProtectedResultSchema,
  workflowPipelineNodeConfigurationSchema,
  workflowProtectedErrorSchema,
  workflowReduceNodeConfigurationSchema,
  workflowRepeatUntilNodeConfigurationSchema,
  workflowRevisionProtectedDefinitionSchema,
  workflowRunProtectedInputSchema,
  workflowRunProtectedResultSchema,
  workflowVerifyNodeConfigurationSchema,
  type WorkflowAgentNodeConfiguration,
  type WorkflowJsonValue,
  type WorkflowJsonObject,
  type WorkflowMeasuredUsage,
  type WorkflowNodeExecutionResult,
  type WorkflowPredicate,
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
  configuration: WorkflowAgentNodeConfiguration,
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

function valueAtPointer(
  root: WorkflowJsonValue,
  pointer: string,
): { found: boolean; value?: WorkflowJsonValue } {
  if (pointer === "") return { found: true, value: root };
  let current = root;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return { found: false };
      const position = Number(segment);
      if (position >= current.length) return { found: false };
      current = current[position]!;
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      return { found: false };
    }
    current = current[segment]!;
  }
  return { found: true, value: current };
}

function orderedComparison(
  left: WorkflowJsonValue,
  right: WorkflowJsonValue,
): number | null {
  if (
    (typeof left === "number" && typeof right === "number") ||
    (typeof left === "string" && typeof right === "string")
  ) {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return null;
}

function evaluatePredicate(
  root: WorkflowJsonValue,
  predicate: WorkflowPredicate,
): boolean {
  const selected = valueAtPointer(root, predicate.path);
  if (predicate.operator === "exists") return selected.found;
  if (predicate.operator === "not-exists") return !selected.found;
  if (!selected.found || predicate.value === undefined) return false;
  if (predicate.operator === "equals") {
    return isDeepStrictEqual(selected.value, predicate.value);
  }
  if (predicate.operator === "not-equals") {
    return !isDeepStrictEqual(selected.value, predicate.value);
  }
  if (predicate.operator === "contains") {
    if (
      typeof selected.value === "string" &&
      typeof predicate.value === "string"
    ) {
      return selected.value.includes(predicate.value);
    }
    if (Array.isArray(selected.value)) {
      return selected.value.some((value) =>
        isDeepStrictEqual(value, predicate.value),
      );
    }
    return (
      selected.value !== null &&
      typeof selected.value === "object" &&
      !Array.isArray(selected.value) &&
      typeof predicate.value === "string" &&
      Object.hasOwn(selected.value, predicate.value)
    );
  }
  const comparison = orderedComparison(selected.value!, predicate.value);
  if (comparison === null) return false;
  if (predicate.operator === "greater-than") return comparison > 0;
  if (predicate.operator === "greater-than-or-equals") return comparison >= 0;
  if (predicate.operator === "less-than") return comparison < 0;
  return comparison <= 0;
}

function aggregateUsage(
  values: WorkflowMeasuredUsage[],
): WorkflowMeasuredUsage {
  const bearing = values.filter(
    (usage) =>
      usage.costAvailable ||
      usage.estimatedCostUsd !== null ||
      usage.totalTokens > 0 ||
      usage.durationMs > 0,
  );
  const costAvailable =
    bearing.length > 0 &&
    bearing.every(
      ({ costAvailable: available, estimatedCostUsd }) =>
        available && estimatedCostUsd !== null,
    );
  return workflowMeasuredUsageSchema.parse({
    inputTokens: values.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: values.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cachedInputTokens: values.reduce(
      (sum, usage) => sum + usage.cachedInputTokens,
      0,
    ),
    totalTokens: values.reduce((sum, usage) => sum + usage.totalTokens, 0),
    durationMs: values.reduce((sum, usage) => sum + usage.durationMs, 0),
    estimatedCostUsd: costAvailable
      ? values.reduce((sum, usage) => sum + (usage.estimatedCostUsd ?? 0), 0)
      : null,
    costAvailable,
  });
}

function collectionEntries(value: WorkflowJsonValue) {
  if (value === null || typeof value !== "object") {
    throw new Error("A workflow collection must be a JSON array or object.");
  }
  if (Array.isArray(value)) {
    return {
      kind: "array" as const,
      entries: value.map((item, position) => [String(position), item] as const),
    };
  }
  const object = workflowJsonValueSchema.parse(value) as WorkflowJsonObject;
  return {
    kind: "object" as const,
    entries: Object.keys(object)
      .sort()
      .map((key) => [key, object[key]!] as const),
  };
}

function aggregateCollection(
  kind: "array" | "object",
  entries: ReadonlyArray<readonly [string, WorkflowJsonValue]>,
  values: WorkflowJsonValue[],
): WorkflowJsonValue {
  return kind === "array"
    ? values
    : Object.fromEntries(
        entries.map(([key], position) => [key, values[position]!]),
      );
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
    executionKey: string;
    threadId: string | null;
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
      const node = definition.graph.nodes[input.command.nodePosition];
      if (
        !node ||
        node.type !== input.command.nodeType ||
        node.type === "gate"
      ) {
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
      const outgoing = definition.graph.edges
        .map((edge, edgePosition) => ({ edge, edgePosition }))
        .filter(({ edge }) => edge.from === node.key);
      const dependencyByEdgePosition = new Map(
        input.command.outgoingDependencies.map(
          ({ edgePosition, dependencyId }) => [edgePosition, dependencyId],
        ),
      );
      if (
        dependencyByEdgePosition.size !==
          input.command.outgoingDependencies.length ||
        outgoing.length !== dependencyByEdgePosition.size ||
        outgoing.some(
          ({ edgePosition }) => !dependencyByEdgePosition.has(edgePosition),
        )
      ) {
        throw new Error(
          "The protected workflow dependency manifest is inconsistent.",
        );
      }

      const invoke = (
        configuration: WorkflowAgentNodeConfiguration,
        executionInput: WorkflowJsonValue,
        executionKey: string,
        outputSchema: WorkflowJsonObject,
        threadId: string | null = null,
      ) =>
        input.execute({
          executionKey,
          threadId,
          prompt: renderedPrompt(configuration, executionInput),
          developerInstructions: configuration.developerInstructions,
          skillNames: node.permissionRequirements.skills,
          outputSchema,
          networkAccess: node.permissionRequirements.network,
          approvalMode: node.permissionRequirements.approvalMode,
        });
      let result: {
        threadId: string | null;
        turnId: string | null;
        text: string;
        structuredResult: WorkflowJsonValue;
        measuredUsage: WorkflowMeasuredUsage;
        logicalExecutionCount: number;
        selectedDependencyIds: string[] | null;
      };
      if (node.type === "condition") {
        const configuration = workflowConditionNodeConfigurationSchema.parse(
          node.configuration,
        );
        const selected =
          outgoing.find(
            ({ edge }) =>
              edge.condition !== null &&
              evaluatePredicate(structuredInput, edge.condition),
          ) ?? outgoing.find(({ edge }) => edge.condition === null);
        if (!selected && configuration.requireMatch) {
          throw new Error("No protected workflow condition branch matched.");
        }
        result = {
          threadId: null,
          turnId: null,
          text: "",
          structuredResult: structuredInput,
          measuredUsage: workflowMeasuredUsageSchema.parse({}),
          logicalExecutionCount: 1,
          selectedDependencyIds: selected
            ? [dependencyByEdgePosition.get(selected.edgePosition)!]
            : [],
        };
      } else if (node.type === "map" || node.type === "pipeline") {
        const isMap = node.type === "map";
        const mapConfiguration = isMap
          ? workflowMapNodeConfigurationSchema.parse(node.configuration)
          : null;
        const pipelineConfiguration = isMap
          ? null
          : workflowPipelineNodeConfigurationSchema.parse(node.configuration);
        const configuration = mapConfiguration ?? pipelineConfiguration!;
        const selected = valueAtPointer(
          structuredInput,
          configuration.collectionPath,
        );
        if (!selected.found) {
          throw new Error(
            `The protected ${node.type} collection path did not match.`,
          );
        }
        const collection = collectionEntries(selected.value!);
        if (collection.entries.some(([itemKey]) => itemKey.length > 10_000)) {
          throw new Error("Protected workflow collection keys are too long.");
        }
        const executionCount = isMap
          ? collection.entries.length
          : collection.entries.length * pipelineConfiguration!.steps.length;
        if (Math.max(1, executionCount) > input.command.maxNodeExecutions) {
          throw new Error(
            `The protected ${node.type} expansion exceeds the workflow node budget.`,
          );
        }
        const values: WorkflowJsonValue[] = [];
        const usages: WorkflowMeasuredUsage[] = [];
        let lastThreadId: string | null = null;
        let lastTurnId: string | null = null;
        let lastText = "";
        for (const [position, [, itemValue]] of collection.entries.entries()) {
          try {
            let itemInput: WorkflowJsonValue = {
              [configuration.itemInputKey]: itemValue,
            };
            if (isMap) {
              const execution = await invoke(
                workflowMapNodeConfigurationSchema.parse(configuration),
                itemInput,
                `map:${position}`,
                node.outputSchema,
              );
              itemInput = execution.structuredResult;
              usages.push(execution.measuredUsage);
              lastThreadId = execution.threadId;
              lastTurnId = execution.turnId;
              lastText = execution.text;
            } else {
              let itemThreadId: string | null = null;
              for (const [
                stepPosition,
                step,
              ] of pipelineConfiguration!.steps.entries()) {
                const execution = await invoke(
                  step,
                  itemInput,
                  `pipeline:${position}:${stepPosition}`,
                  step.outputSchema,
                  itemThreadId,
                );
                itemInput = execution.structuredResult;
                itemThreadId = execution.threadId;
                usages.push(execution.measuredUsage);
                lastThreadId = execution.threadId;
                lastTurnId = execution.turnId;
                lastText = execution.text;
              }
            }
            values.push(
              configuration.failurePolicy === "continue"
                ? { status: "completed", result: itemInput }
                : itemInput,
            );
          } catch (error) {
            if (configuration.failurePolicy === "fail-fast") throw error;
            values.push({
              status: "failed",
              error: {
                code: "collection-item-failed",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
        result = {
          threadId: lastThreadId,
          turnId: lastTurnId,
          text: lastText,
          structuredResult: aggregateCollection(
            collection.kind,
            collection.entries,
            values,
          ),
          measuredUsage: aggregateUsage(usages),
          logicalExecutionCount: Math.max(1, executionCount),
          selectedDependencyIds: null,
        };
      } else if (node.type === "repeatUntil") {
        const configuration = workflowRepeatUntilNodeConfigurationSchema.parse(
          node.configuration,
        );
        const startedAt = Date.now();
        const usages: WorkflowMeasuredUsage[] = [];
        let iterationInput = structuredInput;
        let lastProgress: WorkflowJsonValue | undefined;
        let unchangedIterations = 0;
        let lastExecution: WorkflowNodeExecutionResult | null = null;
        for (
          let iteration = 1;
          iteration <= configuration.maxIterations;
          iteration += 1
        ) {
          if (iteration > input.command.maxNodeExecutions) {
            throw new Error(
              "The protected repeat-until loop exceeds the workflow node budget.",
            );
          }
          lastExecution = await invoke(
            configuration,
            iterationInput,
            `repeat:${iteration}`,
            node.outputSchema,
            lastExecution?.threadId ?? input.command.threadId,
          );
          usages.push(lastExecution.measuredUsage);
          const iterationResult = lastExecution.structuredResult;
          const progress = valueAtPointer(
            iterationResult,
            configuration.progressPath,
          );
          if (!progress.found) {
            throw new Error(
              "The protected repeat-until progress path did not match.",
            );
          }
          unchangedIterations =
            lastProgress === undefined ||
            !isDeepStrictEqual(lastProgress, progress.value)
              ? 0
              : unchangedIterations + 1;
          lastProgress = progress.value;
          if (
            evaluatePredicate(iterationResult, configuration.successCondition)
          ) {
            break;
          }
          if (Date.now() - startedAt >= configuration.maxDurationMs) {
            throw new Error(
              "The protected repeat-until loop exceeded its duration limit.",
            );
          }
          if (unchangedIterations >= configuration.maxUnchangedIterations) {
            throw new Error(
              "The protected repeat-until loop made no progress.",
            );
          }
          if (iteration === configuration.maxIterations) {
            throw new Error(
              "The protected repeat-until loop exhausted its iteration limit.",
            );
          }
          iterationInput = iterationResult;
        }
        if (!lastExecution) {
          throw new Error("The protected repeat-until loop did not execute.");
        }
        result = {
          ...lastExecution,
          measuredUsage: aggregateUsage(usages),
          logicalExecutionCount: usages.length,
          selectedDependencyIds: null,
        };
      } else {
        let configuration: WorkflowAgentNodeConfiguration;
        let executionInput = structuredInput;
        if (node.type === "agent") {
          configuration = workflowAgentNodeConfigurationSchema.parse(
            node.configuration,
          );
        } else if (node.type === "reduce") {
          const reduce = workflowReduceNodeConfigurationSchema.parse(
            node.configuration,
          );
          const selected = valueAtPointer(
            structuredInput,
            reduce.collectionPath,
          );
          if (!selected.found) {
            throw new Error(
              "The protected reduce collection path did not match.",
            );
          }
          const collection = collectionEntries(selected.value!);
          if (
            collection.entries.length === 0 &&
            reduce.emptyCollection === "fail"
          ) {
            throw new Error("The protected reduce collection is empty.");
          }
          configuration = reduce;
          executionInput = selected.value!;
        } else {
          configuration = workflowVerifyNodeConfigurationSchema.parse(
            node.configuration,
          );
        }
        const execution = await invoke(
          configuration,
          executionInput,
          node.type,
          node.outputSchema,
          input.command.threadId,
        );
        if (
          node.type === "verify" &&
          !evaluatePredicate(
            execution.structuredResult,
            workflowVerifyNodeConfigurationSchema.parse(node.configuration)
              .passCondition,
          ) &&
          workflowVerifyNodeConfigurationSchema.parse(node.configuration)
            .failurePolicy === "fail-run"
        ) {
          throw new Error("Protected workflow verification failed.");
        }
        result = {
          ...execution,
          logicalExecutionCount: 1,
          selectedDependencyIds: null,
        };
      }
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
        logicalExecutionCount: result.logicalExecutionCount,
        selectedDependencyIds: result.selectedDependencyIds,
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
