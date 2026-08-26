import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_READ_OPERATIONS,
  CANTRIP_MCP_READ_TOOL_NAMES,
  cantripMcpOperationsForPermissionProfile,
  cantripMcpWebReadInputSchema,
  cantripMcpWebSearchInputSchema,
  cantripMcpWebSessionOpenInputSchema,
  cantripMcpWebSessionTypeInputSchema,
} from "./index.js";

describe("managed web tool contracts", () => {
  it("adds search and reading to the open-world read catalog", () => {
    expect(CANTRIP_MCP_READ_OPERATIONS).toEqual(
      expect.arrayContaining([
        "web.search",
        "web.read",
        "web.session.snapshot",
      ]),
    );
    expect(CANTRIP_MCP_READ_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "web_search",
        "web_read",
        "web_session_snapshot",
      ]),
    );
  });

  it("requires opaque session references and fixes persistent profiles at open", () => {
    expect(
      cantripMcpOperationsForPermissionProfile(":read-only"),
    ).not.toContain("web.session.snapshot");
    expect(
      cantripMcpWebSessionOpenInputSchema.parse({
        url: "https://example.com/",
      }),
    ).toEqual({ url: "https://example.com/" });
    expect(() =>
      cantripMcpWebSessionOpenInputSchema.parse({
        url: "https://example.com/",
        sessionId: `wss_${"a".repeat(32)}`,
        browserTarget: {
          kind: "surface",
          projectId: "project-one",
          surfaceId: "browser-one",
          surfaceKind: "browser",
        },
      }),
    ).toThrow(/fixed profile/u);
    expect(
      cantripMcpWebSessionTypeInputSchema.parse({
        sessionId: `wss_${"a".repeat(32)}`,
        elementRef: `wer_${"b".repeat(32)}`,
        text: "query",
      }).submit,
    ).toBe(false);
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
