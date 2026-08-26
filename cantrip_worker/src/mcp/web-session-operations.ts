import {
  cantripMcpWebSessionOpenInputSchema,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";

import type { CantripMcpOperationOptions } from "./read-operations.js";
import { resolveSurfaceContext } from "./read-operations.js";

export async function executeCantripMcpWebSessionOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  const service = options.webService;
  if (!service) throw new Error("Worker web services are unavailable.");

  switch (options.request.operation) {
    case "web.session.open": {
      const input = cantripMcpWebSessionOpenInputSchema.parse(
        options.request.arguments,
      );
      if (input.browserTarget) {
        const { target } = await resolveSurfaceContext(
          options,
          input.browserTarget,
        );
        return await service.sessionOpen(options.binding, input, {
          projectId: target.projectId,
          surfaceId: target.surfaceId,
        });
      }
      return await service.sessionOpen(options.binding, input);
    }
    case "web.session.snapshot":
      return await service.sessionSnapshot(
        options.binding,
        options.request.arguments,
      );
    case "web.session.click":
      return await service.sessionClick(
        options.binding,
        options.request.arguments,
      );
    case "web.session.type":
      return await service.sessionType(
        options.binding,
        options.request.arguments,
      );
    case "web.session.close":
      return await service.sessionClose(
        options.binding,
        options.request.arguments,
      );
    default:
      throw new Error(
        `Unsupported web session operation: ${options.request.operation}`,
      );
  }
}
