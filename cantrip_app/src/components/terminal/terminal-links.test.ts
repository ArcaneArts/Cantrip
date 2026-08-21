import { describe, expect, it } from "vitest";

import {
  findTerminalWebLinks,
  segmentTerminalWebLinks,
  terminalLinkBrowserTitle,
} from "./terminal-links";

describe("terminal web links", () => {
  it("finds HTTP links and excludes sentence punctuation", () => {
    expect(
      findTerminalWebLinks(
        "See https://example.com/docs, then http://localhost:4173/test.",
      ),
    ).toEqual([
      {
        end: 28,
        start: 4,
        url: "https://example.com/docs",
      },
      {
        end: 61,
        start: 35,
        url: "http://localhost:4173/test",
      },
    ]);
  });

  it("trims unmatched closing punctuation but keeps balanced URL pairs", () => {
    expect(
      findTerminalWebLinks(
        "(https://example.com/a_(b)) https://example.com/a_(b)",
      ).map(({ url }) => url),
    ).toEqual(["https://example.com/a_(b)", "https://example.com/a_(b)"]);
  });

  it("segments a URL that wraps across terminal rows", () => {
    expect(
      segmentTerminalWebLinks([
        { row: 8, text: "go https://exam" },
        { row: 9, text: "ple.com/path" },
      ]),
    ).toEqual([
      expect.objectContaining({
        row: 8,
        startColumn: 3,
        endColumn: 15,
        url: "https://example.com/path",
      }),
      expect.objectContaining({
        row: 9,
        startColumn: 0,
        endColumn: 12,
        url: "https://example.com/path",
      }),
    ]);
  });

  it("uses the destination host as the Browser tab title", () => {
    expect(terminalLinkBrowserTitle("https://docs.example.com/guide")).toBe(
      "docs.example.com",
    );
  });
});
