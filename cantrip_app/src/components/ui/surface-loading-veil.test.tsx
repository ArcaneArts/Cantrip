import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SurfaceLoadingVeil } from "./surface-loading-veil";

describe("SurfaceLoadingVeil", () => {
  it("can uncover a ready surface without fading", () => {
    const markup = renderToStaticMarkup(
      <SurfaceLoadingVeil
        fade={false}
        label="Starting surface…"
        visible={false}
      />,
    );

    expect(markup).toContain("opacity-0");
    expect(markup).not.toContain("transition-opacity");
    expect(markup).not.toContain("duration-500");
  });

  it("keeps fading available for unrelated loading surfaces", () => {
    const markup = renderToStaticMarkup(
      <SurfaceLoadingVeil label="Starting surface…" visible={false} />,
    );

    expect(markup).toContain("transition-opacity");
    expect(markup).toContain("duration-500");
  });
});
