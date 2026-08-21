import {
  cantripAgentOperationRequestSchema,
  cantripAgentOperationResultSchema,
} from "@cantrip/protocol";
import type {
  CantripAgentOperationRequest,
  CantripAgentOperationResult,
} from "@cantrip/protocol";

export type CantripAgentOperationHandler<Context> = (
  context: Context,
  request: CantripAgentOperationRequest,
) => Promise<CantripAgentOperationResult>;

/**
 * Validates the transport-neutral boundary around Cantrip agent operations.
 * Authentication and context resolution happen before this executor; CLI and
 * MCP transports both enter through this same bounded contract.
 */
export const createCantripAgentOperationExecutor = <Context>(
  handler: CantripAgentOperationHandler<Context>,
) => ({
  async execute(
    context: Context,
    request: CantripAgentOperationRequest,
  ): Promise<CantripAgentOperationResult> {
    const parsedRequest = cantripAgentOperationRequestSchema.parse(request);
    const result = await handler(context, parsedRequest);
    return cantripAgentOperationResultSchema.parse(result);
  },
});
