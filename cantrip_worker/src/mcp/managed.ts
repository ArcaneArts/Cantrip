import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANTRIP_MCP_TOOL_NAMES,
  MANAGED_CANTRIP_MCP_NAME,
  isManagedMcpName,
  type McpServerConfiguration,
} from "@cantrip/protocol";

export interface CantripMcpHostInvocation {
  arguments: string[];
  command: string;
}

export const CANTRIP_MCP_OMIT_OUTPUT_SCHEMAS_ENVIRONMENT =
  "CANTRIP_MCP_OMIT_TOOL_OUTPUT_SCHEMAS";

export function cantripMcpHostInvocation(
  options: {
    execArguments?: string[];
    execPath?: string;
    moduleUrl?: string;
  } = {},
): CantripMcpHostInvocation {
  const modulePath = fileURLToPath(options.moduleUrl ?? import.meta.url);
  const sourceRuntime = path.extname(modulePath) === ".ts";
  const hostPath = path.join(
    path.dirname(modulePath),
    `stdio.${sourceRuntime ? "ts" : "js"}`,
  );
  return {
    command: options.execPath ?? process.execPath,
    arguments: [
      ...(sourceRuntime ? (options.execArguments ?? process.execArgv) : []),
      hostPath,
    ],
  };
}

export function managedCantripMcpServer(
  invocation: CantripMcpHostInvocation,
  connectionPath: string,
  managedToolNames: readonly (typeof CANTRIP_MCP_TOOL_NAMES)[number][] = CANTRIP_MCP_TOOL_NAMES,
): McpServerConfiguration & {
  managedToolNames: Array<(typeof CANTRIP_MCP_TOOL_NAMES)[number]>;
} {
  return {
    name: MANAGED_CANTRIP_MCP_NAME,
    enabled: true,
    transport: "stdio",
    command: invocation.command,
    args: [
      ...invocation.arguments,
      "--connection",
      path.resolve(connectionPath),
    ],
    environment: {},
    managedToolNames: [...managedToolNames],
  };
}

export function mergeManagedMcpServers(
  configured: McpServerConfiguration[],
  managed: Array<McpServerConfiguration | null>,
): McpServerConfiguration[] {
  const userServers = configured.filter(({ name }) => !isManagedMcpName(name));
  const managedServers = new Map<string, McpServerConfiguration>();
  for (const server of managed) {
    if (!server || !isManagedMcpName(server.name)) continue;
    managedServers.set(server.name.trim().toLowerCase(), server);
  }
  return [...userServers, ...managedServers.values()];
}
