import {
  CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS,
  CANTRIP_MCP_MUTATION_OPERATIONS,
  CANTRIP_MCP_READ_OPERATIONS,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";

import { executeCantripMcpMutationOperation } from "./mutation-operations.js";
import { executeCantripMcpClientControlOperation } from "./client-control-operations.js";
import {
  executeCantripMcpReadOperation,
  type CantripMcpOperationOptions,
} from "./read-operations.js";
import { executeCantripMcpRunConfigurationOperation } from "./run-configuration-operations.js";

const readOperations = new Set<string>(CANTRIP_MCP_READ_OPERATIONS);
const mutationOperations = new Set<string>(CANTRIP_MCP_MUTATION_OPERATIONS);
const clientControlOperations = new Set<string>(
  CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS,
);

export function executeCantripMcpOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  if (options.request.operation.startsWith("run-configuration.")) {
    return executeCantripMcpRunConfigurationOperation(options);
  }
  if (readOperations.has(options.request.operation)) {
    return executeCantripMcpReadOperation(options);
  }
  if (clientControlOperations.has(options.request.operation)) {
    return executeCantripMcpClientControlOperation(options);
  }
  if (mutationOperations.has(options.request.operation)) {
    return executeCantripMcpMutationOperation(options);
  }
  throw new Error(
    `Unsupported Cantrip MCP operation: ${options.request.operation}`,
  );
}
