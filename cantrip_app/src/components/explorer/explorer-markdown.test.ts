import { describe, expect, it } from "vitest";
import { explorerMarkdownDestination } from "./explorer-markdown";
describe("Explorer Markdown destinations", () => {
  it.each([
    "../../outside.md",
    "%2e%2e/%2e%2e/outside.md",
    "../%2e%2e/outside.md",
    "/outside.md",
    "%2Foutside.md",
    "C%3A/outside.md",
    "..%5Coutside.md",
    "%00.md",
  ])("rejects an outside-root destination: %s", (href) => {
    expect(() => explorerMarkdownDestination(href, "notes/source.md")).toThrow(
      "outside this project",
    );
  });
  it("decodes each path once and separates URI anchors from encoded filename characters", () => {
    expect(
      explorerMarkdownDestination(
        "space%20%C3%BCnicode%23%3F.md#section",
        "notes/source.md",
      ),
    ).toEqual({ path: "notes/space ünicode#?.md", fragment: "section" });
    expect(
      explorerMarkdownDestination("literal%2520.md", "notes/source.md"),
    ).toEqual({ path: "notes/literal%20.md", fragment: "" });
    expect(
      explorerMarkdownDestination(
        "../README.md?view=1#intro",
        "notes/source.md",
      ),
    ).toEqual({ path: "README.md", fragment: "intro" });
  });
  it("resolves fragment-only links within the current file", () => {
    expect(
      explorerMarkdownDestination("#unicode-%C3%BC", "notes/source.md"),
    ).toEqual({ path: "notes/source.md", fragment: "unicode-ü" });
  });
  it("leaves external URL navigation to the Markdown renderer", () => {
    expect(
      explorerMarkdownDestination(
        "https://example.com/../file.md",
        "notes/source.md",
      ),
    ).toBeNull();
    expect(
      explorerMarkdownDestination("//example.com/file.md", "notes/source.md"),
    ).toBeNull();
  });
  it("rejects malformed percent encoding", () => {
    expect(() =>
      explorerMarkdownDestination("bad%XX.md", "notes/source.md"),
    ).toThrow();
  });
});
