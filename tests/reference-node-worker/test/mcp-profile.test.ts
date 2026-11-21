import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_STANDALONE_OPERATIONS,
  CANTRIP_MCP_STANDALONE_TOOL_NAMES,
  cantripMcpInstructions,
  cantripMcpProfile,
} from "../src/mcp/profile.js";

describe("managed Cantrip MCP profiles", () => {
  it("defines the exact standalone operation and tool catalogs", () => {
    expect(CANTRIP_MCP_STANDALONE_OPERATIONS).toEqual([
      "tool.help",
      "web.search",
      "web.read",
    ]);
    expect(CANTRIP_MCP_STANDALONE_TOOL_NAMES).toEqual([
      "tool_help",
      "web_search",
      "web_read",
    ]);
  });

  it("keeps standalone instructions limited to available web tools", () => {
    const instructions = cantripMcpInstructions("standalone-web");
    expect(instructions).toContain("web_search");
    expect(instructions).toContain("web_read");
    expect(instructions).not.toContain("context_get");
    expect(instructions).not.toContain("run_configuration_detect");
  });

  it("defaults to IDE and rejects unknown process profiles", () => {
    expect(cantripMcpProfile(undefined)).toBe("ide");
    expect(cantripMcpProfile("standalone-web")).toBe("standalone-web");
    expect(() => cantripMcpProfile("project-admin")).toThrow(
      "profile is invalid",
    );
  });
});
