import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS,
  CANTRIP_WEB_SEARCH_RUNTIME_TIMEOUT_MS,
} from "../src/mcp/timeouts.js";

describe("Cantrip MCP timeout budgets", () => {
  it("leaves room for managed runtime startup and a bounded web search", () => {
    expect(CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS).toBeGreaterThan(
      30_000 + CANTRIP_WEB_SEARCH_RUNTIME_TIMEOUT_MS,
    );
    expect(CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS).toBeLessThan(60_000);
  });
});
