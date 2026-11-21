import {
  isManagedMcpName,
  type McpServerConfiguration,
  type CantripAgentOperationName,
} from "@cantrip/protocol";

/** The pinned remote environment cannot launch worker-local stdio MCP servers.
 * Native Linux tools remain available. A user network MCP stays on the worker's
 * native client; a local executable is never moved into the guest implicitly. */
export function osNativeMcpServers(
  servers: McpServerConfiguration[],
): McpServerConfiguration[] {
  const configured = servers.filter((server) => !isManagedMcpName(server.name));
  const local = configured.find(
    (server) => server.enabled && server.transport === "stdio",
  );
  if (local)
    throw new Error(
      `CantripOS cannot start the worker-local stdio MCP server '${local.name}'. Disable it for this chat or configure a network MCP transport.`,
    );
  return configured;
}

/** These existing handlers still select a Host source. Do not advertise them
 * to a captured Linux agent until their explicit source adapters are installed. */
export function osNativeMcpOperations(
  operations: readonly CantripAgentOperationName[],
): CantripAgentOperationName[] {
  return operations.filter(
    (operation) =>
      !operation.startsWith("run-configuration.") &&
      !operation.startsWith("worktree.") &&
      operation !== "task.create",
  );
}
