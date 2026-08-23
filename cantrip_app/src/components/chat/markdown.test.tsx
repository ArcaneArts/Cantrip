import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { markdownCodeLanguage } from "./markdown-code";
import { handleMarkdownLinkClick, Markdown } from "./markdown";

describe("Markdown", () => {
  it("marks rendered prose as selectable application content", () => {
    const markup = renderToStaticMarkup(
      <Markdown>{"Copy **this** text."}</Markdown>,
    );

    expect(markup).toContain('data-selectable-text="true"');
  });

  it("syntax highlights fenced code using its declared language", () => {
    const markup = renderToStaticMarkup(
      <Markdown>
        {"```java\npublic class Example {\n  return;\n}\n```"}
      </Markdown>,
    );

    expect(markup).toContain("language-java");
    expect(markup).toContain("token keyword");
    expect(markup).toContain("token class-name");
  });

  it("syntax highlights fenced diffs", () => {
    const markup = renderToStaticMarkup(
      <Markdown>{"```diff\n-before\n+after\n unchanged\n```"}</Markdown>,
    );

    expect(markup).toContain("language-diff");
    expect(markup).toContain("deleted-sign");
    expect(markup).toContain("inserted-sign");
  });

  it("keeps unsupported fenced languages as readable plain code", () => {
    const markup = renderToStaticMarkup(
      <Markdown>{"```not-a-language\ncall something\n```"}</Markdown>,
    );

    expect(markup).toContain("language-not-a-language");
    expect(markup).not.toContain("token keyword");
    expect(markup).toContain("call something");
  });

  it("normalizes common fenced language aliases", () => {
    expect(markdownCodeLanguage("language-js")).toBe("javascript");
    expect(markdownCodeLanguage("language-shell")).toBe("bash");
    expect(markdownCodeLanguage("language-c++")).toBe("cpp");
  });

  it("renders a release-note link for delegated external opening", () => {
    const openLink = vi.fn();
    const markup = renderToStaticMarkup(
      <Markdown onOpenLink={openLink}>
        {"[Full changelog](https://example.com/changelog)"}
      </Markdown>,
    );

    expect(markup).toContain('href="https://example.com/changelog"');
    expect(markup).toContain('target="_blank"');
    expect(openLink).not.toHaveBeenCalled();
  });

  it("prevents webview navigation when delegating a Markdown link", () => {
    const preventDefault = vi.fn();
    const openLink = vi.fn();

    expect(
      handleMarkdownLinkClick(
        { preventDefault },
        "https://example.com/changelog",
        openLink,
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openLink).toHaveBeenCalledWith("https://example.com/changelog");
  });

  it("preserves and delegates agent file links without a browser target", () => {
    const openFile = vi.fn();
    const markup = renderToStaticMarkup(
      <Markdown onOpenFile={openFile}>
        {"[Fabric JAR](E:\\workspace\\Fabric\\fabric.jar)"}
      </Markdown>,
    );

    expect(markup).toContain('href="#cantrip-file=');
    expect(markup).not.toContain('target="_blank"');
    expect(openFile).not.toHaveBeenCalled();
  });

  it("always prevents native navigation for an internal file link", () => {
    const preventDefault = vi.fn();
    const openFile = vi.fn();

    expect(
      handleMarkdownLinkClick(
        { preventDefault },
        `#cantrip-file=${encodeURIComponent("E:\\workspace\\app.jar")}`,
        undefined,
        openFile,
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith("E:\\workspace\\app.jar");
  });
});
