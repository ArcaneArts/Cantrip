import type {
  McpServerConfiguration,
  McpServerOpaqueRuntime,
} from "@cantrip/protocol";
import type { CodexRuntime } from "./runtime.js";

/** Resolve only after the coordinator has recovered identity and selected intent. */
export function withManagedSessionMcpServers(
  runtime: Pick<CodexRuntime, "prepareManagedThread">,
  configured: McpServerOpaqueRuntime[] | undefined,
  resolve: (
    configured: McpServerOpaqueRuntime[],
  ) => Promise<McpServerConfiguration[]>,
): Pick<CodexRuntime, "prepareManagedThread"> {
  return {
    prepareManagedThread: async (options) =>
      runtime.prepareManagedThread({
        ...options,
        mcpServers: await resolveManagedSessionMcpServers(
          {
            threadId: options.threadId,
            intent: options.intent,
            mcpServers: configured,
          },
          resolve,
        ),
      }),
  };
}

/** Keep attachment observation distinct from an explicit configuration replacement. */
async function resolveManagedSessionMcpServers(
  input: {
    threadId: string | null;
    intent: "configure" | "preserve";
    mcpServers?: McpServerOpaqueRuntime[];
  },
  resolve: (
    configured: McpServerOpaqueRuntime[],
  ) => Promise<McpServerConfiguration[]>,
): Promise<McpServerConfiguration[] | undefined> {
  if (
    input.threadId &&
    input.intent === "preserve" &&
    input.mcpServers === undefined
  ) {
    return undefined;
  }
  // New sessions still need their managed tools, even when opening the first
  // view supplied no user servers. An explicit [] also reaches this resolver.
  return resolve(input.mcpServers ?? []);
}
