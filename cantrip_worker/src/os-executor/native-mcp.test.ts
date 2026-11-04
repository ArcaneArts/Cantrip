import { expect, it } from "vitest";
import type { McpServerConfiguration } from "@cantrip/protocol";
import { osNativeMcpServers, osNativeMcpOperations } from "./native-mcp.js";
const local = (name: string, enabled = true): McpServerConfiguration => ({
  name,
  enabled,
  transport: "stdio",
  command: "/worker/local/tool",
  args: [],
  environment: {},
});
it("keeps network MCP on the native client and rejects active worker-local executables", () => {
  const remote: McpServerConfiguration = {
    name: "network",
    enabled: true,
    transport: "http",
    url: "https://mcp.example.test",
    bearerTokenEnvironmentVariable: null,
    headers: {},
    environmentHeaders: {},
  };
  expect(osNativeMcpServers([remote, local("disabled", false)])).toEqual([
    remote,
    local("disabled", false),
  ]);
  expect(() => osNativeMcpServers([local("user-server")])).toThrow(
    /worker-local stdio MCP server/,
  );
});
it("never injects reserved Host integrations into the remote Linux session", () => {
  expect(
    osNativeMcpServers([
      local("cantrip"),
      local("cantrip_cua"),
      local("codegraph"),
    ]),
  ).toEqual([]);
});

it("does not expose handlers which still select Host to a captured Linux agent", () => {
  expect(
    osNativeMcpOperations([
      "context.get",
      "policy.read",
      "explorer.read",
      "terminal.send",
      "worktree.create",
      "worktree.status",
      "run-configuration.start",
      "task.create",
      "task.status",
    ]),
  ).toEqual([
    "context.get",
    "policy.read",
    "explorer.read",
    "terminal.send",
    "task.status",
  ]);
});
