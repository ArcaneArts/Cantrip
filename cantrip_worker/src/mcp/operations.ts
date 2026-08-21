import {
  CANTRIP_MCP_READ_OPERATIONS,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";

import { executeCantripMcpMutationOperation } from "./mutation-operations.js";
import {
  executeCantripMcpReadOperation,
  type CantripMcpOperationOptions,
} from "./read-operations.js";

const readOperations = new Set<string>(CANTRIP_MCP_READ_OPERATIONS);

export function executeCantripMcpOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  return readOperations.has(options.request.operation)
    ? executeCantripMcpReadOperation(options)
    : executeCantripMcpMutationOperation(options);
}
