import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_READ_OPERATIONS,
  CANTRIP_MCP_READ_TOOL_NAMES,
  cantripMcpWebReadInputSchema,
  cantripMcpWebSearchInputSchema,
} from "./index.js";

describe("managed web tool contracts", () => {
  it("adds search and reading to the open-world read catalog", () => {
    expect(CANTRIP_MCP_READ_OPERATIONS).toEqual(
      expect.arrayContaining(["web.search", "web.read"]),
    );
    expect(CANTRIP_MCP_READ_TOOL_NAMES).toEqual(
      expect.arrayContaining(["web_search", "web_read"]),
    );
  });

  it("bounds search controls and rejects contradictory domain filters", () => {
    expect(
      cantripMcpWebSearchInputSchema.parse({ query: " search fixture " }),
    ).toMatchObject({
      query: "search fixture",
      count: 10,
      page: 1,
      safeSearch: "moderate",
    });
    expect(() =>
      cantripMcpWebSearchInputSchema.parse({
        query: "fixture",
        includeDomains: ["Example.com"],
        excludeDomains: ["example.com"],
      }),
    ).toThrow(/both included and excluded/u);
    expect(() =>
      cantripMcpWebSearchInputSchema.parse({
        query: "fixture",
        includeDomains: ["https://example.com/path"],
      }),
    ).toThrow(/hostnames/u);
  });

  it("requires one initial read source or one continuation cursor", () => {
    expect(
      cantripMcpWebReadInputSchema.parse({ url: "https://example.com/" }),
    ).toMatchObject({ maxChars: 20_000, render: "auto" });
    expect(() =>
      cantripMcpWebReadInputSchema.parse({
        url: "https://example.com/",
        searchResultId: `wsr_${"a".repeat(32)}`,
      }),
    ).toThrow(/exactly one/u);
    expect(() => cantripMcpWebReadInputSchema.parse({})).toThrow(
      /exactly one/u,
    );
    expect(
      cantripMcpWebReadInputSchema.parse({
        cursor: `wrc_${"a".repeat(32)}`,
      }).cursor,
    ).toHaveLength(36);
  });
});
