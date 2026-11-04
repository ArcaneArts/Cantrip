import {
  isManagedMcpName,
  type McpServerConfiguration,
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
