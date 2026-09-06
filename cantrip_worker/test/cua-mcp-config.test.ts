import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isManagedMcpName } from "@cantrip/protocol";
import {
  codexMcpConfigOverride,
  cantripChatThreadParams,
  managedMcpToolRequirements,
} from "../src/codex/app-server.js";
import {
  cuaMcpHostInvocation,
  managedCuaMcpServer,
  managedCantripMcpServer,
  mergeManagedMcpServers,
} from "../src/mcp/managed.js";
import { CANTRIP_MCP_MAX_RESPONSE_BYTES } from "../src/mcp/http.js";
import { CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS } from "../src/mcp/timeouts.js";

const invocation = { command: "node", arguments: ["cua-stdio.js"] };
describe("managed CUA MCP configuration", () => {
  it.each(["ide", "standalone-chat"] as const)(
    "advertises the actual CUA entry point in %s thread instructions",
    (profile) => {
      const cua = managedCuaMcpServer(invocation, "connection.json");
      const instructions = cantripChatThreadParams(true, profile, [
        cua,
      ]).developerInstructions;
      expect(instructions).toContain('"script":"await cua.targets()"');
      expect(instructions).toContain("namespace is separate from `cantrip`");
      expect(instructions).toContain("An empty `cantrip.target_list`");
      expect(instructions).toContain("Window sharing starts automatically");
      expect(
        cantripChatThreadParams(true, profile, [{ ...cua, enabled: false }])
          .developerInstructions,
      ).not.toContain("await cua.targets()");
      expect(
        cantripChatThreadParams(true, profile, [{ ...cua, name: "unrelated" }])
          .developerInstructions,
      ).not.toContain("await cua.targets()");
    },
  );
  it("uses the dedicated worker host in source and packaged runtimes", () => {
    expect(
      cuaMcpHostInvocation({
        execPath: "node",
        moduleUrl: pathToFileURL(path.resolve("/worker/dist/mcp/managed.js"))
          .href,
      }),
    ).toEqual({
      command: "node",
      arguments: [path.resolve("/worker/dist/mcp/cua-stdio.js")],
    });
    expect(
      cuaMcpHostInvocation({
        execPath: "node",
        moduleUrl: pathToFileURL(path.resolve("/worker/src/mcp/managed.ts"))
          .href,
        execArguments: ["--import", "tsx"],
      }),
    ).toEqual({
      command: "node",
      arguments: [
        "--import",
        "tsx",
        path.resolve("/worker/src/mcp/cua-stdio.ts"),
      ],
    });
  });
  it("reserves the name and removes configured shadows", () => {
    const managed = managedCuaMcpServer(invocation, "connection.json");
    expect(isManagedMcpName(" Cantrip_CUA ")).toBe(true);
    expect(
      mergeManagedMcpServers(
        [{ ...managed, name: "CANTRIP_CUA", command: "shadow" }],
        [managed],
      ),
    ).toEqual([managed]);
  });
  it("extends only CUA's approval-compatible deadline and required tools", () => {
    const cua = managedCuaMcpServer(invocation, "connection.json");
    const ordinary = managedCantripMcpServer(
      { command: "node", arguments: ["stdio.js"] },
      "connection.json",
    );
    const custom = { ...ordinary, name: "user-server" };
    const config = codexMcpConfigOverride([cua, ordinary, custom]) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(config.mcp_servers.cantrip_cua).toMatchObject({
      required: true,
      enabled_tools: ["js", "js_reset"],
      tool_timeout_sec: 370,
    });
    expect(config.mcp_servers.cantrip).not.toHaveProperty("tool_timeout_sec");
    expect(config.mcp_servers["user-server"]).not.toHaveProperty(
      "tool_timeout_sec",
    );
    expect(managedMcpToolRequirements([cua])).toEqual([
      { name: "cantrip_cua", tool: "js" },
      { name: "cantrip_cua", tool: "js_reset" },
    ]);
    expect(CANTRIP_MCP_MAX_RESPONSE_BYTES).toBe(512 * 1024);
    expect(CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS).toBe(55_000);
  });
});
