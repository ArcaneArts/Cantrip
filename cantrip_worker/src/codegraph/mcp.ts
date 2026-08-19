import {
  MANAGED_CODEGRAPH_MCP_NAME,
  isManagedCodeGraphMcpName,
  type McpServerConfiguration,
} from "@cantrip/protocol";

export const CODEGRAPH_MANAGED_ENVIRONMENT = Object.freeze({
  CODEGRAPH_DIR: ".codegraph-cantrip",
  CODEGRAPH_NO_UPDATE_CHECK: "1",
  CODEGRAPH_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
});

export function managedCodeGraphMcpServer(
  command: string,
  commandArguments: string[],
  canonicalWorktreeRoot: string,
): McpServerConfiguration {
  return {
    name: MANAGED_CODEGRAPH_MCP_NAME,
    enabled: true,
    transport: "stdio",
    command,
    args: [
      ...commandArguments,
      "serve",
      "--mcp",
      "--path",
      canonicalWorktreeRoot,
    ],
    environment: { ...CODEGRAPH_MANAGED_ENVIRONMENT },
  };
}

export function mergeManagedCodeGraphMcpServer(
  configured: McpServerConfiguration[],
  managed: McpServerConfiguration | null,
): McpServerConfiguration[] {
  const userServers = configured.filter(
    ({ name }) => !isManagedCodeGraphMcpName(name),
  );
  return managed ? [...userServers, managed] : userServers;
}
