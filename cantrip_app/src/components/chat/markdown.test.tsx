import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("marks rendered prose as selectable application content", () => {
    const markup = renderToStaticMarkup(
      <Markdown>{"Copy **this** text."}</Markdown>,
    );

    expect(markup).toContain('data-selectable-text="true"');
  });
});
