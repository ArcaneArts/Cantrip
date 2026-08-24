import {
  cantripMcpRunConfigurationCreateInputSchema,
  cantripMcpRunConfigurationCreateResultSchema,
  cantripMcpRunConfigurationDeleteInputSchema,
  cantripMcpRunConfigurationDeleteResultSchema,
  cantripMcpRunConfigurationDetectInputSchema,
  cantripMcpRunConfigurationDetectResultSchema,
  cantripMcpRunConfigurationGetInputSchema,
  cantripMcpRunConfigurationGetResultSchema,
  cantripMcpRunConfigurationListInputSchema,
  cantripMcpRunConfigurationListResultSchema,
  cantripMcpRunConfigurationReadOutputInputSchema,
  cantripMcpRunConfigurationReadOutputResultSchema,
  cantripMcpRunConfigurationRestartInputSchema,
  cantripMcpRunConfigurationRestartResultSchema,
  cantripMcpRunConfigurationSecretSetInputSchema,
  cantripMcpRunConfigurationSecretSetResultSchema,
  cantripMcpRunConfigurationStartInputSchema,
  cantripMcpRunConfigurationStartResultSchema,
  cantripMcpRunConfigurationStatusInputSchema,
  cantripMcpRunConfigurationStatusResultSchema,
  cantripMcpRunConfigurationStopInputSchema,
  cantripMcpRunConfigurationStopResultSchema,
  cantripMcpRunConfigurationUpdateInputSchema,
  cantripMcpRunConfigurationUpdateResultSchema,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";
import {
  protectedRunConfigurationRuntimeOutputResultSchema,
  runConfigurationRuntimeOutputContentSchema,
  runConfigurationRuntimeOutputSchema,
} from "@cantrip/protocol/run-configuration-runtime";

import { openWorkerRunContent } from "../run-content-encryption.js";
import { protectRunConfigurationSecretValue } from "../run-configuration-secret-encryption.js";
import type { CantripMcpOperationOptions } from "./read-operations.js";

function assertBoundProject(
  options: CantripMcpOperationOptions,
  result: CantripAgentOperationResult,
) {
  if (
    result.target?.kind !== "project" ||
    result.target.projectId !== options.binding.projectId
  ) {
    throw new Error(
      "Cantrip returned Run configuration state for another project.",
    );
  }
}

function assertBoundWorktreeResult(
  options: CantripMcpOperationOptions,
  result: CantripAgentOperationResult,
) {
  if (
    result.target?.kind !== "worktree" ||
    result.target.projectId !== options.binding.projectId ||
    result.target.worktreeId !== result.worktreeId
  ) {
    throw new Error(
      "Cantrip returned a Run configuration runtime for another target.",
    );
  }
}

async function executeReadOperation(options: CantripMcpOperationOptions) {
  switch (options.request.operation) {
    case "run-configuration.list": {
      cantripMcpRunConfigurationListInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        options.request,
        options.requestId,
      );
      assertBoundProject(options, result);
      return cantripMcpRunConfigurationListResultSchema.parse(result);
    }
    case "run-configuration.get": {
      const arguments_ = cantripMcpRunConfigurationGetInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: options.request.operation, arguments: arguments_ },
        options.requestId,
      );
      assertBoundProject(options, result);
      return cantripMcpRunConfigurationGetResultSchema.parse(result);
    }
    case "run-configuration.detect": {
      const arguments_ = cantripMcpRunConfigurationDetectInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: options.request.operation, arguments: arguments_ },
        options.requestId,
      );
      assertBoundProject(options, result);
      return cantripMcpRunConfigurationDetectResultSchema.parse(result);
    }
    case "run-configuration.status": {
      const arguments_ = cantripMcpRunConfigurationStatusInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: options.request.operation, arguments: arguments_ },
        options.requestId,
      );
      assertBoundProject(options, result);
      return cantripMcpRunConfigurationStatusResultSchema.parse(result);
    }
    case "run-configuration.read-output": {
      const arguments_ = cantripMcpRunConfigurationReadOutputInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: options.request.operation, arguments: arguments_ },
        options.requestId,
      );
      assertBoundWorktreeResult(options, result);
      const wire = protectedRunConfigurationRuntimeOutputResultSchema.parse(
        result.data,
      );
      if (
        wire.projectId !== options.binding.projectId ||
        wire.configurationId !== arguments_.configurationId ||
        wire.worktreeId !== result.worktreeId
      ) {
        throw new Error("Cantrip returned output for another Run runtime.");
      }
      const output = await openWorkerRunContent({
        serverId: options.service.serverIdentity(),
        projectId: wire.projectId,
        worktreeId: wire.worktreeId,
        operationId: wire.operationId,
        operation: "run.configuration.output",
        opaque: wire.protectedOutput,
        schema: runConfigurationRuntimeOutputContentSchema,
        service: options.service,
        direction: "response",
      });
      return cantripMcpRunConfigurationReadOutputResultSchema.parse({
        ...result,
        data: runConfigurationRuntimeOutputSchema.parse({
          operationId: wire.operationId,
          projectId: wire.projectId,
          configurationId: wire.configurationId,
          worktreeId: wire.worktreeId,
          generation: wire.generation,
          ...output,
        }),
      });
    }
    default:
      throw new Error(
        "The requested operation is not a Run configuration read.",
      );
  }
}

async function executeMutationOperation(options: CantripMcpOperationOptions) {
  switch (options.request.operation) {
    case "run-configuration.create": {
      const arguments_ = cantripMcpRunConfigurationCreateInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: options.request.operation, arguments: arguments_ },
        options.requestId,
      );
      assertBoundProject(options, result);
      return cantripMcpRunConfigurationCreateResultSchema.parse(result);
    }
    case "run-configuration.update": {
      const arguments_ = cantripMcpRunConfigurationUpdateInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: options.request.operation, arguments: arguments_ },
        options.requestId,
      );
      assertBoundProject(options, result);
      return cantripMcpRunConfigurationUpdateResultSchema.parse(result);
    }
    case "run-configuration.delete": {
      const arguments_ = cantripMcpRunConfigurationDeleteInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: options.request.operation, arguments: arguments_ },
        options.requestId,
      );
      assertBoundProject(options, result);
      return cantripMcpRunConfigurationDeleteResultSchema.parse(result);
    }
    case "run-configuration.start":
    case "run-configuration.restart":
    case "run-configuration.stop": {
      const arguments_ =
        options.request.operation === "run-configuration.start"
          ? cantripMcpRunConfigurationStartInputSchema.parse(
              options.request.arguments,
            )
          : options.request.operation === "run-configuration.restart"
            ? cantripMcpRunConfigurationRestartInputSchema.parse(
                options.request.arguments,
              )
            : cantripMcpRunConfigurationStopInputSchema.parse(
                options.request.arguments,
              );
      const result = await options.execute(
        options.binding,
        { operation: options.request.operation, arguments: arguments_ },
        options.requestId,
      );
      assertBoundWorktreeResult(options, result);
      return options.request.operation === "run-configuration.start"
        ? cantripMcpRunConfigurationStartResultSchema.parse(result)
        : options.request.operation === "run-configuration.restart"
          ? cantripMcpRunConfigurationRestartResultSchema.parse(result)
          : cantripMcpRunConfigurationStopResultSchema.parse(result);
    }
    case "run-configuration.secret-set": {
      const arguments_ = cantripMcpRunConfigurationSecretSetInputSchema.parse(
        options.request.arguments,
      );
      const protectedValue = await protectRunConfigurationSecretValue({
        projectId: options.binding.projectId,
        reference: arguments_.reference,
        value: arguments_.value,
        service: options.service,
      });
      const result = await options.execute(
        options.binding,
        {
          operation: options.request.operation,
          arguments: {
            operationId: arguments_.operationId,
            reference: arguments_.reference,
            protectedValue,
          },
        },
        options.requestId,
      );
      assertBoundProject(options, result);
      return cantripMcpRunConfigurationSecretSetResultSchema.parse(result);
    }
    default:
      throw new Error(
        "The requested operation is not a Run configuration mutation.",
      );
  }
}

export function executeCantripMcpRunConfigurationOperation(
  options: CantripMcpOperationOptions,
) {
  if (options.service.ownerId() !== options.binding.ownerId) {
    throw new Error("Worker encryption belongs to a different MCP owner.");
  }
  return options.request.operation === "run-configuration.list" ||
    options.request.operation === "run-configuration.get" ||
    options.request.operation === "run-configuration.detect" ||
    options.request.operation === "run-configuration.status" ||
    options.request.operation === "run-configuration.read-output"
    ? executeReadOperation(options)
    : executeMutationOperation(options);
}
