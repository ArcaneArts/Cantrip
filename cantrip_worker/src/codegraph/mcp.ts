import {
  MANAGED_CODEGRAPH_MCP_NAME,
  type McpServerConfiguration,
} from "@cantrip/protocol";

import { mergeManagedMcpServers } from "../mcp/managed.js";

export const CODEGRAPH_MANAGED_ENVIRONMENT = Object.freeze({
  CODEGRAPH_DIR: ".codegraph-cantrip",
  // Use the same direct MCP mode that runtime installation verifies. The
  // shared daemon can fail to attach to canonical Windows worktree paths,
  // leaving Codex with zero tools until Cantrip's readiness deadline expires.
  CODEGRAPH_NO_DAEMON: "1",
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
  return mergeManagedMcpServers(configured, [managed]);
}
