import { describe, expect, it } from "vitest";
import { CANTRIP_MCP_TOOL_NAMES } from "@cantrip/protocol";

import {
  cantripMcpHostInvocation,
  managedCantripMcpServer,
  mergeManagedMcpServers,
} from "../src/mcp/managed.js";

describe("managed worker MCP servers", () => {
  it("materializes the packaged worker-owned stdio host", () => {
    const invocation = cantripMcpHostInvocation({
      execPath: "/worker/runtime/node",
      moduleUrl: "file:///worker/dist/mcp/managed.js",
    });
    expect(invocation).toEqual({
      command: "/worker/runtime/node",
      arguments: ["/worker/dist/mcp/stdio.js"],
    });
    expect(
      managedCantripMcpServer(invocation, "/worker/data/binding.json"),
    ).toEqual({
      name: "cantrip",
      enabled: true,
      transport: "stdio",
      command: "/worker/runtime/node",
      args: [
        "/worker/dist/mcp/stdio.js",
        "--connection",
        "/worker/data/binding.json",
      ],
      environment: {},
      managedToolNames: [...CANTRIP_MCP_TOOL_NAMES],
    });
  });

  it("preserves user servers while removing both reserved shadows", () => {
    const cantrip = managedCantripMcpServer(
      { command: "node", arguments: ["stdio.js"] },
      "/binding.json",
    );
    const codegraph = {
      name: "codegraph",
      enabled: true,
      transport: "stdio" as const,
      command: "codegraph",
      args: ["serve", "--mcp"],
      environment: {},
    };
    const user = {
      name: "database",
      enabled: true,
      transport: "stdio" as const,
      command: "database-mcp",
      args: [],
      environment: {},
    };
    expect(
      mergeManagedMcpServers(
        [
          user,
          { ...user, name: "CANTRIP", command: "shadow" },
          { ...user, name: "CodeGraph", command: "shadow" },
        ],
        [codegraph, cantrip],
      ),
    ).toEqual([user, codegraph, cantrip]);
  });
});
