import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { markdownCodeLanguage } from "./markdown-code";
import { Markdown } from "./markdown";

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
});
