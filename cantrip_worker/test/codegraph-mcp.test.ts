import { describe, expect, it } from "vitest";

import {
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
      environment: {
        CODEGRAPH_DIR: ".codegraph-cantrip",
        CODEGRAPH_NO_DAEMON: "0",
        CODEGRAPH_NO_UPDATE_CHECK: "1",
        CODEGRAPH_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
      },
    });
  });

  it.each(["/worktrees/project", "C:\\Cantrip worktrees\\project"])(
    "lets multiple chats share the indexed project at %s",
    (root) => {
      const first = managedCodeGraphMcpServer("/managed/node", [], root);
      const second = managedCodeGraphMcpServer("/managed/node", [], root);

      for (const server of [first, second]) {
        expect(server.args).toEqual(["serve", "--mcp", "--path", root]);
        expect({
          CODEGRAPH_NO_DAEMON: "1",
          ...server.environment,
        }).toMatchObject({
          CODEGRAPH_DIR: ".codegraph-cantrip",
          CODEGRAPH_NO_DAEMON: "0",
        });
      }
      expect(first.environment).not.toBe(second.environment);
      first.environment.CODEGRAPH_NO_DAEMON = "1";
      expect(second.environment.CODEGRAPH_NO_DAEMON).toBe("0");
      expect(
        managedCodeGraphMcpServer("/managed/node", [], root).environment
          .CODEGRAPH_NO_DAEMON,
      ).toBe("0");
    },
  );

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
