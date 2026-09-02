import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GitContentSurface } from "./git-content-surface";

describe("Git content gutters", () => {
  it("gutters eligible content without requiring its navigation to be nested", () => {
    const markup = renderToStaticMarkup(
      <GitContentSurface guttered>Content</GitContentSurface>,
    );

    expect(markup).toContain('data-content-gutter="wide"');
  });

  it("keeps the repository graph edge to edge", () => {
    const markup = renderToStaticMarkup(
      <GitContentSurface guttered={false}>Graph</GitContentSurface>,
    );

    expect(markup).not.toContain("data-content-gutter");
  });
});
