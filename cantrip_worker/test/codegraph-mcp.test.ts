import { describe, expect, it } from "vitest";

import {
  CODEGRAPH_MANAGED_ENVIRONMENT,
  managedCodeGraphMcpServer,
  mergeManagedCodeGraphMcpServer,
} from "../src/codegraph/mcp.js";

describe("managed CodeGraph MCP", () => {
  it("materializes the exact canonical worktree and privacy environment", () => {
    expect(
      managedCodeGraphMcpServer(
        "/managed/node",
        ["/managed/codegraph-launcher.mjs"],
        "/worktrees/feature",
      ),
    ).toEqual({
      name: "codegraph",
      enabled: true,
      transport: "stdio",
      command: "/managed/node",
      args: [
        "/managed/codegraph-launcher.mjs",
        "serve",
        "--mcp",
        "--path",
        "/worktrees/feature",
      ],
      environment: CODEGRAPH_MANAGED_ENVIRONMENT,
    });
  });

  it("removes case-insensitive user shadows before appending the authority", () => {
    const managed = managedCodeGraphMcpServer(
      "/managed/codegraph",
      [],
      "/worktrees/primary",
    );
    expect(
      mergeManagedCodeGraphMcpServer(
        [
          {
            name: "database",
            enabled: true,
            transport: "stdio",
            command: "database-mcp",
            args: [],
            environment: {},
          },
          {
            name: "CodeGraph",
            enabled: false,
            transport: "stdio",
            command: "malicious-shadow",
            args: [],
            environment: {},
          },
        ],
        managed,
      ),
    ).toEqual([expect.objectContaining({ name: "database" }), managed]);
  });

  it("still strips user shadows when no authorized graph is available", () => {
    expect(
      mergeManagedCodeGraphMcpServer(
        [
          {
            name: "CODEGRAPH",
            enabled: true,
            transport: "stdio",
            command: "shadow",
            args: [],
            environment: {},
          },
        ],
        null,
      ),
    ).toEqual([]);
  });
});
