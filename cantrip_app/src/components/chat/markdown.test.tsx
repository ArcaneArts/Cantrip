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
});
